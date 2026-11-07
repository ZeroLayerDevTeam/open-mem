// `cli backfill`: queue again, from Claude Code's transcripts, the tool calls and turn summaries of a time window that
// went through the lossy no-LLM path while the LLM was down: observations stored raw (upgraded in place once the LLM
// answers), calls the raw path dropped (reads, searches, MCP calls), and turn summaries written without a model or not at
// all. It only queues, with each record's original time: the normal drainer handles them after what is already waiting,
// under the same pause and GPU rules. Nothing is queued twice: calls already in memory with the LLM or in the queue are
// skipped by their tool_use_id.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transaction } from './db.mjs';
import { enqueue } from './queue.mjs';

const OWN_TOOLS = /^mcp__plugin_open-mem_/;
const DAY = 864e5;

// Folders holding Claude Code projects. Each entry may be a config folder (with projects/), a projects folder, or a
// folder of config folders (one per account, as ccm keeps them). Defaults: CLAUDE_CONFIG_DIR and ~/.claude.
export function projectRoots(dirs = [], env = process.env) {
  const given = dirs.length ? dirs : [env.CLAUDE_CONFIG_DIR, path.join(os.homedir(), '.claude')].filter(Boolean);
  const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  const roots = new Set();
  for (const d of given) {
    if (!isDir(d)) continue;
    if (isDir(path.join(d, 'projects'))) { roots.add(path.resolve(d, 'projects')); continue; }
    const accounts = fs.readdirSync(d).map((s) => path.join(d, s, 'projects')).filter(isDir);
    if (accounts.length) for (const a of accounts) roots.add(path.resolve(a));
    else roots.add(path.resolve(d));
  }
  return [...roots];
}

// session id -> { main: transcript file, files: main + its subagents' transcripts }, for the wanted sessions. A session
// resumed from another account has a copy of its transcript in each: only the largest (most complete) copy is kept.
export function findTranscripts(roots, wanted) {
  const found = new Map();
  const size = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
  const add = (sid, file, main) => {
    const hit = found.get(sid) || { main: null, subs: new Map() };
    if (main) {
      if (!hit.main || size(file) > size(hit.main)) hit.main = file;
    } else {
      const prev = hit.subs.get(path.basename(file));
      if (!prev || size(file) > size(prev)) hit.subs.set(path.basename(file), file);
    }
    hit.files = [hit.main, ...hit.subs.values()].filter(Boolean);
    found.set(sid, hit);
  };
  const want = new Set(wanted);
  for (const root of roots) {
    let projects;
    try { projects = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { continue; }
    for (const p of projects) {
      const dir = path.join(root, p.name);
      let names;
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const name of names) {
        if (name.endsWith('.jsonl') && want.has(name.slice(0, -6))) add(name.slice(0, -6), path.join(dir, name), true);
        else if (want.has(name)) {
          const sub = path.join(dir, name, 'subagents');
          try {
            for (const f of fs.readdirSync(sub)) if (f.endsWith('.jsonl')) add(name, path.join(sub, f), false);
          } catch { /* no subagents */ }
        }
      }
    }
  }
  return found;
}

const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n') : '');

// One transcript: its tool calls ({ id, tool, input, output, isError, at }) and the assistant's texts ({ at, text }).
export function readTranscript(file) {
  const uses = new Map();
  const results = new Map();
  const texts = [];
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { calls: [], texts }; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const at = Date.parse(e.timestamp) || null;
    const content = e.message?.content;
    if (e.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) if (c?.type === 'tool_use' && c.id) uses.set(c.id, { tool: c.name, input: c.input ?? {}, at });
      const text = textOf(content);
      if (text.trim() && !e.isSidechain) texts.push({ at, text });
    } else if (e.type === 'user' && Array.isArray(content)) {
      for (const c of content) {
        if (c?.type !== 'tool_result' || !c.tool_use_id) continue;
        results.set(c.tool_use_id, { output: e.toolUseResult ?? textOf(c.content) ?? c.content, isError: Boolean(c.is_error), at });
      }
    }
  }
  const calls = [];
  for (const [id, u] of uses) {
    const r = results.get(id);
    if (!r) continue; // never finished: no PostToolUse either
    calls.push({ id, tool: u.tool, input: u.input, output: r.output, isError: r.isError, at: r.at ?? u.at });
  }
  return { calls, texts };
}

// The queue keeps only what the LLM reads (maxToolChars): a transcript's tool output can be megabytes. Long strings are
// cut inside the structure, so fields such as file_path stay where processObservation looks for them.
export function clipValue(v, max, depth = 0) {
  if (typeof v === 'string') return v.length > max ? `${v.slice(0, max)}\n…[${v.length - max} chars cut]` : v;
  if (v == null || typeof v !== 'object') return v ?? '';
  if (depth > 4) return clipValue(JSON.stringify(v), max);
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => clipValue(x, max, depth + 1));
  return Object.fromEntries(Object.entries(v).slice(0, 50).map(([k, x]) => [k, clipValue(x, max, depth + 1)]));
}

// What a backfill of [from, to] would queue. Pure over the database and the transcripts: `apply` queues it.
export function planBackfill(db, settings, { from, to, roots }) {
  const counts = { sessions: 0, transcripts: 0, missing: 0, calls: 0, inMemory: 0, queued: 0, skippedTools: 0, errors: 0,
    upgrade: 0, add: 0, summariesRedo: 0, summariesAdd: 0, summariesDone: 0 };
  const excluded = new Set((settings.excludedProjects || []).map((p) => p.toLowerCase()));
  const sessions = db.prepare(`SELECT session_id, project FROM sessions WHERE (last_seen_at IS NULL OR last_seen_at >= ?)
      AND (started_at IS NULL OR started_at <= ?)
    UNION SELECT session_id, project FROM prompts WHERE created_at BETWEEN ? AND ? AND session_id IS NOT NULL`).all(from, to, from, to)
    .filter((s) => !excluded.has(String(s.project || '').toLowerCase()));
  const projectOf = new Map(sessions.map((s) => [s.session_id, s.project]));
  counts.sessions = projectOf.size;
  const transcripts = findTranscripts(roots, [...projectOf.keys()]);
  counts.transcripts = [...transcripts.values()].filter((t) => t.main).length;
  counts.missing = counts.sessions - counts.transcripts;

  // Memory and queue as they are, keyed by tool_use_id.
  const stored = new Map(db.prepare(`SELECT id, json_extract(metadata, '$.tool_use_id') t, json_extract(metadata, '$.compressed') c
    FROM observations WHERE source = 'native' AND created_at BETWEEN ? AND ? AND json_extract(metadata, '$.tool_use_id') IS NOT NULL`)
    .all(from - DAY, to + DAY).map((r) => [r.t, r]));
  const queuedCalls = new Set(db.prepare("SELECT json_extract(payload, '$.tool_use_id') t FROM queue WHERE kind = 'observation'").all().map((r) => r.t));
  const queuedTurns = new Set(db.prepare("SELECT session_id || ':' || json_extract(payload, '$.prompt_number') k FROM queue WHERE kind = 'summary'").all().map((r) => r.k));
  const promptsOf = db.prepare('SELECT prompt_number n, created_at at FROM prompts WHERE session_id = ? AND prompt_number IS NOT NULL ORDER BY created_at');
  const summaryOf = db.prepare("SELECT model, created_at FROM summaries WHERE source = 'native' AND source_id = ?");

  const observations = [];
  const summaries = [];
  const seen = new Set();
  for (const [sid, t] of transcripts) {
    const prompts = promptsOf.all(sid);
    const promptAt = (at) => prompts.filter((p) => p.at <= at).pop()?.n ?? null;
    const project = projectOf.get(sid);
    let texts = [];
    for (const file of t.files) {
      const read = readTranscript(file);
      if (file === t.main) ({ texts } = read);
      for (const c of read.calls) {
        if (!c.at || c.at < from || c.at > to || seen.has(c.id)) continue;
        seen.add(c.id); // a call seen in two transcripts counts once
        counts.calls++;
        if (settings.skipTools.includes(c.tool) || OWN_TOOLS.test(c.tool)) { counts.skippedTools++; continue; }
        const hit = stored.get(c.id);
        if (hit && Number(hit.c) !== 0) { counts.inMemory++; continue; }
        if (queuedCalls.has(c.id)) { counts.queued++; continue; }
        if (!hit && c.isError) { counts.errors++; continue; } // failed calls never reached PostToolUse
        if (hit) counts.upgrade++; else counts.add++;
        observations.push({ sid, project, payload: {
          tool: c.tool, input: clipValue(c.input, settings.maxToolChars), output: clipValue(c.output, settings.maxToolChars * 2),
          tool_use_id: c.id, prompt_number: promptAt(c.at), at: c.at, backfill: true, ...(hit ? { upgrade: hit.id } : {}),
        } });
      }
    }
    // Turn summaries: the turns that started in the window, unless one with a model exists or waits in the queue.
    if (!t.main) continue;
    prompts.forEach((p, i) => {
      if (p.at < from || p.at > to) return;
      const existing = summaryOf.get(`${sid}:${p.n}`);
      if (existing?.model || queuedTurns.has(`${sid}:${p.n}`)) { counts.summariesDone++; return; }
      const end = prompts[i + 1]?.at ?? Infinity;
      const last = texts.filter((x) => x.at >= p.at && x.at < end).pop();
      if (existing) counts.summariesRedo++; else counts.summariesAdd++;
      summaries.push({ sid, project, payload: {
        prompt_number: p.n, transcript_path: t.main, at: existing?.created_at ?? last?.at ?? p.at,
        assistant_text: clipValue(last?.text || '', 4000), backfill: true,
      } });
    });
  }
  observations.sort((a, b) => a.payload.at - b.payload.at);
  summaries.sort((a, b) => a.payload.at - b.payload.at);
  return { counts, observations, summaries };
}

// Queues the plan: observations first, then the summaries that read them (the queue runs in id order).
export function applyBackfill(db, plan) {
  transaction(db, () => {
    for (const o of plan.observations) enqueue(db, 'observation', o.sid, o.project, o.payload);
    for (const s of plan.summaries) enqueue(db, 'summary', s.sid, s.project, s.payload);
  });
  return plan.observations.length + plan.summaries.length;
}
