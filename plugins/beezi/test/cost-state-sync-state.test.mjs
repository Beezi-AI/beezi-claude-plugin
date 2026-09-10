import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  readSyncState, isDue, markAttempt, markSuccess, scanFloorMs, STATE_VERSION, DUE_MS, OVERLAP_MS,
} from '../lib/cost-state-sync-state.mjs';

function makeHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-state-sync-test-'));
  process.env.BEEZI_HOME = dir;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('due when no state exists', (t) => {
  makeHome(t);
  assert.strictEqual(isDue(readSyncState(), Date.now()), true);
});

test('not due inside the hour', (t) => {
  makeHome(t);
  const now = Date.now();
  markAttempt(now);
  assert.strictEqual(isDue(readSyncState(), now + DUE_MS - 1000), false);
});

test('due again after the hour', (t) => {
  makeHome(t);
  const now = Date.now();
  markAttempt(now);
  assert.strictEqual(isDue(readSyncState(), now + DUE_MS + 1000), true);
});

test('an attempt gates even when the run never succeeds', (t) => {
  makeHome(t);
  const now = Date.now();
  markAttempt(now);
  // No markSuccess: a child that crashed must still cost an hour, not respawn every turn.
  assert.strictEqual(isDue(readSyncState(), now + 60_000), false);
});

test('success advances lastScanAt', (t) => {
  makeHome(t);
  const now = Date.now();
  markAttempt(now);
  markSuccess(now + 5000);
  assert.strictEqual(new Date(readSyncState().lastScanAt).getTime(), now + 5000);
});

test('a stamp from the future is treated as a clock change, not freshness', (t) => {
  makeHome(t);
  const now = Date.now();
  markAttempt(now + 10 * DUE_MS);
  assert.strictEqual(isDue(readSyncState(), now), true);
});

test('a state file from another version is ignored', (t) => {
  const dir = makeHome(t);
  fs.writeFileSync(
    path.join(dir, 'cost-state-sync.json'),
    JSON.stringify({ version: STATE_VERSION + 1, attemptedAt: new Date().toISOString() }),
  );
  assert.strictEqual(isDue(readSyncState(), Date.now()), true);
});

test('a corrupt state file is ignored rather than thrown', (t) => {
  const dir = makeHome(t);
  fs.writeFileSync(path.join(dir, 'cost-state-sync.json'), '{ not json');
  assert.strictEqual(isDue(readSyncState(), Date.now()), true);
});

// The two stamps are not interchangeable: a failed attempt saw nothing, so it must not move the
// mtime floor past transcripts it never uploaded. Their mtimes never change again.
test('the mtime floor comes from lastScanAt alone, never from an attempt', (t) => {
  makeHome(t);
  const now = Date.now();
  markAttempt(now);
  assert.strictEqual(scanFloorMs(readSyncState()), 0);
  markSuccess(now);
  assert.strictEqual(scanFloorMs(readSyncState()), now - OVERLAP_MS);
});
