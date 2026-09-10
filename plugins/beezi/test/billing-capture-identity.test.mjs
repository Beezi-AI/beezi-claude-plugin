import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  describeBillingChanges,
  identityChanged,
  reconcileBillingConfig,
} from '../lib/billing-capture.mjs';
import { markAsked } from '../lib/telemetry-consent.mjs';
import { runSessionStart as _runSessionStart } from '../lib/session-start.mjs';

// The two identity questions the anchor pair could not answer on its own:
//   - a setup token replaced by ANOTHER setup token (a rotation), which moved no anchor SOURCE and
//     therefore printed nothing for the user even though the record was rewritten;
//   - a Claude login replaced by a DIFFERENT account's login, where the stored anchor is the CLI's
//     email and the file anchor is a uuid — a cross-source pair `anchorChanged` can never match, so
//     the switch waited up to a week for the heartbeat.
// Both are decided from the uuid/email FIELDS, where a null side means "not stated", never
// "different".

const NOW = new Date('2026-09-01T12:00:00.000Z');
const ISO = (msAgo) => new Date(NOW.getTime() - msAgo).toISOString();
const HOURS = 60 * 60 * 1000;
const DAYS = 24 * HOURS;

const TOKEN_A = 'sk-ant-oat01-aaaaaaaaaaaaaaaaaaaaaaaaAAAA';
const TOKEN_B = 'sk-ant-oat01-bbbbbbbbbbbbbbbbbbbbbbbbBBBB';
const fpOf = (t) => ({ prefix: t.slice(0, 12), last4: t.slice(-4), length: t.length });
const keyAnchorOf = (t) => {
  const f = fpOf(t);
  return { value: `${f.prefix}...${f.last4}:${f.length}`, source: 'oauth_key', updatedAt: ISO(DAYS) };
};

// A record the portal priced for a setup token.
function keyRecord(token, overrides = {}) {
  return {
    version: 4,
    source: 'subscription',
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_20x',
    plan: 'max_20x',
    capturedAt: ISO(DAYS),
    capturedBy: 'plan-writeback',
    detectedVia: 'key_resolution',
    planSource: 'key_resolution',
    accountAnchor: keyAnchorOf(token),
    accountUuid: null,
    accountEmail: null,
    keyFingerprint: fpOf(token),
    anchorCheckedAt: ISO(HOURS),
    ...overrides,
  };
}

// A record captured from an interactive Claude login, anchored the way `buildAnchor` anchors one
// whenever `claude auth status` answers: on the EMAIL.
function loginRecord(overrides = {}) {
  return {
    version: 4,
    source: 'subscription',
    subscriptionType: 'pro',
    rateLimitTier: 'default_claude_pro',
    plan: 'pro',
    capturedAt: ISO(DAYS),
    capturedBy: 'session-start',
    detectedVia: 'cli_status',
    planSource: 'claude_login',
    accountAnchor: { value: 'alice@example.com', source: 'email', updatedAt: ISO(DAYS) },
    accountUuid: 'uuid-A',
    accountEmail: 'alice@example.com',
    keyFingerprint: null,
    anchorCheckedAt: ISO(HOURS),
    ...overrides,
  };
}

function subUnderLogin(email, uuid, type = 'max', tier = 'default_claude_max_20x') {
  return {
    accountUuid: uuid,
    email,
    subscriptionType: type,
    rateLimitTier: tier,
    expiresAt: null,
    planSource: null,
    detectedVia: 'cli_status',
    anchor: email == null ? null : { value: email, source: 'email' },
  };
}

function subUnderToken(token) {
  return {
    accountUuid: null,
    email: null,
    subscriptionType: null,
    rateLimitTier: null,
    expiresAt: null,
    planSource: 'unresolved',
    detectedVia: 'oauth_token',
    anchor: { value: keyAnchorOf(token).value, source: 'oauth_key' },
  };
}

function reconcile({ existing, env = {}, sub = null, fileAnchor = null, fileAccount = null }) {
  const writes = [];
  const res = reconcileBillingConfig({
    readBillingConfig: () => existing,
    writeBillingConfig: (c) => writes.push(c),
    // Neutralized: a source realignment is a separate concern and would otherwise read the
    // developer's own ~/.claude.json through the real resolver.
    resolveSource: (c) => (c == null || c.source == null ? 'unknown' : c.source),
    resolveClaudeSubscription: () => sub,
    readClaudeAccountAnchor: () => fileAnchor,
    readClaudeAccount: () => fileAccount,
    env,
    now: NOW,
  });
  return { ...res, writes };
}

// ─── describeBillingChanges: the rotation line ──────────────────────────────

test('a rotated setup token is announced', () => {
  const changes = describeBillingChanges(keyRecord(TOKEN_A), keyRecord(TOKEN_B));
  assert.deepEqual(changes, ['setup token rotated']);
});

test('the same setup token announces nothing', () => {
  assert.deepEqual(describeBillingChanges(keyRecord(TOKEN_A), keyRecord(TOKEN_A)), []);
});

test('a rotation is seen through the anchor when no fingerprint was stored', () => {
  // The pre-fingerprint shape: key-scoped through `accountAnchor.source === 'oauth_key'` alone.
  // The anchor value encodes prefix...last4:length, so it moves on every rotation.
  const before = keyRecord(TOKEN_A, { keyFingerprint: null });
  const after = keyRecord(TOKEN_B, { keyFingerprint: null });
  assert.deepEqual(describeBillingChanges(before, after), ['setup token rotated']);
});

test('a fingerprint becoming visible on the same key is not a rotation', () => {
  // Filling a blank is not a change: the anchor did not move, only the structural fingerprint
  // arrived. Announcing it would fire once on every machine at upgrade.
  const before = keyRecord(TOKEN_A, { keyFingerprint: null });
  const after = keyRecord(TOKEN_A);
  assert.deepEqual(describeBillingChanges(before, after), []);
});

// ─── identityChanged: the uuid/email pair ───────────────────────────────────

test('a different account uuid is a changed identity', () => {
  assert.equal(identityChanged({ accountUuid: 'uuid-A' }, { accountUuid: 'uuid-B' }), true);
});

test('a different account email is a changed identity', () => {
  assert.equal(
    identityChanged({ accountEmail: 'alice@example.com' }, { email: 'bob@example.com' }),
    true,
  );
});

test('the same uuid with no email observed is not a changed identity', () => {
  // The case that must be skipped: the account id still matches, the observation simply does not
  // state an email. The stored email stays.
  assert.equal(
    identityChanged(
      { accountUuid: 'uuid-A', accountEmail: 'alice@example.com' },
      { accountUuid: 'uuid-A', email: null },
    ),
    false,
  );
});

test('the same email with no uuid observed is not a changed identity', () => {
  assert.equal(
    identityChanged(
      { accountUuid: 'uuid-A', accountEmail: 'alice@example.com' },
      { accountUuid: null, email: 'alice@example.com' },
    ),
    false,
  );
});

test('an email differing only by case or padding is the same identity', () => {
  assert.equal(
    identityChanged({ accountEmail: 'Alice@Example.com' }, { email: ' alice@example.com ' }),
    false,
  );
});

test('an observation that states nothing is never a changed identity', () => {
  assert.equal(identityChanged(loginRecord(), { accountUuid: null, email: null }), false);
  assert.equal(identityChanged(loginRecord(), null), false);
  assert.equal(identityChanged(null, { accountUuid: 'uuid-B', email: null }), false);
});

// ─── the reconcile: a login replaced by another account's login ─────────────

test('a switch to another account is caught the same session, not a week later', (t) => {
  // The common shape: the record is anchored on the CLI's email, ~/.claude.json states a uuid. The
  // anchor pair is cross-source and inconclusive, so before the field comparison nothing fired
  // until the seven-day heartbeat.
  const res = reconcile({
    existing: loginRecord(),
    sub: subUnderLogin('bob@example.com', 'uuid-B'),
    fileAnchor: { value: 'uuid-B', source: 'account_uuid' },
    fileAccount: { accountUuid: 'uuid-B', email: 'bob@example.com' },
  });
  assert.equal(res.outcome, 'switched');
  assert.equal(res.config.accountUuid, 'uuid-B');
  assert.equal(res.config.accountEmail, 'bob@example.com');
  assert.ok(
    res.changes.indexOf('account alice@example.com → bob@example.com') !== -1,
    `expected an account line, got ${JSON.stringify(res.changes)}`,
  );
});

test('the same account with the email no longer stated does not re-capture', () => {
  // ~/.claude.json names the uuid we already hold and no email at all. Nothing moved: keep the
  // stored subscription, keep the stored email.
  const res = reconcile({
    existing: loginRecord(),
    sub: subUnderLogin(null, 'uuid-A', 'pro', 'default_claude_pro'),
    fileAnchor: { value: 'uuid-A', source: 'account_uuid' },
    fileAccount: { accountUuid: 'uuid-A', email: null },
  });
  assert.equal(res.outcome, 'none');
  assert.equal(res.config.accountEmail, 'alice@example.com');
  assert.equal(res.config.plan, 'pro');
});

test('the same account with the uuid no longer stated does not re-capture', () => {
  const res = reconcile({
    existing: loginRecord(),
    sub: subUnderLogin('alice@example.com', null, 'pro', 'default_claude_pro'),
    fileAnchor: null,
    fileAccount: { accountUuid: null, email: 'alice@example.com' },
  });
  assert.equal(res.outcome, 'none');
  assert.equal(res.config.accountUuid, 'uuid-A');
  assert.equal(res.config.plan, 'pro');
});

test('a stale profile under a setup token never counts as an account switch', () => {
  // The hazard the guard exists for: the portal wrote its own accountEmail into this key-scoped
  // record, while ~/.claude.json still describes whoever logged in interactively last. Comparing
  // the two would wipe a key_resolution plan on a machine whose key never changed.
  const res = reconcile({
    existing: keyRecord(TOKEN_A, { accountEmail: 'billing@example.com', accountUuid: null }),
    env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN_A },
    sub: subUnderToken(TOKEN_A),
    fileAnchor: { value: 'uuid-A', source: 'account_uuid' },
    fileAccount: { accountUuid: 'uuid-A', email: 'alice@example.com' },
  });
  assert.equal(res.outcome, 'none');
  assert.equal(res.config.plan, 'max_20x');
  assert.equal(res.config.planSource, 'key_resolution');
});

test('a key-scoped record is protected even when the env cannot see the token', () => {
  // The documented honest limit: a token exported from a shell profile is invisible to every env
  // tier, so the guard cannot key off the env alone. The RECORD still says it belongs to a key.
  const res = reconcile({
    existing: keyRecord(TOKEN_A, { accountEmail: 'billing@example.com' }),
    env: {},
    sub: null,
    fileAnchor: { value: 'uuid-A', source: 'account_uuid' },
    fileAccount: { accountUuid: 'uuid-A', email: 'alice@example.com' },
  });
  assert.notEqual(res.outcome, 'switched');
  assert.equal(res.config.plan, 'max_20x');
});

test('a self-reported plan is replaced when the account demonstrably changed', () => {
  // Pinning the widened reach: `switched` writes wholesale and consults nothing, which is what the
  // reconcile already did for a same-source anchor move. The record describes someone else.
  const res = reconcile({
    existing: loginRecord({ selfReported: true, planSource: 'self_reported', plan: 'max_20x' }),
    sub: subUnderLogin('bob@example.com', 'uuid-B', 'pro', 'default_claude_pro'),
    fileAnchor: { value: 'uuid-B', source: 'account_uuid' },
    fileAccount: { accountUuid: 'uuid-B', email: 'bob@example.com' },
  });
  assert.equal(res.outcome, 'switched');
  assert.equal(res.config.selfReported, undefined);
  assert.equal(res.config.accountEmail, 'bob@example.com');
});

test('an overwrite keeps the stored email when the fresh capture states none', () => {
  // Same account, a capture that learned a better plan but named no email (the CLI answered a type
  // and no address). The record must gain the plan without losing the identity it already had.
  const stale = loginRecord({ capturedAt: ISO(9 * DAYS), anchorCheckedAt: ISO(9 * DAYS) });
  const res = reconcile({
    existing: stale,
    sub: {
      accountUuid: 'uuid-A',
      email: null,
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
      expiresAt: null,
      planSource: null,
      detectedVia: 'cli_status',
      anchor: { value: 'uuid-A', source: 'account_uuid' },
    },
    fileAnchor: { value: 'uuid-A', source: 'account_uuid' },
    fileAccount: { accountUuid: 'uuid-A', email: null },
  });
  assert.equal(res.outcome, 'captured');
  assert.equal(res.config.plan, 'max_20x');
  assert.equal(res.config.accountEmail, 'alice@example.com', 'the stored email survived');
  assert.equal(res.config.accountUuid, 'uuid-A');
});

// ─── the reconcile: one setup token replaced by another ─────────────────────

test('a rotation clears the previous key’s plan and announces itself', () => {
  const res = reconcile({
    existing: keyRecord(TOKEN_A),
    env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN_B },
    sub: subUnderToken(TOKEN_B),
    fileAnchor: null,
    fileAccount: null,
  });
  assert.equal(res.outcome, 'switched');
  assert.equal(res.config.plan, null, 'the previous key’s plan is not served under the new one');
  assert.equal(res.config.planSource, 'unresolved');
  assert.deepEqual(res.config.keyFingerprint, fpOf(TOKEN_B));
  assert.deepEqual(res.changes, ['setup token rotated']);
});

test('an account switch seen only in the file drops the previous account’s plan', () => {
  // ~/.claude.json names another account and the CLI said nothing. The record still describes the
  // PREVIOUS account, so keeping its plan would price this machine against someone else. The
  // reconcile's established answer for a degraded switch applies: write the degraded capture and
  // let the unknown-source nudge ask the right account, rather than serving a stale tier.
  const res = reconcile({
    existing: loginRecord(),
    sub: null,
    fileAnchor: { value: 'uuid-B', source: 'account_uuid' },
    fileAccount: { accountUuid: 'uuid-B', email: 'bob@example.com' },
  });
  assert.equal(res.outcome, 'switched');
  assert.equal(res.config.accountUuid, 'uuid-B');
  assert.notEqual(res.config.plan, 'pro', 'the previous account’s tier is gone');
  assert.notEqual(res.config.accountEmail, 'alice@example.com');
});

test('a rotation clears the previous key’s plan even when the CLI cannot answer', () => {
  // The env alone proves the rotation — the fingerprint is the one local signal that moves with the
  // token — so it must not need a CLI answer to take effect. Without this the `kept` branch adopted
  // the NEW fingerprint while leaving the PREVIOUS key's plan in place: an answer about a different
  // credential, served under this one.
  const res = reconcile({
    existing: keyRecord(TOKEN_A),
    env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN_B },
    sub: null,
    fileAnchor: null,
    fileAccount: null,
  });
  assert.equal(res.outcome, 'switched');
  assert.notEqual(res.config.plan, 'max_20x', 'the previous key’s tier is gone');
  assert.notEqual(res.config.planSource, 'key_resolution');
  assert.deepEqual(res.config.keyFingerprint, fpOf(TOKEN_B));
  assert.deepEqual(res.changes, ['setup token rotated']);
});

// ─── the env token appearing or disappearing ────────────────────────────────

test('a setup token appearing is acted on the same session', () => {
  // The record was written while no token existed, and one is in force now. That flip is free to
  // observe — no CLI, no clock — so it must not wait out the auth-mode recheck window.
  const res = reconcile({
    existing: loginRecord({ envKeyPresent: false, anchorCheckedAt: ISO(5 * 60 * 1000) }),
    env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN_A },
    sub: subUnderToken(TOKEN_A),
    fileAnchor: { value: 'uuid-A', source: 'account_uuid' },
  });
  assert.equal(res.outcome, 'switched');
  assert.deepEqual(res.changes, ['Claude login → setup token']);
});

test('a setup token disappearing is acted on the same session', () => {
  const res = reconcile({
    existing: keyRecord(TOKEN_A, { envKeyPresent: true, anchorCheckedAt: ISO(5 * 60 * 1000) }),
    env: {},
    sub: subUnderLogin('alice@example.com', 'uuid-A', 'pro', 'default_claude_pro'),
    fileAnchor: { value: 'uuid-A', source: 'account_uuid' },
  });
  assert.equal(res.outcome, 'migrated');
  assert.ok(res.changes.indexOf('setup token → Claude login') !== -1);
});

test('an unchanged env token state still waits out the recheck window', () => {
  // The record disagrees with the env — key-scoped, no token visible — but nothing MOVED since the
  // last check. This is the shape the window exists for: a token exported from a shell profile,
  // invisible to every env tier, whose predicate stays true forever. It must not spawn the CLI on
  // every session.
  const res = reconcile({
    existing: keyRecord(TOKEN_A, { envKeyPresent: false, anchorCheckedAt: ISO(5 * 60 * 1000) }),
    env: {},
    sub: subUnderLogin('alice@example.com', 'uuid-A', 'pro', 'default_claude_pro'),
    fileAnchor: { value: 'uuid-A', source: 'account_uuid' },
  });
  assert.equal(res.outcome, 'none');
  assert.equal(res.config.plan, 'max_20x');
});

test('the recheck window is one hour', () => {
  const res = reconcile({
    existing: keyRecord(TOKEN_A, { envKeyPresent: false, anchorCheckedAt: ISO(70 * 60 * 1000) }),
    env: {},
    sub: subUnderLogin('alice@example.com', 'uuid-A', 'pro', 'default_claude_pro'),
    fileAnchor: { value: 'uuid-A', source: 'account_uuid' },
  });
  assert.equal(res.outcome, 'migrated');
});

test('a record written before this field waits out the window rather than firing on upgrade', () => {
  // `envKeyPresent` absent is "not stated", never "flipped": every machine at upgrade would
  // otherwise look like it had just changed auth mode.
  const existing = loginRecord({ anchorCheckedAt: ISO(5 * 60 * 1000) });
  delete existing.envKeyPresent;
  const res = reconcile({
    existing,
    env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN_A },
    sub: subUnderToken(TOKEN_A),
    fileAnchor: { value: 'uuid-A', source: 'account_uuid' },
  });
  assert.equal(res.outcome, 'none');
});

test('every write records whether a setup token was in force', () => {
  // What makes the flip observable next session. Stamped on the kept path too, so a machine that
  // writes nothing else still learns its own env state.
  const kept = reconcile({
    existing: loginRecord({ anchorCheckedAt: ISO(8 * DAYS) }),
    env: {},
    sub: subUnderLogin('alice@example.com', 'uuid-A', 'pro', 'default_claude_pro'),
    fileAnchor: { value: 'uuid-A', source: 'account_uuid' },
    fileAccount: { accountUuid: 'uuid-A', email: 'alice@example.com' },
  });
  assert.equal(kept.config.envKeyPresent, false);

  const underKey = reconcile({
    existing: keyRecord(TOKEN_A, { envKeyPresent: false, anchorCheckedAt: ISO(5 * 60 * 1000) }),
    env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN_B },
    sub: subUnderToken(TOKEN_B),
  });
  assert.equal(underKey.config.envKeyPresent, true);
});

test('recording the env token state is not a billing change', () => {
  // The `kept` path now writes one more field. It must not reach the notice: otherwise the first
  // session after an upgrade announces a "billing change" on every machine that takes that branch.
  const res = reconcile({
    existing: keyRecord(TOKEN_A, { envKeyPresent: true, anchorCheckedAt: ISO(5 * 60 * 1000) }),
    env: {},
    sub: null,
    fileAnchor: { value: 'uuid-A', source: 'account_uuid' },
  });
  assert.equal(res.outcome, 'no-signal', 'the flip triggered, and the kept branch wrote');
  assert.equal(res.config.envKeyPresent, false, 'the new state was stamped, so it fires only once');
  assert.deepEqual(res.changes, []);
});

// ─── end to end: rotation → cleared → re-priced from the portal ─────────────

// The two end-to-end tests below run against the REAL clock (runSessionStart owns its own `now`),
// so their stored record must be stamped from it: a fixture dated off the frozen NOW above lands
// in the future, which the reconcile reads as a clock change and fires the heartbeat — a trigger
// that would mask whether the identity comparison works at all.
function stampedNow(record) {
  const iso = new Date().toISOString();
  return { ...record, capturedAt: iso, anchorCheckedAt: iso };
}

function makeTmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bci-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.BEEZI_HOME = dir;
  // Point Claude Code's own config dir at the same empty temp dir, so nothing here reads the
  // developer's real ~/.claude.json: the account these tests describe must come from the injected
  // seam alone.
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  t.after(() => {
    if (previousConfigDir == null) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  });
  markAsked();
  return dir;
}

test('after a rotation the session start re-prices the machine from the portal', async (t) => {
  const home = makeTmpHome(t);
  fs.writeFileSync(path.join(home, 'billing.json'), JSON.stringify(stampedNow(keyRecord(TOKEN_A))), 'utf-8');

  const probes = [];
  const message = await _runSessionStart({ session_id: 'sess-rotate', cwd: '/x' }, {
    env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN_B },
    checkForUpdate: async () => null,
    getAccessToken: async () => 'tok',
    gitImpl: () => { throw new Error('not a git repo'); },
    fetchImpl: async (url) => {
      if (String(url).includes('/me/claude-code/whoami')) return { ok: true, status: 200, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ connected: false }) };
    },
    resolveClaudeSubscription: () => subUnderToken(TOKEN_B),
    readClaudeAccountAnchor: () => null,
    readClaudeAccount: () => null,
    syncAccount: async () => ({ reported: true }),
    fetchOauthKeyStatus: async (_token, opts) => {
      probes.push(opts == null ? {} : opts);
      return {
        known: true,
        needsAttention: false,
        subscriptionPlan: 'pro',
        subscriptionType: 'pro',
        rateLimitTier: 'default_claude_pro',
        accountEmail: null,
        accountLinked: true,
        accountAnchored: false,
        planSource: 'manual',
        fingerprint: fpOf(TOKEN_B),
      };
    },
  });

  const written = JSON.parse(fs.readFileSync(path.join(home, 'billing.json'), 'utf-8'));
  assert.deepEqual(written.keyFingerprint, fpOf(TOKEN_B), 'the record follows the new key');
  assert.equal(written.plan, 'pro', 'the new key’s plan came from the portal');
  assert.equal(written.planSource, 'key_resolution');
  assert.ok(probes.length >= 1, 'the portal was asked about the new key');
  assert.match(message == null ? '' : message, /setup token rotated/);
});

test('a session start after logging into another account announces the switch', async (t) => {
  const home = makeTmpHome(t);
  fs.writeFileSync(path.join(home, 'billing.json'), JSON.stringify(stampedNow(loginRecord())), 'utf-8');

  const message = await _runSessionStart({ session_id: 'sess-switch', cwd: '/x' }, {
    env: {},
    checkForUpdate: async () => null,
    getAccessToken: async () => 'tok',
    gitImpl: () => { throw new Error('not a git repo'); },
    fetchImpl: async (url) => {
      if (String(url).includes('/me/claude-code/whoami')) return { ok: true, status: 200, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ connected: false }) };
    },
    resolveClaudeSubscription: () => subUnderLogin('bob@example.com', 'uuid-B'),
    readClaudeAccountAnchor: () => ({ value: 'uuid-B', source: 'account_uuid' }),
    readClaudeAccount: () => ({ accountUuid: 'uuid-B', email: 'bob@example.com' }),
    syncAccount: async () => ({ reported: true }),
    fetchOauthKeyStatus: async () => null,
  });

  const written = JSON.parse(fs.readFileSync(path.join(home, 'billing.json'), 'utf-8'));
  assert.equal(written.accountEmail, 'bob@example.com', 'the record follows the new account');
  assert.equal(written.accountUuid, 'uuid-B');
  assert.match(message == null ? '' : message, /account alice@example\.com → bob@example\.com/);
});
