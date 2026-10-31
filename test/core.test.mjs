import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'open-mem-test-'));
process.env.CLAUDE_OPEN_MEM_DATA_DIR = path.join(TMP, 'data');

const { saveSettings, DEFAULT_SETTINGS } = await import('../src/config.mjs');
const { openDb } = await import('../src/db.mjs');
const { importClaudeMem } = await import('../src/claudemem.mjs');
const store = await import('../src/store.mjs');
const { enqueue, drain } = await import('../src/queue.mjs');
const { parseJsonReply, pickOllamaModel } = await import('../src/llm.mjs');

saveSettings({ ...DEFAULT_SETTINGS, provider: 'none', autoImportClaudeMem: false });

function fakeClaudeMem(file) {
  const src = new DatabaseSync(file);
  src.exec(`
    CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY, content_session_id TEXT, memory_session_id TEXT, project TEXT);
    CREATE TABLE observations (id INTEGER PRIMARY KEY, memory_session_id TEXT, project TEXT, text TEXT, type TEXT, title TEXT,
      subtitle TEXT, facts TEXT, narrative TEXT, concepts TEXT, files_read TEXT, files_modified TEXT, prompt_number INTEGER,
      created_at TEXT, created_at_epoch INTEGER, merged_into_project TEXT);
    CREATE TABLE session_summaries (id INTEGER PRIMARY KEY, memory_session_id TEXT, project TEXT, request TEXT, investigated TEXT,
      learned TEXT, completed TEXT, next_steps TEXT, notes TEXT, prompt_number INTEGER, created_at TEXT, created_at_epoch INTEGER);
    CREATE TABLE user_prompts (id INTEGER PRIMARY KEY, session_db_id INTEGER, content_session_id TEXT, prompt_number INTEGER,
      prompt_text TEXT, created_at TEXT, created_at_epoch INTEGER);
    INSERT INTO sdk_sessions VALUES (1, 'content-1', 'mem-1', 'alpha');
    INSERT INTO observations VALUES (1, 'mem-1', 'alpha', NULL, 'discovery', 'Configuración del proxy nginx', 'sub',
      '["puerto 81"]', 'El panel está en el puerto 81', '["nginx"]', '[]', '[]', 1, '', 1700000000000, NULL);
    INSERT INTO observations VALUES (2, 'mem-1', 'old-name', 'legacy text', 'bugfix', 'Fix BOM in json', NULL,
      NULL, NULL, NULL, NULL, NULL, 1, '', 1700000001000, 'alpha');
    INSERT INTO session_summaries VALUES (1, 'mem-1', 'alpha', 'Arreglar proxy', 'logs', 'certs', 'copiados', 'nada', NULL, 1, '', 1700000002000);
    INSERT INTO user_prompts VALUES (1, 1, 'content-1', 1, 'arregla el proxy', '', 1700000000000);
  `);
  return src;
}

test('imports claude-mem incrementally and read-only', () => {
  const file = path.join(TMP, 'claude-mem.db');
  const src = fakeClaudeMem(file);
  const db = openDb();
  const first = importClaudeMem(db, file);
  assert.equal(first.ok, true);
  assert.deepEqual(first.results.map((r) => r.added), [2, 1, 1]);
  const second = importClaudeMem(db, file);
  assert.deepEqual(second.results.map((r) => r.added), [0, 0, 0]);
  src.exec("INSERT INTO observations (id, memory_session_id, project, type, title, created_at_epoch) VALUES (3, 'mem-1', 'beta', 'feature', 'Nueva cosa', 1700000003000)");
  assert.deepEqual(importClaudeMem(db, file).results.map((r) => r.added), [1, 0, 0]);
  const merged = db.prepare("SELECT project, narrative, session_id FROM observations WHERE source_id = '2'").get();
  assert.equal(merged.project, 'alpha'); // merged_into_project wins
  assert.equal(merged.narrative, 'legacy text'); // falls back to text
  assert.equal(merged.session_id, 'content-1'); // memory id mapped to content session id
  src.close();
  db.close();
});

test('search: diacritics, project filter, OR fallback, summaries', () => {
  const db = openDb();
  const hit = store.search(db, { query: 'configuracion proxy' });
  assert.equal(hit[0].title, 'Configuración del proxy nginx');
  assert.equal(store.search(db, { query: 'proxy', project: 'ALPHA', kind: 'observations' }).length, 1);
  assert.equal(store.search(db, { query: 'proxy', project: 'beta' }).length, 0);
  assert.ok(store.search(db, { query: 'nginx inexistentezzz' }).length >= 1, 'OR fallback');
  assert.ok(store.search(db, { query: 'certs' }).some((r) => r.kind === 'sum'));
  const full = store.formatFull(store.getByRefs(db, ['S1', 1]));
  assert.match(full, /Learned: certs/);
  assert.match(full, /- puerto 81/);
  const tl = store.timeline(db, '2', 5, 5);
  assert.ok(tl.some((r) => r.anchor));
  assert.ok(tl.length >= 3);
  db.close();
});

test('queue drain without LLM keeps edits, skips reads, writes a turn summary', async () => {
  const db = openDb();
  const n = store.addPrompt(db, { sessionId: 's1', project: 'gamma', cwd: '/x/gamma', text: 'cambia el puerto' });
  enqueue(db, 'observation', 's1', 'gamma', { tool: 'Read', input: { file_path: '/x/a.txt' }, output: 'hola', prompt_number: n });
  enqueue(db, 'observation', 's1', 'gamma', { tool: 'Edit', input: { file_path: '/x/app.conf' }, output: 'ok', prompt_number: n });
  enqueue(db, 'summary', 's1', 'gamma', { prompt_number: n });
  const handled = await drain(db, { ...DEFAULT_SETTINGS, provider: 'none' }, { lock: false, provider: { kind: 'none' } });
  assert.equal(handled, 3);
  const obs = db.prepare("SELECT * FROM observations WHERE project = 'gamma'").all();
  assert.equal(obs.length, 1);
  assert.equal(obs[0].files_modified, JSON.stringify(['/x/app.conf']));
  const sum = db.prepare("SELECT * FROM summaries WHERE project = 'gamma'").get();
  assert.match(sum.completed, /app\.conf/);
  assert.match(store.contextFor(db, 'gamma', DEFAULT_SETTINGS), /Edit: \/x\/app\.conf/);
  db.close();
});

test('llm helpers', () => {
  assert.deepEqual(parseJsonReply('<think>hmm {x}</think>```json\n{"skip": true}\n```'), { skip: true });
  assert.equal(pickOllamaModel(['nomic-embed-text', 'qwen3:14b', 'gemma3:12b'], ''), 'gemma3:12b');
  assert.equal(pickOllamaModel(['gemma3:12b', 'qwen3:14b'], 'qwen3:14b'), 'qwen3:14b');
  assert.equal(pickOllamaModel(['nomic-embed-text'], ''), null);
});

function rpc(lines) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'src', 'mcp-server.mjs')], { env: process.env, cwd: TMP });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', () => resolve(out.trim().split('\n').map((l) => JSON.parse(l))));
    for (const l of lines) child.stdin.write(`${JSON.stringify(l)}\n`);
    child.stdin.end();
  });
}

test('mcp server speaks JSON-RPC', async () => {
  const res = await rpc([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search', arguments: { query: 'nginx' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'save_memory', arguments: { text: 'Usar pnpm siempre' } } },
    { jsonrpc: '2.0', id: 5, method: 'nope' },
  ]);
  assert.equal(res.length, 5);
  assert.equal(res[0].result.serverInfo.name, 'claude-open-mem');
  assert.deepEqual(res[1].result.tools.map((t) => t.name), ['search', 'timeline', 'get_observations', 'save_memory']);
  assert.match(res[2].result.content[0].text, /nginx/);
  assert.match(res[3].result.content[0].text, /Saved as \d+/);
  assert.equal(res[4].error.code, -32601);
});

test('hooks record prompt and tool calls, session start injects context', () => {
  const hook = (event, input) => spawnSync(process.execPath, ['--no-warnings', path.join(ROOT, 'src', 'hook.mjs'), event], {
    input: JSON.stringify(input), env: process.env, encoding: 'utf8',
  });
  const base = { session_id: 'h1', cwd: path.join(TMP, 'delta') };
  hook('user-prompt', { ...base, prompt: 'hola' });
  hook('post-tool', { ...base, tool_name: 'TodoWrite', tool_input: {}, tool_response: {} });
  hook('post-tool', { ...base, tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'a' } });
  const db = openDb();
  assert.equal(db.prepare("SELECT count(*) n FROM prompts WHERE session_id = 'h1'").get().n, 1);
  assert.equal(db.prepare("SELECT count(*) n FROM queue WHERE session_id = 'h1'").get().n
    + db.prepare("SELECT count(*) n FROM observations WHERE session_id = 'h1'").get().n, 1, 'TodoWrite skipped, Bash kept');
  db.close();
  const start = hook('session-start', { session_id: 'h2', cwd: path.join(TMP, 'alpha') });
  const out = JSON.parse(start.stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /Configuración del proxy nginx/);
});

test('redaction removes secrets but keeps ordinary code', async () => {
  const { redactText, redact } = await import('../src/redact.mjs');
  const fake = 'glpat-' + 'a1B2c3D4e5F6g7H8i9J0k';
  const out = redactText(`GITLAB_TOKEN=${fake}\npassword: "hunter2hunter2"\nhttps://bob:s3cret@host/x\n<private>mi dni</private>`);
  assert.doesNotMatch(out, /a1B2c3D4|hunter2|s3cret|mi dni/);
  assert.equal(redactText("tokenize='unicode61' max_tokens: 4000"), "tokenize='unicode61' max_tokens: 4000");
  assert.deepEqual(redact({ apiKey: 'abc', nested: [{ v: `Bearer ${'x'.repeat(30)}` }] }), { apiKey: '[REDACTED]', nested: [{ v: 'Bearer [REDACTED]' }] });
  const db = openDb();
  const id = store.insertObservation(db, { project: 'zeta', title: 't', narrative: `clave sk-ant-${'Z'.repeat(30)}`, created_at: Date.now() });
  assert.doesNotMatch(db.prepare('SELECT narrative FROM observations WHERE id = ?').get(id).narrative, /ZZZZ/);
  db.prepare("UPDATE observations SET narrative = 'raw password=letmein123' WHERE id = ?").run(id);
  assert.equal(store.redactExisting(db), 1);
  assert.equal(store.search(db, { query: 'letmein123' }).length, 0, 'FTS index no longer holds the secret');
  db.close();
});
