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
