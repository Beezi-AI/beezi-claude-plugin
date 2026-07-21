import { execFileSync } from 'node:child_process';

// A branch is tracked only when it carries a `.../task-<id>` segment. The capture group
// yields the `task-<id>` token (see taskFromBranch).
export const TASK_BRANCH_RE = /\/(task-[a-zA-Z0-9_-]+)/;

export function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    // Bound the spawn so a hung git can't burn the whole 10s hook budget.
    timeout: 5000,
    killSignal: 'SIGKILL',
    // Pin the C locale so parsed output (e.g. reflog "checkout: moving from…") stays
    // English regardless of the user's git language settings.
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  }).trim();
}

export function sanitizeRemote(url) {
  return url.replace(/\/\/[^@/]+@/, '//');
}

// Resolve a repo's origin remote with embedded credentials stripped, or null on any
// failure (not a repo, no origin, git error). Never throws.
export function resolveOriginRemote(gitImpl, dir) {
  try { return sanitizeRemote(gitImpl(['remote', 'get-url', 'origin'], dir)); }
  catch { return null; }
}

export function currentBranch(cwd, gitImpl = git) {
  return gitImpl(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
}

// The `task-<id>` token for a task branch, or null when the branch doesn't fit.
export function taskFromBranch(branch) {
  const match = TASK_BRANCH_RE.exec(branch ?? '');
  return match ? match[1] : null;
}
