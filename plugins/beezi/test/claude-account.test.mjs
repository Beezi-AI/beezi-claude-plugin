import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readClaudeAccount, readClaudeAuthSignals } from '../lib/claude-account.mjs';

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

test('readClaudeAccount — exposes accountUuid from oauthAccount', () => {
  const r = readClaudeAccount(
    withAccount({ accountUuid: 'acc-123', seatTier: 'max', userRateLimitTier: 'default_claude_max_5x' }),
  );
  assert.equal(r.accountUuid, 'acc-123');
});

test('readClaudeAccount — accountUuid null when absent or non-string', () => {
  assert.equal(readClaudeAccount(withAccount({ seatTier: 'pro' })).accountUuid, null);
  assert.equal(readClaudeAccount(withAccount({ accountUuid: 42, seatTier: 'pro' })).accountUuid, null);
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

// ─── readClaudeAuthSignals: presence-only, never the key value ───────────────

// Keys are built with path.join so the fake matches the separator the lib actually emits.
const HOME = path.join(path.sep, 'home', 'u');
const AT = (...parts) => path.join(HOME, ...parts);

function fakeFs(files) {
  return {
    exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFile: (p) => files[p],
    env: {},
    homedir: HOME,
  };
}

test('readClaudeAuthSignals — a /login managed key shows up as primaryApiKey', () => {
  const s = readClaudeAuthSignals(fakeFs({
    [AT('.claude.json')]: JSON.stringify({ primaryApiKey: 'sk-ant-api-SECRET' }),
  }));
  assert.deepEqual(s, { hasManagedApiKey: true, hasApiKeyHelper: false });
  // The flag is a boolean — the credential itself must never leave this function.
  assert.equal(JSON.stringify(s).includes('SECRET'), false);
});

test('readClaudeAuthSignals — absent or empty primaryApiKey is not a signal', () => {
  assert.equal(readClaudeAuthSignals(fakeFs({
    [AT('.claude.json')]: JSON.stringify({ numStartups: 3 }),
  })).hasManagedApiKey, false);
  assert.equal(readClaudeAuthSignals(fakeFs({
    [AT('.claude.json')]: JSON.stringify({ primaryApiKey: '' }),
  })).hasManagedApiKey, false);
});

test('readClaudeAuthSignals — apiKeyHelper in user settings counts, and is never executed', () => {
  const s = readClaudeAuthSignals(fakeFs({
    [AT('.claude','settings.json')]: JSON.stringify({ apiKeyHelper: 'op read op://vault/key' }),
  }));
  assert.equal(s.hasApiKeyHelper, true);
});

test('readClaudeAuthSignals — unreadable/malformed files yield no signals rather than throwing', () => {
  assert.deepEqual(
    readClaudeAuthSignals(fakeFs({ [AT('.claude.json')]: '{not json' })),
    { hasManagedApiKey: false, hasApiKeyHelper: false },
  );
  assert.deepEqual(
    readClaudeAuthSignals(fakeFs({})),
    { hasManagedApiKey: false, hasApiKeyHelper: false },
  );
});
