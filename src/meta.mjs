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

const DEFAULT_BRANCHES = new Set(['main', 'master', 'HEAD']);
const count = (cwd, range) => Number(git(cwd, ['rev-list', '--count', range]) || 0);

// One line when the repo at cwd is not on its default branch: either the branch is already merged (the clone was
// left on it and misses everything else) or it has commits the default branch lacks. No fetch: remote refs as last
// fetched. Null on the default branch, outside a repo, or without a remote default branch.
export function branchWarning(cwd, branch) {
  if (!cwd || !branch || DEFAULT_BRANCHES.has(branch)) return null;
  const def = git(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
    || ['origin/main', 'origin/master'].find((r) => git(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/${r}`]));
  if (!def) return null;
  const ahead = count(cwd, `${def}..HEAD`);
  const behind = count(cwd, `HEAD..${def}`);
  const name = def.replace(/^origin\//, '');
  if (!ahead) {
    return `This repo is on branch "${branch}", which is already merged into ${def}`
      + `${behind ? ` (${behind} commit(s) behind it)` : ''}: switch back with \`git switch ${name} && git pull\` before new work.`;
  }
  return `This repo is on branch "${branch}" with ${ahead} commit(s) not in ${def} yet${behind ? `, ${behind} behind it` : ''}: merge or open an MR when done.`;
}

// Start of the working day in local time: 05:00, so a session after midnight still belongs to the night before.
export function workdayStart(now = Date.now()) {
  const d = new Date(now);
  d.setHours(5, 0, 0, 0);
  if (d.getTime() > now) d.setDate(d.getDate() - 1);
  return d.getTime();
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
