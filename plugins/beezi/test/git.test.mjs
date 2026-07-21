import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskFromBranch, sanitizeRemote, TASK_BRANCH_RE } from '../lib/git.mjs';

test('taskFromBranch — extracts task token from a task branch', () => {
  assert.equal(taskFromBranch('feature/task-abc-123'), 'task-abc-123');
  assert.equal(taskFromBranch('beezi/task-PROJ_9'), 'task-PROJ_9');
});

test('taskFromBranch — null when the branch does not fit', () => {
  assert.equal(taskFromBranch('main'), null);
  assert.equal(taskFromBranch('feature/no-task-here'), null);
  assert.equal(taskFromBranch('task-abc'), null); // needs a leading segment before task-
  assert.equal(taskFromBranch(''), null);
  assert.equal(taskFromBranch(undefined), null);
});

test('taskFromBranch — agrees with TASK_BRANCH_RE (checkpoint filter)', () => {
  for (const branch of ['x/task-1', 'main', 'feat/task-a_b-c', 'nope']) {
    assert.equal(Boolean(taskFromBranch(branch)), TASK_BRANCH_RE.test(branch));
  }
});

test('sanitizeRemote — strips credentials from the URL', () => {
  assert.equal(
    sanitizeRemote('https://user:tok@host/acme/repo.git'),
    'https://host/acme/repo.git',
  );
});
