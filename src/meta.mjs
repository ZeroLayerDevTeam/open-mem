// Reconstruction metadata captured with every record: where, on which machine, at which commit.
import { execFileSync } from 'node:child_process';
import { deviceName } from './config.mjs';

function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    }).trim() || null;
  } catch {
    return null;
  }
}

export function gitInfo(cwd) {
  if (!cwd) return { gitBranch: null, gitCommit: null };
  const gitCommit = git(cwd, ['rev-parse', '--short=12', 'HEAD']);
  if (!gitCommit) return { gitBranch: null, gitCommit: null };
  return { gitBranch: git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']), gitCommit };
}

// Fields copied from the session row onto each observation/summary.
export function sessionMeta(session, settings) {
  return {
    cwd: session?.cwd ?? null,
    device: session?.device || deviceName(settings),
    git_branch: session?.git_branch ?? null,
    git_commit: session?.git_commit ?? null,
  };
}
