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

// Always injected: the real reader would hit the developer's own ~/.claude.json.
const withAccount = { readClaudeAccount: () => ({ subscriptionType: 'max' }) };
const noAccount = { readClaudeAccount: () => null };

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
  const throwing = { readClaudeAccount: () => { throw new Error('EACCES'); } };
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
  assert.equal(rec.version, 1);
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
