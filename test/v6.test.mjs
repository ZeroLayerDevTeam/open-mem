import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'open-mem-v6-'));
process.env.CLAUDE_OPEN_MEM_DATA_DIR = path.join(TMP, 'data');

const { DEFAULT_SETTINGS, dataPath } = await import('../src/config.mjs');
const { backupDb, openDb } = await import('../src/db.mjs');
const store = await import('../src/store.mjs');
const { drain, findLessons, projectsForLessons } = await import('../src/queue.mjs');

test('backup: consistent copy while another connection holds a write transaction open', () => {
  const file = path.join(TMP, 'live.db');
  const db = openDb(file);
  store.insertObservation(db, { project: 'p', type: 'discovery', title: 'kept in the copy', created_at: 1 });
  const writer = new DatabaseSync(file);
  writer.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
  writer.exec("INSERT INTO meta (key, value) VALUES ('uncommitted', '1')");
  try {
    const dest = path.join(TMP, 'out', 'copy.db');
    assert.ok(backupDb(db, dest) > 0);
    const copy = new DatabaseSync(dest, { readOnly: true });
    assert.equal(copy.prepare('SELECT count(*) n FROM observations').get().n, 1);
    assert.equal(copy.prepare("SELECT count(*) n FROM meta WHERE key = 'uncommitted'").get().n, 0);
    copy.close();
    assert.throws(() => backupDb(db, dest), /already exists/);
  } finally {
    writer.exec('ROLLBACK');
    writer.close();
    db.close();
  }
});

test('recall usefulness: fetched or worked-on records count as used, never-used ones get muted', () => {
  const db = openDb(path.join(TMP, 'recall.db'));
  const a = store.insertObservation(db, { project: 'p', type: 'bugfix', title: 'Restore fails on locked database file',
    files_modified: JSON.stringify(['C:\\repo\\src\\db.mjs']), created_at: 1 });
  const b = store.insertObservation(db, { project: 'p', type: 'discovery', title: 'Restore database notes from backups', created_at: 2 });
  const rows = store.recall(db, { prompt: 'restore the locked database', project: 'p' });
  assert.deepEqual(rows.find((r) => r.id === a).files, ['C:\\repo\\src\\db.mjs']);
  for (let s = 1; s <= 5; s++) {
    store.logRecall(db, `s${s}`, rows);
    store.logRecall(db, `s${s}`, rows); // the same session never counts twice
  }
  store.markRecallUsed(db, 's1', { file: 'c:/REPO/src/db.mjs' });
  assert.deepEqual(store.mutedRefs(db, 5), [String(b)]);
  assert.deepEqual(store.mutedRefs(db, 6), []);
  assert.deepEqual(store.mutedRefs(db, 0), []);
  store.markRecallUsed(db, 's2', { refs: [b] });
  assert.deepEqual(store.mutedRefs(db, 5), []);
  assert.deepEqual(store.recallStats(db, 5), { shown: 10, used: 2, sessions: 5, muted: 0 });
  db.prepare('UPDATE recall_log SET shown_at = 0').run();
  assert.equal(store.pruneRecallLog(db), 10);
  db.close();
});

test('lessons: only mistakes fixed in two different sessions, known ids only', async () => {
  const db = openDb(path.join(TMP, 'lessons.db'));
  const now = Date.now();
  const x = store.insertObservation(db, { project: 'p', session_id: 'one', type: 'bugfix', title: 'ssh from Git Bash denied', created_at: now - 2000 });
  const y = store.insertObservation(db, { project: 'p', session_id: 'two', type: 'bugfix', title: 'ssh from Git Bash denied again', created_at: now - 1000 });
  const z = store.insertObservation(db, { project: 'p', session_id: 'two', type: 'bugfix', title: 'same session twice', created_at: now });
  const reply = { lessons: [{ ids: [x, `${y}`, 999], rule: 'Run ssh from PowerShell, not Git Bash.' }, { ids: [y, z], rule: 'one session only' }] };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => res.end(JSON.stringify({ message: { content: JSON.stringify(reply) } })));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const found = await findLessons(db, 'p', { kind: 'ollama', model: 'm', baseUrl: `http://127.0.0.1:${server.address().port}` }, DEFAULT_SETTINGS);
    assert.deepEqual(found, [{ ids: [String(x), String(y)], rule: 'Run ssh from PowerShell, not Git Bash.' }]);
    assert.deepEqual(store.lessons(db, 'P').lessons, found);
  } finally { server.close(); db.close(); }
});

test('lessons: a project with fixes from a single session never reaches the LLM', () => {
  const db = openDb(path.join(TMP, 'lessons-scope.db'));
  const now = Date.now();
  for (let i = 0; i < 4; i++) {
    store.insertObservation(db, { project: 'solo', session_id: 'one', type: 'bugfix', title: `solo fix ${i}`, created_at: now - i });
    store.insertObservation(db, { project: 'many', session_id: `s${i % 2}`, type: 'bugfix', title: `many fix ${i}`, created_at: now - i });
  }
  assert.deepEqual(projectsForLessons(db), ['many']);
  db.close();
});

test('drain: a second run in the same process (a slow serve tick) keeps out and leaves the lock alone', async () => {
  const db = openDb(path.join(TMP, 'overlap.db'));
  const settings = { ...DEFAULT_SETTINGS, mode: 'remote', serverUrl: 'http://127.0.0.1:1' };
  let open;
  const gate = new Promise((r) => { open = r; });
  let pushes = 0;
  const options = { provider: { kind: 'none' }, push: () => (++pushes === 1 ? gate : undefined) };
  const first = drain(db, settings, options);
  while (!pushes) await new Promise((r) => setTimeout(r, 5));
  assert.equal(await drain(db, settings, options), 0);
  assert.equal(pushes, 1);
  assert.equal(fs.readFileSync(dataPath('drain.lock'), 'utf8'), String(process.pid));
  open();
  await first;
  assert.equal(fs.existsSync(dataPath('drain.lock')), false);
  await drain(db, settings, options); // free again once the first run is over
  assert.equal(pushes, 2);
  db.close();
});
