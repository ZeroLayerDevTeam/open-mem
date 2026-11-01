import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'open-mem-config-'));
const cli = (...args) => spawnSync(process.execPath, ['--no-warnings', CLI, ...args],
  { encoding: 'utf8', env: { ...process.env, CLAUDE_OPEN_MEM_DATA_DIR: DATA } });
const saved = () => JSON.parse(fs.readFileSync(path.join(DATA, 'settings.json'), 'utf8')).llmKeepAlive;

test('llmKeepAlive defaults to 10 minutes', () => {
  assert.equal(JSON.parse(cli('config').stdout).llmKeepAlive, '10m');
});

test('config set llmKeepAlive takes a duration and gives bare seconds a unit', () => {
  for (const [given, stored] of [['1h', '1h'], ['1h30m', '1h30m'], ['45s', '45s'], ['0', '0s'], ['-1', '-1s']]) {
    const r = cli('config', 'set', 'llmKeepAlive', given);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(saved(), stored);
  }
});

test('config set llmKeepAlive refuses a value Ollama cannot read', () => {
  cli('config', 'set', 'llmKeepAlive', '10m');
  for (const bad of ['ten minutes', '10 min', '']) {
    const r = cli('config', 'set', 'llmKeepAlive', bad);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /llmKeepAlive must be a duration/);
    assert.equal(saved(), '10m');
  }
});