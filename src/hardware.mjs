// What GPU this machine has and which local model fits it, for `cli setup` and the first-session hint.
// NVIDIA through nvidia-smi; Windows adapters through the display class in the registry (WMI's AdapterRAM is a
// 32-bit field and caps at 4 GB); AMD on Linux through amdgpu's sysfs files; Apple Silicon shares RAM with its GPU.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gpus } from './gpu.mjs';

const GB = 1024;

const run = (file, args) => new Promise((resolve) => {
  execFile(file, args, { windowsHide: true, timeout: 8000 }, (err, stdout) => resolve(err ? '' : String(stdout)));
});

// Integrated graphics borrow system RAM and are too slow for a 1B+ model: not counted as a usable GPU.
export const isIntegrated = (name) => /intel/i.test(name) && !/\barc\b/i.test(name)
  || /virtual|basic display|parsec|remote|vmware|virtualbox|hyper-v|citrix/i.test(name);

// `reg query <display class> /s` output -> [{ name, vramMb }] (one per adapter key that has both values).
export function parseRegistryAdapters(memOut, descOut) {
  const byKey = (out, value) => {
    const map = new Map();
    let key = null;
    for (const line of String(out).split(/\r?\n/)) {
      if (/^HKEY_/i.test(line.trim())) key = line.trim();
      const m = line.match(new RegExp(`^\\s+${value.replace(/\./g, '\\.')}\\s+REG_\\w+\\s+(.+)$`));
      if (key && m) map.set(key, m[1].trim());
    }
    return map;
  };
  const mem = byKey(memOut, 'HardwareInformation.qwMemorySize');
  const desc = byKey(descOut, 'DriverDesc');
  return [...mem.entries()].map(([key, hex]) => ({ name: desc.get(key) || 'GPU', vramMb: Math.round(Number(BigInt(hex)) / 1048576) }))
    .filter((a) => a.vramMb > 0);
}

async function windowsAdapters() {
  const key = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}';
  const [mem, desc] = await Promise.all([run('reg', ['query', key, '/s', '/v', 'HardwareInformation.qwMemorySize']),
    run('reg', ['query', key, '/s', '/v', 'DriverDesc'])]);
  return parseRegistryAdapters(mem, desc);
}

function linuxAmdAdapters(root = '/sys/class/drm') {
  const out = [];
  let cards = [];
  try { cards = fs.readdirSync(root).filter((c) => /^card\d+$/.test(c)); } catch { return out; }
  for (const card of cards) {
    const dev = path.join(root, card, 'device');
    try {
      if (fs.readFileSync(path.join(dev, 'vendor'), 'utf8').trim() !== '0x1002') continue;
      const bytes = Number(fs.readFileSync(path.join(dev, 'mem_info_vram_total'), 'utf8').trim());
      let name = 'AMD GPU';
      try { name = fs.readFileSync(path.join(dev, 'product_name'), 'utf8').trim() || name; } catch { /* not exposed */ }
      if (bytes > 0) out.push({ name, vramMb: Math.round(bytes / 1048576) });
    } catch { /* not an amdgpu card */ }
  }
  return out;
}

// { name, vramMb, kind: 'dedicated'|'unified'|'none', vendor } for the best GPU found.
export async function detectGpu({ platform = process.platform, arch = process.arch, totalMem = os.totalmem() } = {}) {
  if (platform === 'darwin' && arch === 'arm64') {
    // Metal can give the GPU about two thirds of the unified memory by default.
    return { name: 'Apple Silicon', vendor: 'apple', kind: 'unified', vramMb: Math.round((totalMem / 1048576) * 0.66) };
  }
  const found = [];
  const smi = await gpus();
  for (const g of smi.list || []) if (g.memTotalMb) found.push({ name: g.name, vramMb: g.memTotalMb });
  if (platform === 'win32') found.push(...await windowsAdapters());
  if (platform === 'linux') found.push(...linuxAmdAdapters());
  const usable = found.filter((g) => !isIntegrated(g.name)).sort((a, b) => b.vramMb - a.vramMb);
  if (!usable.length) return { name: found[0]?.name || null, vendor: null, kind: 'none', vramMb: 0 };
  const g = usable[0];
  const vendor = /nvidia|geforce|rtx|quadro|tesla/i.test(g.name) ? 'nvidia' : /amd|radeon/i.test(g.name) ? 'amd' : /intel|arc/i.test(g.name) ? 'intel' : 'other';
  return { ...g, vendor, kind: 'dedicated' };
}

// Model per usable GPU memory. Download sizes as Ollama lists them. Only gemma3:12b has been checked in depth
// against open-mem's JSON prompts; the smaller ones write shorter, rougher observations.
export const MODELS = {
  'gemma3:12b': { sizeGb: 8.1, quality: 'good' },
  'gemma3:4b': { sizeGb: 3.3, quality: 'fair' },
  'gemma3:1b': { sizeGb: 0.8, quality: 'low' },
  embeddinggemma: { sizeGb: 0.6 },
};

export function recommendModel(gpu) {
  const gb = (gpu?.vramMb || 0) / GB;
  if (gpu?.kind === 'none' || gb < 2) return { model: null, cpuModel: 'gemma3:1b', reason: 'no usable GPU' };
  if (gb >= 11) return { model: 'gemma3:12b' };
  if (gb >= 5.5) return { model: 'gemma3:4b' };
  return { model: 'gemma3:1b' };
}

export const describeGpu = (gpu) => (gpu.kind === 'none'
  ? `no usable GPU${gpu.name ? ` (only ${gpu.name})` : ''}`
  : `${gpu.name}, ${(gpu.vramMb / GB).toFixed(1)} GB${gpu.kind === 'unified' ? ' usable (unified memory)' : ''}`);
