import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { markAsked } from '../lib/telemetry-consent.mjs';
import { runSessionStart as _runSessionStart } from '../lib/session-start.mjs';

// The setup-token arm of SessionStart: registering a key the portal has never seen, adopting the
// answer once it has one, and the one notice that is said rather than nudged.

function runSessionStart(input, deps = {}) {
  // Same guards as session-start.test.mjs: never let a unit test spawn the OS-environment probe or
  // reach GitHub for the update check.
  return _runSessionStart(input, { env: {}, checkForUpdate: async () => null, ...deps });
}

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-key-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setHome(dir) {
  process.env.BEEZI_HOME = dir;
  markAsked();
}

function fakeFetchWhoamiOkNoRepo() {
  return async (url) => {
    if (String(url).includes('/me/claude-code/whoami')) return { ok: true, status: 200, json: async () => ({}) };
    return { ok: true, json: async () => ({ connected: false }) };
  };
}

const quietBilling = {
  resolveSource: () => 'subscription',
  readBillingConfig: () => ({
    source: 'subscription',
    plan: 'pro',
    capturedAt: new Date().toISOString(),
    anchorCheckedAt: new Date(Date.now() - 60_000).toISOString(),
  }),
  isStale: () => false,
  resolveClaudeSubscription: () => null,
  readClaudeAccountAnchor: () => null,
};

function base(deps) {
  return {
    getAccessToken: async () => 'tok',
    ...quietBilling,
    fetchImpl: fakeFetchWhoamiOkNoRepo(),
    gitImpl: () => { throw new Error('not a git repo'); },
    ...deps,
  };
}

const FINGERPRINT = Object.freeze({ prefix: 'sk-ant-oat01', last4: 'UQAA', length: 108 });

test('an unknown key is registered by a forced check-in, then asked about again', async (t) => {
  setHome(makeTmpDir(t));

  // The portal has never heard of this key, so it withholds needsAttention on purpose — the
  // check-in that registers it rides this very hook. Without the register-then-re-poll the user is
  // told nothing at all and their usage reports unpriced indefinitely.
  const probes = [];
  const syncs = [];
  const result = await runSessionStart({ session_id: 'sess-unknown-key', cwd: '/x' }, base({
    fetchOauthKeyStatus: async (_token, opts) => {
      probes.push(opts == null ? {} : opts);
      if (probes.length === 1) return { known: false, needsAttention: false, subscriptionPlan: null };
      return { known: true, needsAttention: true, subscriptionPlan: null, fingerprint: FINGERPRINT };
    },
    syncAccount: async (_token, options) => { syncs.push(options); return { reported: true }; },
  }));

  assert.equal(probes.length, 2, 'asked again after registering');
  assert.equal(probes[1].refresh, true, 'the second read must bypass the six-hour cache');
  // The hash gate in syncAccountIfNeeded skips the POST for an unchanged payload, which is exactly
  // the state of a machine whose key is unknown for any reason other than a changed payload. The
  // forced send is what actually registers it.
  assert.ok(syncs.some((o) => o != null && o.force === true), 'a forced check-in was issued');
  assert.match(result ?? '', /\/beezi:refresh/);
});

test('a probe that could not ask does NOT trigger a check-in or a second read', async (t) => {
  setHome(makeTmpDir(t));

  // null is "offline, older server, or no token on this machine at all" — never "unknown key".
  // Treating it as unknown would make every token-less and every offline machine pay a serial
  // check-in plus a second probe on every single session, forever, for an unanswerable question.
  const probes = [];
  const syncs = [];
  const result = await runSessionStart({ session_id: 'sess-null-probe', cwd: '/x' }, base({
    fetchOauthKeyStatus: async (_token, opts) => { probes.push(opts); return null; },
    syncAccount: async (_token, options) => { syncs.push(options); return { reported: false }; },
  }));

  assert.equal(probes.length, 1);
  assert.equal(syncs.filter((o) => o != null && o.force === true).length, 0);
  assert.doesNotMatch(result ?? '', /setup token/);
});

test('a key still unknown after registering says nothing and does not throw', async (t) => {
  setHome(makeTmpDir(t));

  const result = await runSessionStart({ session_id: 'sess-still-unknown', cwd: '/x' }, base({
    fetchOauthKeyStatus: async () => ({ known: false, needsAttention: false, subscriptionPlan: null }),
    syncAccount: async () => ({ reported: false }),
  }));

  // An honest silence: the portal has no answer, and inventing a nudge for a state the user cannot
  // act on is how the actionable nudges beside it stop being read.
  assert.doesNotMatch(result ?? '', /setup token/);
});

// ─── the key that inherited someone else's subscription ─────────────────────

const ANCHORED = Object.freeze({
  known: true,
  needsAttention: false,
  subscriptionPlan: 'team',
  subscriptionType: 'team',
  rateLimitTier: 'default_raven',
  accountEmail: 'someone-else@corp.co',
  accountAnchored: true,
  planSource: 'reported',
  fingerprint: FINGERPRINT,
});

test('a key billing an account established by an earlier sign-in is reported once', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const adopted = [];
  const deps = base({
    fetchOauthKeyStatus: async () => ANCHORED,
    recordResolvedKeyData: (status) => { adopted.push(status); return true; },
  });

  const first = await runSessionStart({ session_id: 'sess-anchored-1', cwd: '/x' }, deps);
  assert.match(first ?? '', /an earlier sign-in established/);
  assert.match(first ?? '', /someone-else@corp\.co/, 'names the subscription so the user can judge it');
  // The notice is ADDITIONAL. Usage still gets priced — withholding the plan would trade a
  // questionable answer for no answer at all.
  assert.equal(adopted.length, 1);
  assert.equal(adopted[0].subscriptionPlan, 'team');

  // Said once. The user cannot act on it from here — /link refuses an account that has its own
  // identity — so repeating it every session is noise, not a nudge.
  const second = await runSessionStart({ session_id: 'sess-anchored-2', cwd: '/x' }, deps);
  assert.doesNotMatch(second ?? '', /an earlier sign-in established/);
  assert.equal(adopted.length, 2, 'the adoption still happens every session');
});

test('rotating the token re-arms the notice — a different key is a different question', async (t) => {
  setHome(makeTmpDir(t));

  const deps = base({ fetchOauthKeyStatus: async () => ANCHORED });
  const first = await runSessionStart({ session_id: 'sess-rot-1', cwd: '/x' }, deps);
  assert.match(first ?? '', /an earlier sign-in established/);

  const rotated = { ...ANCHORED, fingerprint: { prefix: 'sk-ant-oat01', last4: 'ZZZZ', length: 108 } };
  const second = await runSessionStart({ session_id: 'sess-rot-2', cwd: '/x' }, base({
    fetchOauthKeyStatus: async () => rotated,
  }));
  assert.match(second ?? '', /an earlier sign-in established/);
});

test('a plan a human declared is never second-guessed', async (t) => {
  setHome(makeTmpDir(t));

  // planSource 'manual' means somebody answered this question deliberately. The account carrying
  // its own identity is then expected, not suspicious.
  const result = await runSessionStart({ session_id: 'sess-manual', cwd: '/x' }, base({
    fetchOauthKeyStatus: async () => ({ ...ANCHORED, planSource: 'manual' }),
  }));
  assert.doesNotMatch(result ?? '', /an earlier sign-in established/);
});

test('a key standing on its own draws no notice', async (t) => {
  setHome(makeTmpDir(t));

  const result = await runSessionStart({ session_id: 'sess-own', cwd: '/x' }, base({
    fetchOauthKeyStatus: async () => ({ ...ANCHORED, accountAnchored: false, accountEmail: null }),
  }));
  assert.doesNotMatch(result ?? '', /an earlier sign-in established/);
});
