import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  fetchOauthKeyStatus,
  readOauthKeyStatus,
  clearOauthKeyStatus,
} from '../lib/oauth-key-status.mjs';

// The v3 cache: the whole portal answer, not just the plan, plus the two controls the session-start
// flow needs — a forced re-read, and a way to throw the answer away once it is known to be stale.

async function withTempHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-keyfields-'));
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

const FULL = Object.freeze({
  known: true,
  accountLinked: true,
  subscriptionPlan: 'max_20x',
  planSource: 'reported',
  needsAttention: false,
  subscriptionType: 'max',
  rateLimitTier: 'default_claude_max_20x',
  accountEmail: 'ci@example.com',
  accountAnchored: true,
});

test('the whole answer is returned and cached, fingerprint included', async () => {
  await withTempHome(async () => {
    const status = await fetchOauthKeyStatus('tok', {
      env: envWithToken,
      fetchImpl: respond(FULL),
    });
    assert.equal(status.subscriptionType, 'max');
    assert.equal(status.rateLimitTier, 'default_claude_max_20x');
    assert.equal(status.accountEmail, 'ci@example.com');
    assert.equal(status.accountAnchored, true);
    assert.equal(status.accountLinked, true);
    // planSource decides whether session-start warns that this key is riding a subscription an
    // interactive sign-in established. It was dropped here for two versions, which left that
    // notice comparing against undefined and unable to fire at all.
    assert.equal(status.planSource, 'reported');
    // The fingerprint rides the return value so the caller scopes the adopted plan to the key it
    // was resolved for, instead of re-deriving it from a second env read.
    assert.deepEqual(status.fingerprint, { prefix: 'sk-ant-oat01', last4: 'yyyy', length: TOKEN.length });

    const cached = readOauthKeyStatus();
    assert.equal(cached.version, 3);
    assert.equal(cached.subscriptionType, 'max');
    assert.equal(cached.accountAnchored, true);
    assert.equal(cached.planSource, 'reported');
  });
});

test('a cache hit replays every field, not just the plan', async () => {
  await withTempHome(async () => {
    await fetchOauthKeyStatus('tok', { env: envWithToken, fetchImpl: respond(FULL) });

    let calls = 0;
    const status = await fetchOauthKeyStatus('tok', {
      env: envWithToken,
      fetchImpl: async () => { calls += 1; return { status: 200, json: async () => FULL }; },
    });
    assert.equal(calls, 0, 'served from the cache');
    assert.equal(status.subscriptionType, 'max');
    assert.equal(status.accountEmail, 'ci@example.com');
    assert.equal(status.accountAnchored, true);
    assert.equal(status.planSource, 'reported');
    assert.deepEqual(status.fingerprint, { prefix: 'sk-ant-oat01', last4: 'yyyy', length: TOKEN.length });
  });
});

test('an older server that sends only the plan yields nulls, never undefined', async () => {
  await withTempHome(async () => {
    const status = await fetchOauthKeyStatus('tok', {
      env: envWithToken,
      fetchImpl: respond({ known: true, subscriptionPlan: 'pro', needsAttention: false }),
    });
    assert.equal(status.subscriptionPlan, 'pro');
    assert.equal(status.subscriptionType, null);
    assert.equal(status.rateLimitTier, null);
    assert.equal(status.accountEmail, null);
    assert.equal(status.accountAnchored, false);
    // Null, not undefined: session-start compares this against a string literal, and undefined
    // would make the comparison quietly unreachable rather than false.
    assert.equal(status.planSource, null);
  });
});

test('refresh: true bypasses a fresh cache', async () => {
  await withTempHome(async () => {
    await fetchOauthKeyStatus('tok', {
      env: envWithToken,
      fetchImpl: respond({ known: false, needsAttention: false, subscriptionPlan: null }),
    });

    // The check-in that registers this key has just landed, so the cached "unknown" is already
    // wrong. Believing it would report the key as unknown for another six hours.
    let calls = 0;
    const status = await fetchOauthKeyStatus('tok', {
      env: envWithToken,
      refresh: true,
      fetchImpl: async () => { calls += 1; return { status: 200, json: async () => FULL }; },
    });
    assert.equal(calls, 1);
    assert.equal(status.known, true);
    assert.equal(readOauthKeyStatus().known, true, 'the forced read replaces the cache too');
  });
});

test('a v1 cache file is discarded rather than half-read', async () => {
  await withTempHome(async (dir) => {
    fs.writeFileSync(
      path.join(dir, 'oauth-key-status.json'),
      JSON.stringify({
        version: 1,
        fingerprint: { prefix: 'sk-ant-oat01', last4: 'yyyy', length: TOKEN.length },
        checkedAt: new Date().toISOString(),
        known: true,
        needsAttention: false,
        subscriptionPlan: 'team',
      }),
    );

    let calls = 0;
    const status = await fetchOauthKeyStatus('tok', {
      env: envWithToken,
      fetchImpl: async () => { calls += 1; return { status: 200, json: async () => FULL }; },
    });
    assert.equal(calls, 1, 'the version gate rejects it, so the portal is asked again');
    assert.equal(status.subscriptionPlan, 'max_20x');
  });
});

// The v2 → v3 bump exists so the planSource fix takes effect today rather than whenever each
// machine's six-hour cache happens to lapse. A v2 file has every other field this reader wants,
// so nothing but the version gate stops it being served — which is exactly what would leave the
// anchored-key notice unable to fire for another six hours per machine.
test('a v2 cache file is discarded too, so the planSource fix lands at once', async () => {
  await withTempHome(async (dir) => {
    fs.writeFileSync(
      path.join(dir, 'oauth-key-status.json'),
      JSON.stringify({
        version: 2,
        fingerprint: { prefix: 'sk-ant-oat01', last4: 'yyyy', length: TOKEN.length },
        checkedAt: new Date().toISOString(),
        known: true,
        needsAttention: false,
        subscriptionPlan: 'max_20x',
        accountAnchored: true,
        // No planSource — that is the whole reason a v2 file cannot be trusted.
      }),
    );

    let calls = 0;
    const status = await fetchOauthKeyStatus('tok', {
      env: envWithToken,
      fetchImpl: async () => { calls += 1; return { status: 200, json: async () => FULL }; },
    });
    assert.equal(calls, 1, 'the version gate rejects it, so the portal is asked again');
    assert.equal(status.planSource, 'reported');
  });
});

test('clearOauthKeyStatus drops the answer so the next call asks again', async () => {
  await withTempHome(async () => {
    await fetchOauthKeyStatus('tok', { env: envWithToken, fetchImpl: respond(FULL) });
    assert.notEqual(readOauthKeyStatus(), null);

    assert.equal(clearOauthKeyStatus(), true);
    assert.equal(readOauthKeyStatus(), null);

    let calls = 0;
    await fetchOauthKeyStatus('tok', {
      env: envWithToken,
      fetchImpl: async () => { calls += 1; return { status: 200, json: async () => FULL }; },
    });
    assert.equal(calls, 1);
  });
});

test('clearing an absent cache is not an error — it is a cache', async () => {
  await withTempHome(async () => {
    assert.equal(clearOauthKeyStatus(), false);
  });
});

// Contract guard between this module and its one consumer.
//
// session-start.mjs reads keyStatus.planSource and compares it against a string literal. This
// module dropped that field for two versions, so the comparison was always undefined === 'reported'
// — false, silently, forever — and the notice it gates could not fire. The suite stayed green the
// whole time because session-start's own tests stub fetchOauthKeyStatus with a hand-written object
// that DID carry planSource, i.e. they asserted against a shape this function never produced.
//
// So: assert the real return value carries every field the consumer reads. A stub can lie about
// the shape; this cannot.
test('the returned answer carries every field session-start reads', async () => {
  await withTempHome(async () => {
    const live = await fetchOauthKeyStatus('tok', { env: envWithToken, fetchImpl: respond(FULL) });
    // Read straight out of lib/session-start.mjs's key block.
    const consumed = [
      'known', 'needsAttention', 'subscriptionPlan', 'subscriptionType', 'rateLimitTier',
      'accountEmail', 'accountAnchored', 'planSource', 'fingerprint',
    ];
    const missing = consumed.filter((k) => !(k in live));
    assert.deepEqual(missing, [], `fields the consumer reads but this module never sends: ${missing}`);

    // And again off the cache, which is a separately hand-written object literal — the exact
    // shape of duplication that let the two drift apart in the first place.
    const cachedAnswer = await fetchOauthKeyStatus('tok', {
      env: envWithToken,
      fetchImpl: () => { throw new Error('must be served from cache'); },
    });
    const missingCached = consumed.filter((k) => !(k in cachedAnswer));
    assert.deepEqual(missingCached, [], `fields missing from the CACHED answer: ${missingCached}`);
  });
});
