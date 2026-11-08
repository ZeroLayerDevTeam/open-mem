import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'open-mem-v8-'));
process.env.CLAUDE_OPEN_MEM_DATA_DIR = path.join(TMP, 'data');

const { DEFAULT_SETTINGS, dataPath, log, saveSettings } = await import('../src/config.mjs');
const { getMeta, openDb, setMeta } = await import('../src/db.mjs');
const store = await import('../src/store.mjs');
const { parseJsonReply, salvageJson, unloadOllama } = await import('../src/llm.mjs');
const budget = await import('../src/budget.mjs');
const queue = await import('../src/queue.mjs');
const sync = await import('../src/sync.mjs');
const { startGuard } = await import('../src/guard.mjs');

// Tests never look at this machine's markers, processes or GPU.
const BASE = { ...DEFAULT_SETTINGS, busyFiles: [], pauseWhenBusy: false, ollamaAutostart: false, embedModel: '' };
saveSettings({ ...BASE, provider: 'none', webAutostart: false, autoImportClaudeMem: false });
const GB = 1024 ** 3;

// A fake Ollama shared by another app: `loaded` is what /api/ps lists; every request is recorded.
async function fakeOllama({ loaded = [], reply = '{"skip": false, "type": "discovery", "title": "t", "narrative": "n"}', chatDelayMs = 0, chatStatus = 200 } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = body ? JSON.parse(body) : null;
      calls.push({ route: req.url, body: json });
      const send = (o, status = 200) => { if (!res.destroyed) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); } };
      if (req.url === '/api/chat' && chatStatus !== 200) return send({ error: 'model failed to load' }, chatStatus);
      if (req.url === '/api/ps') return send({ models: loaded.map((name) => ({ name, size: 3 * GB, size_vram: 3 * GB })) });
      if (req.url === '/api/tags') return send({ models: [{ name: 'gemma3:12b', size: 8 * GB }, { name: 'gemma3:4b', size: 3 * GB }, { name: 'embeddinggemma:latest', size: 0.6 * GB }] });
      if (req.url === '/api/chat') return setTimeout(() => send({ message: { content: reply }, eval_count: 10, eval_duration: 1e8 }), chatDelayMs);
      if (req.url === '/api/generate') return send({ done: true });
      return send({});
    });
  });
  await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
  return { calls, url: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections(); server.close(); } };
}

test('unloading frees only open-mem\'s models, never another app\'s', async () => {
  const o = await fakeOllama({ loaded: ['qwen3:8b', 'gemma3:12b', 'embeddinggemma:latest', 'bge-m3:latest'] });
  try {
    assert.deepEqual(await unloadOllama(o.url, ['gemma3:12b', 'embeddinggemma', 'gemma3:4b']), ['gemma3:12b', 'embeddinggemma:latest']);
    assert.deepEqual(o.calls.filter((c) => c.route === '/api/generate').map((c) => c.body), [
      { model: 'gemma3:12b', keep_alive: 0 }, { model: 'embeddinggemma:latest', keep_alive: 0 }]);
    o.calls.length = 0;
    assert.deepEqual(await unloadOllama(o.url, []), []);
    assert.deepEqual(o.calls, [], 'no list of models: not even a request');
  } finally { o.close(); }
});

test('a reply cut at the token limit keeps what was written before the cut', () => {
  assert.deepEqual(parseJsonReply('{"skip": false, "type": "bugfix", "title": "SEH fix", "subtitle": "Removed workar'),
    { skip: false, type: 'bugfix', title: 'SEH fix' });
  assert.deepEqual(parseJsonReply('{"title": "x", "facts": ["a, b", "c'), { title: 'x', facts: ['a, b'] });
  assert.deepEqual(salvageJson('{"skip": true'), { skip: true });
  assert.deepEqual(parseJsonReply('{"a": {"b": 1}, "c": "}"}'), { a: { b: 1 }, c: '}' });
  assert.throws(() => parseJsonReply('{"title": "never clos'), /no JSON object/);
  assert.throws(() => parseJsonReply('no json at all'), /no JSON object/);
});

// planGpu with a 12 GiB card: `usedMb` in use by everything (including open-mem's own loaded models).
const plan = (settings, opts, { loaded = [], usedMb = 1500, list, overheadMb = 0, maxLoaded = 3 } = {}) => budget.planGpu(
  { ...BASE, fallbackModels: ['gemma3:4b'], ...settings }, { baseUrl: 'x', model: 'gemma3:12b', ...opts }, {
    ps: async () => ({ models: loaded.map(([name, gb]) => ({ name, size: gb * GB, size_vram: gb * GB })) }),
    tags: async () => ({ models: [{ name: 'gemma3:12b', size: 8 * GB }, { name: 'gemma3:4b', size: 3 * GB }, { name: 'embeddinggemma:latest', size: 0.6 * GB }] }),
    gpus: async () => ({ list: list === undefined ? [{ memTotalMb: 12288, memUsedMb: usedMb }] : list }),
    limits: async () => ({ overheadMb, maxLoaded }),
  });

test('GPU budget: the best model that fits, a lighter one while others share Ollama, a pause when nothing fits', async () => {
  assert.deepEqual(await plan({}, {}), { model: 'gemma3:12b', unload: [] });
  // 12b needs ~8.8 GiB + 1.5 GiB reserve: with a 6.5 GiB teacher loaded only the 4b would fit, and another app is in Ollama.
  assert.equal((await plan({}, {}, { loaded: [['qwen3:8b', 6.5]], usedMb: 1500 + 6656 })).pause?.kind, 'gpu');
  assert.deepEqual(await plan({}, {}, { loaded: [['qwen3:8b', 4]], usedMb: 1500 + 4096 }), { model: 'gemma3:4b', unload: [] });
  // OLLAMA_GPU_OVERHEAD counts: Ollama itself refuses loads above total - overhead.
  assert.equal((await plan({}, {}, { usedMb: 1500, overheadMb: 2048 })).model, 'gemma3:4b');
  // Training holds almost all of it.
  const p = await plan({}, {}, { usedMb: 11000 });
  assert.equal(p.pause.kind, 'gpu');
  assert.match(p.pause.detail, /MiB free, gemma3:12b needs \d+ MiB/);
  // Loading one more model would push another app's model out (OLLAMA_MAX_LOADED_MODELS).
  const slots = await plan({}, {}, { loaded: [['qwen3:8b', 1], ['bge-m3:latest', 1]], usedMb: 3500, maxLoaded: 2 });
  assert.equal(slots.pause.kind, 'slots');
  assert.match(slots.pause.detail, /qwen3:8b, bge-m3:latest \(OLLAMA_MAX_LOADED_MODELS=2\)/);
  // A backlog drains with the lighter model; open-mem's other loaded model is freed first and counts as free memory.
  assert.deepEqual(await plan({ backlogItems: 100 }, { backlog: 101 }, { loaded: [['gemma3:12b', 8.5]], usedMb: 1500 + 8704 }),
    { model: 'gemma3:4b', unload: ['gemma3:12b'] });
  // Without nvidia-smi the memory is unknown: only the slot rule applies.
  assert.equal((await plan({}, {}, { list: null })).model, 'gemma3:12b');
  // The embedding model needs room too.
  assert.equal((await plan({ fallbackModels: [] }, { embed: true }, { usedMb: 1800 })).pause?.kind, 'gpu');
  assert.equal((await plan({ fallbackModels: [] }, { embed: true }, { usedMb: 1500 })).model, 'gemma3:12b');
  // exact (the guard): no fallback, a loaded model needs nothing more, others' models are left alone.
  assert.equal((await plan({}, { exact: true }, { loaded: [['qwen3:8b', 4]], usedMb: 1500 + 4096 })).pause?.kind, 'gpu');
  assert.deepEqual(await plan({}, { exact: true, model: 'gemma3:4b' }, { loaded: [['gemma3:4b', 3]], usedMb: 12000 }), { model: 'gemma3:4b', unload: [] });
});

test('GPU budget: the model already loaded is used even when the free memory looks short', async () => {
  // 12b loaded with a large context (another app asked for it): 11.2 GiB used of 12, the count says it would not fit.
  assert.deepEqual(await plan({ fallbackModels: [] }, {}, { loaded: [['gemma3:12b', 9]], usedMb: 11500 }), { model: 'gemma3:12b', unload: [] });
  // Not loaded: the free memory decides, as before.
  assert.equal((await plan({ fallbackModels: [] }, {}, { usedMb: 11500 })).pause?.kind, 'gpu');
});

test('drain: an answer clears a pause another drainer noted', async () => {
  const db = openDb(path.join(TMP, 'stale-pause.db'));
  const o = await fakeOllama({});
  const free = async (s, { model }) => ({ model, unload: [] });
  try {
    setMeta(db, 'pause', JSON.stringify({ kind: 'gpu', detail: 'x', since: Date.now() - 60000, at: Date.now() - 60000 }));
    enqueueReads(db, 1);
    assert.equal(await queue.drain(db, BASE, { lock: false, sync: false, force: true, provider: { kind: 'ollama', model: 'gemma3:12b', baseUrl: o.url }, plan: free }), 1);
    assert.equal(queue.queueState(db).pause, null);
  } finally { o.close(); db.close(); }
});

test('drain: the embedding model is loaded before the items and kept by the plan; a slow load does not stop the drain', async () => {
  const db = openDb(path.join(TMP, 'warm.db'));
  const o = await fakeOllama({});
  const settings = { ...BASE, embedModel: 'embeddinggemma', provider: 'ollama' };
  const provider = { kind: 'ollama', model: 'gemma3:12b', baseUrl: o.url };
  try {
    const order = [];
    const embeds = [];
    const plan = async (s, { model, embed }) => { embeds.push(embed); return { model, unload: [] }; };
    const warm = async () => { order.push('warm'); };
    enqueueReads(db, 2);
    const origFetch = o.calls.length;
    assert.equal(await queue.drain(db, settings, { lock: false, sync: false, force: true, provider, plan, warm }), 2);
    assert.equal(order.length, 1);
    assert.ok(o.calls.length > origFetch);
    assert.ok(embeds.every(Boolean), 'every plan keeps the embedding model');
    // Too slow to load: the items are still handled, and the plan no longer keeps it.
    embeds.length = 0;
    enqueueReads(db, 1);
    const slow = async () => { throw new Error('The operation was aborted due to timeout'); };
    assert.equal(await queue.drain(db, settings, { lock: false, sync: false, force: true, provider, plan, warm: slow }), 1);
    assert.ok(embeds.includes(false), 'the items run without it'); // upkeep still asks for it to embed the records
  } finally { o.close(); db.close(); }
});

test('marker files: a live one pauses, a stale or missing one does not; folders hold markers', () => {
  const dir = path.join(TMP, 'gpu-busy');
  fs.mkdirSync(dir, { recursive: true });
  const settings = { busyFiles: [dir] };
  assert.equal(budget.markerPause(settings), null);
  const file = path.join(dir, 'securitymodel-train');
  const now = Date.now();
  fs.writeFileSync(file, JSON.stringify({ owner: 'securitymodel', phase: 'train', heartbeat: new Date(now).toISOString(), stale_after_s: 60 }));
  assert.deepEqual(budget.markerPause(settings, now), { kind: 'marker', detail: 'securitymodel train', file });
  // Its job died: heartbeat and mtime older than stale_after_s.
  const old = new Date(now - 120000);
  fs.writeFileSync(file, JSON.stringify({ owner: 'securitymodel', phase: 'train', heartbeat: old.toISOString(), stale_after_s: 60 }));
  fs.utimesSync(file, old, old);
  assert.equal(budget.markerPause(settings, now), null);
  // A plain file counts while it exists, by name; a file listed directly works as well as a folder.
  fs.writeFileSync(path.join(dir, 'render'), '');
  assert.equal(budget.markerPause(settings, now).detail, 'render');
  assert.equal(budget.markerPause({ busyFiles: [path.join(dir, 'render'), path.join(TMP, 'missing')] }, now).detail, 'render');
  fs.rmSync(dir, { recursive: true });
});

test('manual pause: until resume, or for a few hours', () => {
  assert.equal(budget.manualPause(), null);
  budget.setPause({ reason: 'training' });
  assert.deepEqual(budget.manualPause(), { kind: 'manual', detail: 'training', until: null });
  assert.equal(budget.clearPause(), true);
  assert.equal(budget.manualPause(), null);
  const p = budget.setPause({ hours: 1, now: 1000 });
  assert.equal(p.until, 1000 + 3600000);
  assert.equal(budget.manualPause(1000 + 3600001), null, 'expired: removed');
  assert.equal(budget.clearPause(), false);
});

function enqueueReads(db, n, session = 's8') {
  const prompt = store.addPrompt(db, { sessionId: session, project: 'p8', cwd: '/x/p8', text: 'lee' });
  for (let i = 0; i < n; i++) queue.enqueue(db, 'observation', session, 'p8', { tool: 'Read', input: { file_path: `/x/${i}` }, output: 'ok', prompt_number: prompt, at: 1000 + i });
}

test('drain: a marker holds the queue and frees only open-mem\'s models; the queue goes on when it is gone', async () => {
  const db = openDb(path.join(TMP, 'marker.db'));
  const o = await fakeOllama({ loaded: ['qwen3:8b', 'gemma3:12b'] });
  const dir = path.join(TMP, 'markers');
  fs.mkdirSync(dir, { recursive: true });
  const settings = { ...BASE, busyFiles: [dir], model: 'gemma3:12b' };
  const provider = () => ({ kind: 'ollama', model: 'gemma3:12b', baseUrl: o.url });
  const go = (opts = {}) => queue.drain(db, settings, { lock: false, sync: false, provider: provider(), plan: async (s, { model }) => ({ model, unload: [] }), ...opts });
  try {
    enqueueReads(db, 2);
    fs.writeFileSync(path.join(dir, 'job'), JSON.stringify({ owner: 'securitymodel', phase: 'train', heartbeat: new Date().toISOString(), stale_after_s: 60 }));
    assert.equal(await go(), 0);
    assert.equal(db.prepare("SELECT count(*) n FROM queue WHERE status = 'pending' AND attempts = 0").get().n, 2);
    assert.deepEqual(o.calls.filter((c) => c.route === '/api/generate').map((c) => c.body.model), ['gemma3:12b']);
    const state = queue.queueState(db);
    assert.equal(state.pending, 2);
    assert.deepEqual([state.pause.kind, state.pause.detail], ['marker', 'securitymodel train']);
    // Hooks start drainers all the time: a pause seen seconds ago is reused, nothing is asked again.
    o.calls.length = 0;
    assert.equal(await go(), 0);
    assert.deepEqual(o.calls, []);
    // `force` (the web viewer's button) does not override a marker: the GPU belongs to that job.
    assert.equal(await go({ force: true }), 0);
    fs.rmSync(path.join(dir, 'job'));
    setMeta(db, 'pause', JSON.stringify({ ...JSON.parse(getMeta(db, 'pause')), at: Date.now() - 20000 }));
    assert.equal(await go(), 2);
    assert.equal(queue.queueState(db).pause, null);
    // Records keep the time of capture, not of processing: the activity chart fills the right days.
    assert.deepEqual(db.prepare("SELECT created_at FROM observations WHERE project = 'p8' ORDER BY created_at").all().map((r) => r.created_at), [1000, 1001]);
  } finally { o.close(); db.close(); }
});

test('drain: the plan picks the model of each call; a manual pause holds the queue; force overrides it', async () => {
  const db = openDb(path.join(TMP, 'plan.db'));
  const o = await fakeOllama();
  const provider = () => ({ kind: 'ollama', model: 'gemma3:12b', baseUrl: o.url });
  try {
    enqueueReads(db, 2);
    budget.setPause({ reason: 'training' });
    assert.equal(await queue.drain(db, BASE, { lock: false, sync: false, provider: provider() }), 0);
    assert.deepEqual(queue.queueState(db).pause, { ...queue.queueState(db).pause, kind: 'manual', detail: 'training' });
    let plans = 0;
    const fallback = async () => { plans++; return { model: 'gemma3:4b', unload: [] }; };
    assert.equal(await queue.drain(db, BASE, { lock: false, sync: false, provider: provider(), force: true, plan: fallback }), 2);
    assert.equal(plans, 3, 'before each item, and once more to find the queue empty');
    assert.deepEqual([...new Set(o.calls.filter((c) => c.route === '/api/chat').map((c) => c.body.model))], ['gemma3:4b']);
    budget.clearPause();
  } finally { o.close(); db.close(); }
});

test('drain: a timeout keeps the item and its attempts, and waits a while before the next call', async () => {
  const db = openDb(path.join(TMP, 'slow.db'));
  const o = await fakeOllama({ chatDelayMs: 1000 });
  const settings = { ...BASE, llmTimeoutMs: 50 };
  const provider = () => ({ kind: 'ollama', model: 'gemma3:12b', baseUrl: o.url });
  const free = async (s, { model }) => ({ model, unload: [] });
  try {
    enqueueReads(db, 1);
    assert.equal(await queue.drain(db, settings, { lock: false, sync: false, provider: provider(), plan: free }), 0);
    const row = db.prepare('SELECT status, attempts FROM queue').get();
    assert.deepEqual({ ...row }, { status: 'pending', attempts: 0 });
    assert.equal(queue.queueState(db).pause.kind, 'slow');
    const chats = o.calls.filter((c) => c.route === '/api/chat').length;
    setMeta(db, 'pause', ''); // a drainer that does not reuse the pause still respects the backoff
    assert.equal(await queue.drain(db, settings, { lock: false, sync: false, provider: provider(), plan: free }), 0);
    assert.equal(o.calls.filter((c) => c.route === '/api/chat').length, chats);
    assert.ok(JSON.parse(getMeta(db, 'llm_backoff')).until > Date.now());
  } finally { o.close(); db.close(); }
});

test('a timeout waits 15 s, then 30 s, 60 s and at most 2 min in a row; an answer starts over', () => {
  const db = openDb(path.join(TMP, 'steps.db'));
  try {
    const now = 1_000_000;
    const wait = () => JSON.parse(getMeta(db, 'llm_backoff')).until - now;
    const waits = [];
    for (let i = 0; i < 5; i++) { queue.backOff(db, 'slow', 'x', now); waits.push(wait()); }
    assert.deepEqual(waits, [15000, 30000, 60000, 120000, 120000]);
    queue.backOff(db, 'error', 'oom', now);
    assert.equal(wait(), 120000, 'a model failure waits 2 min');
    setMeta(db, 'llm_slow_streak', '');
    queue.backOff(db, 'slow', 'x', now);
    assert.equal(wait(), 15000);
  } finally { db.close(); }
});

test('drain: an answer resets the timeout streak', async () => {
  const db = openDb(path.join(TMP, 'streak.db'));
  const o = await fakeOllama({});
  const free = async (s, { model }) => ({ model, unload: [] });
  try {
    setMeta(db, 'llm_slow_streak', '3');
    enqueueReads(db, 1);
    assert.equal(await queue.drain(db, BASE, { lock: false, sync: false, provider: { kind: 'ollama', model: 'gemma3:12b', baseUrl: o.url }, plan: free }), 1);
    assert.ok(!getMeta(db, 'llm_slow_streak'));
  } finally { o.close(); db.close(); }
});

test('a local Ollama that does not answer is started, at most every 10 minutes', async () => {
  const db = openDb(path.join(TMP, 'start.db'));
  try {
    setMeta(db, 'llm_seen_at', Date.now());
    let starts = 0;
    const start = async () => { starts++; return null; };
    // A port nothing listens on: connection refused, Ollama is not running.
    const probe = http.createServer();
    await new Promise((r) => { probe.listen(0, '127.0.0.1', r); });
    const closed = probe.address().port;
    await new Promise((r) => { probe.close(r); });
    const settings = { ...BASE, ollamaAutostart: true, provider: 'auto', baseUrl: `http://127.0.0.1:${closed}` };
    await queue.drain(db, settings, { lock: false, sync: false, start });
    await queue.drain(db, settings, { lock: false, sync: false, start });
    assert.equal(starts, 1);
    // An Ollama that runs but does not answer in time (busy loading another app's model) is left alone.
    setMeta(db, 'ollama_start_at', 0);
    const slow = http.createServer(() => { /* never answers */ });
    await new Promise((r) => { slow.listen(0, '127.0.0.1', r); });
    try {
      await queue.drain(db, { ...settings, baseUrl: `http://127.0.0.1:${slow.address().port}` }, { lock: false, sync: false, start });
    } finally { slow.closeAllConnections(); slow.close(); }
    assert.equal(starts, 1);
    // Never one on another machine.
    setMeta(db, 'ollama_start_at', 0);
    await queue.drain(db, { ...settings, baseUrl: 'http://192.0.2.1:9' }, { lock: false, sync: false, start });
    assert.equal(starts, 1);
    // An LLM down for a while shows at session start.
    setMeta(db, 'llm_down', JSON.stringify({ since: Date.now() - 3600000, ms: 3600000, at: Date.now(), reason: 'fetch failed' }));
    assert.match(queue.downNotice(db), /has not answered since .* \(fetch failed\)\. 0 queue item\(s\) wait/);
  } finally { db.close(); }
});

test('the log rotates past 5 MB', () => {
  const file = dataPath('logs', 'open-mem.log');
  log('info', 'first');
  fs.appendFileSync(file, 'x'.repeat(5 * 1024 * 1024 + 1));
  log('info', 'after rotation');
  assert.ok(fs.statSync(`${file}.1`).size > 5 * 1024 * 1024);
  assert.match(fs.readFileSync(file, 'utf8'), /^\S+ \[info\] after rotation\n$/);
});

test('a client reports its queue: once a minute, at once when the pause changes; the server keeps it per device', async () => {
  const db = openDb(path.join(TMP, 'status.db'));
  try {
    const sent = [];
    const send = async (method, route, body) => { sent.push([method, route, body]); };
    const read = async () => ({ list: [{ name: 'RTX 3060', memUsedMb: 4000, memTotalMb: 12288 }] });
    const paused = { pending: 5, oldest: 1, failed: 0, pause: { kind: 'marker', detail: 'securitymodel train', since: 1 }, down: null };
    assert.equal(await sync.reportStatus(db, send, { queue: paused, withGpus: true, now: 1e6, read }), true);
    assert.equal(await sync.reportStatus(db, send, { queue: { ...paused, pending: 9 }, now: 1e6 + 1000, read }), false);
    assert.equal(await sync.reportStatus(db, send, { queue: { ...paused, pause: null }, now: 1e6 + 2000, read }), true);
    assert.equal(await sync.reportStatus(db, send, { queue: { ...paused, pause: null }, now: 1e6 + 63000, read }), true);
    assert.deepEqual(sent.map(([m, r, b]) => `${m} ${r} ${b.gpus ? 'gpu' : '-'}`), ['POST /api/client gpu', 'POST /api/client -', 'POST /api/client -']);

    const stored = sync.storeClientStatus(db, 'torre', { queue: { ...paused, pause: { kind: 'evil', detail: 'x' }, down: { since: 2, ms: 3, reason: 'r'.repeat(500) } }, gpus: sent[0][2].gpus }, 5000);
    assert.equal(stored.pause, null, 'unknown pause kinds are dropped');
    assert.equal(stored.down.reason.length, 300);
    sync.storeClientStatus(db, 'torre', { queue: paused }, 6000);
    assert.deepEqual(sync.clientStatuses(db, 7000).map((s) => [s.device, s.pending, s.pause.detail]), [['torre', 5, 'securitymodel train']]);
    assert.deepEqual(sync.clientStatuses(db, 6000 + 15 * 864e5), []);

    sync.storeClientStatus(db, 'torre', { queue: paused });
    const { overview } = await import('../src/views.mjs');
    const o = overview(db, { ...BASE, mode: 'local', deviceName: 'pi' });
    assert.deepEqual(o.queues.map((q) => [q.device, q.pending, q.pause?.kind]), [['torre', 5, 'marker']]);
  } finally { db.close(); }
});

test('guard: a marker closes the door; a call whose model does not fit is refused; only open-mem\'s models are freed', async () => {
  const o = await fakeOllama({ loaded: ['qwen3:8b', 'gemma3:4b'] });
  const state = { pause: null, fits: true };
  const settings = { ...BASE, baseUrl: o.url, guardAllow: ['127.0.0.1'], guardPort: 0, guardPollSeconds: 0.05, model: 'gemma3:12b', embedModel: 'embeddinggemma' };
  const guard = await startGuard(settings, {
    busy: async () => null,
    paused: () => state.pause,
    plan: async (s, { model }) => (state.fits ? { model } : { pause: { kind: 'gpu', detail: `${model} does not fit` } }),
  });
  const url = `http://127.0.0.1:${guard.address().port}`;
  const chat = (model) => fetch(`${url}/api/chat`, { method: 'POST', body: JSON.stringify({ model, messages: [] }) });
  try {
    assert.equal((await chat('gemma3:4b')).status, 200);
    state.fits = false;
    await new Promise((r) => { setTimeout(r, 5100); }); // past the reuse window of the last decision
    const refused = await chat('gemma3:4b');
    assert.equal(refused.status, 503);
    assert.equal((await refused.json()).error, 'GPU busy: gemma3:4b does not fit');
    state.pause = { kind: 'marker', detail: 'securitymodel train' };
    await new Promise((r) => { setTimeout(r, 100); });
    const closed = await fetch(`${url}/api/tags`);
    assert.equal(closed.status, 503);
    assert.equal((await closed.json()).error, 'GPU busy: securitymodel train');
    const unloaded = o.calls.filter((c) => c.route === '/api/generate').map((c) => c.body.model);
    assert.ok(unloaded.includes('gemma3:4b'), 'a model the server used through the door');
    assert.ok(!unloaded.includes('qwen3:8b'), 'never another app\'s');
  } finally { guard.closeAllConnections(); guard.close(); o.close(); }
});

test('drain: Ollama errors wait instead of burning the attempts in a row; a refused call (503) costs none', async () => {
  const db = openDb(path.join(TMP, 'errors.db'));
  const free = async (s, { model }) => ({ model, unload: [] });
  try {
    enqueueReads(db, 1);
    const failing = await fakeOllama({ chatStatus: 500 });
    try {
      assert.equal(await queue.drain(db, BASE, { lock: false, sync: false, provider: { kind: 'ollama', model: 'gemma3:12b', baseUrl: failing.url }, plan: free }), 0);
      assert.deepEqual({ ...db.prepare('SELECT status, attempts FROM queue').get() }, { status: 'pending', attempts: 1 });
      assert.equal(queue.queueState(db).pause.kind, 'error');
      assert.equal(failing.calls.filter((c) => c.route === '/api/chat').length, 1, 'one call, then a wait');
    } finally { failing.close(); }
    setMeta(db, 'llm_backoff', '');
    setMeta(db, 'pause', '');
    const closed = await fakeOllama({ chatStatus: 503 });
    try {
      await queue.drain(db, BASE, { lock: false, sync: false, provider: { kind: 'ollama', model: 'gemma3:12b', baseUrl: closed.url }, plan: free });
      assert.deepEqual({ ...db.prepare('SELECT status, attempts FROM queue').get() }, { status: 'pending', attempts: 1 });
    } finally { closed.close(); }
  } finally { db.close(); }
});

test('drain: while a marker holds, Ollama is not even asked; a reply without a title is retried, not dropped', async () => {
  const db = openDb(path.join(TMP, 'early.db'));
  const o = await fakeOllama({ reply: '{"skip": false, "type": "bugfix", "subt' });
  const dir = path.join(TMP, 'early-markers');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const prompt = store.addPrompt(db, { sessionId: 'se', project: 'p8', cwd: '/x/p8', text: 'cambia' });
    queue.enqueue(db, 'observation', 'se', 'p8', { tool: 'Edit', input: { file_path: '/x/app.conf' }, output: 'ok', prompt_number: prompt, at: 5000 });
    setMeta(db, 'llm_model', 'gemma3:4b');
    fs.writeFileSync(path.join(dir, 'train'), '');
    const settings = { ...BASE, provider: 'auto', baseUrl: o.url, busyFiles: [dir] };
    assert.equal(await queue.drain(db, settings, { lock: false, sync: false }), 0);
    assert.deepEqual(o.calls.map((c) => c.route), ['/api/ps'], 'only the unload of its own models');
    assert.equal(queue.queueState(db).pause.detail, 'train');
    fs.rmSync(path.join(dir, 'train'));
    setMeta(db, 'pause', '');
    // The cut reply salvages to {"skip": false, "type": "bugfix"}: no title, so each try is a failed attempt, and after
    // the last one the edit is stored without the LLM instead of vanishing.
    assert.equal(await queue.drain(db, { ...settings, gpuBudget: false }, { lock: false, sync: false }), 1);
    assert.equal(o.calls.filter((c) => c.route === '/api/chat').length, 3);
    const row = db.prepare("SELECT title, created_at, json_extract(metadata, '$.compressed') compressed FROM observations WHERE session_id = 'se'").get();
    assert.deepEqual({ ...row }, { title: 'Edit: /x/app.conf', created_at: 5000, compressed: 0 });
  } finally { o.close(); db.close(); }
});
