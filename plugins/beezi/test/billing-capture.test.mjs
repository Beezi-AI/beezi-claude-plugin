import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, buildConfig, shouldKeepExisting } from '../lib/billing-capture.mjs';

test('parseArgs recognizes --from-claude as a boolean flag', () => {
  const a = parseArgs(['--from-claude', '--via', 'login']);
  assert.equal(a.fromClaude, true);
  assert.equal(a.via, 'login');
});

test('buildConfig — null/absent expiresAt yields null credentialsExpiresAt (not 0)', () => {
  const cfg = buildConfig(
    { subscriptionType: 'team', rateLimitTier: 'default_raven', expiresAt: null, via: 'login' },
    {},
    new Date('2026-07-07T00:00:00.000Z'),
  );
  assert.equal(cfg.credentialsExpiresAt, null);
  assert.equal(cfg.plan, 'team');
});

test('parseArgs reads the named flags', () => {
  const a = parseArgs(['--subscription-type', 'pro', '--rate-limit-tier', 'default_claude_max_5x', '--expires-at', '123', '--via', 'login']);
  assert.deepEqual(a, { subscriptionType: 'pro', rateLimitTier: 'default_claude_max_5x', expiresAt: '123', via: 'login' });
});

test('buildConfig — subscription env yields plan + raw fields', () => {
  const cfg = buildConfig(
    { subscriptionType: 'pro', rateLimitTier: 'default_claude_max_5x', expiresAt: '1754418735285', via: 'login' },
    {},
    new Date('2026-07-07T00:00:00.000Z'),
  );
  assert.equal(cfg.version, 1);
  assert.equal(cfg.source, 'subscription');
  assert.equal(cfg.subscriptionType, 'pro');
  assert.equal(cfg.rateLimitTier, 'default_claude_max_5x');
  assert.equal(cfg.plan, 'max_5x');
  assert.equal(cfg.credentialsExpiresAt, 1754418735285);
  assert.equal(cfg.capturedBy, 'login');
  assert.equal(cfg.capturedAt, '2026-07-07T00:00:00.000Z');
});

test('buildConfig — api-key env nulls the plan fields', () => {
  const cfg = buildConfig(
    { subscriptionType: 'pro', rateLimitTier: 'default_claude_max_5x', via: 'refresh' },
    { ANTHROPIC_API_KEY: 'sk-x' },
    new Date('2026-07-07T00:00:00.000Z'),
  );
  assert.equal(cfg.source, 'anthropic_api_key');
  assert.equal(cfg.subscriptionType, null);
  assert.equal(cfg.rateLimitTier, null);
  assert.equal(cfg.plan, null);
});

test('buildConfig — rejects token-shaped input', () => {
  assert.throws(() => buildConfig({ subscriptionType: 'sk-ant-oat01-secret' }, {}, new Date()));
  assert.throws(() => buildConfig({ rateLimitTier: 'x'.repeat(65) }, {}, new Date()));
});

test('parseArgs reads --plan', () => {
  const a = parseArgs(['--plan', 'max_5x', '--via', 'login-user']);
  assert.equal(a.plan, 'max_5x');
  assert.equal(a.via, 'login-user');
});

test('parseArgs throws when --plan is combined with --from-claude', () => {
  assert.throws(() => parseArgs(['--from-claude', '--plan', 'pro']), /mutually exclusive/);
});

test('buildConfig — each self-reported plan derives type, keeps tier null, marks selfReported', () => {
  const cases = [
    ['pro', 'pro'],
    ['max_5x', 'max'],
    ['max_20x', 'max'],
    ['team', 'team'],
    ['enterprise', 'enterprise'],
  ];
  for (const [plan, type] of cases) {
    const cfg = buildConfig({ plan, via: 'login-user' }, {}, new Date('2026-07-14T00:00:00.000Z'));
    assert.equal(cfg.version, 1);
    assert.equal(cfg.source, 'subscription');
    assert.equal(cfg.plan, plan);
    assert.equal(cfg.subscriptionType, type);
    assert.equal(cfg.rateLimitTier, null);
    assert.equal(cfg.credentialsExpiresAt, null);
    assert.equal(cfg.selfReported, true);
    assert.equal(cfg.capturedBy, 'login-user');
    assert.equal(cfg.capturedAt, '2026-07-14T00:00:00.000Z');
  }
});

test('buildConfig — rejects a plan outside the allowlist', () => {
  assert.throws(() => buildConfig({ plan: 'ultra' }, {}, new Date()), /Unknown plan/);
  assert.throws(() => buildConfig({ plan: 'max' }, {}, new Date()), /Unknown plan/);
});

test('buildConfig — self-reported plan is normalized (trim + lowercase) before the exact match', () => {
  const cfg = buildConfig({ plan: ' Max_20x ' }, {}, new Date());
  assert.equal(cfg.plan, 'max_20x');
});

test('buildConfig — --plan ignores subscription-type and rate-limit-tier args', () => {
  const cfg = buildConfig(
    { plan: 'pro', subscriptionType: 'enterprise', rateLimitTier: 'default_claude_max_20x' },
    {},
    new Date(),
  );
  assert.equal(cfg.plan, 'pro');
  assert.equal(cfg.subscriptionType, 'pro');
  assert.equal(cfg.rateLimitTier, null);
});

test('buildConfig — self-reported plan under api-key env nulls the plan fields', () => {
  const cfg = buildConfig({ plan: 'pro' }, { ANTHROPIC_API_KEY: 'sk-x' }, new Date());
  assert.equal(cfg.source, 'anthropic_api_key');
  assert.equal(cfg.plan, null);
  assert.equal(cfg.subscriptionType, null);
});

test('buildConfig — auto-captured config has no selfReported key', () => {
  const cfg = buildConfig({ subscriptionType: 'pro', via: 'login' }, {}, new Date());
  assert.equal('selfReported' in cfg, false);
});

test('shouldKeepExisting — keeps a self-reported plan when fresh capture still resolves unknown', () => {
  const fresh = { plan: 'unknown' };
  const existing = { selfReported: true, plan: 'max_5x' };
  assert.equal(shouldKeepExisting(fresh, existing), true);
});

test('shouldKeepExisting — overwrites when the fresh capture resolves a known plan', () => {
  const fresh = { plan: 'pro' };
  const existing = { selfReported: true, plan: 'max_5x' };
  assert.equal(shouldKeepExisting(fresh, existing), false);
});

test('shouldKeepExisting — overwrites when the existing config is not self-reported', () => {
  const fresh = { plan: 'unknown' };
  const existing = { plan: 'pro' };
  assert.equal(shouldKeepExisting(fresh, existing), false);
});

test('shouldKeepExisting — overwrites when there is no existing config', () => {
  const fresh = { plan: 'unknown' };
  assert.equal(shouldKeepExisting(fresh, null), false);
  assert.equal(shouldKeepExisting(fresh, undefined), false);
});

test('shouldKeepExisting — overwrites when the existing plan is missing or unknown', () => {
  const fresh = { plan: 'unknown' };
  assert.equal(shouldKeepExisting(fresh, { selfReported: true, plan: 'unknown' }), false);
  assert.equal(shouldKeepExisting(fresh, { selfReported: true, plan: null }), false);
  assert.equal(shouldKeepExisting(fresh, { selfReported: true }), false);
});

test('shouldKeepExisting — a non-subscription fresh capture (plan null) still overwrites', () => {
  // The guard protects only against 'unknown'; a machine that moved to api-key
  // billing must be able to replace a stale self-report with the nulled config.
  assert.equal(shouldKeepExisting({ plan: null }, { selfReported: true, plan: 'pro' }), false);
});
