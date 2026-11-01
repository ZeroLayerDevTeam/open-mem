import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'open-mem-llm-'));
process.env.CLAUDE_OPEN_MEM_DATA_DIR = path.join(TMP, 'data');

const { DEFAULT_SETTINGS, loadSettings, saveSettings } = await import('../src/config.mjs');
const { openDb } = await import('../src/db.mjs');
const llm = await import('../src/llm.mjs');
const stats = await import('../src/llmstats.mjs');
const semantic = await import('../src/semantic.mjs');
const engine = await import('../src/engine.mjs');
const auth = await import('../src/auth.mjs');
const { serve } = await import('../src/server.mjs');

// Drainers started by the tests must never reach a real LLM.
saveSettings({ ...DEFAULT_SETTINGS, provider: 'none', webAutostart: false, autoImportClaudeMem: false });

// A fake Ollama: chat answers `reply` with timings, plus version/ps/tags/generate/embed.
function fakeOllama(reply = '{"skip": true}') {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls.push({ url: req.url, body: body ? JSON.parse(body) : null });
      const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/api/chat') return send({ message: { content: reply }, eval_count: 50, eval_duration: 2e9, prompt_eval_count: 400, prompt_eval_duration: 5e8, load_duration: 1e8, total_duration: 2.7e9 });
      if (req.url === '/api/version') return send({ version: '9.9.9' });
      if (req.url === '/api/tags') return send({ models: [{ name: 'gemma3:12b', size: 8e9, details: { parameter_size: '12B', quantization_level: 'Q4_K_M' } }, { name: 'embeddinggemma:latest', size: 6e8, details: {} }] });
      if (req.url === '/api/ps') return send({ models: [{ name: 'gemma3:12b', size: 8e9, size_vram: 6e9, context_length: 8192, expires_at: new Date(Date.now() + 30000).toISOString(), details: { parameter_size: '12B' } }] });
      if (req.url === '/api/generate') return send({ done: true });
      if (req.url === '/api/embed') return send({ embeddings: JSON.parse(body).input.map(() => [1, 0, 0]), prompt_eval_count: 30, total_duration: 4e8, load_duration: 0 });
      res.writeHead(404); res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` })));
}

test('every chat call is recorded with its timings and task, failed ones too', async () => {
  const db = openDb(path.join(TMP, 'calls.db'));
  const o = await fakeOllama();
  try {
    const provider = stats.withRecorder(db, { kind: 'ollama', model: 'gemma3:12b', baseUrl: o.url });
    assert.deepEqual(await llm.completeJson(provider, llm.OBSERVATION_SYSTEM, 'x'), { skip: true });
    const row = db.prepare('SELECT * FROM llm_calls').get();
    assert.deepEqual([row.task, row.model, row.ok, row.output_tokens, row.prompt_tokens, row.eval_ms, row.total_ms], ['observation', 'gemma3:12b', 1, 50, 400, 2000, 2700]);
    const bad = await fakeOllama('not json');
    try {
      const p2 = stats.withRecorder(db, { kind: 'ollama', model: 'gemma3:12b', baseUrl: bad.url });
      await assert.rejects(llm.completeJson(p2, llm.BRIEF_SYSTEM, 'x'), /no JSON object/);
    } finally { bad.server.close(); }
    const failed = db.prepare("SELECT * FROM llm_calls WHERE task = 'brief'").get();
    assert.equal(failed.ok, 0);
    assert.equal(failed.output_tokens, 50, 'the model ran: its timings are kept');
    // Unreachable provider: recorded as a failure with the elapsed time.
    const down = stats.withRecorder(db, { kind: 'ollama', model: 'm', baseUrl: 'http://127.0.0.1:9' });
    await assert.rejects(llm.completeJson(down, llm.SUMMARY_SYSTEM, 'x'));
    assert.equal(db.prepare("SELECT ok FROM llm_calls WHERE task = 'summary'").get().ok, 0);
    // Embedding batches are recorded as one call each.
    await semantic.embed({ ...DEFAULT_SETTINGS, baseUrl: o.url, embedModel: 'embeddinggemma' }, ['a', 'b'], 5000, (s) => stats.recordCall(db, s));
    const emb = db.prepare("SELECT * FROM llm_calls WHERE task = 'embed'").get();
    assert.deepEqual([emb.items, emb.prompt_tokens, emb.total_ms], [2, 30, 400]);
  } finally { o.server.close(); db.close(); }
});

test('call stats: speed, latency percentiles, failures and time buckets', () => {
  const db = openDb(path.join(TMP, 'stats.db'));
  const now = Date.now();
  for (let i = 0; i < 10; i++) {
    stats.recordCall(db, { at: now - i * 3600000, task: 'observation', model: 'g', ok: i !== 3, output_tokens: 100, eval_ms: 4000, total_ms: 1000 * (i + 1) });
  }
  stats.recordCall(db, { at: now, task: 'embed', model: 'e', ok: true, items: 32, prompt_tokens: 900, total_ms: 300 });
  stats.recordCall(db, { at: now - 40 * 3600000, task: 'observation', model: 'g', ok: true, output_tokens: 100, eval_ms: 1000, total_ms: 500 });
  const day = stats.callStats(db, { hours: 24 });
  assert.equal(day.chat.calls, 10);
  assert.equal(day.chat.failed, 1);
  assert.equal(day.chat.speed, 25); // 1000 tokens in 40 s
  assert.equal(day.chat.p50, 6000);
  assert.equal(day.buckets.length, 24);
  assert.equal(day.buckets.reduce((n, b) => n + b.calls, 0), 10, 'embeddings stay out of the chat charts');
  assert.equal(day.buckets.at(-1).calls, 1);
  assert.equal(day.buckets.at(-1).speed, 25);
  assert.equal(day.tasks.find((r) => r.task === 'embed').items, 32);
  const week = stats.callStats(db, { hours: 168 });
  assert.equal(week.chat.calls, 11);
  assert.ok(week.buckets.length >= 28 && week.buckets.length <= 29);
  assert.equal(stats.callStats(db, { hours: 5 }).hours, 24, 'unknown ranges fall back to 24 hours');
  assert.equal(day.recent[0].task, 'observation');
  db.close();
});

test('engine status reads Ollama, the queue and the index; actions retry, load and pin models', async () => {
  const db = openDb(path.join(TMP, 'engine.db'));
  const o = await fakeOllama();
  const settings = { ...DEFAULT_SETTINGS, baseUrl: o.url, embedModel: 'embeddinggemma', pauseWhenBusy: false };
  try {
    db.prepare("INSERT INTO queue (kind, session_id, project, payload, status, attempts, error, created_at) VALUES ('observation', 's', 'p', ?, 'failed', 3, 'boom', 1)")
      .run(JSON.stringify({ tool: 'Bash', input: { command: 'git status' } }));
    db.prepare("INSERT INTO queue (kind, session_id, project, payload, created_at) VALUES ('summary', 's', 'p', '{\"prompt_number\": 4}', 2)").run();
    const s = await engine.engineStatus(db, settings);
    assert.equal(s.ollama.version, '9.9.9');
    assert.equal(s.provider.model, 'gemma3:12b');
    assert.deepEqual(s.ollama.loaded.map((m) => [m.name, m.vram, m.context]), [['gemma3:12b', 6e9, 8192]]);
    assert.deepEqual(s.ollama.installed.map((m) => m.chat), [true, false]);
    assert.deepEqual(s.queue.failed.map((q) => [q.tool, q.what, q.error]), [['Bash', 'git status', 'boom']]);
    assert.equal(s.queue.next[0].prompt_number, 4);
    assert.equal(s.embeddings.pending, 0);
    assert.equal(JSON.stringify(s).includes('apiKey'), false);

    assert.deepEqual(await engine.engineAction(db, settings, 'retry'), { retried: 1, started: true });
    assert.equal(db.prepare("SELECT count(*) n FROM queue WHERE status = 'failed'").get().n, 0);
    const loaded = await engine.engineAction(db, settings, 'load');
    assert.equal(loaded.loaded, 'gemma3:12b');
    assert.equal(o.calls.at(-1).body.keep_alive, '10m');
    await assert.rejects(engine.engineAction(db, settings, 'load', { model: 'embeddinggemma:latest' }), /embedding model/);
    assert.deepEqual(await engine.engineAction(db, settings, 'model', { model: 'gemma3:12b' }), { model: 'gemma3:12b' });
    assert.equal(loadSettings().model, 'gemma3:12b');
    await assert.rejects(engine.engineAction(db, settings, 'model', { model: 'nope:1b' }), /not an installed chat model/);
    await engine.engineAction(db, settings, 'model', { model: '' });
    assert.equal(loadSettings().model, '');
    await assert.rejects(engine.engineAction(db, { ...settings, provider: 'openai' }, 'unload'), /local Ollama/);
    await assert.rejects(engine.engineAction(db, settings, 'nope'), /unknown action/);
  } finally { o.server.close(); db.close(); }
});

test('nvidia-smi output is parsed, missing values become null', () => {
  assert.deepEqual(engine.parseNvidiaSmi('0, NVIDIA GeForce RTX 3060, 2060, 12288, 40, 49, 28.30\n1, Other GPU, 10, 4096, [N/A], [N/A], [N/A]\n'), [
    { index: 0, name: 'NVIDIA GeForce RTX 3060', memUsedMb: 2060, memTotalMb: 12288, util: 40, temp: 49, powerW: 28.3 },
    { index: 1, name: 'Other GPU', memUsedMb: 10, memTotalMb: 4096, util: null, temp: null, powerW: null },
  ]);
});

test('nvidia-smi is looked up on PATH first, then where the driver installs it', () => {
  assert.deepEqual(engine.smiCandidates('win32', { SystemRoot: 'C:\\WINDOWS', ProgramW6432: 'D:\\Programs' }), [
    'nvidia-smi', 'C:\\WINDOWS\\System32\\nvidia-smi.exe', 'D:\\Programs\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe',
  ]);
  assert.equal(engine.smiCandidates('win32', {})[2], 'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe');
  assert.ok(engine.smiCandidates('linux', {}).includes('/usr/lib/wsl/lib/nvidia-smi'));
});

test('server: the LLM page needs the admin; actions are POST, origin-checked, admin only', async () => {
  const db = openDb(path.join(TMP, 'srv.db'));
  const server = await serve(db, { ...DEFAULT_SETTINGS, provider: 'none' }, { host: '127.0.0.1', port: 0 });
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${url}/api/engine`)).status, 401);
    const token = auth.createAdminToken(db);
    const login = await fetch(`${url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const s = await (await fetch(`${url}/api/engine?hours=168`, { headers: { cookie } })).json();
    assert.equal(s.provider.kind, 'none');
    assert.equal(s.stats.hours, 168);
    const post = (p, headers = {}) => fetch(`${url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, ...headers }, body: '{}' });
    assert.equal((await post('/api/engine/nope')).status, 404);
    assert.equal((await post('/api/engine/retry', { origin: 'http://evil.example' })).status, 403);
    assert.deepEqual((await (await post('/api/engine/retry')).json()).result, { retried: 0, started: false });
    const key = auth.addDevice(db, 'laptop');
    const asDevice = await fetch(`${url}/api/engine/retry`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: '{}' });
    assert.equal(asDevice.status, 403);
  } finally { server.close(); db.close(); }
});

test('a machine that runs Ollama reports its GPU at most once a minute; the server keeps it per device', async () => {
  const gpu = await import('../src/gpu.mjs');
  const db = openDb(path.join(TMP, 'gpu.db'));
  try {
    const sent = [];
    const send = async (...args) => { sent.push(args); };
    const read = async () => ({ list: [{ index: 0, name: 'RTX 4060 Ti', memUsedMb: 900, memTotalMb: 16380, util: 3, temp: 41, powerW: 12 }], error: null });
    assert.equal(await gpu.reportGpu(db, send, { now: 1e6, read }), true);
    assert.equal(await gpu.reportGpu(db, send, { now: 1e6 + 30000, read }), false);
    assert.equal(await gpu.reportGpu(db, send, { now: 1e6 + 61000, read: async () => ({ list: null, error: 'missing' }) }), false);
    assert.deepEqual(sent.map(([m, r]) => `${m} ${r}`), ['POST /api/gpu']);

    assert.equal(gpu.storeGpuReport(db, 'torre', { gpus: [{ name: 'x'.repeat(200), memUsedMb: '5', temp: 40, extra: 1 }] }, 5000), 1);
    assert.deepEqual(gpu.gpuReports(db, 6000), [{ device: 'torre', at: 5000,
      gpus: [{ index: null, name: 'x'.repeat(80), memUsedMb: null, memTotalMb: null, util: null, temp: 40, powerW: null }] }]);
    assert.deepEqual(gpu.gpuReports(db, 5000 + 8 * 864e5), []);
    assert.throws(() => gpu.storeGpuReport(db, 'torre', { gpus: [] }), /no GPU/);
  } finally { db.close(); }
});

test('server: /api/gpu takes reports from devices only and the LLM page lists them', async () => {
  const db = openDb(path.join(TMP, 'srv-gpu.db'));
  const server = await serve(db, { ...DEFAULT_SETTINGS, provider: 'none' }, { host: '127.0.0.1', port: 0 });
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const key = auth.addDevice(db, 'torre');
    const report = (headers, body) => fetch(`${url}/api/gpu`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    assert.equal((await report({}, { gpus: [{ name: 'RTX' }] })).status, 401);
    assert.equal((await report({ authorization: `Bearer ${key}` }, { gpus: [] })).status, 400);
    assert.equal((await report({ authorization: `Bearer ${key}` }, { gpus: [{ name: 'RTX', memUsedMb: 1, memTotalMb: 2 }] })).status, 200);
    const token = auth.createAdminToken(db);
    const login = await fetch(`${url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const s = await (await fetch(`${url}/api/engine`, { headers: { cookie } })).json();
    assert.deepEqual(s.remoteGpus.map((r) => [r.device, r.gpus[0].name]), [['torre', 'RTX']]);
  } finally { server.close(); db.close(); }
});
