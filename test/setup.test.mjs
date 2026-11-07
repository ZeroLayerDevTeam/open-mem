import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS } from '../src/config.mjs';
import { detectGpu, isIntegrated, parseRegistryAdapters, recommendModel } from '../src/hardware.mjs';
import { parseUserEnv, planSetup } from '../src/setup.mjs';

const KEY = 'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}';

test('registry adapters: 64-bit memory size (beyond the 4 GB WMI cap) matched to the driver name', () => {
  const mem = `\r\n${KEY}\\0000\r\n    HardwareInformation.qwMemorySize    REG_QWORD    0x3ffc00000\r\n\r\n`
    + `${KEY}\\0002\r\n    HardwareInformation.qwMemorySize    REG_QWORD    0x8000000\r\n\r\nEnd of search: 2 match(es) found.\r\n`;
  const desc = `${KEY}\\0000\r\n    DriverDesc    REG_SZ    NVIDIA GeForce RTX 4060 Ti\r\n\r\n`
    + `${KEY}\\0001\r\n    DriverDesc    REG_SZ    Parsec Virtual Display Adapter\r\n\r\n`
    + `${KEY}\\0002\r\n    DriverDesc    REG_SZ    Intel(R) UHD Graphics 770\r\n`;
  assert.deepEqual(parseRegistryAdapters(mem, desc), [
    { name: 'NVIDIA GeForce RTX 4060 Ti', vramMb: 16380 },
    { name: 'Intel(R) UHD Graphics 770', vramMb: 128 },
  ]);
});

test('integrated and virtual adapters do not count as a GPU; Intel Arc does', () => {
  assert.equal(isIntegrated('Intel(R) UHD Graphics 770'), true);
  assert.equal(isIntegrated('Intel(R) Iris(R) Xe Graphics'), true);
  assert.equal(isIntegrated('Parsec Virtual Display Adapter'), true);
  assert.equal(isIntegrated('Microsoft Basic Display Adapter'), true);
  assert.equal(isIntegrated('Intel(R) Arc(TM) A770 Graphics'), false);
  assert.equal(isIntegrated('AMD Radeon RX 7800 XT'), false);
});

test('model per GPU memory', () => {
  assert.equal(recommendModel({ kind: 'dedicated', vramMb: 16380 }).model, 'gemma3:12b');
  assert.equal(recommendModel({ kind: 'dedicated', vramMb: 12282 }).model, 'gemma3:12b');
  assert.equal(recommendModel({ kind: 'dedicated', vramMb: 8192 }).model, 'gemma3:4b');
  assert.equal(recommendModel({ kind: 'dedicated', vramMb: 6144 }).model, 'gemma3:4b');
  assert.equal(recommendModel({ kind: 'dedicated', vramMb: 4096 }).model, 'gemma3:1b');
  assert.equal(recommendModel({ kind: 'none', vramMb: 0 }).model, null);
  assert.equal(recommendModel({ kind: 'none', vramMb: 0 }).cpuModel, 'gemma3:1b');
});

test('Apple Silicon: two thirds of the unified memory', async () => {
  const gpu = await detectGpu({ platform: 'darwin', arch: 'arm64', totalMem: 16 * 1024 ** 3 });
  assert.equal(gpu.kind, 'unified');
  assert.equal(gpu.vramMb, Math.round(16 * 1024 * 0.66));
  assert.equal(recommendModel(gpu).model, 'gemma3:4b');
});

const nvidia16 = { name: 'RTX', kind: 'dedicated', vramMb: 16380 };
const none = { name: 'Intel(R) UHD Graphics', kind: 'none', vramMb: 0 };

test('setup plan: install, start and pull only what is missing', () => {
  const s = DEFAULT_SETTINGS;
  let p = planSetup({ gpu: nvidia16, installed: null, models: null, settings: s });
  assert.deepEqual(p.steps.map((x) => x.kind), ['install', 'pull', 'pull']);
  assert.equal(p.model, 'gemma3:12b');
  assert.equal(p.downloadGb.toFixed(1), '8.7');
  p = planSetup({ gpu: nvidia16, installed: '/usr/bin/ollama', models: null, settings: s });
  assert.deepEqual(p.steps.map((x) => x.kind), ['start', 'pull', 'pull']);
  p = planSetup({ gpu: nvidia16, installed: 'ollama', models: ['gemma3:12b', 'embeddinggemma:latest'], settings: s });
  assert.deepEqual(p.steps, []);
  p = planSetup({ gpu: nvidia16, installed: 'ollama', models: [], settings: s, opts: { model: 'qwen3:8b' } });
  assert.deepEqual(p.steps.map((x) => x.model), ['qwen3:8b', 'embeddinggemma']);
});

test('setup plan without a GPU: alternatives instead of an install, unless asked for the CPU or Ollama already answers', () => {
  const s = DEFAULT_SETTINGS;
  let p = planSetup({ gpu: none, installed: null, models: null, settings: s });
  assert.match(p.blocked, /No usable GPU/);
  assert.match(p.blocked, /remote connect/);
  assert.equal(p.steps.length, 0);
  p = planSetup({ gpu: none, installed: null, models: null, settings: s, opts: { cpu: true } });
  assert.equal(p.model, 'gemma3:1b');
  assert.match(p.warnings.join(' '), /CPU/);
  // A server without a GPU that reaches another machine's Ollama through a tunnel: nothing to install.
  p = planSetup({ gpu: none, installed: null, models: ['gemma3:12b', 'embeddinggemma:latest'], settings: s });
  assert.equal(p.blocked, null);
  assert.deepEqual(p.steps, []);
  p = planSetup({ gpu: nvidia16, installed: null, models: null, settings: { ...s, provider: 'openai' } });
  assert.match(p.blocked, /provider is "openai"/);
});

test('an Ollama started without its app gets the user\'s OLLAMA_* variables from the registry', () => {
  const out = '\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    C:\\x\r\n    OLLAMA_MAX_LOADED_MODELS    REG_SZ    2\r\n'
    + '    OLLAMA_MODELS    REG_EXPAND_SZ    D:\\models dir\r\n    OLLAMA_GPU_OVERHEAD    REG_SZ    1073741824\r\n';
  assert.deepEqual(parseUserEnv(out), { OLLAMA_MAX_LOADED_MODELS: '2', OLLAMA_MODELS: 'D:\\models dir', OLLAMA_GPU_OVERHEAD: '1073741824' });
  assert.deepEqual(parseUserEnv(''), {});
});
