import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'open-mem-guard-'));
process.env.CLAUDE_OPEN_MEM_DATA_DIR = path.join(TMP, 'data');
const { DEFAULT_SETTINGS } = await import('../src/config.mjs');
const { startGuard } = await import('../src/guard.mjs');
const { resolveProvider } = await import('../src/llm.mjs');
const { embed } = await import('../src/semantic.mjs');

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// A fake Ollama. /api/chat hangs until released, so a call can be caught in flight.
async function fakeOllama() {
  const seen = [];
  let release = null;
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (req.url === '/api/tags') return json({ models: [{ name: 'gemma3:12b' }] });
      if (req.url === '/api/embed') return json({ echo: JSON.parse(body), embeddings: [[3, 4]] });
      if (req.url === '/api/chat') { release = () => json({ message: { content: '{}' } }); return undefined; }
      return json({});
    });
  });
  await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
  return { server, seen, url: `http://127.0.0.1:${server.address().port}`, release: () => release?.() };
}

async function setup({ allow = ['127.0.0.1'], pollSeconds = 0.05 } = {}) {
  const ollama = await fakeOllama();
  const state = { busy: null, looks: 0, unloads: 0 };
  const settings = { ...DEFAULT_SETTINGS, baseUrl: ollama.url, guardAllow: allow, guardPort: 0, guardPollSeconds: pollSeconds };
  const guard = await startGuard(settings, {
    busy: async () => { state.looks++; return state.busy; },
    unload: async () => { state.unloads++; return []; },
  });
  const url = `http://127.0.0.1:${guard.address().port}`;
  return { ollama, state, guard, url, close: () => { guard.closeAllConnections(); guard.close(); ollama.server.closeAllConnections(); ollama.server.close(); } };
}

test('idle: the routes a server needs reach Ollama, and the shared LLM code works through it', async () => {
  const g = await setup();
  try {
    assert.equal((await resolveProvider({ provider: 'auto', baseUrl: g.url })).kind, 'ollama');
    const res = await fetch(`${g.url}/api/embed`, { method: 'POST', body: JSON.stringify({ input: ['x'] }) });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).echo, { input: ['x'] });
    assert.deepEqual([...await embed({ baseUrl: g.url, embedModel: 'm' }, ['q'])].length, 1);
  } finally { g.close(); }
});

test('only the addresses in guardAllow get in, and never to pull or delete models', async () => {
  const stranger = await setup({ allow: ['10.9.9.9'] });
  try {
    assert.equal((await fetch(`${stranger.url}/api/tags`)).status, 403);
    assert.deepEqual(stranger.ollama.seen, []);
  } finally { stranger.close(); }
  const g = await setup();
  try {
    for (const [method, route] of [['POST', '/api/pull'], ['DELETE', '/api/delete'], ['POST', '/api/create'], ['GET', '/']]) {
      assert.equal((await fetch(`${g.url}${route}`, { method })).status, 404, route);
    }
    assert.deepEqual(g.ollama.seen, []);
  } finally { g.close(); }
});

test('a game closes the door, frees the GPU, and the door opens when it ends', async () => {
  const g = await setup();
  try {
    g.state.busy = 'D:\\SteamLibrary\\steamapps\\common\\Game\\game.exe';
    const res = await fetch(`${g.url}/api/tags`);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'GPU busy: game.exe');
    assert.deepEqual(g.ollama.seen, []);
    assert.ok(g.state.unloads >= 1);
    // The server's code reads a closed door as an LLM that is down: records wait, search stays full-text.
    const provider = await resolveProvider({ provider: 'auto', baseUrl: g.url });
    assert.equal(provider.kind, 'none');
    assert.equal(provider.unreachable, true);
    await assert.rejects(embed({ baseUrl: g.url, embedModel: 'm' }, ['q']), /HTTP 503/);
    g.state.busy = null;
    await sleep(100);
    assert.equal((await fetch(`${g.url}/api/tags`)).status, 200);
  } finally { g.close(); }
});

test('a game that starts during a call cuts it, without waiting for the answer', async () => {
  const g = await setup();
  try {
    const call = fetch(`${g.url}/api/chat`, { method: 'POST', body: '{}' });
    while (!g.ollama.seen.includes('POST /api/chat')) await sleep(5);
    g.state.busy = 'game.exe';
    await assert.rejects(call, /fetch failed/);
    assert.ok(g.state.unloads >= 1);
  } finally { g.close(); }
});

test('nobody using the door: no process listing at all', async () => {
  const g = await setup();
  try {
    await sleep(200);
    assert.equal(g.state.looks, 0);
  } finally { g.close(); }
});

test('a guard without allowed addresses refuses to start', () => {
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');
  const r = spawnSync(process.execPath, ['--no-warnings', cli, 'guard'], { encoding: 'utf8', env: { ...process.env, CLAUDE_OPEN_MEM_DATA_DIR: path.join(TMP, 'cli') } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /guardAllow/);
});
