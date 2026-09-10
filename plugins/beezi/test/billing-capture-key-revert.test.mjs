import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldKeepExisting, reconcileBillingConfig, describeBillingChanges } from '../lib/billing-capture.mjs';

// The MIRROR of billing-capture-key.test.mjs: setup token → interactive login.
//
// That direction was unreachable. `anchorChanged` cannot express it (an `oauth_key` anchor versus
// an `email` one is a cross-source pair, deliberately inconclusive), and shouldKeepExisting blocks
// a `claude_login` capture from overwriting a key-scoped record — a rule written for a machine
// whose token is merely INVISIBLE, which cannot tell that case from a real migration. The result
// was that a plan resolved for a key nobody uses any more kept pricing every report, on session
// start, through the weekly heartbeat, and through /beezi:refresh, which the guard also covers.
//
// The discriminator now is whether the CLI POSITIVELY answered for an interactive login. That is
// not a perfect signal and the code says so; these tests pin what it does and does not accept.

const T0 = new Date('2026-08-21T10:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function harness({ existing = null, sub = null, fileAnchor = null, env = {} } = {}) {
  const writes = [];
  let store = existing;
  return {
    writes,
    deps: {
      readBillingConfig: () => store,
      writeBillingConfig: (cfg) => { writes.push(cfg); store = cfg; },
      resolveSource: (cfg) => (
        cfg != null && (cfg.keyFingerprint != null || (cfg.plan && cfg.plan !== 'unknown'))
          ? 'subscription'
          : 'unknown'
      ),
      isStale: () => false,
      resolveClaudeSubscription: () => sub,
      readClaudeAccountAnchor: () => fileAnchor,
      env,
      now: T0,
    },
  };
}

const FINGERPRINT = Object.freeze({ prefix: 'sk-ant-oat01', last4: 'UQAA', length: 44 });

// What /beezi:refresh leaves on a setup-token machine: a plan the PORTAL resolved, scoped to one
// fingerprint, anchored to the key rather than to any account identity.
const KEY_SCOPED = Object.freeze({
  version: 4,
  source: 'subscription',
  subscriptionType: 'max',
  rateLimitTier: 'default_claude_max_20x',
  plan: 'max_20x',
  planSource: 'key_resolution',
  capturedAt: new Date(T0.getTime() - DAY_MS).toISOString(),
  anchorCheckedAt: new Date(T0.getTime() - DAY_MS).toISOString(),
  accountAnchor: { value: 'sk-ant-oat01...UQAA:44', source: 'oauth_key', updatedAt: new Date(T0.getTime() - DAY_MS).toISOString() },
  accountEmail: 'ci-key@example.com',
  keyFingerprint: FINGERPRINT,
});

// A healthy interactive login, as resolveClaudeSubscription really returns it: the CLI answered
// with a subscription type, so detectedVia is 'merged' (or 'cli_status'). NOTE there is no
// planSource — that field is set by exactly one branch, the oauth_token one.
const LOGIN_CONFIRMED_SUB = Object.freeze({
  accountUuid: 'human-account-uuid',
  email: 'human@example.com',
  subscriptionType: 'pro',
  rateLimitTier: null,
  expiresAt: null,
  detectedVia: 'merged',
  anchor: { value: 'human@example.com', source: 'email' },
});

// The arm taken when the CLI gave NO usable answer and only ~/.claude.json's profile is left. On a
// token machine that profile describes whoever logged in last, so it is worth nothing here.
const STALE_PROFILE_SUB = Object.freeze({
  accountUuid: 'human-account-uuid',
  email: 'human@example.com',
  subscriptionType: 'pro',
  rateLimitTier: null,
  detectedVia: 'oauth_account',
  anchor: { value: 'human-account-uuid', source: 'account_uuid' },
});

const FILE_ANCHOR = { value: 'human-account-uuid', source: 'account_uuid' };

test('revert — a confirmed login rewrites the key-scoped record', () => {
  const h = harness({ existing: KEY_SCOPED, sub: LOGIN_CONFIRMED_SUB, fileAnchor: FILE_ANCHOR, env: {} });
  const { config, outcome } = reconcileBillingConfig(h.deps);

  assert.equal(outcome, 'migrated');
  assert.equal(config.plan, 'pro');
  assert.equal(config.planSource, 'claude_login');
  // The record must stop belonging to a key, or the next capture is blocked by the same rule.
  assert.equal(config.keyFingerprint, null);
  assert.equal(config.accountAnchor.source, 'email');
  assert.equal(config.accountEmail, 'human@example.com');
});

// The whole point of the guard this stands down: a stale on-disk profile is not evidence that the
// token is gone. Only the CLI answering for a login is.
test('revert — an unconfirmed capture still cannot touch the record', () => {
  const h = harness({ existing: KEY_SCOPED, sub: STALE_PROFILE_SUB, fileAnchor: FILE_ANCHOR, env: {} });
  const { config, outcome } = reconcileBillingConfig(h.deps);

  assert.notEqual(outcome, 'migrated');
  assert.equal(config.plan, 'max_20x');
  assert.equal(config.planSource, 'key_resolution');
  assert.deepEqual(config.keyFingerprint, FINGERPRINT);
});

test('revert — no CLI answer at all leaves the record alone', () => {
  const h = harness({ existing: KEY_SCOPED, sub: null, fileAnchor: FILE_ANCHOR, env: {} });
  const { config, outcome } = reconcileBillingConfig(h.deps);

  assert.notEqual(outcome, 'migrated');
  assert.equal(config.plan, 'max_20x');
});

// The token is still in force, so nothing was reverted — however loudly the on-disk profile talks.
test('revert — a visible token blocks the whole path', () => {
  const h = harness({
    existing: KEY_SCOPED,
    sub: LOGIN_CONFIRMED_SUB,
    fileAnchor: FILE_ANCHOR,
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz-UQAA' },
  });
  const { config, outcome } = reconcileBillingConfig(h.deps);

  assert.notEqual(outcome, 'migrated');
  assert.deepEqual(config.keyFingerprint, FINGERPRINT);
});

// A record anchored to a key but carrying no fingerprint (written before billing.json v4) is still
// key-scoped, and must migrate too.
test('revert — an oauth_key anchor alone is enough to be key-scoped', () => {
  const noFingerprint = { ...KEY_SCOPED, keyFingerprint: null };
  const h = harness({ existing: noFingerprint, sub: LOGIN_CONFIRMED_SUB, fileAnchor: FILE_ANCHOR, env: {} });
  const { config, outcome } = reconcileBillingConfig(h.deps);

  assert.equal(outcome, 'migrated');
  assert.equal(config.plan, 'pro');
  assert.equal(config.accountAnchor.source, 'email');
});

// A machine that was never on a token has nothing to revert FROM: it must take the ordinary
// capture path, so the outcome stays 'captured' and the new message never fires.
test('revert — a login-only record is an ordinary capture, not a migration', () => {
  const loginScoped = {
    version: 4, source: 'subscription', subscriptionType: 'pro', plan: 'pro',
    planSource: 'claude_login', capturedAt: new Date(T0.getTime() - DAY_MS).toISOString(),
    anchorCheckedAt: new Date(T0.getTime() - DAY_MS).toISOString(),
    accountAnchor: { value: 'old@example.com', source: 'email', updatedAt: new Date(T0.getTime() - DAY_MS).toISOString() },
  };
  const h = harness({ existing: loginScoped, sub: LOGIN_CONFIRMED_SUB, fileAnchor: FILE_ANCHOR, env: {} });
  const { outcome } = reconcileBillingConfig(h.deps);

  assert.notEqual(outcome, 'migrated');
});

// ─── the guard itself, in isolation ───────────────────────────────────────────

test('shouldKeepExisting — the key-scoping rule holds without confirmation', () => {
  const fresh = { plan: 'pro', planSource: 'claude_login', keyFingerprint: null };
  assert.equal(shouldKeepExisting(fresh, KEY_SCOPED), true);
  assert.equal(shouldKeepExisting(fresh, KEY_SCOPED, {}), true);
  assert.equal(shouldKeepExisting(fresh, KEY_SCOPED, { keyRevertConfirmed: false }), true);
});

test('shouldKeepExisting — a confirmed revert stands it down', () => {
  const fresh = { plan: 'pro', planSource: 'claude_login', keyFingerprint: null };
  assert.equal(shouldKeepExisting(fresh, KEY_SCOPED, { keyRevertConfirmed: true }), false);
});

// The escape must be narrow: it releases ONE rule, not the protections around it. A capture that
// dropped the Max multiplier has not learned anything to correct the record with, confirmed
// migration or not.
test('shouldKeepExisting — a confirmed revert does not release the multiplier guard', () => {
  const coarser = { plan: 'max', planSource: 'claude_login', keyFingerprint: null };
  assert.equal(shouldKeepExisting(coarser, KEY_SCOPED, { keyRevertConfirmed: true }), true);
});

// Nor the rule protecting a key_resolution plan from an 'unresolved' verdict — that path is about
// a token still being in force, and a revert has nothing to say about it.
test('shouldKeepExisting — a confirmed revert does not release the unresolved guard', () => {
  const unresolved = { plan: null, planSource: 'unresolved', keyFingerprint: null };
  assert.equal(shouldKeepExisting(unresolved, KEY_SCOPED, { keyRevertConfirmed: true }), true);
});

// ─── the change summary the session-start notice is built from ────────────────

// A write is not a change. The heartbeat re-captures the identical tuple on a healthy machine, so
// a summary keyed off `outcome` would announce a change every seven days forever and train the
// user to skip the line — costing them the one time it says something.
test('describeBillingChanges — an identical record reports nothing', () => {
  assert.deepEqual(describeBillingChanges(KEY_SCOPED, { ...KEY_SCOPED }), []);
});

// There was nothing to change FROM. A machine's first capture is not news.
test('describeBillingChanges — a first capture is not a change', () => {
  assert.deepEqual(describeBillingChanges(null, { plan: 'pro', source: 'subscription' }), []);
});

test('describeBillingChanges — the credential move is reported first', () => {
  const after = {
    plan: 'pro', planSource: 'claude_login', source: 'subscription',
    keyFingerprint: null, accountEmail: 'human@example.com',
    accountAnchor: { value: 'human@example.com', source: 'email' },
  };
  const changes = describeBillingChanges(KEY_SCOPED, after);
  // Order is load-bearing: "plan max_20x → pro" alone reads as a downgrade nobody asked for.
  assert.equal(changes[0], 'setup token → Claude login');
  assert.ok(changes.some((c) => c === 'plan max_20x → pro'), changes.join(' | '));
  assert.ok(changes.some((c) => c.startsWith('account ci-key@example.com →')), changes.join(' | '));
});

test('describeBillingChanges — the reverse transition reads the other way round', () => {
  const before = { plan: 'pro', source: 'subscription', accountAnchor: { value: 'x', source: 'email' } };
  const after = { plan: null, source: 'subscription', keyFingerprint: FINGERPRINT };
  assert.equal(describeBillingChanges(before, after)[0], 'Claude login → setup token');
});

// 'unknown' and null are the same statement — "no plan" — so moving between them is not news.
test('describeBillingChanges — unknown and null are the same plan', () => {
  assert.deepEqual(
    describeBillingChanges({ plan: 'unknown', source: 'subscription' }, { plan: null, source: 'subscription' }),
    [],
  );
});

test('describeBillingChanges — a billing source switch is reported', () => {
  const changes = describeBillingChanges(
    { plan: 'max_5x', source: 'subscription' },
    { plan: 'max_5x', source: 'anthropic_api_key' },
  );
  assert.deepEqual(changes, ['billing source subscription → anthropic_api_key']);
});

// A uuid and an email that move together are ONE account switch, not two lines.
test('describeBillingChanges — an account switch is a single line', () => {
  const changes = describeBillingChanges(
    { plan: 'pro', source: 'subscription', accountEmail: 'a@x.io', accountUuid: 'uuid-a' },
    { plan: 'pro', source: 'subscription', accountEmail: 'b@x.io', accountUuid: 'uuid-b' },
  );
  assert.deepEqual(changes, ['account a@x.io → b@x.io']);
});

// The reconcile has to hand the summary out, or the notice has nothing to render.
test('reconcile returns the change summary alongside the config', () => {
  const h = harness({ existing: KEY_SCOPED, sub: LOGIN_CONFIRMED_SUB, fileAnchor: FILE_ANCHOR, env: {} });
  const { changes } = reconcileBillingConfig(h.deps);
  assert.ok(Array.isArray(changes));
  assert.equal(changes[0], 'setup token → Claude login');
});

// The `kept` path protects the PLAN, not the whole record: it still adopts identity fields that
// have become visible, because the check-in needs them. So a kept reconcile can legitimately report
// an account change — and should, since that is exactly what the portal is about to be told.
test('reconcile reports an identity change even on the kept path', () => {
  const h = harness({ existing: KEY_SCOPED, sub: STALE_PROFILE_SUB, fileAnchor: FILE_ANCHOR, env: {} });
  const { config, changes } = reconcileBillingConfig(h.deps);

  assert.equal(config.plan, 'max_20x', 'the plan is still protected');
  assert.deepEqual(changes, ['account ci-key@example.com → human@example.com']);
  // And no credential line: the record is still key-scoped, so nothing migrated.
  assert.equal(changes.indexOf('setup token → Claude login'), -1);
});

// A genuinely inert reconcile — nothing new to see, nothing to say.
test('reconcile reports no changes when nothing moved', () => {
  const h = harness({
    existing: KEY_SCOPED,
    sub: { ...STALE_PROFILE_SUB, accountUuid: null, email: 'ci-key@example.com' },
    fileAnchor: null,
    env: {},
  });
  const { changes } = reconcileBillingConfig(h.deps);
  assert.deepEqual(changes, []);
});

// Filling a blank is not a change. This is what keeps the notice worth reading: most writes to
// billing.json are the plugin learning something it did not know, not the user's billing moving.
// Without these the line would fire once on nearly every machine at upgrade — a v2 record gaining
// accountEmail, a source resolving off 'unknown' — and be ignored by the time it mattered.
test('describeBillingChanges — learning an identity for the first time is silent', () => {
  assert.deepEqual(
    describeBillingChanges(
      { plan: 'max_20x', source: 'subscription' },
      { plan: 'max_20x', source: 'subscription', accountEmail: 'dev@example.com' },
    ),
    [],
  );
});

test('describeBillingChanges — a source resolving off unknown is silent', () => {
  assert.deepEqual(
    describeBillingChanges(
      { plan: 'pro', source: 'unknown', accountEmail: 'd@e.io' },
      { plan: 'pro', source: 'subscription', accountEmail: 'd@e.io' },
    ),
    [],
  );
});

// The multiplier becoming readable is a refinement, not a plan the user moved to — the inverse of
// what losesMultiplier refuses to write.
test('describeBillingChanges — a same-product sharpening is silent', () => {
  assert.deepEqual(
    describeBillingChanges(
      { plan: 'max', source: 'subscription' },
      { plan: 'max_20x', source: 'subscription' },
    ),
    [],
  );
});

// But a move to a different product is real, in either direction.
test('describeBillingChanges — a different product still reports', () => {
  assert.deepEqual(
    describeBillingChanges(
      { plan: 'max_20x', source: 'subscription' },
      { plan: 'pro', source: 'subscription' },
    ),
    ['plan max_20x → pro'],
  );
});

// The credential transitions are exempt from the "known → known" rule: they are observations about
// which credential is in force, and both directions are news whatever the record knew before.
test('describeBillingChanges — a credential move reports even from a blank record', () => {
  assert.deepEqual(
    describeBillingChanges({ source: 'subscription' }, { source: 'subscription', keyFingerprint: FINGERPRINT }),
    ['Claude login → setup token'],
  );
});

// ---------------------------------------------------------------------------
// A DECLARED plan is not a key-scoped plan, and the revert escape must not reach it.
// ---------------------------------------------------------------------------

// What the unknown-nudge leaves on a token machine whose user answered it: their own testimony,
// scoped to the fingerprint that was visible at the time.
const SELF_REPORTED_KEY_SCOPED = Object.freeze({
  ...KEY_SCOPED,
  planSource: 'reported',
  selfReported: true,
});

// The honest limit `confirmsInteractiveLogin` documents, applied to the one record no automatic
// capture can reconstruct: a token exported from a shell profile is invisible to every env tier,
// so the CLI answers `claude.ai` for the previous login and a real migration is indistinguishable
// from a merely invisible token. Guessing wrong on a declared plan is permanent — isStale() never
// re-asks a self-reported record — so this direction must not be guessed at all.
test('revert — a self-reported plan survives a confirmed login', () => {
  const h = harness({ existing: SELF_REPORTED_KEY_SCOPED, sub: LOGIN_CONFIRMED_SUB, fileAnchor: FILE_ANCHOR, env: {} });
  const { config, outcome } = reconcileBillingConfig(h.deps);

  assert.notEqual(outcome, 'migrated');
  assert.equal(config.plan, 'max_20x');
  assert.equal(config.planSource, 'reported');
  assert.equal(config.selfReported, true);
});

// Forced is the /beezi:refresh path, and it covers this rule too — same reason the key guard does.
test('revert — /beezi:refresh does not overwrite a self-reported plan either', () => {
  const h = harness({ existing: SELF_REPORTED_KEY_SCOPED, sub: LOGIN_CONFIRMED_SUB, fileAnchor: FILE_ANCHOR, env: {} });
  const { config } = reconcileBillingConfig(h.deps, { force: true });

  assert.equal(config.plan, 'max_20x');
  assert.equal(config.selfReported, true);
});

// The exclusion is about the DECLARATION, not about being key-scoped: an ordinary key_resolution
// record still migrates. Pinned here so a future widening of the exclusion is visible.
test('revert — the exclusion does not reach an ordinary key-scoped record', () => {
  const h = harness({ existing: KEY_SCOPED, sub: LOGIN_CONFIRMED_SUB, fileAnchor: FILE_ANCHOR, env: {} });
  const { outcome } = reconcileBillingConfig(h.deps);

  assert.equal(outcome, 'migrated');
});

// An account SWITCH still overrides a declared plan — the record demonstrably describes someone
// else — and it reaches that verdict without the revert escape, through anchorChanged.
test('revert — a self-reported record still yields to a real account switch', () => {
  const existing = {
    ...SELF_REPORTED_KEY_SCOPED,
    accountAnchor: { value: 'declared@example.com', source: 'email', updatedAt: new Date(T0.getTime() - DAY_MS).toISOString() },
    keyFingerprint: null,
  };
  // Same-source, so anchorChanged can see it — which is exactly why this path needs no escape.
  const fileAnchor = { value: 'human@example.com', source: 'email' };
  const h = harness({ existing, sub: LOGIN_CONFIRMED_SUB, fileAnchor, env: {} });
  const { outcome } = reconcileBillingConfig(h.deps);

  assert.equal(outcome, 'switched');
});

// The guard that protects a declared plan read only the FINGERPRINT, while everything else here
// treats an `oauth_key` anchor as key-scoping on its own — so a record captured through the anchor
// alone fell through to the ordinary selfReported logic and the weekly heartbeat overwrote the
// user's own answer with the previous login's plan. Reproduced end to end: an old enough record so
// the heartbeat is what triggers, which is how this actually reaches a real machine.
test('revert — an anchor-only self-reported plan survives the heartbeat', () => {
  const stale = new Date(T0.getTime() - 60 * DAY_MS).toISOString();
  const existing = {
    ...SELF_REPORTED_KEY_SCOPED,
    keyFingerprint: null,
    capturedAt: stale,
    anchorCheckedAt: stale,
  };
  const h = harness({ existing, sub: LOGIN_CONFIRMED_SUB, fileAnchor: FILE_ANCHOR, env: {} });
  const { config } = reconcileBillingConfig(h.deps);

  assert.equal(config.plan, 'max_20x');
  assert.equal(config.selfReported, true);
});

// And the same record WITHOUT the declaration still migrates on the heartbeat — the widened guard
// scopes the record, it does not freeze it.
test('revert — an anchor-only record with no declaration still migrates', () => {
  const stale = new Date(T0.getTime() - 60 * DAY_MS).toISOString();
  const existing = { ...KEY_SCOPED, keyFingerprint: null, capturedAt: stale, anchorCheckedAt: stale };
  const h = harness({ existing, sub: LOGIN_CONFIRMED_SUB, fileAnchor: FILE_ANCHOR, env: {} });
  const { config, outcome } = reconcileBillingConfig(h.deps);

  assert.equal(outcome, 'migrated');
  assert.equal(config.plan, 'pro');
});
