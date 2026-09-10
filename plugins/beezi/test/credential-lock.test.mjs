import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireCredentialLock,
  releaseCredentialLock,
  holdsCredentialLock,
  readCredentialLockOwner,
  OWNERLESS_GRACE_MS,
  START_TIME_TOLERANCE_S,
} from '../lib/credential-lock.mjs';

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-lock-'));
  const prev = process.env.BEEZI_HOME;
  process.env.BEEZI_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_HOME;
    else process.env.BEEZI_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const lockDir = (dir) => path.join(dir, 'credentials.lock');
const ownerFile = (dir) => path.join(lockDir(dir), 'owner.json');

// Owner nonces are 32 hex chars: a record with anything else is not a valid owner record.
const FOREIGN = 'ff'.repeat(16);
const OTHER = 'ee'.repeat(16);

// A lock left behind by some other holder: `pid` + `startedAt` decide liveness, `nonce` ownership.
function plantLock(dir, { pid, nonce = FOREIGN, startedAt, ageMs = 0 } = {}) {
  fs.mkdirSync(lockDir(dir));
  if (pid != null) {
    fs.writeFileSync(ownerFile(dir), JSON.stringify({ pid, nonce, startedAt, acquiredAt: Date.now() - ageMs }));
  }
  const stamp = new Date(Date.now() - ageMs);
  fs.utimesSync(lockDir(dir), stamp, stamp);
}

test('acquire records the owner pid and a random nonce; a second caller is refused', async (t) => {
  const dir = tmpHome(t);
  const lock = await acquireCredentialLock({ waitMs: 0 });
  assert.ok(lock, 'first caller acquires');
  assert.equal(lock.pid, process.pid);
  assert.match(lock.nonce, /^[0-9a-f]{32}$/);
  const owner = readCredentialLockOwner();
  assert.equal(owner.pid, process.pid);
  assert.equal(owner.nonce, lock.nonce);
  assert.equal(await acquireCredentialLock({ waitMs: 0 }), null, 'held by a live process');
  assert.equal(fs.existsSync(ownerFile(dir)), true);
});

test('release with the owner nonce removes the lock; release with any other nonce is a no-op', async (t) => {
  const dir = tmpHome(t);
  const lock = await acquireCredentialLock({ waitMs: 0 });
  assert.equal(releaseCredentialLock({ ...lock, nonce: 'someone-else' }), false);
  assert.equal(fs.existsSync(lockDir(dir)), true, 'wrong nonce leaves the holder lock in place');
  assert.equal(holdsCredentialLock(lock), true);
  assert.equal(releaseCredentialLock(lock), true);
  assert.equal(fs.existsSync(lockDir(dir)), false);
  assert.equal(holdsCredentialLock(lock), false);
  assert.equal(releaseCredentialLock(lock), false, 'second release is a no-op');
});

test('a lock owned by a live pid is never reclaimed, however old its timestamp', async (t) => {
  const dir = tmpHome(t);
  plantLock(dir, { pid: process.pid, ageMs: 6 * 60 * 60 * 1000 });
  assert.equal(await acquireCredentialLock({ waitMs: 0 }), null);
  assert.equal(readCredentialLockOwner().nonce, FOREIGN, 'holder untouched');
});

test('a lock whose owner pid is dead is reclaimed', async (t) => {
  const dir = tmpHome(t);
  plantLock(dir, { pid: 424242 });
  const lock = await acquireCredentialLock({ waitMs: 0 }, { isAlive: () => false });
  assert.ok(lock, 'reclaimed');
  assert.equal(readCredentialLockOwner().nonce, lock.nonce);
});

test('an ownerless lock is only reclaimed once it is older than the grace window', async (t) => {
  const dir = tmpHome(t);
  plantLock(dir, { ageMs: 0 });
  assert.equal(await acquireCredentialLock({ waitMs: 0 }), null, 'a holder may still be writing its owner record');
  fs.rmSync(lockDir(dir), { recursive: true, force: true });
  plantLock(dir, { ageMs: OWNERLESS_GRACE_MS + 1000 });
  assert.ok(await acquireCredentialLock({ waitMs: 0 }), 'crashed between mkdir and the owner write');
});

test('a stray temp file from an owner write killed mid-flight is cleared with the ownerless lock', async (t) => {
  const dir = tmpHome(t);
  plantLock(dir, { ageMs: OWNERLESS_GRACE_MS + 1000 });
  fs.writeFileSync(path.join(lockDir(dir), 'owner.json.999.abc.tmp'), '{');
  const stamp = new Date(Date.now() - OWNERLESS_GRACE_MS - 1000);
  fs.utimesSync(lockDir(dir), stamp, stamp);
  const lock = await acquireCredentialLock({ waitMs: 0 });
  assert.ok(lock, 'reclaimed');
  assert.deepEqual(fs.readdirSync(lockDir(dir)), ['owner.json']);
});

test('a lock directory that cannot be emptied stays held and acquire still returns within waitMs', async (t) => {
  const dir = tmpHome(t);
  plantLock(dir, { ageMs: OWNERLESS_GRACE_MS + 1000 });
  fs.mkdirSync(path.join(lockDir(dir), 'wedge')); // unlink cannot remove a directory
  const stamp = new Date(Date.now() - OWNERLESS_GRACE_MS - 1000);
  fs.utimesSync(lockDir(dir), stamp, stamp);
  const began = Date.now();
  assert.equal(await acquireCredentialLock({ waitMs: 30, pollMs: 5 }), null);
  assert.ok(Date.now() - began < 1000, 'no spin: the deadline is honoured');
  assert.equal(fs.existsSync(path.join(lockDir(dir), 'wedge')), true);
});

test('acquire waits up to waitMs for a release, polling every pollMs', async (t) => {
  tmpHome(t);
  const holder = await acquireCredentialLock({ waitMs: 0 });
  setTimeout(() => releaseCredentialLock(holder), 60);
  const began = Date.now();
  const lock = await acquireCredentialLock({ waitMs: 2000, pollMs: 10 });
  assert.ok(lock);
  assert.ok(Date.now() - began >= 50, 'waited for the holder');
  assert.notEqual(lock.nonce, holder.nonce);
});

test('acquire gives up after waitMs when the holder stays alive', async (t) => {
  const dir = tmpHome(t);
  plantLock(dir, { pid: process.pid });
  const began = Date.now();
  assert.equal(await acquireCredentialLock({ waitMs: 80, pollMs: 10 }), null);
  assert.ok(Date.now() - began >= 70);
});

// ── finding 2: pid-only liveness cannot see a recycled pid ────────────────────────────────────

test('a live pid whose start time differs from the record is a recycled pid: the lock is reclaimed', async (t) => {
  const dir = tmpHome(t);
  const startedAt = 1_700_000_000;
  plantLock(dir, { pid: process.pid, startedAt });
  const lock = await acquireCredentialLock(
    { waitMs: 0 },
    { processStartTime: () => startedAt + START_TIME_TOLERANCE_S + 1 },
  );
  assert.ok(lock, 'the number was reused by an unrelated process');
  assert.equal(readCredentialLockOwner().nonce, lock.nonce);
});

test('a start time inside the tolerance is the same process: the lock is held', async (t) => {
  const dir = tmpHome(t);
  const startedAt = 1_700_000_000;
  plantLock(dir, { pid: process.pid, startedAt });
  const deps = { processStartTime: () => startedAt + START_TIME_TOLERANCE_S };
  assert.equal(await acquireCredentialLock({ waitMs: 0 }, deps), null);
  assert.equal(readCredentialLockOwner().nonce, FOREIGN, 'holder untouched');
});

test('an undeterminable start time counts as alive, never as a free lock', async (t) => {
  const dir = tmpHome(t);
  plantLock(dir, { pid: process.pid, startedAt: 1_700_000_000 });
  assert.equal(await acquireCredentialLock({ waitMs: 0 }, { processStartTime: () => null }), null);
  assert.equal(readCredentialLockOwner().nonce, FOREIGN, 'holder untouched');
});

test('the start time is probed once per acquire, not once per poll', async (t) => {
  const dir = tmpHome(t);
  plantLock(dir, { pid: process.pid, startedAt: 1_700_000_000 });
  let probes = 0;
  const deps = { processStartTime: () => { probes++; return 1_700_000_000; } };
  assert.equal(await acquireCredentialLock({ waitMs: 60, pollMs: 5 }, deps), null);
  assert.equal(probes, 1, 'the probe spawns a process; polling must not repeat it');
});

// ── finding 1: two waiters over one dead owner ────────────────────────────────────────────────

test('two waiters reclaiming one dead owner: only one wins and the loser never strips it', async (t) => {
  const dir = tmpHome(t);
  plantLock(dir, { pid: 424242 });
  const dead = () => false;
  let reachedTombstone;
  const paused = new Promise((r) => { reachedTombstone = r; });
  let resume;
  const gate = new Promise((r) => { resume = r; });
  // The loser is frozen between its owner re-read and the tombstone rename — the ABA window.
  const loser = acquireCredentialLock({ waitMs: 0 }, {
    isAlive: dead,
    reclaimStep: async (step) => { if (step === 'tombstone') { reachedTombstone(); await gate; } },
  });
  await paused;
  const winner = await acquireCredentialLock({ waitMs: 0 }, { isAlive: dead });
  assert.ok(winner, 'the other waiter reclaims the dead owner and acquires');
  resume();
  assert.equal(await loser, null, 'the loser polls out instead of taking the lock');
  assert.equal(fs.existsSync(ownerFile(dir)), true, "the winner's owner record is back in place");
  assert.equal(readCredentialLockOwner().nonce, winner.nonce);
  assert.equal(holdsCredentialLock(winner), true);
});

test('a tombstone holding a live record is not swept by the ownerless grace', async (t) => {
  const dir = tmpHome(t);
  const startedAt = 1_700_000_000;
  fs.mkdirSync(lockDir(dir));
  // A reclaimer renamed a live owner away and stalled before renaming it back.
  fs.writeFileSync(
    path.join(lockDir(dir), `owner.${OTHER}.dead`),
    JSON.stringify({ pid: process.pid, nonce: OTHER, startedAt, acquiredAt: Date.now() }),
  );
  const stamp = new Date(Date.now() - OWNERLESS_GRACE_MS - 1000);
  fs.utimesSync(lockDir(dir), stamp, stamp);
  const deps = { processStartTime: () => startedAt };
  assert.equal(await acquireCredentialLock({ waitMs: 0 }, deps), null);
  assert.equal(holdsCredentialLock({ pid: process.pid, nonce: OTHER }), true, 'the stalled holder keeps it');
});

test('readCredentialLockOwner is null when nothing holds the lock', (t) => {
  tmpHome(t);
  assert.equal(readCredentialLockOwner(), null);
});
