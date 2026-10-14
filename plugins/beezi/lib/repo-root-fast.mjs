import fs from 'fs';
import path from 'path';

// Marker stored in gitRoots when git threw or printed nothing for a candidate root.
export const FAILED = Symbol('FAILED');

// Env vars that change where git's repository discovery starts, stops or looks.
const DISCOVERY_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_COMMON_DIR',
];

function exists(lstatSync, p) {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

// True when realpath left the path exactly as path.resolve spells it; win32 compares with slashes normalised, never case.
function sameLogicalPath(real, dir, platform) {
  const logical = path.resolve(dir);
  if (platform !== 'win32') return real === logical;
  return real.replace(/\//g, '\\') === logical.replace(/\//g, '\\');
}

// Nearest level at or above realpath(dir) holding a `.git` entry, or null wherever git's own walk could differ.
function candidateRoot(dir, realpath, statSync, lstatSync, platform) {
  let level;
  let dev;
  try {
    level = realpath(dir);
    if (!sameLogicalPath(level, dir, platform)) return null;
    const st = statSync(level);
    if (!st.isDirectory()) return null;
    dev = st.dev;
  } catch {
    return null;
  }
  if (level.split(/[\\/]/).some((part) => part.toLowerCase() === '.git')) return null;
  for (;;) {
    try {
      if (statSync(level).dev !== dev) return null;
    } catch {
      return null;
    }
    if (exists(lstatSync, path.join(level, '.git'))) return level;
    if (exists(lstatSync, path.join(level, 'HEAD'))) return null; // git may stop here as a bare repository
    const parent = path.dirname(level);
    if (parent === level) return null;
    level = parent;
  }
}

// Returns git's own repo root for `dir`, found with one `git rev-parse --show-toplevel` per candidate root,
// or undefined when the shortcut cannot guarantee git's answer (the caller then takes today's path).
export function fastRepoRoot(gitImpl, dir, gitRoots, deps = {}) {
  const {
    env = process.env,
    realpath = fs.realpathSync.native,
    statSync = fs.statSync,
    lstatSync = fs.lstatSync,
    platform = process.platform,
  } = deps;
  for (const key of DISCOVERY_ENV) {
    if (env[key] !== undefined) return undefined;
  }
  const root = candidateRoot(dir, realpath, statSync, lstatSync, platform);
  if (root === null) return undefined;
  if (gitRoots.has(root)) {
    const known = gitRoots.get(root);
    return known === FAILED ? undefined : known;
  }
  let answer;
  try {
    answer = gitImpl(['rev-parse', '--show-toplevel'], root).trim();
  } catch {
    answer = '';
  }
  if (answer === '') {
    gitRoots.set(root, FAILED);
    return undefined;
  }
  gitRoots.set(root, answer);
  return answer;
}
