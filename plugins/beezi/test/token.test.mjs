import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAccessToken, getAuthentication } from '../lib/token.mjs';
import { runRefreshWorker } from '../lib/refresh-worker.mjs';
import { AUTH_STATES, AUTH_REASONS } from '../lib/auth-state.mjs';
import { readCredentials, commitCredentials, CREDENTIAL_STATUS } from '../lib/credentials.mjs';
import { acquireCredentialLock, releaseCredentialLock, readCredentialLockOwner } from '../lib/credential-lock.mjs';
import { recordInflight, recordBackoff, recordReauthRequired, readInflight } from '../lib/auth-markers.mjs';

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-'));
  const prev = process.env.BEEZI_HOME;
  process.env.BEEZI_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_HOME;
    else process.env.BEEZI_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const FRESH = {
  client_id: 'cid', token_endpoint: 'https://x/oauth/token',
  access_token: 'at', refresh_token: 'rt', expires_at: 10_000_000,
};
const NEXT = { access_token: 'at2', refresh_token: 'rt2', expires_in: 86400 };
const EXPIRING = 9_999_000; // 1s before FRESH.expires_at, inside the 60s skew
const FOREIGN = 'ff'.repeat(16);

// File-only backend chain: the store is real, only the OS store is out of the picture.
const store = { platform: 'unknown', run: () => ({ ok: false, stdout: '' }) };

async function seed(creds) {
  const lock = await acquireCredentialLock({ waitMs: 0 }, store);
  const r = await commitCredentials(creds, { lock, force: true }, store);
  releaseCredentialLock(lock);
  return r.generation;
}

const committed = () => readCredentials(store);

// A keychain that can be made temporarily unreadable, which is the shape of the storage
// failure that used to read as "not linked" (finding 6).
function fakeKeychain() {
  let stored = null;
  const state = { readable: true };
  state.platform = 'darwin';
  state.run = (_file, args) => {
    if (args[0] === 'find-generic-password') {
      return { ok: state.readable && stored !== null, stdout: state.readable && stored !== null ? stored : '' };
    }
    if (args[0] === 'add-generic-password') {
      stored = args[args.indexOf('-w') + 1];
      return { ok: true, stdout: '' };
    }
    if (args[0] === 'delete-generic-password') stored = null;
    return { ok: true, stdout: '' };
  };
  return state;
}

// A fake clock shared by the accessor, the worker and the marker files, so no test depends on a
// real sleep for an interleaving.
function clock(start = EXPIRING) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

// Runs the worker in-process in place of the detached spawn: the accessor's wait loop yields on
// `sleep`, which is where the worker gets to finish.
function inProcessWorker(workerDeps, c) {
  let running = null;
  return {
    spawnWorker: (generation, force) => {
      running = runRefreshWorker({ generation, force }, workerDeps).catch(() => null);
      return true;
    },
    sleep: async (ms) => { c.advance(ms); await running; },
  };
}

test('an unlinked machine is unlinked, not a failure', async (t) => {
  tmpHome(t);
  const auth = await getAuthentication(store);
  assert.equal(auth.authState, AUTH_STATES.UNLINKED);
  assert.equal(auth.reason, AUTH_REASONS.NO_CREDENTIALS);
  assert.equal(auth.accessToken, null);
  assert.equal(await getAccessToken(store), null);
});

test('a fresh token is ready and is not refreshed', async (t) => {
  tmpHome(t);
  await seed(FRESH);
  const auth = await getAuthentication({
    ...store, now: () => 1_000_000, spawnWorker: () => assert.fail('must not refresh'),
  });
  assert.equal(auth.authState, AUTH_STATES.READY);
  assert.equal(auth.accessToken, 'at');
  assert.equal(await getAccessToken({ ...store, now: () => 1_000_000 }), 'at');
});

// finding 6: unreadable storage is a temporary failure, not "not linked".
test('unreadable storage is unavailable with the credentials preserved', async (t) => {
  tmpHome(t);
  const keychain = fakeKeychain();
  const lock = await acquireCredentialLock({ waitMs: 0 }, keychain);
  await commitCredentials(FRESH, { lock, force: true }, keychain);
  releaseCredentialLock(lock);
  keychain.readable = false;
  const auth = await getAuthentication({ ...keychain, now: () => 1_000_000 });
  assert.equal(auth.authState, AUTH_STATES.UNAVAILABLE);
  assert.equal(auth.reason, AUTH_REASONS.STORAGE_UNAVAILABLE);
  keychain.readable = true;
  const back = await getAuthentication({ ...keychain, now: () => 1_000_000 });
  assert.equal(back.accessToken, 'at', 'nothing was deleted; it recovers without a login');
});

test('an expiring token is refreshed by the worker and comes back ready', async (t) => {
  tmpHome(t);
  await seed(FRESH);
  const c = clock();
  const workerDeps = { ...store, now: c.now, refreshTokens: async () => ({ tokens: NEXT }) };
  const auth = await getAuthentication({ ...store, now: c.now, ...inProcessWorker(workerDeps, c) });
  assert.equal(auth.authState, AUTH_STATES.READY);
  assert.equal(auth.accessToken, 'at2');
  const read = await committed();
  assert.equal(read.generation, 2);
  assert.equal(read.credentials.refresh_token, 'rt2');
  assert.equal(read.credentials.client_id, 'cid', 'client metadata carried over');
  assert.equal(readCredentialLockOwner(), null, 'lock released');
});

test('a worker still running reports refreshing, never unlinked', async (t) => {
  tmpHome(t);
  await seed(FRESH);
  recordInflight(1, process.pid, null);
  const auth = await getAuthentication({
    ...store, now: () => EXPIRING, spawnWorker: () => assert.fail('a worker is already on it'),
  });
  assert.equal(auth.authState, AUTH_STATES.REFRESHING);
  assert.equal(auth.reason, AUTH_REASONS.REFRESH_IN_PROGRESS);
});

test('a worker that never answers within the wait reports refreshing and preserves the credentials', async (t) => {
  tmpHome(t);
  await seed(FRESH);
  const c = clock();
  const auth = await getAuthentication({
    ...store, now: c.now, sleep: async (ms) => { c.advance(ms); }, spawnWorker: () => true,
  }, { waitMs: 300 });
  assert.equal(auth.authState, AUTH_STATES.REFRESHING);
  assert.equal((await committed()).generation, 1);
});

// The marker is the only evidence that a rotating grant may have been spent; the next attempt
// reports it instead of deleting anything.
test('an in-flight marker from a dead worker reports refresh_interrupted and keeps the credentials', async (t) => {
  tmpHome(t);
  await seed(FRESH);
  recordInflight(1, 999_999, 1);
  const c = clock();
  const dead = { isAlive: () => false, processStartTime: () => null };
  const workerDeps = {
    ...store, ...dead, now: c.now, refreshTokens: async () => assert.fail('must not submit a grant'),
  };
  const auth = await getAuthentication({
    ...store, ...dead, now: c.now, ...inProcessWorker(workerDeps, c),
  });
  assert.equal(auth.authState, AUTH_STATES.UNAVAILABLE);
  assert.equal(auth.reason, AUTH_REASONS.REFRESH_INTERRUPTED);
  assert.equal((await committed()).credentials.access_token, 'at');
  assert.equal(readInflight(), null, 'the marker is cleared for the next attempt');
});

test('a rejected generation is reauth_required, and nothing is deleted', async (t) => {
  tmpHome(t);
  await seed(FRESH);
  recordReauthRequired(1, AUTH_REASONS.INVALID_GRANT, EXPIRING);
  const auth = await getAuthentication({
    ...store, now: () => EXPIRING, spawnWorker: () => assert.fail('retries of this grant stop'),
  });
  assert.equal(auth.authState, AUTH_STATES.REAUTH_REQUIRED);
  assert.equal(auth.reason, AUTH_REASONS.INVALID_GRANT);
  assert.equal((await committed()).credentials.refresh_token, 'rt');
});

test('a marker for an older generation does not condemn the current one', async (t) => {
  tmpHome(t);
  await seed(FRESH);
  recordReauthRequired(0, AUTH_REASONS.INVALID_GRANT, EXPIRING);
  const auth = await getAuthentication({ ...store, now: () => 1_000_000 });
  assert.equal(auth.authState, AUTH_STATES.READY);
});

test('a stored generation with no refresh token is reauth_required, not a submitted grant', async (t) => {
  tmpHome(t);
  await seed({ ...FRESH, refresh_token: undefined });
  const auth = await getAuthentication({
    ...store, now: () => EXPIRING, spawnWorker: () => assert.fail('there is nothing to submit'),
  });
  assert.equal(auth.authState, AUTH_STATES.REAUTH_REQUIRED);
  assert.equal(auth.reason, AUTH_REASONS.MISSING_REFRESH_TOKEN);
});

// Without the backoff a machine that is merely offline spawns a worker on every single hook.
test('a recent failure holds off the next attempt and keeps reporting its reason', async (t) => {
  tmpHome(t);
  await seed(FRESH);
  recordBackoff(1, AUTH_REASONS.REFRESH_NETWORK_ERROR, EXPIRING);
  const auth = await getAuthentication({
    ...store, now: () => EXPIRING + 1_000, spawnWorker: () => assert.fail('too soon'),
  });
  assert.equal(auth.authState, AUTH_STATES.UNAVAILABLE);
  assert.equal(auth.reason, AUTH_REASONS.REFRESH_NETWORK_ERROR);
  // Past the window, an attempt is allowed again.
  let spawned = false;
  await getAuthentication({
    ...store, now: () => EXPIRING + 3_600_000, sleep: async () => {}, spawnWorker: () => { spawned = true; return true; },
  }, { waitMs: 0 });
  assert.equal(spawned, true);
});

test('the first ready after a non-ready state is reported as recovered', async (t) => {
  tmpHome(t);
  const keychain = fakeKeychain();
  const lock = await acquireCredentialLock({ waitMs: 0 }, keychain);
  await commitCredentials(FRESH, { lock, force: true }, keychain);
  releaseCredentialLock(lock);
  keychain.readable = false;
  await getAuthentication({ ...keychain, now: () => 1_000_000 });
  keychain.readable = true;
  const back = await getAuthentication({ ...keychain, now: () => 1_000_000 });
  assert.equal(back.authState, AUTH_STATES.READY);
  assert.equal(back.reason, AUTH_REASONS.RECOVERED);
  const steady = await getAuthentication({ ...keychain, now: () => 1_000_000 });
  assert.equal(steady.reason, AUTH_REASONS.OK);
});

test('getAccessToken hands back a token only for ready', async (t) => {
  tmpHome(t);
  await seed(FRESH);
  recordReauthRequired(1, AUTH_REASONS.INVALID_GRANT, EXPIRING);
  assert.equal(await getAccessToken({ ...store, now: () => EXPIRING }), null);
});

test('a lock held by someone else reads as refreshing, not as a missing link', async (t) => {
  const dir = tmpHome(t);
  await seed(FRESH);
  fs.mkdirSync(path.join(dir, 'credentials.lock'));
  fs.writeFileSync(
    path.join(dir, 'credentials.lock', 'owner.json'),
    JSON.stringify({ pid: process.pid, nonce: FOREIGN, acquiredAt: Date.now() }),
  );
  const c = clock();
  const workerDeps = { ...store, now: c.now, refreshTokens: async () => assert.fail('the lock is held') };
  const auth = await getAuthentication({ ...store, now: c.now, ...inProcessWorker(workerDeps, c) }, { waitMs: 100 });
  assert.equal(auth.authState, AUTH_STATES.REFRESHING);
  assert.equal((await committed()).generation, 1);
  assert.equal(readCredentialLockOwner().nonce, FOREIGN, 'the holder keeps its lock');
});

test('a machine that has never failed does not report its first ready as a recovery', async (t) => {
  tmpHome(t);
  await seed(FRESH);
  const first = await getAuthentication({ ...store, now: () => 1_000_000 });
  assert.equal(first.authState, AUTH_STATES.READY);
  assert.equal(first.reason, AUTH_REASONS.OK);
});

test('a live lock owner is reported as refreshing without spawning another worker', async (t) => {
  const dir = tmpHome(t);
  await seed(FRESH);
  fs.mkdirSync(path.join(dir, 'credentials.lock'));
  fs.writeFileSync(
    path.join(dir, 'credentials.lock', 'owner.json'),
    JSON.stringify({ pid: process.pid, nonce: FOREIGN, acquiredAt: Date.now() }),
  );
  const auth = await getAuthentication({
    ...store, now: () => EXPIRING, spawnWorker: () => assert.fail('somebody already holds the lock'),
  });
  assert.equal(auth.authState, AUTH_STATES.REFRESHING);
});

// A spawn that never happened is not a worker that died mid-grant: no refresh token can have
// been spent, so it gets its own reason.
test('a worker that could not be spawned is refresh_spawn_failed, not refresh_interrupted', async (t) => {
  tmpHome(t);
  await seed(FRESH);
  const c = clock();
  const auth = await getAuthentication({
    ...store, now: c.now, sleep: async (ms) => { c.advance(ms); }, spawnWorker: () => false,
  }, { waitMs: 100 });
  assert.equal(auth.authState, AUTH_STATES.UNAVAILABLE);
  assert.equal(auth.reason, AUTH_REASONS.REFRESH_SPAWN_FAILED);
  assert.equal((await committed()).credentials.refresh_token, 'rt', 'nothing was deleted');
});
