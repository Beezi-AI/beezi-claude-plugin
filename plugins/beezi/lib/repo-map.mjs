import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repoMapFile } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { sanitizeRemote } from './git.mjs';

// A persisted machine-wide map of known git repo roots → origin, plus git-binary-free resolution
// fallbacks (parent walk-up, origin parsed from .git/config). The map is a self-healing SEED/HINT,
// never a source of truth: a stale root (its .git gone) is skipped on match and dropped on prune.

// NTFS/APFS default to case-insensitive; fold the lookup key there so C:/Repo and c:/repo collapse.
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

// Forward slashes, no trailing slash. One representation for git output (already forward-slash),
// Node cwd (backslashes on Windows), and transcript file paths.
export function normPath(p) {
  if (typeof p !== 'string' || p === '') return null;
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return s === '' ? '/' : s;
}

function fold(p) {
  return CASE_INSENSITIVE ? p.toLowerCase() : p;
}

function hasGitEntry(root) {
  try {
    // .git is a directory in a normal checkout, a FILE in a worktree/submodule — existsSync covers both.
    return fs.existsSync(path.join(root, '.git'));
  } catch {
    return false;
  }
}

export function loadRepoMap() {
  const m = readJson(repoMapFile(), null);
  if (!m || typeof m !== 'object' || typeof m.roots !== 'object' || m.roots === null) {
    return { version: 1, roots: {} };
  }
  return { version: 1, roots: m.roots };
}

export function saveRepoMap(map) {
  writeJsonSecure(repoMapFile(), { version: 1, roots: map?.roots ?? {} });
}

// Longest known root that contains `dir` (segment-boundary prefix so /repo never matches /repofoo),
// case-folded on Win/macOS. Skips a root whose .git has vanished. Returns the stored root, or null.
export function matchKnownRoot(dir, map) {
  const d = normPath(dir);
  if (!d || !map?.roots) return null;
  const fd = fold(d);
  let best = null;
  let bestLen = -1;
  for (const root of Object.keys(map.roots)) {
    const nr = normPath(root);
    if (!nr) continue;
    const fr = fold(nr);
    if ((fd === fr || fd.startsWith(fr + '/')) && fr.length > bestLen && hasGitEntry(nr)) {
      best = root;
      bestLen = fr.length;
    }
  }
  return best;
}

// Insert/refresh a root with its origin. Mutates and returns `map`.
export function upsertRoot(map, root, origin, nowIso = new Date().toISOString()) {
  const nr = normPath(root);
  if (!nr) return map;
  map.roots ??= {};
  map.roots[nr] = { origin: origin ?? null, detectedAt: nowIso };
  return map;
}

// The stored origin for a known root (or null). Rescues resolution when the git binary is blocked
// (e.g. dubious-ownership) but the root was mapped earlier.
export function knownOrigin(root, map) {
  const nr = normPath(root);
  return nr && map?.roots?.[nr] ? (map.roots[nr].origin ?? null) : null;
}

// Drop roots whose .git no longer exists. Mutates `map`; returns the count removed.
export function pruneRepoMap(map) {
  if (!map?.roots) return 0;
  let removed = 0;
  for (const root of Object.keys(map.roots)) {
    if (!hasGitEntry(normPath(root))) {
      delete map.roots[root];
      removed += 1;
    }
  }
  return removed;
}

// Ascend from `dir` until a directory containing a .git entry (dir OR file) is found. Bounded by
// `ceiling` (default home) and the filesystem root; never crosses to a different drive root. A
// git-binary-free fallback for resolveRepoRoot — returns the working-tree root, or null.
export function findRepoRootByWalk(dir, { ceiling = os.homedir() } = {}) {
  let d = normPath(dir);
  if (!d) return null;
  const stop = normPath(ceiling);
  const foldedStop = stop ? fold(stop) : null;
  // Guard against a pathological path depth.
  for (let i = 0; i < 64; i++) {
    if (hasGitEntry(d)) return d;
    if (foldedStop && fold(d) === foldedStop) return null; // checked the ceiling itself, stop
    const parent = normPath(path.dirname(d));
    if (!parent || parent === d) return null; // filesystem root
    d = parent;
  }
  return null;
}

// [remote "origin"] url from a repo's git config, WITHOUT shelling git — the last resort when the
// git binary can't run (dubious-ownership) but the files are readable. Follows a worktree/submodule
// `.git`-file pointer (via its commondir when present). Credentials are stripped. Returns null on
// any failure or when no origin url is configured.
export function originFromGitConfig(root) {
  try {
    const configPath = resolveGitConfigPath(root);
    if (!configPath) return null;
    const text = fs.readFileSync(configPath, 'utf-8');
    const url = parseOriginUrl(text);
    return url ? sanitizeRemote(url) : null;
  } catch {
    return null;
  }
}

function resolveGitConfigPath(root) {
  const gitPath = path.join(root, '.git');
  let stat;
  try {
    stat = fs.statSync(gitPath);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return path.join(gitPath, 'config');
  // `.git` is a file: `gitdir: <path-to-real-git-dir>`.
  const contents = fs.readFileSync(gitPath, 'utf-8');
  const m = contents.match(/^gitdir:\s*(.+)\s*$/m);
  if (!m) return null;
  let gitDir = m[1].trim();
  if (!path.isAbsolute(gitDir)) gitDir = path.resolve(root, gitDir);
  // A worktree's origin lives in the shared common dir; `commondir` points there (usually `../..`).
  const commondirFile = path.join(gitDir, 'commondir');
  try {
    const rel = fs.readFileSync(commondirFile, 'utf-8').trim();
    const common = path.isAbsolute(rel) ? rel : path.resolve(gitDir, rel);
    return path.join(common, 'config');
  } catch {
    // Submodule (or worktree without commondir): config sits in the git dir itself.
    return path.join(gitDir, 'config');
  }
}

// Minimal INI scan: find the [remote "origin"] section and its first `url =` before the next section.
function parseOriginUrl(text) {
  let inOrigin = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inOrigin = /^\[remote\s+"origin"\]$/.test(line);
      continue;
    }
    if (inOrigin) {
      const m = line.match(/^url\s*=\s*(.+)$/);
      if (m) return m[1].trim();
    }
  }
  return null;
}
