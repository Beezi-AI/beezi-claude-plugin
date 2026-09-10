import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runRefreshWorker } from '../lib/refresh-worker.mjs';
import { AUTH_REASONS } from '../lib/auth-state.mjs';
import { readCredentials, commitCredentials, setCredentials } from '../lib/credentials.mjs';
import { acquireCredentialLock, releaseCredentialLock, readCredentialLockOwner } from '../lib/credential-lock.mjs';
import { readInflight, readReauthMarker, readBackoff, recordInflight } from '../lib/auth-markers.mjs';

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-worker-'));
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
const EXPIRING = 9_999_000;
const FOREIGN = 'ff'.repeat(16);

const store = { platform: 'unknown', run: () => ({ ok: false, stdout: '' }) };
const base = { ...store, now: () => EXPIRING };

async function seed(creds) {
  const lock = await acquireCredentialLock({ waitMs: 0 }, store);
  const r = await commitCredentials(creds, { lock, force: true }, store);
  releaseCredentialLock(lock);
  return r.generation;
}

const committed = () => readCredentials(store);
// The handle of whoever holds the lock now, rebuilt from the on-disk record — how a test stands
// in for "another process moved the generation underneath the worker".
const currentHolder = () => ({ ...readCredentialLockOwner() });

test('a successful refresh commits a new generation and releases the lock', async (t) => {
  tmpHome(t);
  await seed(FRESH);
  const r = await runRefreshWorker({ generation: 1 }, { ...base, refreshTokens: async () => ({ tokens: NEXT }) });
  assert.equal(r.outcome, 'committed');
  const read = await committed();
  assert.equal(read.generation, 2);
  assert.equal(read.credentials.access_token, 'at2');
  assert.equal(read.credentials.expires_at, EXPIRING + 86_400_000);
  assert.equal(readCredentialLockOwner(), null);
  assert.equal(readInflight(), null, 'the in-flight marker is cleared');
});

// The defect this whole task exists for: invalid_grant used to delete the credentials.
test('invalid_grant marks the generation reauth_required and deletes nothing', async (t) => {
  tmpHome(t);
  await seed(FRESH);
  const r = await runRefreshWorker({ generation: 1 }, {
    ...base, refreshTokens: async () => ({ invalidGrant: true, error: 'invalid_grant' }),
  });
  assert.equal(r.reason, AUTH_REASONS.INVALID_GRANT);
  const read = await committed();
  assert.equal(read.generation, 1);
  assert.equal(read.credentials.refresh_token, 'rt', 'the refresh token survives');
  assert.equal(read.credentials.client_id, 'cid', 'the registered client survives');
  assert.equal(readReauthMarker(1).reason, AUTH_REASONS.INVALID_GRANT);
});

test('invalid_client is marked under its own reason', async (t) => {
  tmpHome(t);
  await seed(FRESH);
  await runRefreshWorker({ generation: 1 }, {
    ...base, refreshTokens: async () => ({ invalidGrant: true, error: 'invalid_client' }),
  });
  assert.equal(readReauthMarker(1).reason, AUTH_REASONS.INVALID_CLIENT);
});

test('a transient failure records a backoff and preserves the credentials', async (t) => {
  tmpHome(t);
  await seed(FRESH);
  const r = await runRefreshWorker({ generation: 1 }, {
    ...base, refreshTokens: async () => ({ tokens: null, failure: 'timeout' }),
  });
  assert.equal(r.reason, AUTH_REASONS.REFRESH_TIMEOUT);
  assert.equal(readBackoff(1).reason, AUTH_REASONS.REFRESH_TIMEOUT);
  assert.ok(readBackoff(1).nextAttemptAt > EXPIRING);
  assert.equal((await committed()).generation, 1);
  assert.equal(readReauthMarker(1), null, 'a blip never asks for reauthorization');
});

test('the in-flight marker is written before the grant is submitted', async (t) => {
  tmpHome(t);
  await seed(FRESH);
  let markerAtSubmit = null;
  await runRefreshWorker({ generation: 1 }, {
    ...base,
    refreshTokens: async () => { markerAtSubmit = readInflight(); return { tokens: NEXT }; },
  });
  assert.equal(markerAtSubmit.generation, 1);
  assert.equal(markerAtSubmit.pid, process.pid);
});

// finding 4: a worker delayed behind another process must not submit a grant that has already
// been replaced.
test('a worker whose generation has been superseded submits nothing', async (t) => {
  tmpHome(t);
  await seed(FRESH);
  const lock = await acquireCredentialLock({ waitMs: 0 }, store);
  await commitCredentials({ ...FRESH, access_token: 'at-login' }, { lock, expectedGeneration: 1 }, store);
  releaseCredentialLock(lock);
  const r = await runRefreshWorker({ generation: 1 }, {
    ...base, refreshTokens: async () => assert.fail('the grant is stale'),
  });
  assert.equal(r.outcome, 'superseded');
  assert.equal((await committed()).credentials.access_token, 'at-login');
});

test('a worker that cannot take the lock gets out of the way', async (t) => {
  const dir = tmpHome(t);
  await seed(FRESH);
  fs.mkdirSync(path.join(dir, 'credentials.lock'));
  fs.writeFileSync(
    path.join(dir, 'credentials.lock', 'owner.json'),
    JSON.stringify({ pid: process.pid, nonce: FOREIGN, acquiredAt: Date.now() }),
  );
  const r = await runRefreshWorker({ generation: 1 }, {
    ...base, refreshTokens: async () => assert.fail('the lock is held'),
  });
  assert.equal(r.outcome, 'busy');
  assert.equal(readCredentialLockOwner().nonce, FOREIGN);
});

test('an in-flight marker from a dead worker is reported, not retried', async (t) => {
  tmpHome(t);
  await seed(FRESH);
  recordInflight(1, 999_999, 1);
  const r = await runRefreshWorker({ generation: 1 }, {
    ...base,
    isAlive: () => false,
    processStartTime: () => null,
    refreshTokens: async () => assert.fail('the previous grant may already be spent'),
  });
  assert.equal(r.reason, AUTH_REASONS.REFRESH_INTERRUPTED);
  assert.equal(readBackoff(1).reason, AUTH_REASONS.REFRESH_INTERRUPTED);
  assert.equal(readInflight(), null);
  assert.equal((await committed()).credentials.refresh_token, 'rt');
});

// finding 4, second half: a refresh whose lock was taken away commits nothing.
test('a refresh that loses the lock mid-flight commits nothing', async (t) => {
  tmpHome(t);
  await seed(FRESH);
  const r = await runRefreshWorker({ generation: 1 }, {
    ...base,
    refreshTokens: async () => { releaseCredentialLock(currentHolder()); return { tokens: NEXT }; },
  });
  assert.notEqual(r.outcome, 'committed');
  assert.equal((await committed()).credentials.access_token, 'at', 'store untouched');
});

// finding 4, third half: a login that lands while the worker is refreshing wins, whatever the
// refresh outcome turns out to be.
for (const outcome of [{ tokens: NEXT }, { invalidGrant: true, error: 'invalid_grant' }]) {
  const label = outcome.tokens ? 'success' : 'invalid_grant';
  test(`a login committed during an in-flight refresh (${label}) survives it`, async (t) => {
    tmpHome(t);
    await seed(FRESH);
    let finish;
    const pending = runRefreshWorker({ generation: 1 }, {
      ...base, refreshTokens: () => new Promise((resolve) => { finish = () => resolve(outcome); }),
    });
    await new Promise((r) => setTimeout(r, 20));
    const login = setCredentials(
      { ...FRESH, client_id: 'login-client', access_token: 'at-login', expires_at: 20_000_000 },
      store,
    );
    await new Promise((r) => setTimeout(r, 60));
    assert.equal((await committed()).generation, 1, 'login is still waiting on the lock');
    finish();
    await pending;
    await login;
    const read = await committed();
    assert.equal(read.credentials.client_id, 'login-client');
    assert.equal(read.credentials.access_token, 'at-login');
  });
}

test('a refresh token the store never got is reauth_required, not a submitted grant', async (t) => {
  tmpHome(t);
  await seed({ ...FRESH, refresh_token: '' });
  const r = await runRefreshWorker({ generation: 1 }, {
    ...base, refreshTokens: async () => assert.fail('there is nothing to submit'),
  });
  assert.equal(r.reason, AUTH_REASONS.MISSING_REFRESH_TOKEN);
  assert.equal(readReauthMarker(1).reason, AUTH_REASONS.MISSING_REFRESH_TOKEN);
});

test('the operation budget ends a worker that never returns', async (t) => {
  tmpHome(t);
  await seed(FRESH);
  const r = await runRefreshWorker({ generation: 1, budgetMs: 20 }, {
    ...base, refreshTokens: () => new Promise(() => {}),
  });
  assert.equal(r.outcome, 'expired');
  assert.equal(r.reason, AUTH_REASONS.REFRESH_TIMEOUT);
});
