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
import { manualPause, markerPause, planGpu } from './budget.mjs';
import { BRIEF_SYSTEM, completeJson, LESSONS_SYSTEM, NOTES_REVIEW_SYSTEM, ownModels, resolveProvider, OBSERVATION_SYSTEM, SUMMARY_SYSTEM, unloadOllama } from './llm.mjs';
import { withRecorder } from './llmstats.mjs';
import { sessionMeta } from './meta.mjs';
import { redact } from './redact.mjs';
import { ollamaModels, startOllama } from './setup.mjs';
import { clip as clipLine, insertObservation, lessons, lessonsKey, notesReview, pruneRecallLog, reviewKey, promptText, sessionInfo, turnObservations, upsertSummary } from './store.mjs';
import { embedPending } from './semantic.mjs';
import { pushPending, remoteFetch, reportStatus } from './sync.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.mjs');
const STALE_CLAIM_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const PUSH_EVERY_MS = 2 * 60 * 1000;
const NO_LLM = { kind: 'none' };
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// Hooks start a drainer on every tool call: while paused, a pause seen this recently is reused instead of checked again.
const PAUSE_REUSE_MS = 15000;
const GAMES_RECHECK_MS = 30000; // listing processes costs half a second
// A pause shown on the web viewer is current while a drainer confirmed it this recently (serve drains every 10 min).
export const PAUSE_FRESH_MS = 20 * 60000;
// Time between two drains longer than this means the machine was off or idle: it does not count as LLM downtime.
const DOWN_GAP_MS = 15 * 60000;
const SLOW_BACKOFF_MS = 2 * 60000; // after a timeout, the GPU is busy elsewhere: try again later, not on the next hook
const AUTOSTART_EVERY_MS = 10 * 60000;
const AUTOSTART_WAIT_MS = 20000;
const LOG_REPEAT_MS = 10 * 60000;
// Prompt budget: with maxToolChars this keeps a summary prompt plus its reply inside num_ctx.
const SUMMARY_OBS_CHARS = 8000;

export function enqueue(db, kind, sessionId, project, payload) {
  db.prepare('INSERT INTO queue (kind, session_id, project, payload, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(kind, sessionId, project, JSON.stringify(redact(payload)), Date.now());
}

function claim(db) {
  return transaction(db, () => {
    const row = db.prepare(`SELECT * FROM queue WHERE status = 'pending'
        OR (status = 'processing' AND claimed_at < ?) ORDER BY id LIMIT 1`)
      .get(Date.now() - STALE_CLAIM_MS);
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

// `serve` drains inside its own process: a tick that outlasts serveDrainMinutes must not see its own pid as a stale lock.
let lockHeld = false;

function acquireLock() {
  if (lockHeld) return false;
  const file = dataPath('drain.lock');
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      lockHeld = true;
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
  lockHeld = false;
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
      `Observations:\n${clip(obs.map((o) => `- [${o.type}] ${o.title}: ${o.narrative || ''}`).join('\n') || '(none)', SUMMARY_OBS_CHARS)}`,
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

// Projects with new bug fixes since their last lessons run (at most once a day each). A lesson needs two sessions, so
// a project with fixes from only one is skipped: the model would run for nothing.
export function projectsForLessons(db) {
  const since = Date.now() - LESSONS_WINDOW_MS;
  return db.prepare(`SELECT project, count(*) n, max(created_at) last FROM observations WHERE type = 'bugfix' AND created_at >= ?
    AND project IS NOT NULL GROUP BY project COLLATE NOCASE HAVING n >= 4 AND count(DISTINCT session_id) >= 2`).all(since)
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
    const n = await embedPending(db, settings, { max: settings.embedPerDrain, stop: async () => Boolean(await checkBusy({ embed: true })) });
    if (n) log('info', `embedded ${n} record(s)`);
  } catch (err) {
    log('warn', `embedding failed, will retry: ${err.message}`);
  }
}

// --- pause and LLM state (shown at session start and on the web viewer) --------------------------------------------
const pendingCount = (db) => db.prepare("SELECT count(*) n FROM queue WHERE status IN ('pending', 'processing')").get().n;
const readJson = (db, key) => { try { return JSON.parse(getMeta(db, key) || 'null'); } catch { return null; } };

// Hooks drain several times a second: a state is logged when it starts or changes (`topic`), then every LOG_REPEAT_MS.
function logOnce(db, key, topic, text, level = 'info', now = Date.now()) {
  const last = readJson(db, key);
  if (last?.topic === topic && now - last.at < LOG_REPEAT_MS) return;
  setMeta(db, key, JSON.stringify({ topic, at: now }));
  log(level, text);
}

// A pause lasts while its kind does: the detail of a GPU pause (free memory) changes from one drain to the next.
function notePause(db, pause, now = Date.now()) {
  const prev = readJson(db, 'pause');
  const since = prev?.kind === pause.kind ? prev.since : now;
  setMeta(db, 'pause', JSON.stringify({ kind: pause.kind, detail: pause.detail, until: pause.until ?? null, since, at: now }));
  logOnce(db, 'pause_logged', pause.kind, `drain paused (${pause.kind}: ${pause.detail}), ${pendingCount(db)} queue item(s) waiting`);
}

function endPause(db) {
  if (!getMeta(db, 'pause')) return;
  setMeta(db, 'pause', '');
  setMeta(db, 'pause_logged', '');
  log('info', 'drain resumed');
}

// The pause a drainer confirmed recently ({ kind, detail, since, at, until }), or null.
export function currentPause(db, now = Date.now()) {
  const p = readJson(db, 'pause');
  return p && now - p.at < PAUSE_FRESH_MS ? p : null;
}

// Downtime of an LLM that answered before, counting only the time this machine was in use (drains less than
// DOWN_GAP_MS apart): a machine left off for a weekend does not turn a stopped Ollama into a lost one.
function noteDown(db, reason, now = Date.now()) {
  const d = readJson(db, 'llm_down') || { since: now, ms: 0, at: now };
  if (now - d.at < DOWN_GAP_MS) d.ms += now - d.at;
  Object.assign(d, { at: now, reason: String(reason || '').slice(0, 300) });
  setMeta(db, 'llm_down', JSON.stringify(d));
  return d;
}

function endDown(db, { quiet = false } = {}) {
  const d = readJson(db, 'llm_down');
  if (!d) return;
  setMeta(db, 'llm_down', '');
  setMeta(db, 'down_logged', '');
  if (!quiet) log('info', `LLM answering again, after ${Math.round(d.ms / 60000)} min down while in use`);
}

export const llmDown = (db) => readJson(db, 'llm_down');

// What the web viewer and the shared server show about this machine's queue.
export function queueState(db, now = Date.now()) {
  const q = db.prepare("SELECT count(*) n, min(created_at) oldest FROM queue WHERE status IN ('pending', 'processing')").get();
  const down = llmDown(db);
  return {
    pending: q.n, oldest: q.oldest ?? null, failed: db.prepare("SELECT count(*) n FROM queue WHERE status = 'failed'").get().n,
    pause: currentPause(db, now), down: down ? { since: down.since, ms: down.ms, reason: down.reason } : null, at: now,
  };
}

// For the session start: an LLM that stopped answering should not go unnoticed for days.
export function downNotice(db, now = Date.now()) {
  const d = llmDown(db);
  if (!d || now - d.since < 5 * 60000) return null;
  return `claude-open-mem: the local LLM has not answered since ${new Date(d.since).toLocaleString()} (${d.reason}). `
    + `${pendingCount(db)} queue item(s) wait for it: start Ollama to turn them into memory.`;
}

const isLoopback = (url) => { try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname); } catch { return false; } };

// A local Ollama that does not answer is started (at most every AUTOSTART_EVERY_MS), then given a few seconds.
async function autostartOllama(db, settings, start) {
  if (!settings.ollamaAutostart || !['auto', 'ollama'].includes(settings.provider || 'auto')) return false;
  const baseUrl = settings.baseUrl || 'http://127.0.0.1:11434';
  if (!isLoopback(baseUrl) || Date.now() - Number(getMeta(db, 'ollama_start_at') || 0) < AUTOSTART_EVERY_MS) return false;
  setMeta(db, 'ollama_start_at', Date.now());
  const how = await start();
  if (!how) return false;
  log('warn', `Ollama was not answering at ${baseUrl}: started ${how}`);
  for (const end = Date.now() + AUTOSTART_WAIT_MS; Date.now() < end;) {
    await new Promise((r) => { setTimeout(r, 1000); });
    if (await ollamaModels(baseUrl)) return true;
  }
  return false;
}

async function gamesCheck(db, settings, isBusy) {
  if (Date.now() - Number(getMeta(db, 'games_seen_at') || 0) < GAMES_RECHECK_MS) return getMeta(db, 'games_reason') || null;
  const reason = await isBusy(settings);
  setMeta(db, 'games_seen_at', Date.now());
  setMeta(db, 'games_reason', reason || '');
  return reason;
}

// Processes the queue until it is empty or a reason to wait comes up. Returns the number of items handled.
// `force` (asked for from the web viewer): process even while a game runs or the queue is paused by hand. Marker files
// and the GPU budget still apply: ignoring them could take the GPU from the job that holds it.
export async function drain(db, settings, { lock = true, provider: forced, sync = true, busy: isBusy = busyReason, force = false,
  pushEveryMs = PUSH_EVERY_MS, push = pushPending, plan = planGpu, start = startOllama } = {}) {
  if (lock && !acquireLock()) return 0;
  let handled = 0;
  const touched = new Set();
  const shared = settings.mode === 'remote' && settings.serverUrl && sync;
  const pushNow = async () => {
    try { await push(db, settings); } catch (err) { log('warn', `sync failed, will retry: ${err.message}`); }
  };
  try {
    let provider = withRecorder(db, forced || await resolveProvider(settings));
    if (!forced && provider.unreachable && await autostartOllama(db, settings, start)) provider = withRecorder(db, await resolveProvider(settings));
    const local = provider.kind === 'ollama';
    let held = false;
    if (provider.kind !== 'none') {
      setMeta(db, 'llm_seen_at', Date.now());
      endDown(db);
    } else if (provider.unreachable && getMeta(db, 'llm_seen_at')) {
      // An LLM that worked before and does not answer now is down for a while: the queue waits for it. Only after
      // llmWaitHours of downtime in use does it go through the lossy no-LLM path (edits and commands only).
      const down = noteDown(db, provider.reason);
      held = down.ms < settings.llmWaitHours * 3600000;
      if (held) logOnce(db, 'down_logged', 'held', `LLM unreachable, holding ${pendingCount(db)} queue item(s) until it is back: ${provider.reason}`, 'warn');
      else logOnce(db, 'down_logged', 'gone', `LLM unreachable for ${settings.llmWaitHours} h of use, storing the queue without it: ${provider.reason}`, 'warn');
    } else {
      endDown(db, { quiet: true });
      if (provider.reason) logOnce(db, 'nollm_logged', provider.reason, `drain without LLM: ${provider.reason}`);
    }
    const main = provider.model;
    // Before every item, the reasons to wait, cheapest first. Only a local LLM shares this machine's GPU.
    const gate = async ({ embed = false } = {}) => {
      if (!force) {
        const manual = manualPause();
        if (manual) return { pause: manual };
      }
      if (!local) return {};
      const marker = markerPause(settings);
      if (marker) return { pause: marker };
      if (!force) {
        if (Date.now() < Number(getMeta(db, 'llm_slow_until') || 0)) return { pause: { kind: 'slow', detail: getMeta(db, 'llm_slow_reason') || '' } };
        const game = await gamesCheck(db, settings, isBusy);
        if (game) return { pause: { kind: 'game', detail: game } };
      }
      if (!settings.gpuBudget) return {};
      return plan(settings, { baseUrl: provider.baseUrl, model: main, embed, backlog: pendingCount(db) });
    };
    const recent = local && !force ? currentPause(db) : null;
    let pause = recent && recent.kind !== 'manual' && Date.now() - recent.at < PAUSE_REUSE_MS ? recent : null;
    let pushedAt = Date.now();
    while (!held && !pause) {
      const g = await gate();
      if (g.pause) { pause = g.pause; break; }
      if (g.model) provider.model = g.model;
      if (g.unload?.length) {
        try { await unloadOllama(provider.baseUrl, g.unload); } catch { /* Ollama frees them on its own */ }
      }
      const item = claim(db);
      if (!item) break;
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
          // Provider went away or is too slow: the item waits for the next run, its attempts untouched.
          db.prepare("UPDATE queue SET status = 'pending', attempts = attempts - 1, error = ? WHERE id = ?").run(err.message, item.id);
          if (err.name === 'TimeoutError') {
            // The GPU is busy with something else: wait a little instead of retrying on the next tool call.
            setMeta(db, 'llm_slow_until', Date.now() + SLOW_BACKOFF_MS);
            setMeta(db, 'llm_slow_reason', `no answer from ${provider.model} in ${Math.round(settings.llmTimeoutMs / 1000)} s`);
            pause = { kind: 'slow', detail: getMeta(db, 'llm_slow_reason') };
          } else log('warn', `drain paused, provider unreachable: ${err.message}`);
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
    if (pause && pause !== recent) {
      notePause(db, pause);
      // Free the GPU of open-mem's own models, never of another app's: they share this Ollama.
      if (local && pause.kind !== 'slow') {
        try { await unloadOllama(provider.baseUrl, ownModels(settings, main)); } catch { /* Ollama already gone */ }
      }
    } else if (!pause) {
      endPause(db);
      if (!held) await upkeep(db, touched, provider, settings, async (o) => (await gate(o)).pause);
    }
    if (shared) {
      await pushNow();
      // The server's web viewer shows each machine's queue, and the GPU of the one that runs the LLM.
      try {
        await reportStatus(db, (method, route, body) => remoteFetch(settings, method, route, body), { queue: queueState(db), withGpus: local });
      } catch (err) { log('warn', `status report failed: ${err.message}`); }
    }
  } finally {
    if (lock) releaseLock();
  }
  return handled;
}
