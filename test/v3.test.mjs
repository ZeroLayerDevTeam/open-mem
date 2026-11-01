import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'open-mem-v3-'));
process.env.CLAUDE_OPEN_MEM_DATA_DIR = path.join(TMP, 'data');

const { DEFAULT_SETTINGS } = await import('../src/config.mjs');
const { openDb, setMeta } = await import('../src/db.mjs');
const items = await import('../src/items.mjs');
const store = await import('../src/store.mjs');
const semantic = await import('../src/semantic.mjs');
const { reviewNotes } = await import('../src/queue.mjs');
const { branchWarning, workdayStart } = await import('../src/meta.mjs');
const { itemsMarkdown, exportFileName } = await import('../src/export.mjs');

// A fake Ollama: /api/embed maps each text to a vector by its keywords; /api/chat answers the notes review.
const TOPICS = ['database', 'gpu', 'backup'];
function fakeOllama(chatReply) {
  const calls = { embed: 0, chat: 0 };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/embed') {
        calls.embed++;
        const vec = (t) => { const v = TOPICS.map((k) => (String(t).toLowerCase().includes(k) ? 1 : 0)); v.push(0.01); return v; };
        return res.end(JSON.stringify({ embeddings: body.input.map(vec) }));
      }
      if (req.url === '/api/chat') { calls.chat++; return res.end(JSON.stringify({ message: { content: JSON.stringify(chatReply) } })); }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` })));
}

test('v3 embeddings: pending records are embedded, a changed or deleted record loses its vector', async () => {
  const db = openDb(path.join(TMP, 'emb.db'));
  const o = await fakeOllama({});
  const settings = { ...DEFAULT_SETTINGS, baseUrl: o.url, embedModel: 'fake-embed' };
  try {
    const a = store.insertObservation(db, { project: 'p', type: 'discovery', title: 'Postgres database restore', created_at: 1 });
    store.insertObservation(db, { project: 'p', type: 'discovery', title: 'GPU stutter while gaming', created_at: 2 });
    const note = items.addItem(db, { kind: 'note', title: 'Nightly backup to the NAS', project: 'p' });
    assert.equal(semantic.countPending(db), 3);
    assert.equal(await semantic.embedPending(db, settings, { batch: 2 }), 3);
    assert.equal(semantic.countPending(db), 0);
    const vec = db.prepare('SELECT vec FROM embeddings WHERE ref = ?').get(String(a)).vec;
    assert.equal(vec.byteLength, 4 * 4); // 4 dims from the fake, normalized
    items.updateItem(db, note, { body: 'every night at 19:00' });
    db.prepare('DELETE FROM observations WHERE id = ?').run(a);
    assert.equal(db.prepare('SELECT count(*) n FROM embeddings').get().n, 1);
    assert.equal(semantic.countPending(db), 1);
    // Another model's vectors are dropped and redone.
    assert.equal(await semantic.embedPending(db, { ...settings, embedModel: 'other' }), 2);
    assert.equal(db.prepare("SELECT count(*) n FROM embeddings WHERE model = 'other'").get().n, 2);
  } finally { o.server.close(); db.close(); }
});

test('hybrid search finds records by meaning and falls back to full-text', async () => {
  const db = openDb(path.join(TMP, 'hyb.db'));
  const o = await fakeOllama({});
  const settings = { ...DEFAULT_SETTINGS, baseUrl: o.url, embedModel: 'fake-embed' };
  try {
    const gpu = store.insertObservation(db, { project: 'games', type: 'bugfix', title: 'Stutter fixed', narrative: 'the gpu was busy with the llm', created_at: 1 });
    store.insertObservation(db, { project: 'infra', type: 'discovery', title: 'Database dump size', created_at: 2 });
    await semantic.embedPending(db, settings);
    // "gpu" only appears in the narrative of one record, "stutter" in its title: both ways find it.
    const rows = await semantic.hybridSearch(db, { query: 'gpu' }, settings);
    assert.equal(rows[0].id, gpu);
    assert.ok((await semantic.hybridSearch(db, { query: 'gpu', project: 'infra' }, settings)).every((r) => r.project === 'infra'));
    // A game running (cached busy answer): no embedding call, full-text only.
    const before = o.calls.embed;
    setMeta(db, 'busy_seen_at', Date.now());
    await semantic.hybridSearch(db, { query: 'gpu' }, settings);
    assert.equal(o.calls.embed, before);
    setMeta(db, 'busy_seen_at', 0);
    // Ollama gone: full-text.
    o.server.close();
    const fts = await semantic.hybridSearch(db, { query: 'database' }, { ...settings, baseUrl: 'http://127.0.0.1:9' });
    assert.equal(fts.length, 1);
  } finally { o.server.close(); db.close(); }
});

test('first session of the day recaps the last stretch of work across projects', () => {
  const db = openDb(path.join(TMP, 'recap.db'));
  const h = 3600000;
  const until = Date.UTC(2026, 10, 2, 5);
  const add = (project, request, at) => store.insertSummary(db, { project, request, completed: 'ok', created_at: at, source_id: `${project}${at}` });
  add('old', 'Two days ago', until - 50 * h);
  add('ccm', 'Fix the code warning', until - 4 * h);
  add('corvus', 'Download tool', until - 2 * h);
  add('today', 'Already today', until + h);
  const recap = store.recapBefore(db, until);
  assert.deepEqual(recap.map((r) => r.project), ['corvus', 'ccm']);
  const ctx = store.contextFor(db, 'ccm', DEFAULT_SETTINGS, { recap: { until, tz: -60 } });
  assert.match(ctx.text, /## Last working session \(2026-11-02, every project\)/);
  assert.match(ctx.text, /S\d+ 04:00 · corvus: Download tool/);
  assert.doesNotMatch(store.contextFor(db, 'ccm', DEFAULT_SETTINGS, {}).text, /Last working session/);
  const start = workdayStart(new Date(2026, 10, 2, 3, 0).getTime());
  assert.equal(new Date(start).getDate(), 1);
  assert.equal(new Date(start).getHours(), 5);
  db.close();
});

test('notes review keeps known ids and shows the flags at session start', async () => {
  const db = openDb(path.join(TMP, 'review.db'));
  const a = items.addItem(db, { kind: 'note', title: 'Backups go to C:\\backups', project: 'infra' });
  const b = items.addItem(db, { kind: 'note', title: 'Backups go to /mnt/torre', project: 'infra' });
  const o = await fakeOllama({ flags: [{ ids: [`I${a}`, `${b}`, 'I999'], kind: 'outdated', reason: 'The laptop moved to Linux.' }, { ids: ['I998'], reason: 'unknown' }] });
  try {
    const flags = await reviewNotes(db, 'infra', { kind: 'ollama', model: 'm', baseUrl: o.url }, DEFAULT_SETTINGS);
    assert.deepEqual(flags, [{ ids: [`I${a}`, `I${b}`], kind: 'outdated', reason: 'The laptop moved to Linux.' }]);
    const text = store.contextFor(db, 'infra', DEFAULT_SETTINGS).text;
    assert.match(text, /## Notes that may need fixing/);
    assert.match(text, new RegExp(`I${a}, I${b} outdated: The laptop moved to Linux\\.`));
  } finally { o.server.close(); db.close(); }
});

test('branch warning: merged branch, branch with own commits, default branch', () => {
  const run = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' });
  const origin = path.join(TMP, 'origin.git');
  const repo = path.join(TMP, 'repo');
  run(TMP, 'init', '-q', '--bare', '-b', 'main', origin);
  run(TMP, 'clone', '-q', origin, repo);
  const commit = (msg) => { fs.writeFileSync(path.join(repo, 'f.txt'), msg); run(repo, 'add', '.'); run(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg); };
  commit('one');
  run(repo, 'push', '-q', 'origin', 'main');
  run(repo, 'remote', 'set-head', 'origin', 'main');
  assert.equal(branchWarning(repo, 'main'), null);
  run(repo, 'switch', '-qc', 'feat/x');
  commit('two');
  assert.match(branchWarning(repo, 'feat/x'), /branch "feat\/x" with 1 commit\(s\) not in origin\/main yet/);
  run(repo, 'push', '-q', 'origin', 'feat/x:main');
  run(repo, 'fetch', '-q');
  run(repo, 'switch', '-qc', 'old', 'HEAD~1');
  assert.match(branchWarning(repo, 'old'), /already merged into origin\/main \(1 commit\(s\) behind it\): switch back with `git switch main && git pull`/);
});

test('every source file parses (the CLI and hooks are not all imported by the tests)', () => {
  const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
  for (const dir of ['src', 'web']) {
    for (const f of fs.readdirSync(path.join(root, dir)).filter((n) => /\.m?js$/.test(n))) {
      execFileSync(process.execPath, ['--check', path.join(root, dir, f)], { stdio: 'pipe' });
    }
  }
});

test('export: notes and tasks as Markdown', () => {
  const md = itemsMarkdown('infra', [
    { id: 1, kind: 'note', title: 'Use pnpm', body: 'never npm', status: 'active', tags: '["tools"]', updated_at: Date.UTC(2026, 9, 1), priority: 2 },
    { id: 2, kind: 'task', title: 'Move backups', status: 'doing', priority: 1, updated_at: 1 },
    { id: 3, kind: 'task', title: 'Old task', status: 'done', priority: 2, updated_at: 1, completed_at: Date.UTC(2026, 9, 2) },
  ]);
  assert.match(md, /^# infra\n/);
  assert.match(md, /### Use pnpm\n\n_I1 · updated 2026-10-01 · #tools_\n\nnever npm/);
  assert.match(md, /### Doing\n\n- \[ \] \*\*Move backups\*\* \(I2 · high priority\)/);
  assert.match(md, /- \[x\] \*\*Old task\*\* \(I3 · closed 2026-10-02\)/);
  assert.equal(exportFileName('cuentas claude/repo'), 'cuentas_claude_repo.md');
});
