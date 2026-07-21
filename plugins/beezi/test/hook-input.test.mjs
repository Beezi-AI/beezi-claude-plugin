import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isGitCheckpointCommand } from '../lib/hook-input.mjs';

// ─── matches ────────────────────────────────────────────────────────────────

test('matches: git commit -m "x"', () => {
  assert.equal(isGitCheckpointCommand('git commit -m "x"'), true);
});

test('matches: git switch main', () => {
  assert.equal(isGitCheckpointCommand('git switch main'), true);
});

test('matches: git checkout -b feat', () => {
  assert.equal(isGitCheckpointCommand('git checkout -b feat'), true);
});

test('matches: git   commit (extra spaces)', () => {
  assert.equal(isGitCheckpointCommand('git   commit'), true);
});

// ─── rejects ────────────────────────────────────────────────────────────────

test('rejects: git status', () => {
  assert.equal(isGitCheckpointCommand('git status'), false);
});

test('rejects: git log --oneline', () => {
  assert.equal(isGitCheckpointCommand('git log --oneline'), false);
});

test('rejects: npm run commit', () => {
  assert.equal(isGitCheckpointCommand('npm run commit'), false);
});

test('rejects: empty string', () => {
  assert.equal(isGitCheckpointCommand(''), false);
});
