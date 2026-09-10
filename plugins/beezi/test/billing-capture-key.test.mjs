import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig, shouldKeepExisting, reconcileBillingConfig } from '../lib/billing-capture.mjs';

// The interactive-login → setup-token transition, and what protects the record afterwards.
//
// Its own file rather than more lines on billing-capture.test.mjs: every case here turns on ONE
// distinction the rest of that suite never has to make — did the CLI positively confirm a setup
// token is in force, or did it merely fail to say otherwise? Everything else follows from that.

const T0 = new Date('2026-08-21T10:00:00.000Z');
const iso = (msAgo) => new Date(T0.getTime() - msAgo).toISOString();
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// Same shape as billing-capture.test.mjs's harness, kept local so the two suites cannot drift
// through a shared fixture neither of them owns.
function harness({ existing = null, sub = null, fileAnchor = null, env = {} } = {}) {
  const writes = [];
  let store = existing;
  const subCalls = { count: 0 };
  return {
    writes,
    subCalls,
    deps: {
      readBillingConfig: () => store,
      writeBillingConfig: (cfg) => { writes.push(cfg); store = cfg; },
      // A machine exporting a setup token resolves to SUBSCRIPTION whether or not a plan is known —
      // billing.mjs forces it from the env. Modelled here so the reconcile's tail does not see a
      // phantom source drift and write the record back out on an otherwise no-op run.
      resolveSource: (cfg) => (
        cfg != null && (cfg.keyFingerprint != null || (cfg.plan && cfg.plan !== 'unknown'))
          ? 'subscription'
          : 'unknown'
      ),
      isStale: () => false,
      resolveClaudeSubscription: () => { subCalls.count += 1; return sub; },
      readClaudeAccountAnchor: () => fileAnchor,
      env,
      now: T0,
    },
  };
}

// >= 20 characters, so keyFingerprint() yields a triple rather than null. 44 chars long.
const TOKEN = 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz-UQAA';
const TOKEN_ENV = Object.freeze({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
const FINGERPRINT = Object.freeze({ prefix: 'sk-ant-oat01', last4: 'UQAA', length: TOKEN.length });

// What resolveClaudeSubscription returns from its authMethod === 'oauth_token' branch: plan tuple
// cleared, identity fields null, anchor derived from the token itself. `planSource: 'unresolved'`
// is the confirmation — it is set nowhere else.
const TOKEN_CONFIRMED_SUB = Object.freeze({
  accountUuid: null,
  email: null,
  subscriptionType: null,
  rateLimitTier: null,
  expiresAt: null,
  billingType: null,
  seatTier: null,
  organizationType: null,
  planSource: 'unresolved',
  detectedVia: 'oauth_token',
  anchor: { value: `sk-ant-oat01...UQAA:${TOKEN.length}`, source: 'oauth_key' },
});

// The record the incident left behind: captured from an interactive login, then stamped with the
// plan the server resolved for a key that had been bound to that same (wrong) account.
const LOGIN_RECORD = Object.freeze({
  version: 3,
  source: 'subscription',
  plan: 'team',
  subscriptionType: 'team',
  rateLimitTier: 'default_raven',
  planSource: 'key_resolution',
  capturedAt: iso(DAY_MS),
  anchorCheckedAt: iso(30 * DAY_MS),
  accountAnchor: { value: 'hash-of-user-id', source: 'user_id', updatedAt: iso(30 * DAY_MS) },
  accountUuid: 'acc-uuid-1',
  accountEmail: 'someone-else@corp.co',
});

test('reconcile — a confirmed login→token switch resets the record to the key alone', () => {
  const h = harness({ existing: LOGIN_RECORD, sub: TOKEN_CONFIRMED_SUB, env: TOKEN_ENV });
  const { config, outcome } = reconcileBillingConfig(h.deps);

  assert.equal(outcome, 'switched');
  // Everything describing the previous account is GONE, not merely withheld from the wire.
  assert.equal(config.plan, null);
  assert.equal(config.subscriptionType, null);
  assert.equal(config.rateLimitTier, null);
  assert.equal(config.accountUuid, null);
  assert.equal(config.accountEmail, null);
  // And the record now names the key it belongs to, so the server's answer can be scoped to it.
  assert.equal(config.accountAnchor.source, 'oauth_key');
  assert.deepEqual(config.keyFingerprint, FINGERPRINT);
  assert.equal(config.version, 4);
});

test('reconcile — the switch is self-disabling: an oauth_key-anchored record does not re-fire', () => {
  const h = harness({
    existing: {
      version: 4,
      source: 'subscription',
      plan: null,
      planSource: 'unresolved',
      capturedAt: iso(60 * 1000),
      anchorCheckedAt: iso(60 * 1000),
      accountAnchor: { value: `sk-ant-oat01...UQAA:${TOKEN.length}`, source: 'oauth_key', updatedAt: iso(60 * 1000) },
      keyFingerprint: FINGERPRINT,
    },
    sub: TOKEN_CONFIRMED_SUB,
    env: TOKEN_ENV,
  });
  const { outcome } = reconcileBillingConfig(h.deps);
  assert.equal(outcome, 'none');
  assert.equal(h.subCalls.count, 0, 'nothing triggers, so the CLI is never spawned');
  assert.equal(h.writes.length, 0);
});

test('reconcile — a self-reported record survives the transition untouched', () => {
  // The user's own testimony is the one answer no automatic capture can reconstruct, and the token
  // may well belong to the very account they described.
  const h = harness({
    existing: { ...LOGIN_RECORD, selfReported: true, plan: 'max_20x', planSource: 'self_reported' },
    sub: TOKEN_CONFIRMED_SUB,
    env: TOKEN_ENV,
  });
  const { config, outcome } = reconcileBillingConfig(h.deps);
  assert.notEqual(outcome, 'switched');
  assert.equal(config.plan, 'max_20x');
});

test('reconcile — an UNCONFIRMED transition must not stamp the old plan onto the new key', () => {
  // The defect this guard exists for. The `claude` CLI is missing or timed out, so the resolver
  // falls back to ~/.claude.json's oauthAccount — the previous login's profile — while a setup
  // token is in force. Writing that wholesale under an oauth_key anchor would key-scope the wrong
  // plan permanently AND ship the wrong tier in the very check-in that binds the key.
  const staleProfile = {
    accountUuid: 'acc-uuid-1',
    email: 'someone-else@corp.co',
    subscriptionType: 'team',
    rateLimitTier: 'default_raven',
    detectedVia: 'oauth_account',
    anchor: { value: `sk-ant-oat01...UQAA:${TOKEN.length}`, source: 'oauth_key' },
  };
  const h = harness({ existing: LOGIN_RECORD, sub: staleProfile, env: TOKEN_ENV });
  const { config, outcome } = reconcileBillingConfig(h.deps);

  assert.notEqual(outcome, 'switched');
  assert.equal(config.plan, 'team', 'left alone by the ordinary rules, not rewritten as the key’s own');
  assert.equal(config.subscriptionType, 'team');
});

test('reconcile — no CLI answer at all does not wipe a key-resolved plan with `unknown`', () => {
  const h = harness({ existing: LOGIN_RECORD, sub: null, env: TOKEN_ENV });
  const { config, outcome } = reconcileBillingConfig(h.deps);
  assert.notEqual(outcome, 'switched');
  assert.equal(config.plan, 'team');
});

test('reconcile — an unconfirmable machine re-asks at most once per 6h, not every session', () => {
  // The predicate stays true until a confirming capture rewrites the anchor, so without the
  // rate-limit this machine would spawn `claude auth status` on every single session forever.
  const justChecked = { ...LOGIN_RECORD, capturedAt: iso(60 * 1000), anchorCheckedAt: iso(60 * 1000) };
  const h = harness({ existing: justChecked, sub: null, env: TOKEN_ENV });
  reconcileBillingConfig(h.deps);
  assert.equal(h.subCalls.count, 0, 'checked a minute ago — not due again yet');

  const checkedLongAgo = { ...LOGIN_RECORD, capturedAt: iso(60 * 1000), anchorCheckedAt: iso(7 * HOUR_MS) };
  const h2 = harness({ existing: checkedLongAgo, sub: null, env: TOKEN_ENV });
  reconcileBillingConfig(h2.deps);
  assert.equal(h2.subCalls.count, 1, 'past the window, it asks again');
});

// ─── protecting a key-scoped record from a capture that saw no key ───────────

test('shouldKeepExisting — a token-less claude_login capture cannot overwrite a key-scoped record', () => {
  // The weekly heartbeat on a machine whose token is exported from a shell profile: invisible to
  // the plugin, so the CLI is asked WITHOUT it, answers for the login on disk, and produces a
  // perfectly ordinary `claude_login` capture carrying someone else's plan. Without this rule it
  // wins — the fresh record is not 'unresolved', the existing one is not selfReported — restoring
  // the wrong plan and forcing the check-in that re-binds the key.
  const existing = { plan: null, planSource: 'unresolved', keyFingerprint: FINGERPRINT };
  const fresh = { plan: 'team', planSource: 'claude_login', source: 'subscription', keyFingerprint: null };
  assert.equal(shouldKeepExisting(fresh, existing), true);
});

test('shouldKeepExisting — the same capture still wins against a record with no key', () => {
  // Narrow on purpose: an ordinary machine that never had a setup token is unaffected.
  const existing = { plan: 'pro', planSource: 'claude_login', keyFingerprint: null };
  const fresh = { plan: 'team', planSource: 'claude_login', source: 'subscription', keyFingerprint: null };
  assert.equal(shouldKeepExisting(fresh, existing), false);
});

test('shouldKeepExisting — an `unresolved` verdict is still a real observation about this key', () => {
  // The new rule must not swallow the one capture that IS evidence about the credential in force.
  const existing = { plan: 'team', planSource: 'key_resolution', keyFingerprint: FINGERPRINT };
  const fresh = { plan: null, planSource: 'unresolved', source: 'subscription', keyFingerprint: FINGERPRINT };
  // Kept for the pre-existing key_resolution reason, not the new one — asserted so a later edit
  // that removes either rule fails loudly here.
  assert.equal(shouldKeepExisting(fresh, existing), true);
});

test('buildConfig — a token-less env records no fingerprint ("not stated", never "no key")', () => {
  const cfg = buildConfig({ subscriptionType: 'team', via: 'login' }, {}, T0, { subscriptionType: 'team' });
  assert.equal(cfg.keyFingerprint, null);
});

test('buildConfig — a fingerprintable env stamps the triple', () => {
  const cfg = buildConfig({ subscriptionType: 'team', via: 'login' }, TOKEN_ENV, T0, { subscriptionType: 'team' });
  assert.deepEqual(cfg.keyFingerprint, FINGERPRINT);
});
