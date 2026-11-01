// Hooks only enqueue (fast, no network). A detached drainer turns queue items into memory.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataPath, log } from './config.mjs';
import { getMeta, setMeta, transaction } from './db.mjs';
import { isNetworkError } from './backend.mjs';
import { listItems } from './items.mjs';
import { busyReason } from './busy.mjs';
import { BRIEF_SYSTEM, completeJson, LESSONS_SYSTEM, NOTES_REVIEW_SYSTEM, resolveProvider, OBSERVATION_SYSTEM, SUMMARY_SYSTEM, unloadOllama } from './llm.mjs';
import { withRecorder } from './llmstats.mjs';
import { sessionMeta } from './meta.mjs';
import { redact } from './redact.mjs';
import { clip as clipLine, insertObservation, lessons, lessonsKey, notesReview, pruneRecallLog, reviewKey, promptText, sessionInfo, turnObservations, upsertSummary } from './store.mjs';
import { embedPending } from './semantic.mjs';
import { pushPending, remoteFetch } from './sync.mjs';
import { reportGpu } from './gpu.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.mjs');
const STALE_CLAIM_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const PUSH_EVERY_MS = 2 * 60 * 1000;
const NO_LLM = { kind: 'none' };
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export function enqueue(db, kind, sessionId, project, payload) {
  db.prepare('INSERT INTO queue (kind, session_id, project, payload, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(kind, sessionId, project, JSON.stringify(redact(payload)), Date.now());
}

// `createdBefore`: only items queued before this time (used while waiting for the LLM to come back).
const BUSY_RECHECK_MS = 30000;

function claim(db, createdBefore = Number.MAX_SAFE_INTEGER) {
  return transaction(db, () => {
    const row = db.prepare(`SELECT * FROM queue WHERE (status = 'pending'
        OR (status = 'processing' AND claimed_at < ?)) AND created_at < ? ORDER BY id LIMIT 1`)
      .get(Date.now() - STALE_CLAIM_MS, createdBefore);
    if (!row) return null;
    db.prepare("UPDATE queue SET status = 'processing', claimed_at = ?, attempts = attempts + 1 WHERE id = ?")
      .run(Date.now(), row.id);
    return { ...row, attempts: row.attempts + 1 };
  });
}

// --- single-drainer lock -------------------------------------------------
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

function lockHolder() {
  try {
    const pid = Number(fs.readFileSync(dataPath('drain.lock'), 'utf8'));
    return pid && pid !== process.pid && pidAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

function acquireLock() {
  const file = dataPath('drain.lock');
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (lockHolder()) return false;
      fs.rmSync(file, { force: true }); // stale lock from a dead process
    }
  }
  return false;
}

function releaseLock() {
  try {
    if (Number(fs.readFileSync(dataPath('drain.lock'), 'utf8')) === process.pid) fs.rmSync(dataPath('drain.lock'));
  } catch { /* already gone */ }
}

// Pid of the process draining the queue right now, or null.
export const drainerPid = () => lockHolder();

// Runs a CLI command in a detached background process.
export function spawnCli(...args) {
  const child = spawn(process.execPath, ['--no-warnings', CLI, ...args], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
  child.unref();
}

// Starts a detached drainer unless one runs. Returns whether one was started.
export function spawnDrainer(extraArgs = []) {
  if (lockHolder()) return false;
  spawnCli('drain', ...extraArgs);
  return true;
}

// --- processing ----------------------------------------------------------
const clip = (v, n) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
  return s.length > n ? `${s.slice(0, n)}\n…[${s.length - n} chars cut]` : s;
};

function filesOf(tool, input = {}) {
  const f = input.file_path || input.notebook_path || input.path;
  if (!f) return { read: [], modified: [] };
  return EDIT_TOOLS.has(tool) ? { read: [], modified: [f] } : { read: tool === 'Read' ? [f] : [], modified: [] };
}

function rawObservation(p) {
  // No-LLM fallback: keep only calls that change things.
  if (!EDIT_TOOLS.has(p.tool) && p.tool !== 'Bash') return null;
  const input = p.input || {};
  const what = input.file_path || input.notebook_path || input.command || input.description || '';
  return {
    type: EDIT_TOOLS.has(p.tool) ? 'change' : 'discovery',
    title: `${p.tool}: ${String(what).replace(/\s+/g, ' ').slice(0, 120)}`,
    narrative: clip(p.output, 600),
  };
}

async function processObservation(db, item, provider, settings) {
  const p = JSON.parse(item.payload);
  const files = filesOf(p.tool, p.input);
  let obs;
  if (provider.kind === 'none') {
    obs = rawObservation(p);
  } else {
    const request = promptText(db, item.session_id, p.prompt_number);
    const user = [`Project: ${item.project}`, `User request: ${clip(request, 1500)}`, `Tool: ${p.tool}`,
      `Input:\n${clip(p.input, settings.maxToolChars / 2)}`, `Output:\n${clip(p.output, settings.maxToolChars)}`].join('\n\n');
    const reply = await completeJson(provider, OBSERVATION_SYSTEM, user, settings.llmTimeoutMs);
    obs = reply.skip || !reply.title ? null : reply;
  }
  if (!obs) return;
  insertObservation(db, {
    ...sessionMeta(sessionInfo(db, item.session_id), settings),
    session_id: item.session_id, project: item.project, prompt_number: p.prompt_number, tool: p.tool,
    type: obs.type, title: obs.title, subtitle: obs.subtitle, narrative: obs.narrative,
    facts: obs.facts, concepts: obs.concepts,
    files_read: files.read, files_modified: files.modified, created_at: p.at || item.created_at,
    model: provider.model || null,
    metadata: { tool_use_id: p.tool_use_id || null, compressed: provider.kind !== 'none' },
  });
}

function lastAssistantText(transcriptPath) {
  if (!transcriptPath) return '';
  try {
    const lines = fs.readFileSync(transcriptPath, 'utf8').trimEnd().split('\n');
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 200; i--) {
      const entry = JSON.parse(lines[i]);
      if (entry.type !== 'assistant') continue;
      const content = entry.message?.content;
      const text = Array.isArray(content)
        ? content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
        : typeof content === 'string' ? content : '';
      if (text.trim()) return text;
    }
  } catch { /* transcript optional */ }
  return '';
}

async function processSummary(db, item, provider, settings) {
  const p = JSON.parse(item.payload);
  const request = promptText(db, item.session_id, p.prompt_number);
  const obs = turnObservations(db, item.session_id, p.prompt_number);
  if (!request && !obs.length) return;
  const filesOfTurn = (col) => [...new Set(obs.flatMap((o) => { try { return JSON.parse(o[col] || '[]'); } catch { return []; } }))];
  const changed = filesOfTurn('files_modified');
  let sum;
  if (provider.kind === 'none') {
    if (!obs.length) return;
    sum = { request: clip(request, 500), completed: changed.length ? `Modified: ${changed.join(', ')}` : obs.map((o) => o.title).join('; ') };
  } else {
    const user = [`Project: ${item.project}`, `User request: ${clip(request, 2000)}`,
      `Observations:\n${obs.map((o) => `- [${o.type}] ${o.title}: ${o.narrative || ''}`).join('\n') || '(none)'}`,
      `Assistant final message:\n${clip(lastAssistantText(p.transcript_path), 3000)}`].join('\n\n');
    const reply = await completeJson(provider, SUMMARY_SYSTEM, user, settings.llmTimeoutMs);
    if (reply.skip) return;
    sum = reply;
  }
  const field = (v) => (Array.isArray(v) ? v.join('\n') : v);
  upsertSummary(db, {
    ...sessionMeta(sessionInfo(db, item.session_id), settings),
    files_read: filesOfTurn('files_read'), files_modified: changed, model: provider.model || null,
    metadata: { observations: obs.map((o) => o.id) },
    session_id: item.session_id, project: item.project, prompt_number: p.prompt_number,
    request: field(sum.request) || clip(request, 500), investigated: field(sum.investigated), learned: field(sum.learned),
    completed: field(sum.completed), next_steps: field(sum.next_steps), notes: field(sum.notes),
    created_at: p.at || item.created_at, source_id: `${item.session_id}:${p.prompt_number}`,
  });
}

// --- project briefs ---------------------------------------------------------
function recordsSinceBrief(db, project) {
  const b = db.prepare('SELECT generated_at FROM briefs WHERE project = ?').get(project);
  const since = b?.generated_at ?? 0;
  return db.prepare(`SELECT (SELECT count(*) FROM observations WHERE project = ? COLLATE NOCASE AND created_at > ?)
    + (SELECT count(*) FROM summaries WHERE project = ? COLLATE NOCASE AND created_at > ?) n`).get(project, since, project, since).n;
}

export async function generateBrief(db, project, provider, settings) {
  const prev = db.prepare('SELECT body FROM briefs WHERE project = ?').get(project)?.body || '';
  const sums = db.prepare(`SELECT request, completed, learned, next_steps, created_at FROM summaries WHERE project = ? COLLATE NOCASE
    ORDER BY created_at DESC LIMIT 15`).all(project);
  if (!sums.length) return false;
  const tasks = listItems(db, { kind: 'task', project, open: true, limit: 15 });
  const notes = listItems(db, { kind: 'note', project, limit: 15 });
  const files = new Map();
  for (const r of db.prepare(`SELECT files_modified FROM observations WHERE project = ? COLLATE NOCASE AND files_modified IS NOT NULL
      AND files_modified != '[]' ORDER BY created_at DESC LIMIT 300`).iterate(project)) {
    try { for (const f of JSON.parse(r.files_modified)) files.set(f, (files.get(f) || 0) + 1); } catch { /* skip */ }
  }
  const user = [`Project: ${project}`, `Previous brief:\n${prev || '(none)'}`,
    `Recent sessions (newest first):\n${sums.map((s) => `- ${new Date(s.created_at).toISOString().slice(0, 10)} ${clipLine(s.request, 200)}`
      + `${s.completed ? ` | done: ${clipLine(s.completed, 300)}` : ''}${s.learned ? ` | learned: ${clipLine(s.learned, 300)}` : ''}`).join('\n')}`,
    `Open tasks:\n${tasks.map((t) => `- [${t.status}] ${t.title}`).join('\n') || '(none)'}`,
    `Notes:\n${notes.map((n) => `- ${n.title}: ${clipLine(n.body, 200)}`).join('\n') || '(none)'}`,
    `Most-edited files: ${[...files.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([f]) => f).join(', ') || '(none)'}`].join('\n\n');
  const reply = await completeJson(provider, BRIEF_SYSTEM, user, settings.llmTimeoutMs);
  const body = String(reply.brief || '').trim().slice(0, 2000);
  if (!body) return false;
  db.prepare(`INSERT INTO briefs (project, body, generated_at, record_count, model) VALUES (?, ?, ?, 0, ?)
    ON CONFLICT (project) DO UPDATE SET body = excluded.body, generated_at = excluded.generated_at, model = excluded.model`)
    .run(project, redact(body), Date.now(), provider.model || null);
  return true;
}

async function refreshBriefs(db, projects, provider, settings) {
  if (provider.kind === 'none' || !settings.briefEvery) return;
  for (const project of projects) {
    if (!project || recordsSinceBrief(db, project) < settings.briefEvery) continue;
    try {
      if (await generateBrief(db, project, provider, settings)) log('info', `brief refreshed for ${project}`);
    } catch (err) {
      log('warn', `brief for ${project} failed: ${err.message}`);
      if (isNetworkError(err)) return;
    }
  }
}

// --- notes review -------------------------------------------------------------------------------------

// Projects with at least two active notes, one of them changed since the last review.
function projectsToReview(db, settings) {
  const minGap = settings.notesReviewHours * 3600000;
  return db.prepare(`SELECT project, max(updated_at) last FROM items WHERE kind = 'note' AND status = 'active' AND project IS NOT NULL
    GROUP BY project COLLATE NOCASE HAVING count(*) >= 2`).all()
    .filter((p) => { const r = notesReview(db, p.project); return !r || (p.last > r.at && Date.now() - r.at >= minGap); })
    .map((p) => p.project);
}

export async function reviewNotes(db, project, provider, settings) {
  const notes = listItems(db, { kind: 'note', project, status: 'active', limit: 60 }).sort((a, b) => b.updated_at - a.updated_at);
  const brief = db.prepare('SELECT body FROM briefs WHERE project = ?').get(project)?.body || '(none)';
  const user = [`Project: ${project}`, `Brief:\n${brief}`,
    `Notes:\n${notes.map((n) => `- I${n.id} (${new Date(n.updated_at).toISOString().slice(0, 10)}) ${n.title}: ${clipLine(n.body, 400)}`).join('\n')}`].join('\n\n');
  const reply = await completeJson(provider, NOTES_REVIEW_SYSTEM, user, settings.llmTimeoutMs);
  const known = new Set(notes.map((n) => `I${n.id}`));
  const flags = (Array.isArray(reply.flags) ? reply.flags : [])
    .map((f) => ({ ids: (Array.isArray(f.ids) ? f.ids : []).map((x) => `I${String(x).replace(/^I/i, '')}`).filter((x) => known.has(x)),
      kind: ['contradiction', 'outdated', 'duplicate'].includes(f.kind) ? f.kind : 'outdated', reason: clipLine(f.reason, 240) }))
    .filter((f) => f.ids.length && f.reason).slice(0, 8);
  setMeta(db, reviewKey(project), JSON.stringify({ at: Date.now(), flags }));
  return flags;
}

// --- repeated mistakes ---------------------------------------------------------------------------------
const LESSONS_WINDOW_MS = 90 * 86400000;

// Projects with new bug fixes since their last lessons run (at most once a day each).
function projectsForLessons(db) {
  const since = Date.now() - LESSONS_WINDOW_MS;
  return db.prepare(`SELECT project, count(*) n, max(created_at) last FROM observations WHERE type = 'bugfix' AND created_at >= ?
    AND project IS NOT NULL GROUP BY project COLLATE NOCASE HAVING n >= 4`).all(since)
    .filter((p) => { const l = lessons(db, p.project); return !l || (p.last > l.at && Date.now() - l.at >= 86400000); })
    .map((p) => p.project);
}

export async function findLessons(db, project, provider, settings) {
  const rows = db.prepare(`SELECT id, session_id, title, subtitle, created_at FROM observations WHERE type = 'bugfix'
    AND project = ? COLLATE NOCASE AND created_at >= ? ORDER BY created_at DESC LIMIT 80`).all(project, Date.now() - LESSONS_WINDOW_MS);
  const sessions = new Map();
  const user = [`Project: ${project}`, `Bug fixes:\n${rows.map((r) => {
    if (!sessions.has(r.session_id)) sessions.set(r.session_id, sessions.size + 1);
    return `- ${r.id} (${new Date(r.created_at).toISOString().slice(0, 10)}, session ${sessions.get(r.session_id)}) ${clipLine(r.title, 140)}: ${clipLine(r.subtitle, 200)}`;
  }).join('\n')}`].join('\n\n');
  const reply = await completeJson(provider, LESSONS_SYSTEM, user, settings.llmTimeoutMs);
  const bySession = new Map(rows.map((r) => [String(r.id), r.session_id]));
  const found = (Array.isArray(reply.lessons) ? reply.lessons : [])
    .map((l) => ({ ids: [...new Set((Array.isArray(l.ids) ? l.ids : []).map((x) => String(x).trim()).filter((x) => bySession.has(x)))],
      rule: redact(clipLine(l.rule, 240)) }))
    // A lesson needs the same mistake in two different sessions, whatever the model claims.
    .filter((l) => l.rule && new Set(l.ids.map((x) => bySession.get(x))).size >= 2).slice(0, 8);
  setMeta(db, lessonsKey(project), JSON.stringify({ at: Date.now(), lessons: found }));
  return found;
}

// Briefs, notes review and embeddings: the LLM work that does not come from the queue. Stops when a game starts.
async function upkeep(db, touched, provider, settings, checkBusy) {
  pruneRecallLog(db);
  await refreshBriefs(db, touched, provider, settings);
  // A client of a shared server reads notes and searches there: the server reviews and embeds, not each client.
  if (settings.mode === 'remote') return;
  if (provider.kind !== 'none' && settings.notesReview) {
    for (const project of projectsToReview(db, settings)) {
      if (await checkBusy()) return;
      try {
        const flags = await reviewNotes(db, project, provider, settings);
        log('info', `notes of ${project} reviewed: ${flags.length} flag(s)`);
      } catch (err) {
        log('warn', `notes review for ${project} failed: ${err.message}`);
        if (isNetworkError(err)) break;
      }
    }
  }
  if (provider.kind !== 'none' && settings.lessonsReview) {
    for (const project of projectsForLessons(db)) {
      if (await checkBusy()) return;
      try {
        log('info', `lessons of ${project}: ${(await findLessons(db, project, provider, settings)).length}`);
      } catch (err) {
        log('warn', `lessons for ${project} failed: ${err.message}`);
        if (isNetworkError(err)) break;
      }
    }
  }
  try {
    const n = await embedPending(db, settings, { max: settings.embedPerDrain, stop: async () => Boolean(await checkBusy()) });
    if (n) log('info', `embedded ${n} record(s)`);
  } catch (err) {
    log('warn', `embedding failed, will retry: ${err.message}`);
  }
}

// Processes the queue until empty. Returns number of items handled.
// `force`: process even while a game runs (asked for from the web viewer).
export async function drain(db, settings, { lock = true, provider: forced, sync = true, busy: isBusy = busyReason, force = false, pushEveryMs = PUSH_EVERY_MS, push = pushPending } = {}) {
  if (lock && !acquireLock()) return 0;
  let handled = 0;
  const touched = new Set();
  const shared = settings.mode === 'remote' && settings.serverUrl && sync;
  const pushNow = async () => {
    try { await push(db, settings); } catch (err) { log('warn', `sync failed, will retry: ${err.message}`); }
  };
  try {
    const provider = withRecorder(db, forced || await resolveProvider(settings));
    if (provider.kind !== 'none') setMeta(db, 'llm_seen_at', Date.now());
    // An LLM that worked before and is unreachable now is treated as temporarily down: items wait for
    // it (up to llmWaitHours) instead of going through the lossy no-LLM path.
    const waiting = provider.kind === 'none' && provider.unreachable && Boolean(getMeta(db, 'llm_seen_at'));
    const cutoff = waiting ? Date.now() - settings.llmWaitHours * 3600000 : undefined;
    if (waiting) {
      const n = db.prepare("SELECT count(*) n FROM queue WHERE status IN ('pending', 'processing')").get().n;
      if (n) log('warn', `LLM unreachable, holding ${n} queue item(s) until it is back: ${provider.reason}`);
    } else if (provider.kind === 'none' && provider.reason) log('info', `drain without LLM: ${provider.reason}`);
    // A local LLM competes with games for the GPU: while one runs, nothing is sent to it.
    // Hooks start a drainer on every tool call: a recent "busy" answer is reused instead of listing processes again.
    const checkBusy = provider.kind !== 'ollama' || force ? async () => null : async () => {
      const seen = Number(getMeta(db, 'busy_seen_at') || 0);
      if (Date.now() - seen < BUSY_RECHECK_MS) return getMeta(db, 'busy_reason');
      const reason = await isBusy(settings);
      setMeta(db, 'busy_seen_at', reason ? Date.now() : 0);
      if (reason) setMeta(db, 'busy_reason', reason);
      return reason;
    };
    let busy = await checkBusy();
    let busyCheckedAt = Date.now();
    let pushedAt = Date.now();
    for (let item = busy ? null : claim(db, cutoff); item; item = claim(db, cutoff)) {
      if (Date.now() - busyCheckedAt > BUSY_RECHECK_MS) {
        busyCheckedAt = Date.now();
        if ((busy = await checkBusy())) {
          db.prepare("UPDATE queue SET status = 'pending', attempts = attempts - 1 WHERE id = ?").run(item.id);
          break;
        }
      }
      // Sessions can fill the queue as fast as it drains: new records must not wait for it to empty.
      if (shared && Date.now() - pushedAt >= pushEveryMs) {
        await pushNow();
        pushedAt = Date.now();
      }
      touched.add(item.project);
      const run = (p) => (item.kind === 'observation' ? processObservation(db, item, p, settings)
        : item.kind === 'summary' ? processSummary(db, item, p, settings) : null);
      try {
        await run(provider);
        db.prepare('DELETE FROM queue WHERE id = ?').run(item.id);
        handled++;
      } catch (err) {
        if (isNetworkError(err)) {
          // Provider went away: leave the item for the next run.
          db.prepare("UPDATE queue SET status = 'pending', attempts = attempts - 1, error = ? WHERE id = ?").run(err.message, item.id);
          log('warn', `drain paused, provider unreachable: ${err.message}`);
          break;
        }
        log('warn', `queue item ${item.id} (${item.kind}) attempt ${item.attempts}: ${err.message}`);
        if (item.attempts < MAX_ATTEMPTS) {
          db.prepare("UPDATE queue SET status = 'pending', error = ? WHERE id = ?").run(String(err.message).slice(0, 500), item.id);
          continue;
        }
        // The LLM keeps failing on this item (bad JSON, too long…): store it without the LLM rather than lose it.
        try {
          await run(NO_LLM);
          db.prepare('DELETE FROM queue WHERE id = ?').run(item.id);
          handled++;
        } catch (err2) {
          db.prepare("UPDATE queue SET status = 'failed', error = ? WHERE id = ?").run(String(err2.message).slice(0, 500), item.id);
        }
      }
    }
    if (busy) {
      const n = db.prepare("SELECT count(*) n FROM queue WHERE status IN ('pending', 'processing')").get().n;
      log('info', `drain paused while ${busy} runs (${n} queue item(s) waiting)`);
      try { await unloadOllama(provider.baseUrl); } catch { /* Ollama already gone */ }
    } else await upkeep(db, touched, provider, settings, checkBusy);
    if (shared) {
      await pushNow();
      // This machine runs the LLM: its GPU is the one the server's LLM page should show.
      if (provider.kind === 'ollama') {
        try { await reportGpu(db, (method, route, body) => remoteFetch(settings, method, route, body)); } catch (err) { log('warn', `GPU report failed: ${err.message}`); }
      }
    }
  } finally {
    if (lock) releaseLock();
  }
  return handled;
}
