// Hooks only enqueue (fast, no network). A detached drainer turns queue items into memory.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataPath, log } from './config.mjs';
import { transaction } from './db.mjs';
import { completeJson, resolveProvider, OBSERVATION_SYSTEM, SUMMARY_SYSTEM } from './llm.mjs';
import { redact } from './redact.mjs';
import { insertObservation, promptText, turnObservations, upsertSummary } from './store.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.mjs');
const STALE_CLAIM_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export function enqueue(db, kind, sessionId, project, payload) {
  db.prepare('INSERT INTO queue (kind, session_id, project, payload, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(kind, sessionId, project, JSON.stringify(redact(payload)), Date.now());
}

function claim(db) {
  return transaction(db, () => {
    const row = db.prepare(`SELECT * FROM queue WHERE status = 'pending'
        OR (status = 'processing' AND claimed_at < ?) ORDER BY id LIMIT 1`).get(Date.now() - STALE_CLAIM_MS);
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

export function spawnDrainer() {
  if (lockHolder()) return;
  const child = spawn(process.execPath, ['--no-warnings', CLI, 'drain'], {
    detached: true, stdio: 'ignore', windowsHide: true, env: process.env,
  });
  child.unref();
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
    session_id: item.session_id, project: item.project, prompt_number: p.prompt_number, tool: p.tool,
    type: obs.type, title: obs.title, subtitle: obs.subtitle, narrative: obs.narrative,
    facts: obs.facts, concepts: obs.concepts,
    files_read: files.read, files_modified: files.modified, created_at: p.at || item.created_at,
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
  let sum;
  if (provider.kind === 'none') {
    const changed = [...new Set(obs.flatMap((o) => { try { return JSON.parse(o.files_modified || '[]'); } catch { return []; } }))];
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
    session_id: item.session_id, project: item.project, prompt_number: p.prompt_number,
    request: field(sum.request) || clip(request, 500), investigated: field(sum.investigated), learned: field(sum.learned),
    completed: field(sum.completed), next_steps: field(sum.next_steps), notes: field(sum.notes),
    created_at: p.at || item.created_at, source_id: `${item.session_id}:${p.prompt_number}`,
  });
}

const isNetworkError = (err) => err.name === 'TimeoutError' || err.name === 'AbortError'
  || /fetch failed|ECONNREFUSED|ENOTFOUND/i.test(`${err.message} ${err.cause?.code || ''}`);

// Processes the queue until empty. Returns number of items handled.
export async function drain(db, settings, { lock = true, provider: forced } = {}) {
  if (lock && !acquireLock()) return 0;
  let handled = 0;
  try {
    const provider = forced || await resolveProvider(settings);
    if (provider.kind === 'none' && provider.reason) log('info', `drain without LLM: ${provider.reason}`);
    for (let item = claim(db); item; item = claim(db)) {
      try {
        if (item.kind === 'observation') await processObservation(db, item, provider, settings);
        else if (item.kind === 'summary') await processSummary(db, item, provider, settings);
        db.prepare('DELETE FROM queue WHERE id = ?').run(item.id);
        handled++;
      } catch (err) {
        if (isNetworkError(err)) {
          // Provider went away: leave the item for the next run.
          db.prepare("UPDATE queue SET status = 'pending', attempts = attempts - 1, error = ? WHERE id = ?").run(err.message, item.id);
          log('warn', `drain paused, provider unreachable: ${err.message}`);
          break;
        }
        const status = item.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
        db.prepare('UPDATE queue SET status = ?, error = ? WHERE id = ?').run(status, String(err.message).slice(0, 500), item.id);
        log('warn', `queue item ${item.id} (${item.kind}) attempt ${item.attempts}: ${err.message}`);
      }
    }
  } finally {
    if (lock) releaseLock();
  }
  return handled;
}
