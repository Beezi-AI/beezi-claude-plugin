import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAccessToken } from '../lib/token.mjs';

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

test('returns null when not linked', async () => {
  assert.equal(await getAccessToken({ getCredentials: async () => null }), null);
});

test('returns the stored token while fresh, without refreshing', async () => {
  let refreshed = false;
  const token = await getAccessToken({
    getCredentials: async () => ({ ...FRESH }),
    refreshTokens: async () => { refreshed = true; return { tokens: null }; },
    now: () => 1_000_000, // 9000s before expiry
  });
  assert.equal(token, 'at');
  assert.equal(refreshed, false);
});

test('refreshes an expiring token and persists the result', async (t) => {
  tmpHome(t);
  let saved;
  const token = await getAccessToken({
    getCredentials: async () => ({ ...FRESH }),
    setCredentials: async (c) => { saved = c; return 'file'; },
    refreshTokens: async () => ({ tokens: { access_token: 'at2', refresh_token: 'rt2', expires_in: 86400 } }),
    now: () => 9_999_000, // 1s before expiry (< 60s skew)
  });
  assert.equal(token, 'at2');
  assert.equal(saved.access_token, 'at2');
  assert.equal(saved.refresh_token, 'rt2');
  assert.equal(saved.expires_at, 9_999_000 + 86_400_000);
});

test('invalid_grant wipes credentials and returns null', async (t) => {
  tmpHome(t);
  let deleted = false;
  const token = await getAccessToken({
    getCredentials: async () => ({ ...FRESH }),
    deleteCredentials: async () => { deleted = true; },
    refreshTokens: async () => ({ invalidGrant: true }),
    now: () => 9_999_000,
  });
  assert.equal(token, null);
  assert.equal(deleted, true);
});

test('transient refresh failure falls back to the stale token', async (t) => {
  tmpHome(t);
  const token = await getAccessToken({
    getCredentials: async () => ({ ...FRESH }),
    refreshTokens: async () => ({ tokens: null }),
    now: () => 9_999_000,
  });
  assert.equal(token, 'at');
});

test('waits out a concurrent refresh instead of racing it', async (t) => {
  const dir = tmpHome(t);
  fs.mkdirSync(path.join(dir, 'token-refresh.lock'), { recursive: true }); // someone holds the lock
  let reread = 0;
  const token = await getAccessToken({
    getCredentials: async () => { reread += 1; return { ...FRESH }; },
    refreshTokens: async () => { throw new Error('must not refresh under contention'); },
    now: () => 9_999_000,
    sleep: async () => {},
  });
  assert.equal(token, 'at'); // second read's token
  assert.equal(reread, 2);
});
