import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverRepos } from '../lib/session-start.mjs';
import { normPath } from '../lib/repo-map.mjs';

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-discover-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync(dir);
}

function mkRepo(base, name, origin) {
  const root = path.join(base, name);
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'config'), `[remote "origin"]\n\turl = ${origin}\n`, 'utf-8');
  return root;
}

test('discoverRepos: launch cwd inside a repo maps that root + origin', (t) => {
  const base = tmp(t);
  const repo = mkRepo(base, 'proj', 'https://host/o/proj.git');
  const sub = path.join(repo, 'client');
  fs.mkdirSync(sub, { recursive: true });

  // git resolves the subdir to the repo root and returns the origin.
  const gitStub = (args, cwd) => {
    if (args[0] === 'rev-parse') return repo;
    if (args[0] === 'remote') return 'https://host/o/proj.git';
    throw new Error(`unexpected git ${args.join(' ')} @ ${cwd}`);
  };

  const map = { version: 1, roots: {} };
  const { dirty } = discoverRepos(sub, gitStub, map);

  assert.equal(dirty, true);
  assert.deepEqual(Object.keys(map.roots), [normPath(repo)]);
  assert.equal(map.roots[normPath(repo)].origin, 'https://host/o/proj.git');
});

test('discoverRepos: non-repo parent → shallow child scan maps each child repo', (t) => {
  const base = tmp(t);
  const a = mkRepo(base, 'repo-a', 'https://host/o/a.git');
  const b = mkRepo(base, 'repo-b', 'https://host/o/b.git');
  fs.mkdirSync(path.join(base, 'not-a-repo'), { recursive: true }); // ignored (no .git)

  // Parent isn't a repo (git throws); each child resolves to itself; origin comes from git.
  const gitStub = (args, cwd) => {
    if (args[0] === 'rev-parse') {
      if (normPath(cwd) === normPath(base)) throw new Error('not a repo');
      return cwd;
    }
    if (args[0] === 'remote') return `https://host/o/${path.basename(cwd)}.git`;
    throw new Error(`unexpected git ${args.join(' ')}`);
  };

  const map = { version: 1, roots: {} };
  const { dirty } = discoverRepos(base, gitStub, map);

  assert.equal(dirty, true);
  const keys = Object.keys(map.roots).sort();
  assert.deepEqual(keys, [normPath(a), normPath(b)].sort());
  assert.equal(map.roots[normPath(a)].origin, 'https://host/o/repo-a.git');
  assert.equal(map.roots[normPath(b)].origin, 'https://host/o/repo-b.git');
});

test('discoverRepos: non-repo parent with no child repos → nothing mapped', (t) => {
  const base = tmp(t);
  fs.mkdirSync(path.join(base, 'plain'), { recursive: true });
  const gitStub = (args, cwd) => {
    if (args[0] === 'rev-parse') throw new Error('not a repo');
    throw new Error('unexpected');
  };
  const map = { version: 1, roots: {} };
  const { dirty } = discoverRepos(base, gitStub, map);
  assert.equal(dirty, false);
  assert.deepEqual(map.roots, {});
});
