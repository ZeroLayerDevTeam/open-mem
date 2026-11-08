// A plugin update lands in a new folder of Claude Code's plugin cache (…/open-mem/<version>/), but a session keeps
// running its hooks from the folder it started with until it restarts. Each hook is a fresh process, so it can hand
// itself over to the newest version installed next to it: an update reaches the open sessions at their next hook.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const FORWARDED = 'CLAUDE_OPEN_MEM_FORWARDED';
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

const parse = (v) => SEMVER.exec(v)?.slice(1).map(Number) ?? null;
export function newer(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

// The root of the newest version installed next to `root`, or null when `root` is the newest (or not in a cache).
export function newestRoot(root, file = path.join('src', 'hook.mjs')) {
  const mine = parse(path.basename(root));
  if (!mine) return null; // a git clone or a dev folder: never forward
  let best = null;
  let bestV = mine;
  try {
    for (const name of fs.readdirSync(path.dirname(root))) {
      const v = parse(name);
      const dir = path.join(path.dirname(root), name);
      if (v && newer(v, bestV) && fs.existsSync(path.join(dir, file))) { best = dir; bestV = v; }
    }
  } catch { return null; }
  return best;
}

// Runs the newest version's copy of `file` with the same arguments, stdin and stdout; true when it did.
export function forwardToNewest(root, file, { input } = {}) {
  if (process.env[FORWARDED]) return false;
  const target = newestRoot(root, file);
  if (!target) return false;
  const r = spawnSync(process.execPath, ['--no-warnings', path.join(target, file), ...process.argv.slice(2)], {
    input, stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
    env: { ...process.env, [FORWARDED]: '1', CLAUDE_PLUGIN_ROOT: target }, windowsHide: true,
  });
  if (r.error) return false;
  process.exitCode = r.status ?? 0;
  return true;
}
