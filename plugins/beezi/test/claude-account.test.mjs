import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readClaudeAccount, readClaudeAuthSignals, readClaudeAccountAnchor } from '../lib/claude-account.mjs';

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
  assert.equal(r.rateLimitTier, 'default_claude_max_5x');
  assert.equal(r.subscriptionType, 'max');
});

test('readClaudeAccount — personal Max: organizationType names the product, seatTier is null', () => {
  // Verbatim from a live Max 20x machine. A personal subscription is written as an
  // "organization" of type claude_max: seatTier and userRateLimitTier are both null and the
  // multiplier sits in organizationRateLimitTier. Deriving from seatTier alone returned null
  // here, which downstream read as "this profile cannot state its type" and cost the tier.
  const r = readClaudeAccount(withAccount({
    accountUuid: '164073bf-3bef-4127-93d5-b0bb5d8ec7e5',
    emailAddress: 'b@icloud.com',
    seatTier: null,
    organizationType: 'claude_max',
    userRateLimitTier: null,
    organizationRateLimitTier: 'default_claude_max_20x',
    billingType: 'stripe_subscription',
  }));
  assert.equal(r.subscriptionType, 'max');
  assert.equal(r.rateLimitTier, 'default_claude_max_20x');
});

test('readClaudeAccount — a seat tier still outranks the org product label', () => {
  // Order matters for seat-based orgs: the org names the company, the seat names the product.
  const r = readClaudeAccount(
    withAccount({ organizationType: 'claude_team', seatTier: 'max', userRateLimitTier: 'default_claude_max_20x' }),
  );
  assert.equal(r.subscriptionType, 'team', 'an explicit team org is still a team account');
  const p = readClaudeAccount(withAccount({ organizationType: 'claude_pro' }));
  assert.equal(p.subscriptionType, 'pro');
});

test('readClaudeAccount — accountUuid null when absent or non-string', () => {
  assert.equal(readClaudeAccount(withAccount({ seatTier: 'pro' })).accountUuid, null);
  assert.equal(readClaudeAccount(withAccount({ accountUuid: 42, seatTier: 'pro' })).accountUuid, null);
});

// Some login surfaces write oauthAccount with ONLY emailAddress (no accountUuid) — the email is
// then the machine's one vendor identity, and the identity stamp on session reports needs it.
test('readClaudeAccount — exposes emailAddress as email', () => {
  const r = readClaudeAccount(withAccount({ emailAddress: 'dev@example.com', seatTier: 'max' }));
  assert.equal(r.email, 'dev@example.com');
});

test('readClaudeAccount — email null when absent or non-string', () => {
  assert.equal(readClaudeAccount(withAccount({ seatTier: 'pro' })).email, null);
  assert.equal(readClaudeAccount(withAccount({ emailAddress: 42, seatTier: 'pro' })).email, null);
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

// ─── readClaudeAccountAnchor ─────────────────────────────────────────────────

test('readClaudeAccountAnchor — prefers oauthAccount.accountUuid over userID', () => {
  const a = readClaudeAccountAnchor(fakeFs({
    [AT('.claude.json')]: JSON.stringify({ oauthAccount: { accountUuid: 'acc-1' }, userID: 'uid-9' }),
  }));
  assert.deepEqual(a, { value: 'acc-1', source: 'account_uuid' });
});

test('readClaudeAccountAnchor — falls back to the top-level userID (modern surfaces without oauthAccount)', () => {
  const a = readClaudeAccountAnchor(fakeFs({
    [AT('.claude.json')]: JSON.stringify({ numStartups: 3, userID: 'uid-9' }),
  }));
  assert.deepEqual(a, { value: 'uid-9', source: 'user_id' });
});

test('readClaudeAccountAnchor — null when neither identity exists or values are non-strings', () => {
  assert.equal(readClaudeAccountAnchor(fakeFs({ [AT('.claude.json')]: JSON.stringify({ numStartups: 3 }) })), null);
  assert.equal(readClaudeAccountAnchor(fakeFs({ [AT('.claude.json')]: JSON.stringify({ userID: 42 }) })), null);
  assert.equal(readClaudeAccountAnchor(fakeFs({ [AT('.claude.json')]: '{not json' })), null);
  assert.equal(readClaudeAccountAnchor(fakeFs({})), null);
});
