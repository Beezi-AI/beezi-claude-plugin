import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runClaudeAuthStatus, resolveClaudeSubscription } from '../lib/claude-auth-status.mjs';

// The real shape observed from `claude auth status --json` (CC 2.1.238).
const CLI_JSON = {
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: null,
  orgId: null,
  orgName: null,
  subscriptionType: 'max',
};

test('runClaudeAuthStatus — parses the CLI JSON and copies only the allowlisted fields', () => {
  const calls = [];
  const r = runClaudeAuthStatus({
    exec: (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return JSON.stringify({ ...CLI_JSON, email: 'a@b.co', accessToken: 'sk-ant-oat01-never' });
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'claude');
  assert.deepEqual(calls[0].args, ['auth', 'status', '--json']);
  assert.equal(r.loggedIn, true);
  assert.equal(r.subscriptionType, 'max');
  assert.equal(r.email, 'a@b.co');
  assert.equal('accessToken' in r, false);
  assert.equal(JSON.stringify(r).includes('sk-ant'), false);
});

test('runClaudeAuthStatus — CLI missing / timing out / exiting non-zero reads as null', () => {
  assert.equal(runClaudeAuthStatus({ exec: () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } }), null);
  assert.equal(runClaudeAuthStatus({ exec: () => { throw new Error('ETIMEDOUT'); } }), null);
});

test('runClaudeAuthStatus — garbage stdout reads as null', () => {
  assert.equal(runClaudeAuthStatus({ exec: () => 'not json' }), null);
  assert.equal(runClaudeAuthStatus({ exec: () => '"just a string"' }), null);
  assert.equal(runClaudeAuthStatus({ exec: () => 'null' }), null);
});

test('runClaudeAuthStatus — token-shaped or over-long values are dropped, not copied', () => {
  const r = runClaudeAuthStatus({
    exec: () => JSON.stringify({ loggedIn: true, subscriptionType: 'x'.repeat(300), authMethod: 'two words' }),
  });
  assert.equal(r.subscriptionType, null);
  assert.equal(r.authMethod, null);
});

// ─── resolveClaudeSubscription merge matrix ──────────────────────────────────

const cliStatus = (over = {}) => () => ({ ...CLI_JSON, ...over });
const noCli = () => null;
const account = (over = {}) => () => ({
  accountUuid: 'acc-1',
  email: null,
  subscriptionType: 'max',
  rateLimitTier: 'default_claude_max_20x',
  expiresAt: null,
  billingType: 'stripe_subscription',
  seatTier: 'max',
  organizationType: null,
  ...over,
});
const noAccount = () => null;
const noAnchor = () => null;

test('resolveClaudeSubscription — CLI-only (VS Code extension shape): plan type without multiplier', () => {
  const r = resolveClaudeSubscription({
    runClaudeAuthStatus: cliStatus({ email: 'ext@b.co' }),
    readClaudeAccount: noAccount,
    readClaudeAccountAnchor: noAnchor,
  });
  assert.equal(r.subscriptionType, 'max');
  assert.equal(r.rateLimitTier, null);
  assert.equal(r.accountUuid, null);
  assert.equal(r.email, 'ext@b.co', 'the CLI email must survive with no oauthAccount at all');
  assert.equal(r.detectedVia, 'cli_status');
});

test('resolveClaudeSubscription — oauthAccount-only (CLI missing): pre-existing behavior, tagged', () => {
  const r = resolveClaudeSubscription({
    runClaudeAuthStatus: noCli,
    readClaudeAccount: account(),
    readClaudeAccountAnchor: noAnchor,
  });
  assert.equal(r.subscriptionType, 'max');
  assert.equal(r.rateLimitTier, 'default_claude_max_20x');
  assert.equal(r.accountUuid, 'acc-1');
  assert.equal(r.detectedVia, 'oauth_account');
});

test('resolveClaudeSubscription — same account: CLI type + oauthAccount multiplier merge', () => {
  const r = resolveClaudeSubscription({
    runClaudeAuthStatus: cliStatus({ email: 'cli@b.co' }),
    readClaudeAccount: account({ email: 'CLI@B.co' }),
    readClaudeAccountAnchor: noAnchor,
  });
  assert.equal(r.subscriptionType, 'max');
  assert.equal(r.rateLimitTier, 'default_claude_max_20x', 'a same-account profile donates the multiplier');
  assert.equal(r.email, 'cli@b.co', 'the live CLI email outranks the possibly-stale profile email');
  assert.equal(r.detectedVia, 'merged');
});

test('resolveClaudeSubscription — a differing profile email is a different account: no donation', () => {
  // The switch case the old product-type check was standing in for, now tested directly: the
  // types still agree (both max), so only identity can tell these two accounts apart.
  const r = resolveClaudeSubscription({
    runClaudeAuthStatus: cliStatus({ email: 'cli@b.co' }),
    readClaudeAccount: account({ email: 'previous@b.co' }),
    readClaudeAccountAnchor: noAnchor,
  });
  assert.equal(r.subscriptionType, 'max');
  assert.equal(r.rateLimitTier, null, 'a profile naming another account must not donate its tier');
  assert.equal(r.email, 'cli@b.co', 'the live CLI email outranks the possibly-stale profile email');
  assert.equal(r.detectedVia, 'cli_status');
});

test('resolveClaudeSubscription — a null CLI email falls back to the oauthAccount email', () => {
  const r = resolveClaudeSubscription({
    runClaudeAuthStatus: cliStatus(), // email: null — the observed CC 2.1.238 shape
    readClaudeAccount: account({ email: 'file@b.co' }),
    readClaudeAccountAnchor: noAnchor,
  });
  assert.equal(r.email, 'file@b.co');
});

test('resolveClaudeSubscription — disagreement: the stale profile must NOT donate its multiplier', () => {
  // Account switch: oauthAccount still describes the previous (max) account, the CLI says pro.
  const r = resolveClaudeSubscription({
    runClaudeAuthStatus: cliStatus({ subscriptionType: 'pro' }),
    readClaudeAccount: account(),
    readClaudeAccountAnchor: noAnchor,
  });
  assert.equal(r.subscriptionType, 'pro');
  assert.equal(r.rateLimitTier, null);
  assert.equal(r.detectedVia, 'cli_status');
});

test('resolveClaudeSubscription — partial oauthAccount (setup-token shape, no subscriptionType)', () => {
  // Reversed deliberately. A profile that cannot derive its own product states nothing, and
  // silence is not disagreement: dropping the tier here reported every personal Max user — whose
  // seatTier is null by construction — as plain `max`. Identity is the gate; when neither side
  // offers an email, an underivable type is no reason to discard a tier that is present.
  const r = resolveClaudeSubscription({
    runClaudeAuthStatus: cliStatus(),
    readClaudeAccount: account({ subscriptionType: null }),
    readClaudeAccountAnchor: noAnchor,
  });
  assert.equal(r.subscriptionType, 'max');
  assert.equal(r.rateLimitTier, 'default_claude_max_20x', 'silence is not a contradiction');
  assert.equal(r.detectedVia, 'merged');
});

test('resolveClaudeSubscription — personal Max: organizationType claude_max, seatTier null', () => {
  // The exact live shape from an affected Max 20x machine (macOS, stripe billing). Every field
  // here is real: personal Max is written as an "organization" of type claude_max with a null
  // seatTier and the multiplier parked in organizationRateLimitTier.
  const r = resolveClaudeSubscription({
    runClaudeAuthStatus: cliStatus({ email: 'b@icloud.com' }),
    readClaudeAccount: () => ({
      accountUuid: '164073bf-3bef-4127-93d5-b0bb5d8ec7e5',
      email: 'b@icloud.com',
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
      expiresAt: null,
      billingType: 'stripe_subscription',
      seatTier: null,
      organizationType: 'claude_max',
    }),
    readClaudeAccountAnchor: noAnchor,
  });
  assert.equal(r.rateLimitTier, 'default_claude_max_20x');
  assert.equal(r.detectedVia, 'merged');
});

test('resolveClaudeSubscription — loggedIn false yields no CLI evidence', () => {
  assert.equal(
    resolveClaudeSubscription({
      runClaudeAuthStatus: cliStatus({ loggedIn: false }),
      readClaudeAccount: noAccount,
      readClaudeAccountAnchor: noAnchor,
    }),
    null,
  );
});

test('resolveClaudeSubscription — nothing anywhere yields null', () => {
  assert.equal(
    resolveClaudeSubscription({ runClaudeAuthStatus: noCli, readClaudeAccount: noAccount, readClaudeAccountAnchor: noAnchor }),
    null,
  );
});

// An explicit env everywhere the anchor is asserted: a developer machine with a real
// CLAUDE_CODE_OAUTH_TOKEN exported would otherwise outrank the fixtures under test.
test('resolveClaudeSubscription — anchor prefers the CLI email over the file anchor', () => {
  const r = resolveClaudeSubscription({
    runClaudeAuthStatus: cliStatus({ email: 'a@b.co' }),
    readClaudeAccount: account(),
    readClaudeAccountAnchor: () => ({ value: 'acc-1', source: 'account_uuid' }),
    env: {},
  });
  assert.deepEqual(r.anchor, { value: 'a@b.co', source: 'email' });
});

test('resolveClaudeSubscription — falls back to the file anchor when the CLI has no email', () => {
  const r = resolveClaudeSubscription({
    runClaudeAuthStatus: cliStatus(),
    readClaudeAccount: account(),
    readClaudeAccountAnchor: () => ({ value: 'uid-9', source: 'user_id' }),
    env: {},
  });
  assert.deepEqual(r.anchor, { value: 'uid-9', source: 'user_id' });
});

test('resolveClaudeSubscription — a CLAUDE_CODE_OAUTH_TOKEN outranks BOTH the CLI email and the file anchor', () => {
  const token = `sk-ant-oat01-${'y'.repeat(40)}`;
  const r = resolveClaudeSubscription({
    runClaudeAuthStatus: cliStatus({ email: 'stale@b.co' }),
    readClaudeAccount: account(),
    readClaudeAccountAnchor: () => ({ value: 'acc-1', source: 'account_uuid' }),
    env: { CLAUDE_CODE_OAUTH_TOKEN: token },
  });
  assert.deepEqual(r.anchor, {
    value: `sk-ant-oat01...${token.slice(-4)}:${token.length}`,
    source: 'oauth_key',
  });
  assert.equal(r.anchor.value.includes(token.slice(12, -4)), false, 'the middle never leaves the process');
  // REVERSED, deliberately. This used to assert "identity only — the plan tuple still comes from
  // the CLI + oauthAccount merge", i.e. a visible token moved the anchor but left the previous
  // login's plan in place. That split the plugin against itself: hasOauthTokenIdentity gates the
  // identity stamp, so with a token visible every report already withheld the local uuid and email
  // and sent the fingerprint — while billing.json still carried the login's tier. The server then
  // resolved the KEY's account and priced it with a plan belonging to someone else.
  //
  // A fingerprintable token in the resolved env is now positive evidence of key auth on its own,
  // whatever the CLI says, so the plan clears here exactly as it does on an `oauth_token` answer.
  assert.equal(r.planSource, 'unresolved');
  assert.equal(r.detectedVia, 'oauth_token');
  assert.equal(r.subscriptionType, null);
  assert.equal(r.rateLimitTier, null);
  // And the identity is not copied off the stale profile either — under key auth it describes
  // whoever logged in last, on a machine that may belong to someone else entirely.
  assert.equal(r.accountUuid, null);
  assert.equal(r.email, null);
});

test('resolveClaudeSubscription — a token too short to fingerprint yields no anchor of its own', () => {
  const r = resolveClaudeSubscription({
    runClaudeAuthStatus: cliStatus({ email: 'a@b.co' }),
    readClaudeAccount: account(),
    readClaudeAccountAnchor: noAnchor,
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01' },
  });
  assert.deepEqual(r.anchor, { value: 'a@b.co', source: 'email' });
});

test('resolveClaudeSubscription — a throwing reader degrades to the other layers, never throws', () => {
  const r = resolveClaudeSubscription({
    runClaudeAuthStatus: () => { throw new Error('boom'); },
    readClaudeAccount: account(),
    readClaudeAccountAnchor: () => { throw new Error('boom'); },
  });
  assert.equal(r.detectedVia, 'oauth_account');
  assert.equal(r.subscriptionType, 'max');
});

// ─── setup-token machines: the CLI is asked with the token in force ──────────
//
// Claude Code deletes CLAUDE_CODE_OAUTH_TOKEN from every subprocess environment it builds, so
// without re-injecting it the child answers for whatever login last touched the disk. These lock
// down both halves: the token must reach the child's ENVIRONMENT, and it must reach nothing else.

const SETUP_TOKEN = `sk-ant-oat01-${'z'.repeat(40)}`;

// The real shape observed with a setup token in the child's environment (CC 2.1.251): authMethod
// flips to oauth_token and email/orgId/orgName/subscriptionType are simply absent.
const TOKEN_JSON = { loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty' };

test('runClaudeAuthStatus — the token reaches the child env and NEVER argv', () => {
  const calls = [];
  const r = runClaudeAuthStatus({
    exec: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return JSON.stringify(TOKEN_JSON); },
    oauthToken: SETUP_TOKEN,
    processEnv: { PATH: '/usr/bin', HOME: '/home/x' },
  });
  assert.equal(calls[0].opts.env.CLAUDE_CODE_OAUTH_TOKEN, SETUP_TOKEN);
  assert.equal(calls[0].opts.env.PATH, '/usr/bin', 'the base environment is preserved, not replaced');
  assert.equal(calls[0].cmd.includes('sk-ant'), false);
  assert.equal(JSON.stringify(calls[0].args).includes('sk-ant'), false);
  assert.equal(r.authMethod, 'oauth_token');
  assert.equal(JSON.stringify(r).includes('sk-ant'), false, 'the token never comes back out');
});

test('runClaudeAuthStatus — with no token the spawn is byte-identical to before (no env override)', () => {
  const calls = [];
  runClaudeAuthStatus({ exec: (cmd, args, opts) => { calls.push(opts); return JSON.stringify(CLI_JSON); } });
  assert.equal('env' in calls[0], false);
});

test('runClaudeAuthStatus — the Windows shell fallback carries the env, never the token', () => {
  const calls = [];
  const r = runClaudeAuthStatus({
    platform: 'win32',
    oauthToken: SETUP_TOKEN,
    processEnv: { PATH: 'C:\\bin' },
    exec: (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      if (calls.length === 1) throw new Error('ENOENT');
      return JSON.stringify(TOKEN_JSON);
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].cmd, 'claude auth status --json', 'one fixed literal command line');
  assert.equal(calls[1].opts.shell, true);
  assert.equal(calls[1].opts.env.CLAUDE_CODE_OAUTH_TOKEN, SETUP_TOKEN);
  assert.equal(calls[1].cmd.includes('sk-ant'), false, 'a shell command line is world-readable');
  assert.equal(r.authMethod, 'oauth_token');
});

test('resolveClaudeSubscription — hands the recovered token down to the spawn', () => {
  const seen = [];
  resolveClaudeSubscription({
    runClaudeAuthStatus: (d) => { seen.push(d); return { ...TOKEN_JSON }; },
    readClaudeAccount: account(),
    readClaudeAccountAnchor: noAnchor,
    env: { CLAUDE_CODE_OAUTH_TOKEN: SETUP_TOKEN },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].oauthToken, SETUP_TOKEN, 'without this the child answers for the stale login');
});

test('resolveClaudeSubscription — authMethod oauth_token clears the plan the stale profile names', () => {
  const r = resolveClaudeSubscription({
    runClaudeAuthStatus: () => ({ ...TOKEN_JSON }),
    // The leftovers of a previous interactive /login: a full, confident, wrong profile.
    readClaudeAccount: account({ email: 'previous@b.co' }),
    readClaudeAccountAnchor: () => ({ value: 'acc-1', source: 'account_uuid' }),
    env: { CLAUDE_CODE_OAUTH_TOKEN: SETUP_TOKEN },
  });
  assert.equal(r.subscriptionType, null);
  assert.equal(r.rateLimitTier, null, 'the multiplier belongs to a different account');
  assert.equal(r.billingType, null);
  assert.equal(r.seatTier, null);
  assert.equal(r.organizationType, null);
  assert.equal(r.planSource, 'unresolved');
  assert.equal(r.detectedVia, 'oauth_token');
  // Identity is unchanged: the token anchor still wins, exactly as before.
  assert.deepEqual(r.anchor, {
    value: `sk-ant-oat01...${SETUP_TOKEN.slice(-4)}:${SETUP_TOKEN.length}`,
    source: 'oauth_key',
  });
});

test('resolveClaudeSubscription — an oauth_token answer never falls into the oauth_account branch', () => {
  // The second route to the same bug: a token answer carries NO subscriptionType, so the
  // `cliType == null` arm would otherwise return the whole stale profile verbatim.
  const r = resolveClaudeSubscription({
    runClaudeAuthStatus: () => ({ ...TOKEN_JSON, subscriptionType: null }),
    readClaudeAccount: account(),
    readClaudeAccountAnchor: noAnchor,
    env: {},
  });
  assert.notEqual(r.detectedVia, 'oauth_account');
  assert.equal(r.detectedVia, 'oauth_token');
  assert.equal(r.rateLimitTier, null);
});

test('resolveClaudeSubscription — a loggedIn:false token answer still clears, never leaks the profile', () => {
  // An expired or revoked token is not a reason to start trusting the previous login's leftovers.
  const r = resolveClaudeSubscription({
    runClaudeAuthStatus: () => ({ loggedIn: false, authMethod: 'oauth_token' }),
    readClaudeAccount: account(),
    readClaudeAccountAnchor: noAnchor,
    env: {},
  });
  assert.equal(r.planSource, 'unresolved');
  assert.equal(r.rateLimitTier, null);
});

test('resolveClaudeSubscription — authMethod claude.ai is completely unchanged', () => {
  const r = resolveClaudeSubscription({
    runClaudeAuthStatus: cliStatus({ email: 'cli@b.co' }),
    readClaudeAccount: account({ email: 'cli@b.co' }),
    readClaudeAccountAnchor: noAnchor,
    env: {},
  });
  assert.equal(r.subscriptionType, 'max');
  assert.equal(r.rateLimitTier, 'default_claude_max_20x');
  assert.equal(r.detectedVia, 'merged');
  assert.equal(r.planSource, undefined, 'only the cleared case stamps a planSource');
});

test('resolveClaudeSubscription — an UNKNOWN authMethod is not evidence and clears nothing', () => {
  // Open vocabulary: third_party / api_key_helper / api_key / none today, whatever ships next.
  for (const method of ['api_key_helper', 'third_party', 'api_key', 'none', 'something_new']) {
    const r = resolveClaudeSubscription({
      runClaudeAuthStatus: cliStatus({ authMethod: method, email: 'cli@b.co' }),
      readClaudeAccount: account({ email: 'cli@b.co' }),
      readClaudeAccountAnchor: noAnchor,
      env: {},
    });
    assert.equal(r.detectedVia, 'merged', `authMethod ${method} must not clear`);
    assert.equal(r.rateLimitTier, 'default_claude_max_20x');
  }
});

test('resolveClaudeSubscription — an unavailable or unparseable CLI clears nothing', () => {
  // runClaudeAuthStatus already normalizes "missing / timed out / garbage stdout" to null.
  for (const readStatus of [noCli, () => { throw new Error('boom'); }, () => ({}), () => ({ authMethod: null })]) {
    const r = resolveClaudeSubscription({
      runClaudeAuthStatus: readStatus,
      readClaudeAccount: account(),
      readClaudeAccountAnchor: noAnchor,
      env: {},
    });
    assert.equal(r.detectedVia, 'oauth_account', 'an unanswerable question is not evidence');
    assert.equal(r.rateLimitTier, 'default_claude_max_20x');
    assert.equal(r.planSource, undefined);
  }
});

// The env token is the second route into the clearing branch, and it consults nobody.
//
// `env` reaching resolveClaudeSubscription has already been through every tier — process.env,
// Claude Code's settings file, and the OS environment (Windows registry, macOS launchctl) — so a
// fingerprintable token in it is a positive statement that this machine authenticates by key.
// The CLI can disagree for mundane reasons: a token it rejected, a build too old to report
// authMethod, a spawn that timed out. None of those make ~/.claude.json evidence about the
// credential actually in force.
test('resolveClaudeSubscription — an env token clears the plan even when the CLI says claude.ai', () => {
  const token = `sk-ant-oat01-${'y'.repeat(40)}`;
  const r = resolveClaudeSubscription({
    runClaudeAuthStatus: cliStatus({ email: 'a@b.co' }), // authMethod: claude.ai
    readClaudeAccount: account(),
    readClaudeAccountAnchor: noAnchor,
    env: { CLAUDE_CODE_OAUTH_TOKEN: token },
  });
  assert.equal(r.planSource, 'unresolved');
  assert.equal(r.subscriptionType, null);
});

// Same, with no CLI answer at all. Previously this fell through to the "no CLI answer" arm and
// returned the whole stale oauthAccount profile — the previous login's plan, on a key machine.
test('resolveClaudeSubscription — an env token clears the plan when the CLI cannot answer', () => {
  const token = `sk-ant-oat01-${'y'.repeat(40)}`;
  const r = resolveClaudeSubscription({
    runClaudeAuthStatus: () => null,
    readClaudeAccount: account(),
    readClaudeAccountAnchor: noAnchor,
    env: { CLAUDE_CODE_OAUTH_TOKEN: token },
  });
  assert.equal(r.planSource, 'unresolved');
  assert.equal(r.subscriptionType, null);
  assert.equal(r.email, null);
});

// Truthiness is not enough, here as everywhere: a value too short to fingerprint identifies
// nothing, the server would drop the key entry, and clearing on it would trade a usable plan for
// none at all.
test('resolveClaudeSubscription — a token too short to fingerprint clears nothing', () => {
  const r = resolveClaudeSubscription({
    runClaudeAuthStatus: cliStatus({ email: 'a@b.co' }),
    readClaudeAccount: account(),
    readClaudeAccountAnchor: noAnchor,
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01' },
  });
  assert.notEqual(r.planSource, 'unresolved');
  assert.equal(r.subscriptionType, 'max');
});

// No token anywhere: the ordinary login path is untouched by any of this.
test('resolveClaudeSubscription — no token leaves the login merge exactly as it was', () => {
  const r = resolveClaudeSubscription({
    runClaudeAuthStatus: cliStatus({ email: 'a@b.co' }),
    readClaudeAccount: account(),
    readClaudeAccountAnchor: noAnchor,
    env: {},
  });
  assert.notEqual(r.planSource, 'unresolved');
  assert.equal(r.subscriptionType, 'max');
  assert.equal(r.rateLimitTier, 'default_claude_max_20x');
});
