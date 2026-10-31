import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'open-mem-v2-'));
process.env.CLAUDE_OPEN_MEM_DATA_DIR = path.join(TMP, 'data');

const { DEFAULT_SETTINGS } = await import('../src/config.mjs');
const { openDb, SCHEMA_VERSION } = await import('../src/db.mjs');
const items = await import('../src/items.mjs');
const store = await import('../src/store.mjs');
const auth = await import('../src/auth.mjs');
const { serve } = await import('../src/server.mjs');
const { pushPending } = await import('../src/sync.mjs');
const { call } = await import('../src/backend.mjs');

test('v1 database migrates to v2 without losing rows', () => {
  const file = path.join(TMP, 'v1.db');
  const v1 = new DatabaseSync(file);
  v1.exec(`CREATE TABLE observations (id INTEGER PRIMARY KEY, session_id TEXT, project TEXT, prompt_number INTEGER, type TEXT, title TEXT,
      subtitle TEXT, narrative TEXT, facts TEXT, concepts TEXT, files_read TEXT, files_modified TEXT, tool TEXT, created_at INTEGER,
      source TEXT NOT NULL DEFAULT 'native', source_id TEXT, UNIQUE (source, source_id));
    INSERT INTO observations (project, title, narrative, created_at) VALUES ('old', 'Vieja observación', 'texto', 1);`);
  v1.close();
  const db = openDb(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assert.equal(db.prepare('SELECT count(*) n FROM observations').get().n, 1);
  const cols = db.prepare('PRAGMA table_info(observations)').all().map((c) => c.name);
  for (const c of ['device', 'git_branch', 'git_commit', 'cwd', 'model', 'metadata', 'synced_at']) assert.ok(cols.includes(c), c);
  // Updating a sync column must not touch the FTS index (column-scoped trigger).
  db.prepare('UPDATE observations SET synced_at = 5').run();
  db.exec('INSERT INTO obs_fts (obs_fts) VALUES (\'rebuild\')');
  assert.equal(store.search(db, { query: 'vieja' }).length, 1);
  db.close();
});

test('notes and tasks: create, status history, list, search, context', () => {
  const db = openDb();
  const id = items.addItem(db, { kind: 'task', title: 'Migrar backup a Linux', project: 'infra', directory: '/srv/infra', priority: 1, device: 'torre' });
  items.addItem(db, { kind: 'note', title: 'Usar pnpm siempre', body: 'nunca npm', project: 'infra' });
  assert.throws(() => items.addItem(db, { kind: 'task', title: 'x', status: 'nope' }), /Invalid task status/);
  assert.throws(() => items.addItem(db, { kind: 'task', title: '  ' }), /title is required/);
  let t = items.updateItem(db, id, { status: 'doing', comment: 'empezado' }, { device: 'torre' });
  assert.equal(t.status, 'doing');
  t = items.updateItem(db, id, { status: 'done' });
  assert.ok(t.completed_at);
  assert.deepEqual(t.events.map((e) => e.event), ['created', 'status', 'status']);
  assert.equal(t.events[1].detail, 'empezado');
  assert.equal(items.listItems(db, { kind: 'task', project: 'INFRA', open: true }).length, 0);
  items.updateItem(db, id, { status: 'todo' });
  assert.equal(t.synced_at, null);
  assert.equal(items.listItems(db, { project: 'infra', open: true }).length, 2);
  assert.equal(items.listItems(db, { directory: '/srv/infra' }).length, 1);
  assert.ok(store.search(db, { query: 'backup linux', kind: 'tasks' }).some((r) => r.kind === 'item' && r.id === id));
  const full = store.formatFull(store.getByRefs(db, [`I${id}`]));
  assert.match(full, /task \[todo\]/);
  assert.match(full, /History:/);
  const ctx = store.contextFor(db, 'infra', DEFAULT_SETTINGS);
  assert.match(ctx.text, /## Open tasks\n- I\d+ \[todo\] Migrar backup/);
  assert.match(ctx.text, /Usar pnpm siempre/);
  assert.match(ctx.text, /task_add \/ task_update/);
  assert.ok(ctx.refs.includes(`I${id}`));
  db.close();
});

test('prompt recall needs two informative words and skips already injected records', () => {
  const db = openDb();
  const a = store.insertObservation(db, { project: 'web', title: 'Certificados nginx caducados en npm-29', created_at: Date.now() });
  store.insertObservation(db, { project: 'web', title: 'Otra cosa sin relación', created_at: Date.now() });
  assert.deepEqual(store.recall(db, { prompt: 'hola', project: 'web' }), []);
  const hits = store.recall(db, { prompt: 'revisa los certificados de nginx por favor', project: 'web' });
  assert.equal(hits[0].id, a);
  assert.match(store.formatRecall(hits), /Certificados nginx/);
  assert.deepEqual(store.recall(db, { prompt: 'revisa los certificados de nginx', project: 'web', exclude: new Set([`${a}`]) })
    .filter((r) => r.id === a && r.kind === 'obs'), []);
  db.close();
});

test('auth: admin token once, hashed; device keys; sessions', () => {
  const db = openDb(path.join(TMP, 'auth.db'));
  const token = auth.createAdminToken(db);
  assert.match(token, /^om_admin_[\w-]{43}$/);
  assert.equal(auth.createAdminToken(db), null, 'never re-issued');
  assert.ok(auth.checkAdminToken(db, token));
  assert.ok(!auth.checkAdminToken(db, `${token}x`));
  assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM meta').all()), new RegExp(token.slice(9, 30)));
  const key = auth.addDevice(db, 'portatil');
  assert.equal(auth.deviceForKey(db, key), 'portatil');
  assert.equal(auth.deviceForKey(db, 'om_dev_wrong'), null);
  assert.throws(() => auth.addDevice(db, 'bad name!'), /Device name/);
  const s = auth.createWebSession(db);
  assert.ok(auth.checkWebSession(db, s.id));
  const reset = auth.createAdminToken(db, { reset: true });
  assert.notEqual(reset, token);
  assert.ok(!auth.checkWebSession(db, s.id), 'reset logs everyone out');
  db.close();
});

async function startServer(file) {
  const db = openDb(file);
  const server = await serve(db, DEFAULT_SETTINGS, { host: '127.0.0.1', port: 0 });
  return { db, server, url: `http://127.0.0.1:${server.address().port}` };
}

test('server: login, protected API, CSRF guard, static page', async () => {
  const { db, server, url } = await startServer(path.join(TMP, 'srv.db'));
  try {
    const token = auth.createAdminToken(db);
    const page = await fetch(`${url}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal((await fetch(`${url}/api/overview`)).status, 401);
    const json = (body, extra = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
    assert.equal((await fetch(`${url}/api/login`, json({ token: 'om_admin_nope' }))).status, 401);
    assert.equal((await fetch(`${url}/api/login`, json({ token }, { origin: 'http://evil.example' }))).status, 403);
    const ok = await fetch(`${url}/api/login`, json({ token }));
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly; SameSite=Strict/);
    const sid = cookie.split(';')[0];
    const add = await fetch(`${url}/api/items/add`, json({ kind: 'task', title: 'Desde la web', project: 'p' }, { cookie: sid }));
    assert.equal(add.status, 200);
    const evil = await fetch(`${url}/api/items/add`, json({ kind: 'task', title: 'csrf' }, { cookie: sid, origin: 'http://evil.example' }));
    assert.equal(evil.status, 403);
    const ov = await (await fetch(`${url}/api/overview`, { headers: { cookie: sid } })).json();
    assert.equal(ov.openTasks[0].title, 'Desde la web');
    const bad = await fetch(`${url}/api/items/add`, json({ kind: 'task', title: '' }, { cookie: sid }));
    assert.equal(bad.status, 400);
    assert.equal((await fetch(`${url}/api/ingest`, json({}, { cookie: sid }))).status, 403, 'ingest is for devices');
  } finally {
    server.close();
    db.close();
  }
});

test('server: login rate limit is per client behind a proxy, not per proxy', async () => {
  const { clientIp } = await import('../src/server.mjs');
  const req = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers });
  assert.equal(clientIp(req('::ffff:172.18.0.5', { 'x-real-ip': '81.2.3.4' })), '81.2.3.4');
  assert.equal(clientIp(req('172.18.0.5', { 'x-forwarded-for': '81.2.3.4, 172.18.0.1' })), '81.2.3.4');
  assert.equal(clientIp(req('81.9.9.9', { 'x-real-ip': '1.1.1.1' })), '81.9.9.9', 'public peers cannot spoof');
  const { db, server, url } = await startServer(path.join(TMP, 'rl.db'));
  try {
    auth.createAdminToken(db);
    const login = (ip) => fetch(`${url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': ip }, body: '{"token":"om_admin_bad"}' });
    for (let i = 0; i < 10; i++) assert.equal((await login('81.0.0.1')).status, 401);
    assert.equal((await login('81.0.0.1')).status, 429);
    assert.equal((await login('81.0.0.2')).status, 401, 'another client is not locked out');
  } finally {
    server.close();
    db.close();
  }
});

test('shared mode: client pushes to server, reads remotely, falls back locally', async () => {
  const { db: sdb, server, url } = await startServer(path.join(TMP, 'shared.db'));
  const key = auth.addDevice(sdb, 'portatil');
  const cdb = openDb(path.join(TMP, 'client.db'));
  const settings = { ...DEFAULT_SETTINGS, mode: 'remote', serverUrl: url, deviceKey: key, deviceName: 'portatil' };
  try {
    store.ensureSession(cdb, { sessionId: 'c1', project: 'shared', cwd: '/w/shared', device: 'portatil', gitBranch: 'main' });
    store.addPrompt(cdb, { sessionId: 'c1', project: 'shared', text: 'configura el servidor compartido' });
    store.insertObservation(cdb, { session_id: 'c1', project: 'shared', title: 'Servidor compartido en casa', device: 'portatil', created_at: Date.now() });
    store.insertSummary(cdb, { session_id: 'c1', project: 'shared', request: 'compartir memoria', created_at: Date.now(), source_id: 'c1:1' });
    const tid = items.addItem(cdb, { kind: 'task', title: 'Probar sync', project: 'shared' });
    const pushed = await pushPending(cdb, settings);
    assert.deepEqual(pushed, { observations: 1, summaries: 1, prompts: 1, items: 1 });
    assert.deepEqual(await pushPending(cdb, settings), { observations: 0, summaries: 0, prompts: 0, items: 0 }, 'nothing twice');
    const o = sdb.prepare("SELECT source, device FROM observations WHERE project = 'shared'").get();
    assert.equal(o.source, 'native@portatil');
    assert.equal(sdb.prepare("SELECT git_branch FROM sessions WHERE session_id = 'c1'").get().git_branch, 'main');
    // Editing the task re-syncs it, replacing the server copy (no duplicates).
    items.updateItem(cdb, tid, { status: 'done' });
    await pushPending(cdb, settings);
    const rows = sdb.prepare("SELECT status FROM items WHERE title = 'Probar sync'").all();
    assert.deepEqual(rows.map((r) => r.status), ['done']);
    // Reads go to the server.
    const r = await call('search', { query: 'compartido' }, { db: () => cdb, settings });
    assert.equal(r.remote, true);
    assert.ok(r.result.length >= 1);
    const added = await call('itemAdd', { kind: 'note', title: 'Nota remota', project: 'shared' }, { db: () => cdb, settings });
    assert.equal(sdb.prepare('SELECT device FROM items WHERE id = ?').get(added.result.id).device, 'portatil');
    // Wrong key is an auth error, not a silent fallback.
    await assert.rejects(call('search', { query: 'x' }, { db: () => cdb, settings: { ...settings, deviceKey: 'om_dev_bad' } }), /401/);
  } finally {
    server.close();
  }
  const down = await call('search', { query: 'compartido' }, { db: () => cdb, settings });
  assert.equal(down.fallback, true);
  assert.ok(down.result.length >= 1, 'local copy still answers');
  cdb.close();
  sdb.close();
});
