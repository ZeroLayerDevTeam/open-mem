// "Busy" guard: while a game (or any heavy app the user lists) is running, the local LLM stays idle so it does
// not take VRAM and GPU time away from it.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 10000, maxBuffer: 8 << 20 }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

// Full executable paths of the running processes (best effort: empty when they cannot be listed).
export async function processPaths() {
  if (process.platform === 'win32') {
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '(Get-CimInstance Win32_Process -Property ExecutablePath).ExecutablePath']);
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }
  if (process.platform === 'linux') {
    const paths = [];
    for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
      try { paths.push(fs.readlinkSync(`/proc/${pid}/exe`)); } catch { /* gone, or not ours */ }
    }
    return paths;
  }
  return (await run('ps', ['-axo', 'comm='])).split('\n').map((s) => s.trim()).filter(Boolean);
}

const norm = (s) => String(s).replace(/\\/g, '/').toLowerCase();

// First running process that matches busyProcesses (exe name or path fragment) or busyPaths (game library
// folders), or null. busyIgnore excludes matches (e.g. a wallpaper app installed through Steam).
export function matchBusy(paths, settings) {
  const names = (settings.busyProcesses || []).map(norm).filter(Boolean);
  const dirs = (settings.busyPaths || []).map(norm).filter(Boolean);
  const ignore = (settings.busyIgnore || []).map(norm).filter(Boolean);
  for (const p of paths) {
    const full = norm(p);
    const base = path.posix.basename(full);
    if (ignore.some((i) => base === i || full.includes(i))) continue;
    if (names.some((n) => base === n || base === `${n}.exe` || (n.includes('/') && full.includes(n)))) return p;
    if (dirs.some((d) => full.includes(d))) return p;
  }
  return null;
}

// Returns the process that makes this machine busy, or null. Never throws.
export async function busyReason(settings) {
  if (!settings.pauseWhenBusy) return null;
  try {
    return matchBusy(await processPaths(), settings);
  } catch {
    return null;
  }
}
