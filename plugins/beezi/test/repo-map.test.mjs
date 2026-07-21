import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normPath,
  matchKnownRoot,
  upsertRoot,
  knownOrigin,
  pruneRepoMap,
  findRepoRootByWalk,
  originFromGitConfig,
} from '../lib/repo-map.mjs';

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-repomap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync(dir);
}

// A directory that looks like a repo checkout: `.git` is a directory (optionally with a config).
function mkRepo(base, name, { origin } = {}) {
  const root = path.join(base, name);
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  if (origin !== undefined) {
    fs.writeFileSync(
      path.join(root, '.git', 'config'),
      `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${origin}\n\tfetch = +refs/heads/*\n`,
      'utf-8',
    );
  }
  return root;
}

test('normPath: backslashes → forward slashes, trailing slash stripped', () => {
  assert.equal(normPath('C:\\a\\b\\'), 'C:/a/b');
  assert.equal(normPath('/a/b/'), '/a/b');
  assert.equal(normPath('/'), '/');
  assert.equal(normPath(''), null);
  assert.equal(normPath(null), null);
});

test('matchKnownRoot: longest prefix wins, respects segment boundary', (t) => {
  const base = tmp(t);
  const repo = mkRepo(base, 'repo');
  const nested = mkRepo(path.join(base, 'repo'), 'inner'); // repo/inner is its own repo
  const decoy = mkRepo(base, 'repofoo'); // must NOT match a query under repo
  const map = { version: 1, roots: {} };
  upsertRoot(map, repo, null);
  upsertRoot(map, nested, null);
  upsertRoot(map, decoy, null);

  // A path deep inside the nested repo resolves to the LONGEST matching root.
  assert.equal(normPath(matchKnownRoot(path.join(nested, 'src', 'x.ts'), map)), normPath(nested));
  // A path inside the outer repo (not the nested one) resolves to the outer root.
  assert.equal(normPath(matchKnownRoot(path.join(repo, 'a', 'b'), map)), normPath(repo));
  // Segment boundary: 'repofoo' is not under 'repo'.
  assert.equal(normPath(matchKnownRoot(path.join(decoy, 'z'), map)), normPath(decoy));
  // The root itself matches.
  assert.equal(normPath(matchKnownRoot(repo, map)), normPath(repo));
});

test('matchKnownRoot: a stale root (its .git removed) is skipped', (t) => {
  const base = tmp(t);
  const repo = mkRepo(base, 'gone');
  const map = { version: 1, roots: {} };
  upsertRoot(map, repo, null);
  fs.rmSync(path.join(repo, '.git'), { recursive: true, force: true });
  assert.equal(matchKnownRoot(path.join(repo, 'src'), map), null);
});

test('upsertRoot + knownOrigin roundtrip', (t) => {
  const base = tmp(t);
  const repo = mkRepo(base, 'r');
  const map = { version: 1, roots: {} };
  upsertRoot(map, repo, 'https://host/o/r.git', '2026-07-14T00:00:00.000Z');
  assert.equal(knownOrigin(repo, map), 'https://host/o/r.git');
  assert.equal(map.roots[normPath(repo)].detectedAt, '2026-07-14T00:00:00.000Z');
  assert.equal(knownOrigin(path.join(base, 'nope'), map), null);
});

test('pruneRepoMap drops roots whose .git is gone, keeps live ones', (t) => {
  const base = tmp(t);
  const live = mkRepo(base, 'live');
  const dead = mkRepo(base, 'dead');
  const map = { version: 1, roots: {} };
  upsertRoot(map, live, null);
  upsertRoot(map, dead, null);
  fs.rmSync(path.join(dead, '.git'), { recursive: true, force: true });
  assert.equal(pruneRepoMap(map), 1);
  assert.deepEqual(Object.keys(map.roots), [normPath(live)]);
});

test('findRepoRootByWalk: finds root from a nested subdir (.git dir)', (t) => {
  const base = tmp(t);
  const repo = mkRepo(base, 'proj');
  const deep = path.join(repo, 'a', 'b', 'c');
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(normPath(findRepoRootByWalk(deep, { ceiling: base })), normPath(repo));
});

test('findRepoRootByWalk: matches a worktree .git FILE', (t) => {
  const base = tmp(t);
  const wt = path.join(base, 'wt');
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /somewhere/.git/worktrees/wt\n', 'utf-8');
  const deep = path.join(wt, 'src');
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(normPath(findRepoRootByWalk(deep, { ceiling: base })), normPath(wt));
});

test('findRepoRootByWalk: outside any repo → null, stops at ceiling', (t) => {
  const base = tmp(t);
  const dir = path.join(base, 'x', 'y');
  fs.mkdirSync(dir, { recursive: true });
  assert.equal(findRepoRootByWalk(dir, { ceiling: base }), null);
});

test('originFromGitConfig: reads origin from a .git dir config, strips creds', (t) => {
  const base = tmp(t);
  const repo = mkRepo(base, 'r', { origin: 'https://user:token@host/o/r.git' });
  assert.equal(originFromGitConfig(repo), 'https://host/o/r.git');
});

test('originFromGitConfig: no origin configured → null', (t) => {
  const base = tmp(t);
  const repo = mkRepo(base, 'r'); // .git dir but no config
  assert.equal(originFromGitConfig(repo), null);
});

test('originFromGitConfig: worktree .git-file follows commondir to the shared config', (t) => {
  const base = tmp(t);
  // main repo with the real config
  const main = path.join(base, 'main');
  const commonGit = path.join(main, '.git');
  fs.mkdirSync(path.join(commonGit, 'worktrees', 'wt'), { recursive: true });
  fs.writeFileSync(
    path.join(commonGit, 'config'),
    `[remote "origin"]\n\turl = https://host/o/r.git\n`,
    'utf-8',
  );
  // commondir points from the worktree git dir back to the shared .git
  fs.writeFileSync(path.join(commonGit, 'worktrees', 'wt', 'commondir'), '../..\n', 'utf-8');
  // the linked worktree checkout: `.git` is a file pointing at the per-worktree git dir
  const wt = path.join(base, 'feature');
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(
    path.join(wt, '.git'),
    `gitdir: ${path.join(commonGit, 'worktrees', 'wt')}\n`,
    'utf-8',
  );
  assert.equal(originFromGitConfig(wt), 'https://host/o/r.git');
});
