import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const { newer, newestRoot } = await import('../src/newest.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'open-mem-newest-'));

const install = (version, body) => {
  const dir = path.join(TMP, 'open-mem', version);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'hook.mjs'), body);
  return dir;
};

test('versions compare by number, not as text', () => {
  assert.ok(newer([0, 10, 0], [0, 9, 3]));
  assert.ok(!newer([0, 9, 3], [0, 9, 3]));
  assert.ok(!newer([0, 7, 1], [0, 9, 1]));
});

test('an old session folder hands its hook over to the newest version installed next to it', () => {
  const old = install('0.9.1', '');
  install('0.7.1', '');
  install('0.10.0', '');
  fs.mkdirSync(path.join(TMP, 'open-mem', '0.11.0')); // not fully installed: no hook
  fs.mkdirSync(path.join(TMP, 'open-mem', 'notes'));
  assert.equal(newestRoot(old), path.join(TMP, 'open-mem', '0.10.0'));
  assert.equal(newestRoot(path.join(TMP, 'open-mem', '0.10.0')), null, 'already the newest');
  assert.equal(newestRoot(path.join(TMP, 'clone')), null, 'a git clone never forwards');
});

test('the newer copy gets the same arguments and stdin, and only one hop', () => {
  const root = path.join(TMP, 'run', 'open-mem');
  const mk = (v, body) => { fs.mkdirSync(path.join(root, v, 'src'), { recursive: true }); fs.writeFileSync(path.join(root, v, 'src', 'hook.mjs'), body); };
  const fwd = path.resolve('src/newest.mjs').split(path.sep).join('/');
  mk('1.0.0', `import { forwardToNewest } from 'file:///${fwd}'; import path from 'node:path';
    if (!forwardToNewest(path.resolve(import.meta.dirname, '..'), path.join('src', 'hook.mjs'))) process.stdout.write('old');`);
  mk('1.0.1', `import fs from 'node:fs'; process.stdout.write('new ' + process.argv[2] + ' ' + fs.readFileSync(0, 'utf8') + ' ' + process.env.CLAUDE_OPEN_MEM_FORWARDED);`);
  const r = spawnSync(process.execPath, [path.join(root, '1.0.0', 'src', 'hook.mjs'), 'post-tool'], { input: '{"x":1}', encoding: 'utf8' });
  assert.equal(r.stdout, 'new post-tool {"x":1} 1');
  const again = spawnSync(process.execPath, [path.join(root, '1.0.0', 'src', 'hook.mjs')], { env: { ...process.env, CLAUDE_OPEN_MEM_FORWARDED: '1' }, encoding: 'utf8' });
  assert.equal(again.stdout, 'old', 'never forwards twice');
});
