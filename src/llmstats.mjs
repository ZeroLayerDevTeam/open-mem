// What every LLM call cost: one llm_calls row per chat call or embedding batch, and the aggregates the web
// viewer's LLM page draws (speed, latency, failures over time). Recording never breaks the caller.
const KEEP_MS = 30 * 24 * 3600 * 1000;
const HOUR = 3600 * 1000;

export function recordCall(db, s) {
  try {
    const id = Number(db.prepare(`INSERT INTO llm_calls (at, task, provider, model, ok, items, prompt_tokens, output_tokens,
        load_ms, prompt_ms, eval_ms, total_ms, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      s.at ?? Date.now(), s.task || 'other', s.provider ?? null, s.model ?? null, s.ok ? 1 : 0, s.items ?? null,
      s.prompt_tokens ?? null, s.output_tokens ?? null, s.load_ms ?? null, s.prompt_ms ?? null, s.eval_ms ?? null,
      s.total_ms ?? null, s.error ? String(s.error).slice(0, 300) : null,
    ).lastInsertRowid);
    if (id % 500 === 0) db.prepare('DELETE FROM llm_calls WHERE at < ?').run(Date.now() - KEEP_MS);
  } catch { /* stats are best effort (e.g. database busy) */ }
}

// Gives a provider object a recorder: completeJson reports every call through provider.record.
export function withRecorder(db, provider) {
  if (provider && provider.kind !== 'none') provider.record = (s) => recordCall(db, s);
  return provider;
}

// Ollama reports durations in nanoseconds.
export const ollamaTimings = (res) => ({
  prompt_tokens: res.prompt_eval_count ?? null, output_tokens: res.eval_count ?? null,
  load_ms: res.load_duration != null ? res.load_duration / 1e6 : null, prompt_ms: res.prompt_eval_duration != null ? res.prompt_eval_duration / 1e6 : null,
  eval_ms: res.eval_duration != null ? res.eval_duration / 1e6 : null, total_ms: res.total_duration != null ? res.total_duration / 1e6 : null,
});

const BUCKETS = { 24: HOUR, 168: 6 * HOUR, 720: 24 * HOUR };
const rate = (tokens, ms) => (tokens && ms ? tokens / (ms / 1000) : null);

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

// Window of the last `hours` (24, 168 or 720): totals per task, time buckets for the charts, recent calls.
// Speed = output tokens per second of generation; chat calls only (embeddings report no generation).
export function callStats(db, { hours = 24 } = {}) {
  const h = BUCKETS[hours] ? hours : 24;
  const size = BUCKETS[h];
  const now = Date.now();
  const start = Math.floor((now - h * HOUR) / size) * size + size; // bucket edges on whole hours / days (UTC)
  const tasks = db.prepare(`SELECT task, count(*) calls, sum(ok) ok, sum(items) items, sum(prompt_tokens) prompt_tokens,
      sum(output_tokens) output_tokens, sum(eval_ms) eval_ms, sum(prompt_ms) prompt_ms, sum(total_ms) total_ms
    FROM llm_calls WHERE at >= ? GROUP BY task ORDER BY calls DESC`).all(start)
    .map((r) => ({ ...r, speed: rate(r.output_tokens, r.eval_ms), promptSpeed: rate(r.prompt_tokens, r.prompt_ms) }));
  const chat = tasks.filter((r) => r.task !== 'embed');
  const sum = (k) => chat.reduce((n, r) => n + (r[k] || 0), 0);
  const durations = db.prepare("SELECT total_ms FROM llm_calls WHERE at >= ? AND task != 'embed' AND total_ms IS NOT NULL ORDER BY total_ms LIMIT 20000")
    .all(start).map((r) => r.total_ms);
  // node:sqlite binds JS numbers as REAL: cast, or the bucket index is a fraction.
  const rows = db.prepare(`SELECT CAST((at - ?) / ? AS INTEGER) b, count(*) calls, sum(ok) ok, sum(output_tokens) output_tokens, sum(eval_ms) eval_ms,
      avg(total_ms) avg_ms FROM llm_calls WHERE at >= ? AND task != 'embed' GROUP BY b`).all(start, size, start);
  const byBucket = new Map(rows.map((r) => [Number(r.b), r]));
  const buckets = Array.from({ length: Math.floor((now - start) / size) + 1 }, (_, i) => {
    const r = byBucket.get(i);
    return { at: start + i * size, calls: r?.calls || 0, failed: r ? r.calls - r.ok : 0, speed: r ? rate(r.output_tokens, r.eval_ms) : null, avgMs: r?.avg_ms ?? null };
  });
  return {
    hours: h, bucketMs: size, tasks, buckets,
    chat: {
      calls: sum('calls'), failed: sum('calls') - sum('ok'), speed: rate(sum('output_tokens'), sum('eval_ms')),
      promptSpeed: rate(sum('prompt_tokens'), sum('prompt_ms')), p50: percentile(durations, 50), p95: percentile(durations, 95),
    },
    models: db.prepare('SELECT model, count(*) calls, max(at) last FROM llm_calls WHERE at >= ? GROUP BY model ORDER BY calls DESC').all(start),
    recent: db.prepare(`SELECT id, at, task, provider, model, ok, items, prompt_tokens, output_tokens, load_ms, prompt_ms, eval_ms, total_ms, error
      FROM llm_calls ORDER BY id DESC LIMIT 25`).all(),
  };
}
