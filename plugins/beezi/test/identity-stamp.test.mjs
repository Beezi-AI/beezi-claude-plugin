import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIdentityStamp } from '../lib/identity-stamp.mjs';

// 56 characters, so keyFingerprint's 20-char floor is cleared and the 12+4 window still hides 40.
const TOKEN = `sk-ant-oat01-${'x'.repeat(39)}ab12`;

const ACCOUNT = { accountUuid: 'acc-1', email: 'live@example.com' };

const BILLING = {
  accountUuid: 'acc-billing',
  accountEmail: 'billing@example.com',
  accountAnchor: { value: 'anchor@example.com', source: 'email', updatedAt: '2026-08-01T00:00:00.000Z' },
};

// billing.json is the reconciled record — rewritten on every session start, key-scoped, and the
// source the server's cli_agent_account resolution is fed from. ~/.claude.json is the fallback for
// a machine that has no record yet, never a per-field second opinion.
test('buildIdentityStamp — billing.json outranks the live login', () => {
  const stamp = buildIdentityStamp(ACCOUNT, BILLING, {});
  assert.equal(stamp.account_uuid, 'acc-billing');
  assert.equal(stamp.account_email, 'billing@example.com');
  assert.equal(stamp.oauth_key_prefix, undefined);
});

// The surfaces that never write oauthAccount — the VS Code extension, desktop SSO — leave the live
// read empty, and then billing.json is the machine's ONE vendor identity.
test('buildIdentityStamp — billing.json answers when oauthAccount is unreadable', () => {
  const stamp = buildIdentityStamp(null, BILLING, {});
  assert.equal(stamp.account_uuid, 'acc-billing');
  assert.equal(stamp.account_email, 'billing@example.com');
});

// The fallback, and its only trigger: no record on disk at all.
test('buildIdentityStamp — ~/.claude.json answers when there is no billing record', () => {
  const stamp = buildIdentityStamp(ACCOUNT, null, {});
  assert.equal(stamp.account_uuid, 'acc-1');
  assert.equal(stamp.account_email, 'live@example.com');
});

// THE NULL RULE. A record that states no uuid states no uuid — the fallback is for a MISSING
// record, not a missing field. Falling through would reach for ~/.claude.json on exactly the
// machines it is wrong on: under a setup token it names whoever logged in interactively last, and
// the reconcile deliberately carries a previously known uuid forward rather than blanking it.
test('buildIdentityStamp — a null in billing.json never falls through to ~/.claude.json', () => {
  const stamp = buildIdentityStamp(
    ACCOUNT,
    { accountUuid: null, accountEmail: 'billing@example.com' },
    {},
  );
  assert.equal(stamp.account_uuid, undefined);
  assert.equal(stamp.account_email, 'billing@example.com');
});

test('buildIdentityStamp — a billing record naming nobody states nothing', () => {
  assert.deepEqual(buildIdentityStamp(ACCOUNT, { accountUuid: null, accountEmail: null }, {}), {});
});

test('buildIdentityStamp — the email anchor is the last email fallback', () => {
  const stamp = buildIdentityStamp(null, { accountAnchor: BILLING.accountAnchor }, {});
  assert.equal(stamp.account_email, 'anchor@example.com');
  assert.equal(stamp.account_uuid, undefined);
});

// readClaudeAccountAnchor falls back to ~/.claude.json's top-level userID under source 'user_id'.
// That is an opaque local hash: it identifies nothing server-side, so sending it as an account uuid
// would assert an account that cannot exist.
test('buildIdentityStamp — a user_id anchor is never reported as an account uuid', () => {
  const stamp = buildIdentityStamp(
    null,
    { accountAnchor: { value: 'deadbeef-local-hash', source: 'user_id' } },
    {},
  );
  assert.equal(stamp.account_uuid, undefined);
  assert.equal(stamp.account_email, undefined);
});

// An oauth_key anchor holds the MASKED fingerprint ('sk-ant-oat01...ab12:56'), not an identity.
test('buildIdentityStamp — an oauth_key anchor is neither a uuid nor an email', () => {
  const stamp = buildIdentityStamp(
    null,
    { accountAnchor: { value: 'sk-ant-oat01...ab12:56', source: 'oauth_key' } },
    {},
  );
  assert.equal(stamp.account_uuid, undefined);
  assert.equal(stamp.account_email, undefined);
});

// The core suppression. On a setup-token machine oauthAccount describes whoever logged in last,
// and the server matches a uuid BEFORE a fingerprint — so a stale identity next to a live
// fingerprint does not add a second opinion, it wins.
test('buildIdentityStamp — a fingerprintable token replaces the uuid and the email', () => {
  const stamp = buildIdentityStamp(ACCOUNT, BILLING, { CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
  assert.equal(stamp.account_uuid, undefined);
  assert.equal(stamp.account_email, undefined);
  assert.equal(stamp.oauth_key_prefix, 'sk-ant-oat01');
  assert.equal(stamp.oauth_key_last4, 'ab12');
  assert.equal(stamp.oauth_key_length, TOKEN.length);
});

// Truthiness is not enough: a short value identifies nothing, the server drops the key entry, and
// suppressing on it would trade a usable identity for none at all.
test('buildIdentityStamp — a token too short to fingerprint suppresses nothing', () => {
  const stamp = buildIdentityStamp(ACCOUNT, BILLING, { CLAUDE_CODE_OAUTH_TOKEN: 'x' });
  assert.equal(stamp.account_uuid, 'acc-billing');
  assert.equal(stamp.account_email, 'billing@example.com');
  assert.equal(stamp.oauth_key_prefix, undefined);
});

// billing.json is the source of truth for the uuid, the email and the plan — but NOT for which key
// is in force. Its keyFingerprint is stamped by the reconcile from the same probed env every
// suppression site resolves, so it names no token the env cannot see; it can only disagree, and
// every disagreement is a stale record. Honouring it would strand a self-reported key-scoped
// machine that moved back to an interactive login: shouldKeepExisting's key guard blocks the
// rewrite on the forced path too, so the suppression would never lift. See oauth-identity.mjs.
test('buildIdentityStamp — a stored fingerprint is not a substitute for a live token', () => {
  const stamp = buildIdentityStamp(ACCOUNT, {
    ...BILLING,
    keyFingerprint: { prefix: 'sk-ant-oat01', last4: 'ab12', length: 56 },
  }, {});
  assert.equal(stamp.oauth_key_prefix, undefined);
  assert.equal(stamp.account_uuid, 'acc-billing', 'billing.json still answers for the identity');
  assert.equal(stamp.account_email, 'billing@example.com');
});

// A machine that has never run /beezi:login and cannot read oauthAccount states nothing rather
// than guessing. The server stores the reading with a NULL link.
test('buildIdentityStamp — nothing known is an empty stamp, not nulls', () => {
  assert.deepEqual(buildIdentityStamp(null, null, {}), {});
});

// Absence is how this stamp says "not stated"; an explicit null would be a claim.
test('buildIdentityStamp — unknown fields are omitted, never nulled', () => {
  const stamp = buildIdentityStamp({ accountUuid: 'acc-1', email: null }, null, {});
  assert.deepEqual(Object.keys(stamp), ['account_uuid']);
});

// The whole reason this lives in its own module: the middle of the token is never read, so it can
// never reach the wire.
test('buildIdentityStamp — the middle of the token never leaves the machine', () => {
  const stamp = buildIdentityStamp(null, null, { CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
  assert.ok(!JSON.stringify(stamp).includes(TOKEN.slice(12, -4)));
});

// ---------------------------------------------------------------------------
// One source, not one field at a time.
// ---------------------------------------------------------------------------

// The uuid and the email are read from ONE record, never mixed across sources. billing.json keeps
// the pair consistent — the reconcile writes both together and its switch detection compares both —
// so a mixed pair, which the server would resolve by the uuid alone, is unrepresentable here.
test('buildIdentityStamp — the pair comes from one record, never mixed', () => {
  const stamp = buildIdentityStamp(
    { accountUuid: null, email: 'b@example.com' },
    { accountUuid: 'uuid-A', accountEmail: 'a@example.com' },
    {},
  );
  assert.equal(stamp.account_uuid, 'uuid-A');
  assert.equal(stamp.account_email, 'a@example.com');
});

test('buildIdentityStamp — a live uuid does not displace billing.json\'s', () => {
  const stamp = buildIdentityStamp(
    { accountUuid: 'uuid-B', email: null },
    { accountUuid: 'uuid-A', accountEmail: 'a@example.com' },
    {},
  );
  assert.equal(stamp.account_uuid, 'uuid-A');
  assert.equal(stamp.account_email, 'a@example.com');
});

// An oauthAccount carrying only subscription metadata states no identity at all, so billing.json
// is still the machine's one answer — the object being non-null must not blank the stamp.
test('buildIdentityStamp — an oauthAccount that names nobody still yields to billing.json', () => {
  const stamp = buildIdentityStamp({ accountUuid: null, email: null, subscriptionType: 'pro' }, BILLING, {});
  assert.equal(stamp.account_uuid, 'acc-billing');
  assert.equal(stamp.account_email, 'billing@example.com');
});
