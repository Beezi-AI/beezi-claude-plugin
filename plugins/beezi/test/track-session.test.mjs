import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trackSession } from '../lib/track-session.mjs';

const args = { sessionId: 's1', transcriptPath: '/t.jsonl', cwd: '/repo/task-42' };

const deps = (over = {}) => ({
  getAccessToken: async () => 'tok',
  currentBranch: () => 'feature/task-42',
  runCheckpoint: async () => ({ enqueued: 1, flush: { flushed: 1, rejected: 0, failed: 0, lastError: null } }),
  ...over,
});

test('saved — reports label from branch and segment count', async () => {
  const res = await trackSession(args, deps());
  assert.equal(res.ok, true);
  assert.equal(res.message, 'Beezi: analytics saved for task-42 (1 segment).');
});

test('nothing new — enqueued 0 and flushed 0', async () => {
  const res = await trackSession(args, deps({
    runCheckpoint: async () => ({ enqueued: 0, flush: { flushed: 0, rejected: 0, failed: 0, lastError: null } }),
  }));
  assert.equal(res.ok, true);
  assert.match(res.message, /nothing new to save for task-42/);
});

test('not linked — no token', async () => {
  const res = await trackSession(args, deps({ getAccessToken: async () => null }));
  assert.equal(res.ok, false);
  assert.match(res.message, /not linked/);
});

test('server unreachable — flush failed', async () => {
  const res = await trackSession(args, deps({
    runCheckpoint: async () => ({ enqueued: 1, flush: { flushed: 0, rejected: 0, failed: 1, lastError: 'HTTP 503' } }),
  }));
  assert.equal(res.ok, false);
  assert.match(res.message, /could not reach the server/);
});

test('rejected — carries the server reason', async () => {
  const res = await trackSession(args, deps({
    runCheckpoint: async () => ({ enqueued: 1, flush: { flushed: 0, rejected: 1, failed: 0, lastError: 'branch not linked' } }),
  }));
  assert.equal(res.ok, false);
  assert.equal(res.message, 'Beezi: branch not linked.');
});

test('outside a repo — labels by the cwd folder name', async () => {
  const res = await trackSession({ ...args, cwd: '/some/dir' }, deps({
    currentBranch: () => { throw new Error('not a repo'); },
  }));
  assert.equal(res.ok, true);
  assert.match(res.message, /for dir /);
});
