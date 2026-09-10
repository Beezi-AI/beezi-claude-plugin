import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readBillingConfig,
  writeBillingConfig,
  isStale,
  subscriptionReportFields,
  resolveBilling,
  syncBillingSource,
  resolveSource,
  hasFreshApiKeyEvidence,
  recordApiKeyEvidence,
  isFreshCliCapture,
  isPlanUnresolvable,
  hasRecentStatuslineObservation,
} from '../lib/billing-config.mjs';

function withTempHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-billing-'));
  const prev = process.env.BEEZI_HOME;
  process.env.BEEZI_HOME = dir;
  try { return fn(dir); } finally {
    if (prev === undefined) delete process.env.BEEZI_HOME; else process.env.BEEZI_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('write then read round-trips the config', () => {
  withTempHome(() => {
    const cfg = { version: 1, source: 'subscription', plan: 'max_5x' };
    writeBillingConfig(cfg);
    assert.deepEqual(readBillingConfig(), cfg);
  });
});

test('readBillingConfig returns null when absent', () => {
  withTempHome(() => assert.equal(readBillingConfig(), null));
});

const DAY = 24 * 60 * 60 * 1000;

test('isStale — false for non-subscription source', () => {
  assert.equal(isStale({ source: 'anthropic_api_key' }), false);
});

test('isStale — true when plan missing or unknown', () => {
  const now = 1_000_000_000_000;
  assert.equal(isStale({ source: 'subscription', capturedAt: new Date(now).toISOString() }, now), true);
  assert.equal(isStale({ source: 'subscription', plan: 'unknown', capturedAt: new Date(now).toISOString() }, now), true);
});

test('isStale — true when credentials expired', () => {
  const now = 1_000_000_000_000;
  const cfg = { source: 'subscription', plan: 'pro', credentialsExpiresAt: now - 1, capturedAt: new Date(now).toISOString() };
  assert.equal(isStale(cfg, now), true);
});

test('isStale — true when older than the window, false when fresh', () => {
  const now = 1_000_000_000_000;
  const fresh = { source: 'subscription', plan: 'pro', capturedAt: new Date(now - 1 * DAY).toISOString() };
  const old = { source: 'subscription', plan: 'pro', capturedAt: new Date(now - 8 * DAY).toISOString() };
  assert.equal(isStale(fresh, now), false);
  assert.equal(isStale(old, now), true);
});

test('subscriptionReportFields — populated for subscription, empty otherwise', () => {
  const cfg = { subscriptionType: 'pro', rateLimitTier: 'default_claude_max_5x', plan: 'max_5x' };
  assert.deepEqual(subscriptionReportFields('subscription', cfg), {
    subscription_type: 'pro',
    rate_limit_tier: 'default_claude_max_5x',
    subscription_plan: 'max_5x',
  });
  assert.deepEqual(subscriptionReportFields('anthropic_api_key', cfg), {});
  assert.deepEqual(subscriptionReportFields('subscription', null), {});
});

test('isStale — self-reported plan never goes stale by age or credential expiry', () => {
  const now = 1_000_000_000_000;
  const old = {
    source: 'subscription',
    plan: 'max_20x',
    selfReported: true,
    credentialsExpiresAt: now - 1,
    capturedAt: new Date(now - 400 * DAY).toISOString(),
  };
  assert.equal(isStale(old, now), false);
});

test('isStale — self-reported config with missing or unknown plan is still stale', () => {
  const now = 1_000_000_000_000;
  assert.equal(isStale({ source: 'subscription', selfReported: true, capturedAt: new Date(now).toISOString() }, now), true);
  assert.equal(isStale({ source: 'subscription', plan: 'unknown', selfReported: true, capturedAt: new Date(now).toISOString() }, now), true);
});

// ─── resolveBilling ──────────────────────────────────────────────────────────

const SUB_CONFIG = Object.freeze({
  source: 'subscription',
  subscriptionType: 'max',
  rateLimitTier: 'default_claude_max_5x',
  plan: 'max_5x',
});

// Always injected: the real readers would hit the developer's own ~/.claude.json and
// ~/.beezi/statusline-usage.json.
const withAccount = { readClaudeAccount: () => ({ subscriptionType: 'max' }), hasStatuslineObservation: () => false };
const noAccount = { readClaudeAccount: () => null, hasStatuslineObservation: () => false };

test('resolveBilling — a readable account resolves subscription and emits the plan fields', () => {
  assert.deepEqual(resolveBilling(SUB_CONFIG, {}, withAccount), {
    billing_source: 'subscription',
    subscription_type: 'max',
    rate_limit_tier: 'default_claude_max_5x',
    subscription_plan: 'max_5x',
  });
});

test('resolveBilling — no account and no env signal reports unknown, not a guessed subscription', () => {
  // The regression this exists for: a stale self-reported plan must not ride on a session whose
  // billing method we cannot observe.
  assert.deepEqual(resolveBilling(SUB_CONFIG, {}, noAccount), { billing_source: 'unknown' });
  assert.deepEqual(resolveBilling(null, {}, noAccount), { billing_source: 'unknown' });
});

test('resolveBilling — an unreadable ~/.claude.json degrades to unknown rather than throwing', () => {
  const throwing = { readClaudeAccount: () => { throw new Error('EACCES'); }, hasStatuslineObservation: () => false };
  assert.deepEqual(resolveBilling(SUB_CONFIG, {}, throwing), { billing_source: 'unknown' });
});

test('resolveBilling — fresh API-key evidence outranks a lingering account', () => {
  const config = { ...SUB_CONFIG, apiKeyEvidenceAt: new Date(1_000_000_000_000).toISOString() };
  assert.deepEqual(resolveBilling(config, {}, { ...withAccount, now: 1_000_000_000_000 + 60_000 }), {
    billing_source: 'anthropic_api_key',
  });
});

test('resolveBilling — lapsed API-key evidence falls back to the account', () => {
  const config = { ...SUB_CONFIG, apiKeyEvidenceAt: new Date(1_000_000_000_000).toISOString() };
  const later = 1_000_000_000_000 + 2 * DAY;
  assert.equal(
    resolveBilling(config, {}, { ...withAccount, now: later }).billing_source,
    'subscription',
  );
});

test('resolveBilling — env wins over a stale config source, and drops its plan fields', () => {
  // The config still says subscription; the env says otherwise. The env decides, and the
  // dormant plan data must not leak into the report.
  assert.deepEqual(resolveBilling(SUB_CONFIG, { ANTHROPIC_API_KEY: 'sk-x' }), {
    billing_source: 'anthropic_api_key',
  });
});

test('resolveBilling — third-party env names the provider', () => {
  assert.deepEqual(resolveBilling(SUB_CONFIG, { CLAUDE_CODE_USE_BEDROCK: '1' }), {
    billing_source: 'third_party',
    third_party_provider: 'aws_bedrock',
  });
});

// ─── syncBillingSource ───────────────────────────────────────────────────────

test('syncBillingSource — null when the stored source already matches', () => {
  assert.equal(syncBillingSource(SUB_CONFIG, 'subscription'), null);
});

test('syncBillingSource — null when there is no config to realign', () => {
  assert.equal(syncBillingSource(null, 'anthropic_api_key'), null);
});

test('syncBillingSource — rewrites the source and stamps sourceUpdatedAt', () => {
  const now = new Date('2026-08-05T12:00:00.000Z');
  const synced = syncBillingSource(SUB_CONFIG, 'anthropic_api_key', now);
  assert.equal(synced.source, 'anthropic_api_key');
  assert.equal(synced.sourceUpdatedAt, '2026-08-05T12:00:00.000Z');
});

test('syncBillingSource — preserves the plan fields and never bumps capturedAt', () => {
  // The plan was not re-captured, so capturedAt must not move: isStale() reads it, and a
  // refreshed timestamp would suppress the /beezi:refresh nudge on a plan nobody re-read.
  const capturedAt = new Date(1_000_000_000_000).toISOString();
  const config = { ...SUB_CONFIG, capturedAt, selfReported: true, capturedBy: 'login' };
  const synced = syncBillingSource(config, 'third_party', new Date(2_000_000_000_000));
  assert.equal(synced.capturedAt, capturedAt);
  assert.equal(synced.capturedBy, 'login');
  assert.equal(synced.selfReported, true);
  assert.equal(synced.plan, 'max_5x');
  assert.equal(synced.subscriptionType, 'max');
  assert.equal(synced.rateLimitTier, 'default_claude_max_5x');
});

test('syncBillingSource — does not mutate the config it was given', () => {
  const config = { ...SUB_CONFIG };
  syncBillingSource(config, 'anthropic_api_key', new Date(0));
  assert.equal(config.source, 'subscription');
  assert.equal('sourceUpdatedAt' in config, false);
});

test('syncBillingSource — realigns back to subscription with the plan still intact', () => {
  const now = 1_000_000_000_000;
  const dormant = {
    ...SUB_CONFIG,
    source: 'anthropic_api_key',
    selfReported: true,
    capturedAt: new Date(now - DAY).toISOString(),
  };
  const synced = syncBillingSource(dormant, 'subscription', new Date(now));
  assert.equal(synced.source, 'subscription');
  assert.equal(synced.plan, 'max_5x');
  // The whole point of preserving dormant plan data: switching back needs no re-ask.
  assert.equal(isStale(synced, now), false);
});

// ─── API-key evidence ────────────────────────────────────────────────────────

test('recordApiKeyEvidence — stamps a machine with no billing.json at all', () => {
  const rec = recordApiKeyEvidence(null, new Date(1_000_000_000_000));
  assert.equal(rec.version, 4);
  assert.equal(rec.apiKeyEvidenceAt, new Date(1_000_000_000_000).toISOString());
});

test('recordApiKeyEvidence — null while the existing stamp is still fresh (no redundant write)', () => {
  const now = 1_000_000_000_000;
  const config = { apiKeyEvidenceAt: new Date(now - 60_000).toISOString() };
  assert.equal(recordApiKeyEvidence(config, new Date(now)), null);
});

test('recordApiKeyEvidence — re-stamps once the previous evidence has lapsed', () => {
  const now = 1_000_000_000_000;
  const config = { plan: 'max_20x', apiKeyEvidenceAt: new Date(now - 2 * DAY).toISOString() };
  const rec = recordApiKeyEvidence(config, new Date(now));
  assert.equal(rec.apiKeyEvidenceAt, new Date(now).toISOString());
  assert.equal(rec.plan, 'max_20x', 'unrelated fields survive the stamp');
});

test('hasFreshApiKeyEvidence — window, absence, and a future stamp', () => {
  const now = 1_000_000_000_000;
  assert.equal(hasFreshApiKeyEvidence(null, now), false);
  assert.equal(hasFreshApiKeyEvidence({}, now), false);
  assert.equal(hasFreshApiKeyEvidence({ apiKeyEvidenceAt: 'garbage' }, now), false);
  assert.equal(hasFreshApiKeyEvidence({ apiKeyEvidenceAt: new Date(now - 60_000).toISOString() }, now), true);
  assert.equal(hasFreshApiKeyEvidence({ apiKeyEvidenceAt: new Date(now - 2 * DAY).toISOString() }, now), false);
  // A clock-skewed future stamp must not pin the source indefinitely.
  assert.equal(hasFreshApiKeyEvidence({ apiKeyEvidenceAt: new Date(now + DAY).toISOString() }, now), false);
});

// ─── self-reported testimony as last-resort evidence ────────────────────────

test('resolveSource — a self-reported subscription resolves a machine with no other signal', () => {
  const config = { source: 'subscription', plan: 'max_20x', selfReported: true };
  assert.equal(resolveSource(config, {}, noAccount), 'subscription');
});

test('resolveSource — a self-reported API-key machine is honoured too', () => {
  const config = { source: 'anthropic_api_key', selfReported: true };
  assert.equal(resolveSource(config, {}, noAccount), 'anthropic_api_key');
});

test('resolveSource — a stored source that was NOT self-reported is never evidence', () => {
  // It is a record of the last resolution, not an input to the next one; trusting it would let a
  // switch made outside our sight keep asserting itself forever.
  assert.equal(resolveSource({ source: 'subscription', plan: 'max_20x' }, {}, noAccount), 'unknown');
});

test('resolveSource — API-key evidence revokes a self-reported subscription', () => {
  const now = 1_000_000_000_000;
  const config = {
    source: 'subscription',
    plan: 'max_20x',
    selfReported: true,
    apiKeyEvidenceAt: new Date(now - 60_000).toISOString(),
  };
  assert.equal(resolveSource(config, {}, { ...noAccount, now }), 'anthropic_api_key');
});

// ─── Claude Desktop's injected base URL, through the real resolution path ────
// The reported regression, at the level session-start.mjs and checkpoint.mjs actually call:
// Claude Desktop injects ANTHROPIC_BASE_URL=https://api.anthropic.com into every session it
// spawns, which used to outrank the oauthAccount and relabel a Team seat as gateway billing.

const DESKTOP_ENV = Object.freeze({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' });

const TEAM_CONFIG = Object.freeze({
  version: 1,
  source: 'subscription',
  subscriptionType: 'team',
  rateLimitTier: null,
  plan: 'team',
  selfReported: true,
});

test('resolveBilling — a Claude Desktop session reports the subscription plan, not a gateway', () => {
  assert.deepEqual(resolveBilling(TEAM_CONFIG, DESKTOP_ENV, withAccount), {
    billing_source: 'subscription',
    subscription_type: 'team',
    rate_limit_tier: null,
    subscription_plan: 'team',
  });
});

test('resolveSource — a machine already flipped to third_party heals on the next desktop session', () => {
  // What an affected machine looks like before the fix reaches it: the SessionStart sync rewrote
  // `source` while preserving the plan. With a readable account it must resolve back to
  // subscription, which is what makes syncBillingSource realign billing.json.
  const flipped = { ...TEAM_CONFIG, source: 'third_party', sourceUpdatedAt: '2026-08-01T00:00:00.000Z' };
  assert.equal(resolveSource(flipped, DESKTOP_ENV, withAccount), 'subscription');
  assert.deepEqual(syncBillingSource(flipped, 'subscription', new Date(0)), {
    ...flipped,
    source: 'subscription',
    sourceUpdatedAt: '1970-01-01T00:00:00.000Z',
  });
});

test('resolveBilling — a gateway paid with an API key still reports gateway through the same path', () => {
  const gatewayEnv = { ANTHROPIC_BASE_URL: 'https://gw.corp.example', ANTHROPIC_API_KEY: 'sk-x' };
  assert.deepEqual(resolveBilling(TEAM_CONFIG, gatewayEnv, withAccount), {
    billing_source: 'third_party',
    third_party_provider: 'gateway',
  });
});

test('resolveBilling — a declared tier survives a proxy in front of the API', () => {
  // The route says nothing about the payer, so the machine cannot settle this alone — but once the
  // user has said their subscription pays, that answer holds through the gateway.
  assert.deepEqual(resolveBilling(TEAM_CONFIG, { ANTHROPIC_BASE_URL: 'https://proxy.example' }, withAccount), {
    billing_source: 'subscription',
    subscription_type: 'team',
    rate_limit_tier: null,
    subscription_plan: 'team',
  });
});

test('resolveSource — a custom gateway with no declaration stays unknown so the user is asked', () => {
  const gatewayEnv = { ANTHROPIC_BASE_URL: 'https://gw.corp.example' };
  assert.equal(resolveSource(null, gatewayEnv, withAccount), 'unknown');
  // A stored source that was never declared by the user is not testimony either.
  assert.equal(resolveSource({ source: 'subscription', plan: 'team' }, gatewayEnv, withAccount), 'unknown');
});

test('resolveBilling — a declared gateway reports third-party billing and names the route', () => {
  const declared = { source: 'third_party', plan: null, selfReported: true };
  assert.deepEqual(resolveBilling(declared, { ANTHROPIC_BASE_URL: 'https://gw.corp.example' }, withAccount), {
    billing_source: 'third_party',
    third_party_provider: 'gateway',
  });
});

test('resolveBilling — an undeclared gateway machine reports unknown and nothing else', () => {
  // The new reporting state these users sit in until they answer /beezi:login: no plan claimed,
  // no provider named. Previously they were sent as third_party + gateway.
  assert.deepEqual(
    resolveBilling({ source: 'subscription', plan: 'team' }, { ANTHROPIC_BASE_URL: 'https://gw.corp.example' }, withAccount),
    { billing_source: 'unknown' },
  );
});

// ─── CLI-observed captures and statusline observations as subscription evidence ──

const NOW = 1_000_000_000_000;
const cliCapture = (over = {}) => ({
  version: 2,
  source: 'subscription',
  subscriptionType: 'max',
  rateLimitTier: null,
  plan: 'max',
  capturedAt: new Date(NOW - 60_000).toISOString(),
  detectedVia: 'cli_status',
  ...over,
});

test('isFreshCliCapture — a recent cli_status/merged capture with a real plan counts', () => {
  assert.equal(isFreshCliCapture(cliCapture(), NOW), true);
  assert.equal(isFreshCliCapture(cliCapture({ detectedVia: 'merged' }), NOW), true);
});

test('isFreshCliCapture — stale, self-reported, planless, or differently-sourced captures do not', () => {
  assert.equal(isFreshCliCapture(null, NOW), false);
  assert.equal(isFreshCliCapture(cliCapture({ capturedAt: new Date(NOW - 8 * DAY).toISOString() }), NOW), false);
  assert.equal(isFreshCliCapture(cliCapture({ selfReported: true }), NOW), false);
  assert.equal(isFreshCliCapture(cliCapture({ plan: 'unknown' }), NOW), false);
  assert.equal(isFreshCliCapture(cliCapture({ plan: null }), NOW), false);
  assert.equal(isFreshCliCapture(cliCapture({ detectedVia: 'oauth_account' }), NOW), false);
  assert.equal(isFreshCliCapture(cliCapture({ detectedVia: null }), NOW), false);
  // Clock-skewed future stamp must not pin the source.
  assert.equal(isFreshCliCapture(cliCapture({ capturedAt: new Date(NOW + DAY).toISOString() }), NOW), false);
});

test('resolveSource — a fresh CLI capture resolves subscription for a machine with no oauthAccount', () => {
  assert.equal(resolveSource(cliCapture(), {}, { ...noAccount, now: NOW }), 'subscription');
});

test('resolveSource — a stale CLI capture is no longer evidence', () => {
  const config = cliCapture({ capturedAt: new Date(NOW - 8 * DAY).toISOString() });
  assert.equal(resolveSource(config, {}, { ...noAccount, now: NOW }), 'unknown');
});

test('resolveSource — a recent statusline observation resolves subscription', () => {
  const deps = { readClaudeAccount: () => null, hasStatuslineObservation: () => true };
  assert.equal(resolveSource(null, {}, deps), 'subscription');
});

test('resolveSource — a custom gateway is never answered by CLI captures or observations', () => {
  const gatewayEnv2 = { ANTHROPIC_BASE_URL: 'https://gw.corp.example' };
  assert.equal(resolveSource(cliCapture(), gatewayEnv2, { ...noAccount, now: NOW }), 'unknown');
  const deps = { readClaudeAccount: () => null, hasStatuslineObservation: () => true };
  assert.equal(resolveSource(null, gatewayEnv2, deps), 'unknown');
});

test('resolveSource — a throwing observation reader degrades silently', () => {
  const deps = { readClaudeAccount: () => null, hasStatuslineObservation: () => { throw new Error('EACCES'); } };
  assert.equal(resolveSource(null, {}, deps), 'unknown');
});

test('hasRecentStatuslineObservation — freshness window on lastRecordedAt', () => {
  const read = (state) => ({ readJson: () => state });
  assert.equal(hasRecentStatuslineObservation(NOW, read({ lastRecordedAt: new Date(NOW - 60_000).toISOString() })), true);
  assert.equal(hasRecentStatuslineObservation(NOW, read({ lastRecordedAt: new Date(NOW - 8 * DAY).toISOString() })), false);
  assert.equal(hasRecentStatuslineObservation(NOW, read({ lastRecordedAt: new Date(NOW + DAY).toISOString() })), false);
  assert.equal(hasRecentStatuslineObservation(NOW, read({})), false);
  assert.equal(hasRecentStatuslineObservation(NOW, read(null)), false);
  assert.equal(hasRecentStatuslineObservation(NOW, { readJson: () => { throw new Error('bad'); } }), false);
});

test('v1 configs read back untouched — every reader tolerates the old schema', () => {
  withTempHome(() => {
    const v1 = { version: 1, source: 'subscription', plan: 'max_20x', capturedAt: new Date(NOW).toISOString() };
    writeBillingConfig(v1);
    assert.deepEqual(readBillingConfig(), v1);
    assert.equal(isFreshCliCapture(readBillingConfig(), NOW), false, 'no detectedVia — not CLI evidence');
    assert.deepEqual(
      subscriptionReportFields('subscription', readBillingConfig()),
      { subscription_type: null, rate_limit_tier: null, subscription_plan: 'max_20x' },
    );
  });
});

// ─── a plan that is unresolvable, not stale ──────────────────────────────────
//
// planSource 'unresolved' records that the capture ASKED and was told the credential in force is a
// setup token, so no local source can name a plan. billing.mjs forces SUBSCRIPTION on a truthy
// CLAUDE_CODE_OAUTH_TOKEN, which is why both gates below matter: the source still says
// subscription, and nothing else stands between a plan we know is someone else's and the wire.

const UNRESOLVED_CONFIG = Object.freeze({
  version: 3,
  source: 'subscription',
  subscriptionType: null,
  rateLimitTier: null,
  plan: null,
  planSource: 'unresolved',
  detectedVia: 'oauth_token',
  capturedAt: new Date(1_000_000_000_000).toISOString(),
});

test('isPlanUnresolvable — only the explicit verdict counts', () => {
  assert.equal(isPlanUnresolvable(UNRESOLVED_CONFIG), true);
  assert.equal(isPlanUnresolvable({ source: 'subscription', plan: null }), false, 'a gap is not a verdict');
  assert.equal(isPlanUnresolvable({ planSource: 'claude_login' }), false);
  assert.equal(isPlanUnresolvable(null), false);
});

test('isStale — an unresolvable plan is NOT stale (re-reading it cannot help)', () => {
  const now = 1_000_000_000_000;
  // Same shape a month old: age is irrelevant when the answer cannot change locally.
  assert.equal(isStale(UNRESOLVED_CONFIG, now), false);
  assert.equal(isStale({ ...UNRESOLVED_CONFIG, capturedAt: new Date(now - 30 * DAY).toISOString() }, now), false);
  // The gate has to sit ABOVE the missing-plan check, which plan:null would otherwise trip.
  assert.equal(isStale({ ...UNRESOLVED_CONFIG, planSource: 'claude_login' }, now), true);
});

test('subscriptionReportFields — omits all three plan keys for an unresolvable plan', () => {
  const fields = subscriptionReportFields('subscription', UNRESOLVED_CONFIG);
  assert.deepEqual(fields, {}, 'omitted, not explicit nulls — this client has no plan to assert');
  assert.equal('subscription_type' in fields, false);
  assert.equal('rate_limit_tier' in fields, false);
  assert.equal('subscription_plan' in fields, false);
});

test('resolveBilling — an unresolvable plan still reports billing_source subscription', () => {
  // Injected readers everywhere, like the rest of this suite: the real ones would reach the
  // developer's own ~/.claude.json and statusline-usage.json and make the result machine-dependent.
  const payload = resolveBilling(UNRESOLVED_CONFIG, { CLAUDE_CODE_OAUTH_TOKEN: `sk-ant-oat01-${'y'.repeat(40)}` }, noAccount);
  assert.equal(payload.billing_source, 'subscription');
  assert.deepEqual(Object.keys(payload), ['billing_source']);
});

test('subscriptionReportFields — a resolved plan is unaffected (explicit values, nulls included)', () => {
  const cfg = { source: 'subscription', subscriptionType: 'max', rateLimitTier: null, plan: 'max', planSource: 'claude_login' };
  assert.deepEqual(subscriptionReportFields('subscription', cfg), {
    subscription_type: 'max',
    rate_limit_tier: null,
    subscription_plan: 'max',
  });
});

test('isFreshCliCapture — an unresolvable capture is not subscription-source evidence of a plan', () => {
  assert.equal(isFreshCliCapture(UNRESOLVED_CONFIG, 1_000_000_000_000), false);
});

test('isFreshCliCapture — a server-resolved key plan counts, whatever detectedVia was left behind', () => {
  const now = 1_000_000_000_000;
  // The exact shape recordResolvedKeyPlan writes: it SPREADS the existing config, so the previous
  // login's detectedVia rides along next to a plan that came from the portal.
  const cfg = {
    source: 'subscription',
    plan: 'pro',
    planSource: 'key_resolution',
    planResolvedAt: new Date(now).toISOString(),
    capturedAt: new Date(now).toISOString(),
    detectedVia: 'cli_status',
  };
  assert.equal(isFreshCliCapture(cfg, now), true);
  // …and with no detectedVia at all, which is the shape on a machine that never logged in.
  assert.equal(isFreshCliCapture({ ...cfg, detectedVia: null }, now), true);
  // Provenance is still required: a plan with neither marker is not evidence.
  assert.equal(isFreshCliCapture({ ...cfg, planSource: null, detectedVia: null }, now), false);
});

test('a cleared plan later resolved by the portal reports the plan and omits what nothing observed', () => {
  const now = 1_000_000_000_000;
  // Step 1: the capture cleared the tuple (setup token in force) — nothing on the wire.
  assert.deepEqual(subscriptionReportFields('subscription', UNRESOLVED_CONFIG), {});
  // Step 2: recordResolvedKeyPlan spreads that config and names a plan. It deliberately does NOT
  // synthesize subscriptionType/rateLimitTier — the server named a plan, not a tier — and because
  // the clear already nulled them there is no leftover `max` to contradict a resolved `pro`.
  const resolved = {
    ...UNRESOLVED_CONFIG,
    plan: 'pro',
    planSource: 'key_resolution',
    planResolvedAt: new Date(now).toISOString(),
    capturedAt: new Date(now).toISOString(),
  };
  assert.equal(isPlanUnresolvable(resolved), false, 'the portal answered — no longer unresolvable');
  assert.deepEqual(subscriptionReportFields('subscription', resolved), {
    subscription_type: null,
    rate_limit_tier: null,
    subscription_plan: 'pro',
  });
  assert.equal(isStale(resolved, now), false, 'the restamped capturedAt keeps the nudge quiet');
});

test('isStale — an unresolvable config carries no expiry to fire a false nudge with', () => {
  const now = 1_000_000_000_000;
  // credentialsExpiresAt is the second route to "missing or stale": the clear writes null, and the
  // unresolvable gate sits above the expiry check anyway.
  assert.equal(UNRESOLVED_CONFIG.credentialsExpiresAt, undefined);
  assert.equal(isStale({ ...UNRESOLVED_CONFIG, credentialsExpiresAt: now - 1 }, now), false);
});
