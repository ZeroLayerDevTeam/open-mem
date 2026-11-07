// GPU state from nvidia-smi, for the LLM page. A shared server often has no NVIDIA GPU of its own (Ollama runs on
// another machine, reached through a tunnel): clients that run Ollama report their GPU after each drain, and the
// server keeps the latest report per device.
import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { setMeta } from './db.mjs';


// nvidia-smi, when the machine has one: memory and load per GPU. Cached for a few seconds (the page polls).
const GPU_FIELDS = ['index', 'name', 'memory.used', 'memory.total', 'utilization.gpu', 'temperature.gpu', 'power.draw'];
export function parseNvidiaSmi(out) {
  const num = (x) => (x === undefined || x === '' || /N\/A|\[/.test(x) ? null : Number(x));
  return String(out).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const v = l.split(',').map((s) => s.trim());
    return { index: num(v[0]), name: v[1], memUsedMb: num(v[2]), memTotalMb: num(v[3]), util: num(v[4]), temp: num(v[5]), powerW: num(v[6]) };
  });
}
// nvidia-smi ships with the NVIDIA driver but is not always on PATH: older Windows drivers keep it under
// Program Files\NVIDIA Corporation\NVSMI, WSL under /usr/lib/wsl/lib. PATH first, then those; the one that works is kept.
export function smiCandidates(platform = process.platform, env = process.env) {
  if (platform !== 'win32') return ['nvidia-smi', '/usr/bin/nvidia-smi', '/usr/lib/wsl/lib/nvidia-smi', '/opt/bin/nvidia-smi'];
  const programFiles = env.ProgramW6432 || env.ProgramFiles || 'C:\\Program Files';
  return ['nvidia-smi', win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'nvidia-smi.exe'),
    win32.join(programFiles, 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe')];
}
const runSmi = (file) => new Promise((resolve) => {
  execFile(file, [`--query-gpu=${GPU_FIELDS.join(',')}`, '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 8000 },
    (err, stdout, stderr) => resolve({ err, stdout, stderr }));
});
// { list, error }: error is 'missing' when no nvidia-smi was found, otherwise what nvidia-smi said when it failed
// (driver not loaded, timeout…), so the page tells "no driver tools" apart from "the driver is broken".
let smiPath = null;
let gpuCache = { at: 0, ttl: 0, value: null };
export async function gpus() {
  if (Date.now() - gpuCache.at < gpuCache.ttl) return gpuCache.value;
  let value = { list: null, error: 'missing' };
  for (const file of smiPath ? [smiPath] : smiCandidates()) {
    const { err, stdout, stderr } = await runSmi(file);
    if (err?.code === 'ENOENT') continue;
    if (err) {
      value = { list: null, error: (String(stderr || stdout).trim().split(/\r?\n/)[0] || err.message).slice(0, 200) };
      break;
    }
    smiPath = file;
    value = { list: parseNvidiaSmi(stdout), error: null };
    break;
  }
  if (value.error === 'missing') smiPath = null;
  // A missing nvidia-smi will not appear between two polls: look again in a minute, not every 4 s.
  gpuCache = { at: Date.now(), ttl: value.error === 'missing' ? 60000 : 4000, value };
  return value;
}

// --- reports from other machines (clients send them with their status, see reportStatus in sync.mjs) --------------
const REPORT_KEEP_MS = 7 * 864e5;
const MAX_GPUS = 8;
const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Server: keep the latest report of a device (values checked, strings cut).
export function storeGpuReport(db, device, body, now = Date.now()) {
  const list = (Array.isArray(body?.gpus) ? body.gpus : []).slice(0, MAX_GPUS).map((g) => ({
    index: numOrNull(g?.index), name: String(g?.name ?? '').slice(0, 80), memUsedMb: numOrNull(g?.memUsedMb),
    memTotalMb: numOrNull(g?.memTotalMb), util: numOrNull(g?.util), temp: numOrNull(g?.temp), powerW: numOrNull(g?.powerW),
  }));
  if (!list.length) throw new Error('no GPU in the report');
  setMeta(db, `gpu_report:${device}`, JSON.stringify({ at: now, gpus: list }));
  return list.length;
}

// Latest report per device, newest first; reports older than a week are left out.
export function gpuReports(db, now = Date.now()) {
  return db.prepare("SELECT key, value FROM meta WHERE key LIKE 'gpu_report:%'").all().map((r) => {
    try { return { device: r.key.slice('gpu_report:'.length), ...JSON.parse(r.value) }; } catch { return null; }
  }).filter((r) => r && now - r.at < REPORT_KEEP_MS).sort((a, b) => b.at - a.at);
}
