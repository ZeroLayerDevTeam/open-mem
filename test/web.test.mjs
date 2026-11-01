import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'open-mem-web-'));
process.env.CLAUDE_OPEN_MEM_DATA_DIR = path.join(TMP, 'data');

const { DEFAULT_SETTINGS } = await import('../src/config.mjs');
const { openDb } = await import('../src/db.mjs');
const items = await import('../src/items.mjs');
const store = await import('../src/store.mjs');
const views = await import('../src/views.mjs');
const auth = await import('../src/auth.mjs');
const { serve } = await import('../src/server.mjs');

const NO_LLM = { ...DEFAULT_SETTINGS, provider: 'none' };
const T0 = Date.UTC(2026, 9, 1, 10);

// 120 observations and 12 summaries over two projects; imported-style sessions (no row in `sessions`).
function seed(file) {
  const db = openDb(file);
  for (let i = 0; i < 120; i++) {
    store.insertObservation(db, {
      project: i % 3 ? 'alpha' : 'beta', session_id: `s${i % 6}`, prompt_number: 1 + (i % 4), type: i % 5 ? 'discovery' : 'bugfix',
      title: `Observation ${i} about ${i % 2 ? 'nginx certificates' : 'postgres backups'}`, narrative: `Details of record ${i}`,
      device: i % 2 ? 'laptop' : 'desktop', created_at: T0 + i * 60000, source: 'claude-mem', source_id: String(i),
    });
  }
  for (let i = 0; i < 12; i++) {
    store.insertSummary(db, { project: 'alpha', session_id: `s${i % 6}`, prompt_number: 1, request: `Summary ${i}`, completed: 'done things',
      created_at: T0 + i * 600000 + 30000, source: 'claude-mem', source_id: String(i) });
  }
  db.prepare(`INSERT INTO prompts (session_id, project, prompt_number, text, created_at, source, source_id)
    VALUES ('s0', 'alpha', 1, 'Rotate the nginx certificates please', ?, 'claude-mem', '1')`).run(T0 - 1000);
  return db;
}

test('schema v4 adds the web viewer indexes', () => {
  const db = openDb(path.join(TMP, 'schema.db'));
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name);
  for (const n of ['obs_session', 'sum_session', 'sum_time', 'obs_device']) assert.ok(names.includes(n), n);
  db.close();
});

test('timeline: numbered pages over observations, summaries and events, newest first', () => {
  const db = seed(path.join(TMP, 'feed.db'));
  items.addItem(db, { kind: 'task', title: 'Renew certs', project: 'alpha', created_at: T0 + 5 });
  const p1 = views.feed(db, { pageSize: 50 });
  assert.equal(p1.total, 133);
  assert.equal(p1.rows.length, 50);
  assert.equal(p1.rows[0].title, 'Observation 119 about nginx certificates');
  const all = [1, 2, 3].flatMap((page) => views.feed(db, { page, pageSize: 50 }).rows);
  assert.equal(all.length, 133);
  assert.equal(new Set(all.map((r) => `${r.kind}${r.event_id ?? r.id}`)).size, 133, 'no record repeated across pages');
  assert.ok(all.every((r, i) => !i || all[i - 1].at >= r.at), 'sorted newest first');
  const ev = all.at(-2);
  assert.deepEqual([ev.kind, ev.event, ev.title, all.at(-1).title], ['event', 'created', 'Renew certs', 'Observation 0 about postgres backups']);
  assert.equal(views.feed(db, { project: 'beta' }).total, 40);
  assert.equal(views.feed(db, { kinds: 'sum' }).total, 12);
  assert.equal(views.feed(db, { device: 'laptop', kinds: 'obs' }).total, 60);
  assert.equal(views.feed(db, { before: T0 + 10 * 60000, kinds: 'obs' }).total, 10);
  assert.deepEqual(views.feed(db, { kinds: 'nope' }).rows, []);
  db.close();
});

test('sessions are built from records, so imported ones are listed and open', () => {
  const db = seed(path.join(TMP, 'sessions.db'));
  const page = views.sessions(db, { pageSize: 4 });
  assert.equal(page.total, 6);
  assert.equal(page.rows.length, 4);
  const s0 = views.sessions(db, { q: 'nginx certificates' });
  assert.deepEqual(s0.rows.map((r) => r.session_id), ['s0']);
  assert.equal(s0.rows[0].first_prompt, 'Rotate the nginx certificates please');
  assert.equal(s0.rows[0].first_request, 'Summary 0');
  assert.equal(s0.rows[0].prompts, 1);
  // s0 holds 20 beta observations and 3 alpha records: it counts for both projects, and its own is beta.
  assert.equal(s0.rows[0].project, 'beta');
  assert.deepEqual(s0.rows[0].projects.sort(), ['alpha', 'beta']);
  assert.equal(views.sessions(db, { project: 'beta' }).total, 2);
  assert.equal(views.sessions(db, { project: 'ALPHA' }).total, 6);
  assert.equal(views.projects(db).find((p) => p.project === 'beta').sessions, 2);
  const detail = views.sessionDetail(db, 's0');
  assert.equal(detail.observations.length, 20);
  assert.equal(detail.prompts.length, 1);
  assert.equal(views.sessionDetail(db, 'missing'), null);
  // A native session merges with its records.
  store.ensureSession(db, { sessionId: 's1', project: 'alpha', cwd: '/w/alpha', device: 'laptop' });
  assert.equal(views.sessions(db, { q: '' }).total, 6);
  assert.equal(views.sessionDetail(db, 's1').session.cwd, '/w/alpha');
  db.close();
});

test('notes and tasks page with full-text filter and totals', () => {
  const db = openDb(path.join(TMP, 'items.db'));
  for (let i = 0; i < 7; i++) items.addItem(db, { kind: 'note', title: `Note ${i}`, body: i % 2 ? 'about docker compose' : 'about pnpm', project: 'p' });
  items.addItem(db, { kind: 'task', title: 'Task', project: 'p' });
  assert.equal(views.itemsPage(db, { kind: 'note' }).total, 7);
  assert.equal(views.itemsPage(db, { kind: 'note', pageSize: 3, page: 3 }).rows.length, 1);
  assert.equal(views.itemsPage(db, { kind: 'note', q: 'docker' }).total, 3);
  assert.equal(views.itemsPage(db, { status: 'open' }).total, 8);
  items.updateItem(db, 1, { status: 'archived' });
  assert.equal(views.itemsPage(db, { kind: 'note', status: 'active' }).total, 6);
  assert.equal(views.itemsPage(db, { q: '!!!' }).total, 0);
  db.close();
});

test('search pages: total from full-text counts, excerpt per result', async () => {
  const db = seed(path.join(TMP, 'find.db'));
  assert.equal(store.searchCount(db, { query: 'nginx' }), 60);
  assert.equal(store.searchCount(db, { query: 'nginx zzzz' }), 60, 'falls back to any word like search()');
  assert.equal(store.searchCount(db, { kind: 'observations', type: 'bugfix' }), 24);
  const p2 = await views.find(db, { query: 'nginx', page: 2, pageSize: 25 }, NO_LLM);
  assert.equal(p2.total, 60);
  assert.equal(p2.rows.length, 25);
  assert.equal(p2.rows[0].snippet.startsWith('Details of record'), true);
  const seen = new Set();
  for (let page = 1; page <= 3; page++) for (const r of (await views.find(db, { query: 'nginx', page, pageSize: 25 }, NO_LLM)).rows) seen.add(r.id);
  assert.equal(seen.size, 60);
  const browse = await views.find(db, { kind: 'summaries', pageSize: 5 }, NO_LLM);
  assert.equal(browse.total, 12);
  assert.equal(browse.rows[0].kind, 'sum');
  db.close();
});

test('server: paged routes, facets, gzip, the ui module', async () => {
  const db = seed(path.join(TMP, 'srv.db'));
  const server = await serve(db, NO_LLM, { host: '127.0.0.1', port: 0 });
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const token = auth.createAdminToken(db);
    const login = await fetch(`${url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const get = (p) => fetch(`${url}${p}`, { headers: { cookie } }).then((r) => r.json());
    const feed = await get('/api/feed?page=2&size=20&project=alpha');
    assert.equal(feed.total, 92);
    assert.equal(feed.page, 2);
    assert.equal(feed.rows.length, 20);
    assert.equal((await get('/api/sessions?size=2')).total, 6);
    assert.equal((await get('/api/find?q=postgres&kind=observations')).total, 60);
    assert.equal((await get('/api/items?kind=note')).total, 0);
    const facets = await get('/api/facets');
    assert.deepEqual(facets.devices, ['desktop', 'laptop']);
    assert.deepEqual(facets.types, ['discovery', 'bugfix']);
    const raw = await fetch(`${url}/api/feed?size=50`, { headers: { cookie, 'accept-encoding': 'gzip' } });
    assert.equal(raw.headers.get('content-encoding'), 'gzip');
    const js = await fetch(`${url}/ui.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
  } finally {
    server.close();
    db.close();
  }
});
