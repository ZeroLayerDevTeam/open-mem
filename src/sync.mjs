// Shared mode. Clients keep writing to their local database (an outbox) and push new rows to the
// server; the server stores them with `source = <original source>@<device>` so nothing collides.
import { log } from './config.mjs';
import { getMeta, setMeta, transaction } from './db.mjs';
import { upsertSyncedItem } from './items.mjs';
import { asText, insertObservation, upsertSummary } from './store.mjs';

const BATCH = 400;
const MAX_ROWS = 2000; // per kind, per request (server side)

// --- client ------------------------------------------------------------------
export async function remoteFetch(settings, method, route, body, timeoutMs = settings.remoteTimeoutMs) {
  if (!settings.serverUrl || !settings.deviceKey) throw new Error('remote mode is not configured (cli remote connect)');
  const res = await fetch(new URL(route, settings.serverUrl), {
    method,
    headers: { authorization: `Bearer ${settings.deviceKey}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text.slice(0, 200) }; }
  if (!res.ok) {
    const err = new Error(`server ${res.status}: ${data.error || res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function unsynced(db, table, limit) {
  return db.prepare(`SELECT * FROM ${table} WHERE synced_at IS NULL ORDER BY id LIMIT ?`).all(limit);
}

function collectBatch(db) {
  const observations = unsynced(db, 'observations', BATCH);
  const summaries = unsynced(db, 'summaries', BATCH);
  const prompts = unsynced(db, 'prompts', BATCH);
  const items = unsynced(db, 'items', 100).map((i) => ({
    ...i, events: db.prepare('SELECT at, event, from_status, to_status, detail, device FROM item_events WHERE item_id = ? ORDER BY at, id').all(i.id),
  }));
  const ids = new Set([...observations, ...summaries, ...prompts, ...items].map((r) => r.session_id).filter(Boolean));
  const sessions = [...ids].map((id) => db.prepare(`SELECT session_id, project, cwd, prompt_counter, started_at, source, device,
      git_branch, git_commit, last_seen_at FROM sessions WHERE session_id = ?`).get(id)).filter(Boolean);
  const since = Number(getMeta(db, 'briefs_pushed_at') || 0);
  const briefs = db.prepare('SELECT * FROM briefs WHERE generated_at > ?').all(since);
  return { observations, summaries, prompts, items, sessions, briefs };
}

function markSynced(db, batch, at) {
  transaction(db, () => {
    for (const [table, rows] of [['observations', batch.observations], ['summaries', batch.summaries], ['prompts', batch.prompts]]) {
      const st = db.prepare(`UPDATE ${table} SET synced_at = ? WHERE id = ?`);
      for (const r of rows) st.run(at, r.id);
    }
    // An item edited while the push was in flight stays unsynced.
    const st = db.prepare('UPDATE items SET synced_at = ? WHERE id = ? AND updated_at = ?');
    for (const r of batch.items) st.run(at, r.id, r.updated_at);
    const lastBrief = Math.max(0, ...batch.briefs.map((b) => b.generated_at));
    if (lastBrief) setMeta(db, 'briefs_pushed_at', lastBrief);
  });
}

// Pushes every unsynced row. Returns counts; network errors propagate (rows stay unsynced).
export async function pushPending(db, settings, { onProgress } = {}) {
  const total = { observations: 0, summaries: 0, prompts: 0, items: 0 };
  for (;;) {
    const batch = collectBatch(db);
    const n = batch.observations.length + batch.summaries.length + batch.prompts.length + batch.items.length;
    if (!n && !batch.briefs.length) break;
    await remoteFetch(settings, 'POST', '/api/ingest', batch, 60000);
    markSynced(db, batch, Date.now());
    for (const k of Object.keys(total)) total[k] += batch[k].length;
    onProgress?.(total);
    if (!n) break;
  }
  if (total.observations + total.summaries + total.prompts + total.items) log('info', `sync pushed ${JSON.stringify(total)}`);
  return total;
}

// --- server ------------------------------------------------------------------------
const arr = (v) => (Array.isArray(v) ? v.slice(0, MAX_ROWS) : []);
const tag = (source, device) => `${String(source || 'native').split('@')[0]}@${device}`;

export function ingest(db, device, body) {
  const counts = { observations: 0, summaries: 0, prompts: 0, items: 0, sessions: 0, briefs: 0 };
  transaction(db, () => {
    for (const s of arr(body.sessions)) {
      if (!s?.session_id) continue;
      db.prepare(`INSERT INTO sessions (session_id, project, cwd, prompt_counter, started_at, source, device, git_branch, git_commit, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (session_id) DO UPDATE SET prompt_counter = max(sessions.prompt_counter, excluded.prompt_counter),
          last_seen_at = max(COALESCE(sessions.last_seen_at, 0), COALESCE(excluded.last_seen_at, 0)),
          git_branch = COALESCE(excluded.git_branch, sessions.git_branch), git_commit = COALESCE(excluded.git_commit, sessions.git_commit)`)
        .run(String(s.session_id), asText(s.project), asText(s.cwd), Number(s.prompt_counter) || 0, Number(s.started_at) || null,
          tag(s.source, device), asText(s.device) || device, asText(s.git_branch), asText(s.git_commit), Number(s.last_seen_at) || null);
      counts.sessions++;
    }
    for (const o of arr(body.observations)) {
      if (insertObservation(db, { ...o, device: o.device || device, source: tag(o.source, device), source_id: o.source_id || `obs:${o.id}` })) counts.observations++;
    }
    for (const s of arr(body.summaries)) {
      upsertSummary(db, { ...s, device: s.device || device, source: tag(s.source, device), source_id: s.source_id || `sum:${s.id}` });
      counts.summaries++;
    }
    const prompt = db.prepare(`INSERT OR IGNORE INTO prompts (session_id, project, prompt_number, text, created_at, source, source_id, cwd, device, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const p of arr(body.prompts)) {
      const r = prompt.run(asText(p.session_id), asText(p.project), Number(p.prompt_number) || null, asText(p.text), Number(p.created_at) || null,
        tag(p.source, device), p.source_id || `prompt:${p.id}`, asText(p.cwd), asText(p.device) || device, asText(p.metadata));
      counts.prompts += Number(r.changes);
    }
    for (const b of arr(body.briefs)) {
      if (!b?.project || !b.body) continue;
      db.prepare(`INSERT INTO briefs (project, body, generated_at, record_count, model) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (project) DO UPDATE SET body = excluded.body, generated_at = excluded.generated_at, model = excluded.model
        WHERE excluded.generated_at > briefs.generated_at`)
        .run(String(b.project), asText(b.body), Number(b.generated_at) || Date.now(), Number(b.record_count) || 0, asText(b.model));
      counts.briefs++;
    }
  });
  // Items carry their own transaction (replace + history).
  for (const i of arr(body.items)) {
    if (!i?.title) continue;
    upsertSyncedItem(db, { ...i, device: i.device || device, source: tag(i.source, device), source_id: i.source_id || `item:${i.id}` });
    counts.items++;
  }
  return counts;
}
