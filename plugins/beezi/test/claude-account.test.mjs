import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readClaudeAccount } from '../lib/claude-account.mjs';

const withAccount = (oauthAccount) => ({
  exists: () => true,
  readFile: () => JSON.stringify({ oauthAccount }),
  homedir: '/home/u',
  env: {},
});

test('readClaudeAccount — team org derives subscriptionType=team + tier', () => {
  const r = readClaudeAccount(
    withAccount({
      organizationType: 'claude_team',
      seatTier: 'team_standard',
      userRateLimitTier: 'default_raven',
      billingType: 'stripe_subscription',
    }),
  );
  assert.equal(r.subscriptionType, 'team');
  assert.equal(r.rateLimitTier, 'default_raven');
  assert.equal(r.expiresAt, null);
  assert.equal(r.billingType, 'stripe_subscription');
});

test('readClaudeAccount — NEVER returns tokens even if present on the account', () => {
  const r = readClaudeAccount(
    withAccount({
      organizationType: 'claude_team',
      accessToken: 'sk-ant-oat01-should-never-surface',
      refreshToken: 'sk-ant-ort01-should-never-surface',
    }),
  );
  assert.equal('accessToken' in r, false);
  assert.equal('refreshToken' in r, false);
  assert.equal(JSON.stringify(r).includes('sk-ant'), false);
});

test('readClaudeAccount — Max multiplier comes from rateLimitTier', () => {
  const r = readClaudeAccount(
    withAccount({ seatTier: 'max', userRateLimitTier: 'default_claude_max_20x' }),
  );
  assert.equal(r.rateLimitTier, 'default_claude_max_20x');
  assert.equal(r.subscriptionType, 'max');
});

test('readClaudeAccount — falls back to organizationRateLimitTier', () => {
  const r = readClaudeAccount(
    withAccount({ organizationType: 'claude_team', organizationRateLimitTier: 'default_raven' }),
  );
  assert.equal(r.rateLimitTier, 'default_raven');
});

test('readClaudeAccount — null when the config file is absent', () => {
  assert.equal(readClaudeAccount({ exists: () => false, homedir: '/home/u', env: {} }), null);
});

test('readClaudeAccount — null when there is no oauthAccount', () => {
  assert.equal(
    readClaudeAccount({ exists: () => true, readFile: () => JSON.stringify({ foo: 1 }), homedir: '/home/u', env: {} }),
    null,
  );
});

test('readClaudeAccount — CLAUDE_CONFIG_DIR candidate is checked first', () => {
  const seen = [];
  readClaudeAccount({
    env: { CLAUDE_CONFIG_DIR: '/cfg' },
    homedir: '/home/u',
    exists: (p) => { seen.push(p); return false; },
    readFile: () => '{}',
  });
  assert.ok(seen[0].includes('cfg'));
});
