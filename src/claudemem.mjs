// Interop with an existing claude-mem install: incremental import and optional uninstall.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getMeta, setMeta, transaction } from './db.mjs';
import { insertObservation, insertSummary } from './store.mjs';

const BATCH = 1000;

export function claudeMemDataDir() {
  if (process.env.CLAUDE_MEM_DATA_DIR) return process.env.CLAUDE_MEM_DATA_DIR;
  const home = path.join(os.homedir(), '.claude-mem');
  try {
    const s = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8').replace(/^﻿/, ''));
    if (s.CLAUDE_MEM_DATA_DIR) return s.CLAUDE_MEM_DATA_DIR;
  } catch { /* defaults */ }
  return home;
}

export function claudeMemDbPath() {
  const file = path.join(claudeMemDataDir(), 'claude-mem.db');
  return fs.existsSync(file) ? file : null;
}

function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function installedPluginIds() {
  try {
    const f = path.join(claudeConfigDir(), 'plugins', 'installed_plugins.json');
    return Object.keys(JSON.parse(fs.readFileSync(f, 'utf8')).plugins || {}).filter((k) => k.startsWith('claude-mem@'));
  } catch {
    return [];
  }
}

function columns(src, table) {
  try {
    return new Set(src.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  } catch {
    return new Set();
  }
}

// SELECT list that tolerates schema drift between claude-mem versions.
function pick(cols, wanted) {
  return wanted.map(([expr, alias, needs]) => ((needs || [expr]).every((c) => cols.has(c)) ? `${expr} AS ${alias}` : `NULL AS ${alias}`)).join(', ');
}

function importTable(db, src, { name, table, select, map, insert, metaKey }) {
  const cols = columns(src, table);
  if (!cols.has('id')) return 0;
  let last = Number(getMeta(db, metaKey) || 0);
  let added = 0;
  const stmt = src.prepare(`SELECT ${select(cols)} FROM ${table} t WHERE t.id > ? ORDER BY t.id LIMIT ${BATCH}`);
  for (;;) {
    const rows = stmt.all(last);
    if (!rows.length) break;
    transaction(db, () => {
      for (const r of rows) if (insert(db, map(r)) != null) added++;
      last = Number(rows[rows.length - 1].id);
      setMeta(db, metaKey, last);
    });
  }
  return { name, added };
}

// Copies claude-mem rows newer than the last import. Source opened read-only.
export function importClaudeMem(db, file = claudeMemDbPath()) {
  if (!file) return { ok: false, reason: 'claude-mem database not found' };
  const src = new DatabaseSync(file, { readOnly: true });
  try {
    src.exec('PRAGMA busy_timeout = 10000');
    const sess = columns(src, 'sdk_sessions');
    const sessionMap = new Map();
    if (sess.has('memory_session_id')) {
      for (const s of src.prepare('SELECT memory_session_id m, content_session_id c FROM sdk_sessions WHERE memory_session_id IS NOT NULL').all()) {
        sessionMap.set(s.m, s.c);
      }
    }
    const sessionOf = (m) => (m ? sessionMap.get(m) || m : null);
    const project = (c) => (c.has('merged_into_project') ? 'COALESCE(t.merged_into_project, t.project)' : 't.project');
    const epoch = (c) => (c.has('created_at_epoch') ? 't.created_at_epoch' : "CAST(strftime('%s', t.created_at) AS INTEGER) * 1000");

    const results = [
      importTable(db, src, {
        name: 'observations', table: 'observations', metaKey: 'claude_mem_last_observation',
        select: (c) => `t.id AS id, ${project(c)} AS project, ${epoch(c)} AS created_at, ${pick(c, [
          ['t.memory_session_id', 'session_id', ['memory_session_id']], ['t.type', 'type', ['type']],
          ['t.title', 'title', ['title']], ['t.subtitle', 'subtitle', ['subtitle']],
          ['COALESCE(t.narrative, t.text)', 'narrative', ['narrative', 'text']], ['t.facts', 'facts', ['facts']],
          ['t.concepts', 'concepts', ['concepts']], ['t.files_read', 'files_read', ['files_read']],
          ['t.files_modified', 'files_modified', ['files_modified']], ['t.prompt_number', 'prompt_number', ['prompt_number']]])}`,
        map: (r) => ({ ...r, session_id: sessionOf(r.session_id), source: 'claude-mem', source_id: String(r.id) }),
        insert: insertObservation,
      }),
      importTable(db, src, {
        name: 'summaries', table: 'session_summaries', metaKey: 'claude_mem_last_summary',
        select: (c) => `t.id AS id, ${project(c)} AS project, ${epoch(c)} AS created_at, ${pick(c,
          ['memory_session_id', 'request', 'investigated', 'learned', 'completed', 'next_steps', 'notes', 'prompt_number']
            .map((k) => [`t.${k}`, k === 'memory_session_id' ? 'session_id' : k, [k]]))}`,
        map: (r) => ({ ...r, session_id: sessionOf(r.session_id), source: 'claude-mem', source_id: String(r.id) }),
        insert: insertSummary,
      }),
      importTable(db, src, {
        name: 'prompts', table: 'user_prompts', metaKey: 'claude_mem_last_prompt',
        select: (c) => {
          const proj = sess.has('project') && c.has('session_db_id')
            ? '(SELECT s.project FROM sdk_sessions s WHERE s.id = t.session_db_id)' : 'NULL';
          return `t.id AS id, ${proj} AS project, ${epoch(c)} AS created_at, ${pick(c, [
            ['t.content_session_id', 'session_id', ['content_session_id']], ['t.prompt_number', 'prompt_number', ['prompt_number']],
            ['t.prompt_text', 'text', ['prompt_text']]])}`;
        },
        map: (r) => r,
        insert: (d, r) => Number(d.prepare(`INSERT OR IGNORE INTO prompts (session_id, project, prompt_number, text, created_at, source, source_id)
          VALUES (?, ?, ?, ?, ?, 'claude-mem', ?)`).run(r.session_id, r.project, r.prompt_number, r.text, r.created_at, String(r.id)).changes) || null,
      }),
    ].filter(Boolean);
    setMeta(db, 'claude_mem_last_import_at', new Date().toISOString());
    return { ok: true, file, results };
  } finally {
    src.close();
  }
}

// --- uninstall -----------------------------------------------------------
function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true, cwd });
  return { ok: res.status === 0, out: `${res.stdout || ''}${res.stderr || ''}`.trim() };
}

// Every claude-mem install across scopes, from `claude plugin list --json`.
function claudeMemInstalls() {
  const r = run('claude', ['plugin', 'list', '--json']);
  if (r.ok) {
    try {
      const parsed = JSON.parse(r.out);
      const list = Array.isArray(parsed) ? parsed : parsed.plugins || [];
      return list.filter((p) => String(p.id).startsWith('claude-mem@'))
        .map((p) => ({ id: p.id, scope: p.scope || 'user', cwd: p.projectPath || undefined }));
    } catch { /* fall back below */ }
  }
  return installedPluginIds().map((id) => ({ id, scope: 'user' }));
}

function stopWorker(dir) {
  try {
    const { pid } = JSON.parse(fs.readFileSync(path.join(dir, 'worker.pid'), 'utf8'));
    if (!pid) return 'no worker pid';
    if (process.platform === 'win32') run('taskkill', ['/PID', String(pid), '/T', '/F']);
    else process.kill(pid, 'SIGTERM');
    return `stopped worker pid ${pid}`;
  } catch (err) {
    return `worker not running (${err.code || err.message})`;
  }
}

export function leftoverLaunchers() {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const res = run(cmd, process.platform === 'win32' ? ['claude-mem'] : ['-a', 'claude-mem']);
  return res.ok ? res.out.split(/\r?\n/).filter(Boolean) : [];
}

// Steps: final import -> claude plugin uninstall -> stop worker -> optionally move data aside.
// Data is never deleted: --move-data renames the folder so it can be restored.
export function uninstallClaudeMem(db, { moveData = false, dryRun = false } = {}) {
  const steps = [];
  const dir = claudeMemDataDir();
  const imp = importClaudeMem(db);
  steps.push(imp.ok ? `final import: ${imp.results.map((r) => `${r.name}+${r.added}`).join(', ')}` : `import skipped: ${imp.reason}`);
  const installs = claudeMemInstalls();
  if (!installs.length) steps.push('claude-mem plugin not installed');
  for (const { id, scope, cwd } of installs) {
    // --keep-data preserves the plugin's data folder so a reinstall picks up where it left off.
    const args = ['plugin', 'uninstall', id, '--scope', scope, '--keep-data'];
    const where = cwd ? ` (in ${cwd})` : '';
    if (dryRun) { steps.push(`would run: claude ${args.join(' ')}${where}`); continue; }
    const r = run('claude', args, cwd);
    steps.push(r.ok ? `uninstalled ${id} [${scope}]${where}` : `FAILED to uninstall ${id} [${scope}]${where}: ${r.out}`);
  }
  steps.push(dryRun ? 'would stop the claude-mem worker' : stopWorker(dir));
  if (moveData && fs.existsSync(dir)) {
    const target = `${dir}.removed-${new Date().toISOString().slice(0, 10)}`;
    if (dryRun) steps.push(`would move ${dir} -> ${target}`);
    else {
      try {
        fs.renameSync(dir, target);
        steps.push(`moved ${dir} -> ${target} (delete it yourself once you are happy)`);
      } catch (err) {
        steps.push(`could not move ${dir}: ${err.message} (close processes using it and retry)`);
      }
    }
  }
  const launchers = leftoverLaunchers();
  if (launchers.length) {
    steps.push(`claude-mem launcher still on PATH (installed outside the plugin): ${launchers.join(', ')}`
      + ' — remove with `npm uninstall -g claude-mem` if npm installed it.');
  }
  return steps;
}
