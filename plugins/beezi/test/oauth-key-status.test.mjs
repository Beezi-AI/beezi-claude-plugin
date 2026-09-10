import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchOauthKeyStatus, readOauthKeyStatus } from '../lib/oauth-key-status.mjs';

// Each test gets its own BEEZI_HOME so the cache file cannot leak between tests or touch ~/.beezi.
async function withTempHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-keystatus-'));
  const prev = process.env.BEEZI_HOME;
  process.env.BEEZI_HOME = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.BEEZI_HOME; else process.env.BEEZI_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const TOKEN = `sk-ant-oat01-${'y'.repeat(40)}`;
const envWithToken = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN };

const respond = (body, status = 200) => async () => ({ status, json: async () => body });

const NEEDS = { known: true, accountLinked: false, subscriptionPlan: null, needsAttention: true };
const RESOLVED = { known: true, accountLinked: true, subscriptionPlan: 'max_20x', needsAttention: false };

test('no token means no question — the probe never fires', async () => {
  await withTempHome(async () => {
    let called = false;
    const status = await fetchOauthKeyStatus('tok', {
      env: {},
      fetchImpl: async () => { called = true; return { status: 200, json: async () => NEEDS }; },
    });
    assert.equal(status, null);
    assert.equal(called, false);
  });
});

test('a token too short to fingerprint is not asked about', async () => {
  await withTempHome(async () => {
    let called = false;
    const status = await fetchOauthKeyStatus('tok', {
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01' },
      fetchImpl: async () => { called = true; return { status: 200, json: async () => NEEDS }; },
    });
    assert.equal(status, null);
    assert.equal(called, false);
  });
});

test('an unresolved key reports needsAttention and only the fingerprint travels', async () => {
  await withTempHome(async () => {
    const calls = [];
    const status = await fetchOauthKeyStatus('tok', {
      env: envWithToken,
      fetchImpl: async (url, opts) => {
        calls.push({ url, body: JSON.parse(opts.body) });
        return { status: 200, json: async () => NEEDS };
      },
    });
    assert.equal(status.needsAttention, true);
    assert.deepEqual(calls[0].body, { prefix: 'sk-ant-oat01', last4: 'yyyy', length: TOKEN.length });
    assert.equal(
      JSON.stringify(calls[0].body).includes(TOKEN.slice(12, -4)),
      false,
      'the middle of the token must never leave the machine',
    );
  });
});

test('the answer is cached, so a second start asks nothing', async () => {
  await withTempHome(async () => {
    let calls = 0;
    const deps = {
      env: envWithToken,
      fetchImpl: async () => { calls += 1; return { status: 200, json: async () => NEEDS }; },
    };
    await fetchOauthKeyStatus('tok', deps);
    const second = await fetchOauthKeyStatus('tok', deps);
    assert.equal(calls, 1);
    assert.equal(second.needsAttention, true);
    assert.equal(readOauthKeyStatus().fingerprint.last4, 'yyyy');
  });
});

test('rotating the token discards the previous key’s verdict rather than ageing it out', async () => {
  await withTempHome(async () => {
    let calls = 0;
    const bodies = [NEEDS, RESOLVED];
    const fetchImpl = async () => ({ status: 200, json: async () => bodies[calls++] });
    await fetchOauthKeyStatus('tok', { env: envWithToken, fetchImpl });
    // A different token: same prefix, different last4 — which is the only thing that discriminates.
    const rotated = { CLAUDE_CODE_OAUTH_TOKEN: `sk-ant-oat01-${'z'.repeat(40)}` };
    const after = await fetchOauthKeyStatus('tok', { env: rotated, fetchImpl });
    assert.equal(calls, 2, 'the new key must be asked about, not answered from the old one');
    assert.equal(after.needsAttention, false);
  });
});

test('a stale cache is re-asked', async () => {
  await withTempHome(async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return { status: 200, json: async () => NEEDS }; };
    const then = new Date('2026-08-01T00:00:00.000Z');
    await fetchOauthKeyStatus('tok', { env: envWithToken, fetchImpl, now: then });
    const later = new Date(then.getTime() + 7 * 60 * 60 * 1000);
    await fetchOauthKeyStatus('tok', { env: envWithToken, fetchImpl, now: later });
    assert.equal(calls, 2);
  });
});

// The distinction the whole nudge rests on: "could not ask" is not "unresolved". A machine that
// cannot reach the portal must never be told its billing is unresolved.
test('an unreachable portal answers null, not needsAttention', async () => {
  await withTempHome(async () => {
    const status = await fetchOauthKeyStatus('tok', {
      env: envWithToken,
      fetchImpl: async () => { throw new Error('offline'); },
    });
    assert.equal(status, null);
  });
});

test('an older server with no such route answers null and caches nothing', async () => {
  await withTempHome(async () => {
    const status = await fetchOauthKeyStatus('tok', {
      env: envWithToken,
      fetchImpl: respond({}, 404),
    });
    assert.equal(status, null);
    assert.equal(readOauthKeyStatus(), null);
  });
});

test('a resolved key reports no attention needed', async () => {
  await withTempHome(async () => {
    const status = await fetchOauthKeyStatus('tok', {
      env: envWithToken,
      fetchImpl: respond(RESOLVED),
    });
    assert.equal(status.needsAttention, false);
    assert.equal(status.subscriptionPlan, 'max_20x');
  });
});
