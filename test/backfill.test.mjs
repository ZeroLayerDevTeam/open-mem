import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'open-mem-backfill-'));
process.env.CLAUDE_OPEN_MEM_DATA_DIR = path.join(TMP, 'data');

const { DEFAULT_SETTINGS, saveSettings } = await import('../src/config.mjs');
const { openDb } = await import('../src/db.mjs');
const store = await import('../src/store.mjs');
const { drain } = await import('../src/queue.mjs');
const { ingest } = await import('../src/sync.mjs');
const backfill = await import('../src/backfill.mjs');

// Never a real LLM, marker, process list or GPU.
const SETTINGS = { ...DEFAULT_SETTINGS, provider: 'ollama', busyFiles: [], pauseWhenBusy: false, ollamaAutostart: false, embedModel: '', briefEvery: 0 };
saveSettings({ ...SETTINGS, provider: 'none', webAutostart: false, autoImportClaudeMem: false });

const SID = '11111111-2222-3333-4444-555555555555';
const T0 = Date.parse('2026-11-02T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

// A transcript as Claude Code writes it: prompts, tool_use blocks, tool_result blocks with toolUseResult, texts.
function transcript(entries) {
  return entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
}
const prompt = (at, text) => ({ type: 'user', timestamp: iso(at), sessionId: SID, message: { role: 'user', content: text } });
const say = (at, text) => ({ type: 'assistant', timestamp: iso(at), sessionId: SID, message: { content: [{ type: 'text', text }] } });
const use = (at, id, name, input) => ({ type: 'assistant', timestamp: iso(at), sessionId: SID, message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (at, id, out, isError = false) => ({ type: 'user', timestamp: iso(at), sessionId: SID, toolUseResult: isError ? undefined : out,
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: typeof out === 'string' ? out : 'see toolUseResult', is_error: isError }] } });

function setup() {
  const accounts = path.join(TMP, `accounts-${Math.random().toString(36).slice(2)}`);
  const proj = path.join(accounts, 'work', 'projects', 'F--x');
  fs.mkdirSync(path.join(proj, SID, 'subagents'), { recursive: true });
  const main = transcript([
    prompt(T0, 'arregla el login'),
    use(T0 + 5000, 'tu_edit', 'Edit', { file_path: '/x/login.js', old_string: 'a', new_string: 'b' }), result(T0 + 10000, 'tu_edit', { filePath: '/x/login.js' }),
    use(T0 + 15000, 'tu_bash', 'Bash', { command: 'npm test' }), result(T0 + 16000, 'tu_bash', { stdout: 'ok' }),
    use(T0 + 18000, 'tu_read', 'Read', { file_path: '/x/auth.js' }), result(T0 + 20000, 'tu_read', { file: { content: 'token check' } }),
    use(T0 + 21000, 'tu_todo', 'TodoWrite', { todos: [] }), result(T0 + 21500, 'tu_todo', 'ok'),
    use(T0 + 22000, 'tu_fail', 'Read', { file_path: '/nope' }), result(T0 + 22500, 'tu_fail', 'File does not exist.', true),
    use(T0 + 23000, 'tu_q', 'Glob', { pattern: '*.js' }), result(T0 + 23500, 'tu_q', 'a.js'),
    say(T0 + 50000, 'turn one done'),
    prompt(T0 + 100000, 'y ahora el registro'),
    say(T0 + 150000, 'turn two done'),
    use(T0 + 9e6, 'tu_late', 'Read', { file_path: '/x/late.js' }), result(T0 + 9e6 + 1, 'tu_late', 'later'),
  ]);
  fs.writeFileSync(path.join(proj, `${SID}.jsonl`), main);
  fs.writeFileSync(path.join(proj, SID, 'subagents', 'agent-1.jsonl'), transcript([
    { ...use(T0 + 120000, 'tu_grep', 'Grep', { pattern: 'session' }), isSidechain: true },
    { ...result(T0 + 121000, 'tu_grep', 'src/session.js:3'), isSidechain: true },
  ]));
  // The same session resumed from another account: an older, shorter copy of its transcript.
  const other = path.join(accounts, 'other', 'projects', 'F--x');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, `${SID}.jsonl`), transcript([prompt(T0, 'arregla el login')]));

  const db = openDb(path.join(TMP, `${path.basename(accounts)}.db`));
  db.prepare('INSERT INTO sessions (session_id, project, cwd, started_at, last_seen_at, prompt_counter) VALUES (?, ?, ?, ?, ?, 2)').run(SID, 'x', '/x', T0, T0 + 200000);
  const addPrompt = db.prepare('INSERT INTO prompts (session_id, project, prompt_number, text, created_at) VALUES (?, ?, ?, ?, ?)');
  addPrompt.run(SID, 'x', 1, 'arregla el login', T0);
  addPrompt.run(SID, 'x', 2, 'y ahora el registro', T0 + 100000);
  // What the no-LLM path left: a raw edit (already pushed), an LLM observation, a summary without a model.
  const raw = store.insertObservation(db, { session_id: SID, project: 'x', prompt_number: 1, tool: 'Edit', type: 'change', title: 'Edit: /x/login.js',
    files_modified: ['/x/login.js'], created_at: T0 + 10000, metadata: { tool_use_id: 'tu_edit', compressed: false } });
  db.prepare('UPDATE observations SET synced_at = 1 WHERE id = ?').run(raw);
  store.insertObservation(db, { session_id: SID, project: 'x', prompt_number: 1, tool: 'Bash', type: 'discovery', title: 'Tests pass',
    created_at: T0 + 16000, model: 'gemma3:12b', metadata: { tool_use_id: 'tu_bash', compressed: true } });
  store.upsertSummary(db, { session_id: SID, project: 'x', prompt_number: 1, request: 'arregla el login', completed: 'Modified: /x/login.js',
    created_at: T0 + 60000, source_id: `${SID}:1` });
  db.prepare('INSERT INTO queue (kind, session_id, project, payload, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('observation', SID, 'x', JSON.stringify({ tool: 'Glob', tool_use_id: 'tu_q', at: T0 + 23500 }), Date.now());
  return { db, accounts, raw };
}

test('transcript folders: a folder of accounts, a config folder or a projects folder', () => {
  const { db, accounts } = setup();
  db.close();
  assert.deepEqual(backfill.projectRoots([accounts]).map((r) => path.relative(accounts, r)).sort(), [path.join('other', 'projects'), path.join('work', 'projects')]);
  assert.deepEqual(backfill.projectRoots([path.join(accounts, 'work')]), [path.join(accounts, 'work', 'projects')]);
  assert.deepEqual(backfill.projectRoots([path.join(accounts, 'work', 'projects')]), [path.join(accounts, 'work', 'projects')]);
  assert.deepEqual(backfill.projectRoots([path.join(TMP, 'missing')]), []);
});

test('dry run counts what the window lost; queueing twice adds nothing', () => {
  const { db, accounts, raw } = setup();
  try {
    const opts = { from: T0 - 1000, to: T0 + 3600000, roots: backfill.projectRoots([accounts]) };
    const plan = backfill.planBackfill(db, SETTINGS, opts);
    assert.deepEqual(plan.counts, { sessions: 1, transcripts: 1, missing: 0, calls: 7, inMemory: 1, queued: 1, skippedTools: 1, errors: 1,
      upgrade: 1, add: 2, summariesRedo: 1, summariesAdd: 1, summariesDone: 0 });
    assert.equal(db.prepare('SELECT count(*) n FROM queue').get().n, 1, 'a dry run queues nothing');

    assert.equal(backfill.applyBackfill(db, plan), 5);
    const items = db.prepare('SELECT kind, payload FROM queue ORDER BY id').all().slice(1).map((r) => ({ kind: r.kind, ...JSON.parse(r.payload) }));
    // Observations first, then the summaries that read them; every item keeps the time it was captured.
    assert.deepEqual(items.map((i) => [i.kind, i.tool_use_id ?? `turn ${i.prompt_number}`, i.prompt_number, i.at]), [
      ['observation', 'tu_edit', 1, T0 + 10000], ['observation', 'tu_read', 1, T0 + 20000], ['observation', 'tu_grep', 2, T0 + 121000],
      ['summary', 'turn 1', 1, T0 + 60000], ['summary', 'turn 2', 2, T0 + 150000]]);
    assert.equal(items[0].upgrade, raw);
    assert.equal(items[1].upgrade, undefined);
    assert.ok(items.every((i) => i.backfill === true));
    assert.deepEqual(items[1].output, { file: { content: 'token check' } }, 'the structured result, as PostToolUse gets it');
    assert.equal(items[3].assistant_text, 'turn one done');
    assert.equal(items[4].assistant_text, 'turn two done');

    const again = backfill.planBackfill(db, SETTINGS, opts);
    assert.deepEqual([again.counts.upgrade, again.counts.add, again.counts.summariesRedo, again.counts.summariesAdd], [0, 0, 0, 0]);
  } finally { db.close(); }
});

// A simulated LLM: keeps every call, summarizes every turn, and records what it was asked.
async function fakeLlm() {
  const asked = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = body ? JSON.parse(body) : {};
      const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url !== '/api/chat') return send({ models: [] });
      const [system, user] = json.messages.map((m) => m.content);
      asked.push(user);
      const reply = system.startsWith('You summarize')
        ? { skip: false, request: 'login', completed: 'done by the LLM' }
        : { skip: false, type: 'bugfix', title: `LLM: ${user.match(/Tool: (\S+)/)[1]}`, narrative: 'n', facts: ['f'] };
      send({ message: { content: JSON.stringify(reply) }, eval_count: 5, eval_duration: 1e8 });
    });
  });
  await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
  return { asked, url: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections(); server.close(); } };
}

test('the drainer upgrades raw rows in place, adds dropped calls and summaries on their own days', async () => {
  const { db, accounts, raw } = setup();
  const llm = await fakeLlm();
  try {
    db.prepare('DELETE FROM queue').run(); // the Glob call is no longer queued: it comes back as a dropped call
    backfill.applyBackfill(db, backfill.planBackfill(db, SETTINGS, { from: T0 - 1000, to: T0 + 3600000, roots: backfill.projectRoots([accounts]) }));
    const provider = { kind: 'ollama', model: 'gemma3:4b', baseUrl: llm.url };
    assert.equal(await drain(db, SETTINGS, { lock: false, sync: false, provider, plan: async (s, { model }) => ({ model, unload: [] }) }), 6);

    const up = db.prepare('SELECT title, model, created_at, synced_at, metadata FROM observations WHERE id = ?').get(raw);
    assert.deepEqual([up.title, up.model, up.created_at, up.synced_at], ['LLM: Edit', 'gemma3:4b', T0 + 10000, null], 'same row, pushed again');
    assert.deepEqual(JSON.parse(up.metadata), { tool_use_id: 'tu_edit', compressed: true, backfilled: true });
    const rows = db.prepare(`SELECT title, created_at FROM observations WHERE session_id = ? ORDER BY created_at`).all(SID).map((r) => [r.title, r.created_at]);
    assert.deepEqual(rows, [['LLM: Edit', T0 + 10000], ['Tests pass', T0 + 16000], ['LLM: Read', T0 + 20000], ['LLM: Glob', T0 + 23500], ['LLM: Grep', T0 + 121000]]);
    const sums = db.prepare('SELECT prompt_number, completed, model, created_at FROM summaries WHERE session_id = ? ORDER BY prompt_number').all(SID)
      .map((s) => [s.prompt_number, s.completed, s.model, s.created_at]);
    assert.deepEqual(sums, [[1, 'done by the LLM', 'gemma3:4b', T0 + 60000], [2, 'done by the LLM', 'gemma3:4b', T0 + 150000]]);
    // Each summary got the final message of its own turn, not the last one of the transcript.
    assert.match(llm.asked.find((u) => u.includes('arregla el login') && u.includes('Assistant final message')), /turn one done/);
    assert.match(llm.asked.find((u) => u.includes('y ahora el registro') && u.includes('Assistant final message')), /turn two done/);
  } finally { llm.close(); db.close(); }
});

test('without the LLM a backfilled raw row stays as it is, never doubled', async () => {
  const { db, accounts, raw } = setup();
  try {
    db.prepare('DELETE FROM queue').run();
    backfill.applyBackfill(db, backfill.planBackfill(db, SETTINGS, { from: T0 - 1000, to: T0 + 3600000, roots: backfill.projectRoots([accounts]) }));
    await drain(db, { ...SETTINGS, provider: 'none' }, { lock: false, sync: false, provider: { kind: 'none' } });
    assert.equal(db.prepare("SELECT count(*) n FROM observations WHERE json_extract(metadata, '$.tool_use_id') = 'tu_edit'").get().n, 1);
    assert.equal(db.prepare('SELECT title FROM observations WHERE id = ?').get(raw).title, 'Edit: /x/login.js');
  } finally { db.close(); }
});

test('server: an observation pushed again replaces its copy and keeps its id', () => {
  const db = openDb(path.join(TMP, 'server.db'));
  try {
    const row = { id: 7, session_id: SID, project: 'x', tool: 'Edit', type: 'change', title: 'Edit: /x/login.js', created_at: T0, metadata: '{"compressed":false}' };
    ingest(db, 'torre', { observations: [row] });
    const first = db.prepare("SELECT id, title FROM observations WHERE source_id = 'obs:7'").get();
    ingest(db, 'torre', { observations: [{ ...row, title: 'LLM: Edit', model: 'gemma3:4b', metadata: '{"compressed":true}' }] });
    const second = db.prepare("SELECT id, title, model, created_at FROM observations WHERE source_id = 'obs:7'").get();
    assert.deepEqual([second.id, second.title, second.model, second.created_at], [first.id, 'LLM: Edit', 'gemma3:4b', T0]);
    assert.equal(db.prepare("SELECT count(*) n FROM obs_fts WHERE obs_fts MATCH 'LLM'").get().n, 1, 'full-text index follows');
  } finally { db.close(); }
});
