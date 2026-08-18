import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeMdLines } from '../lib/claude-md.mjs';

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-claudemd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync(dir);
}

function write(root, contents) {
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), contents, 'utf-8');
  return root;
}

test('counts the lines of a repo root CLAUDE.md', (t) => {
  const root = write(tmp(t), '# Rules\n\nBe careful.\n');
  assert.equal(claudeMdLines(root), 3);
});

test('a final line without a trailing newline still counts', (t) => {
  const root = write(tmp(t), 'one\ntwo');
  assert.equal(claudeMdLines(root), 2);
});

test('a trailing newline does not add a phantom line', (t) => {
  const root = write(tmp(t), 'one\ntwo\n');
  assert.equal(claudeMdLines(root), 2);
});

test('blank lines count', (t) => {
  const root = write(tmp(t), 'one\n\n\ntwo\n');
  assert.equal(claudeMdLines(root), 4);
});

// 0 and null are distinct on the wire: null omits the field ("this repo has no CLAUDE.md"),
// 0 reports a file that exists but is empty.
test('an empty CLAUDE.md is 0, a missing one is null', (t) => {
  assert.equal(claudeMdLines(write(tmp(t), '')), 0);
  assert.equal(claudeMdLines(tmp(t)), null);
});

test('a directory named CLAUDE.md reads as absent, not a crash', (t) => {
  const root = tmp(t);
  fs.mkdirSync(path.join(root, 'CLAUDE.md'));
  assert.equal(claudeMdLines(root), null);
});

test('no repo root means nothing to measure', () => {
  assert.equal(claudeMdLines(null), null);
  assert.equal(claudeMdLines(''), null);
});
