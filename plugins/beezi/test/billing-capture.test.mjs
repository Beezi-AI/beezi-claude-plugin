import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, buildConfig, shouldKeepExisting, losesMultiplier, reconcileBillingConfig } from '../lib/billing-capture.mjs';

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
    // These raw fields only ever come from a readable oauthAccount (--from-claude), which is
    // itself the evidence that resolves the source to subscription.
    { subscriptionType: 'team' },
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
    { subscriptionType: 'pro' },
  );
  assert.equal(cfg.version, 4);
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
    assert.equal(cfg.version, 4);
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

// ─── self-reporting a non-subscription machine ──────────────────────────────

test('buildConfig — --plan api_key declares an API-key machine, with no plan attached', () => {
  const cfg = buildConfig({ plan: 'api_key', via: 'login-user' }, {}, new Date('2026-08-05T00:00:00.000Z'));
  assert.equal(cfg.source, 'anthropic_api_key');
  assert.equal(cfg.plan, null);
  assert.equal(cfg.subscriptionType, null);
  assert.equal(cfg.rateLimitTier, null);
  assert.equal(cfg.selfReported, true);
  assert.equal(cfg.capturedBy, 'login-user');
});

test('buildConfig — a positively-named env still outranks the api_key declaration', () => {
  const cfg = buildConfig({ plan: 'api_key' }, { CLAUDE_CODE_USE_BEDROCK: '1' }, new Date());
  assert.equal(cfg.source, 'third_party');
});

test('buildConfig — self-reported tier resolves an otherwise-unknown machine to subscription', () => {
  const cfg = buildConfig({ plan: 'max_20x', via: 'login-user' }, {}, new Date());
  assert.equal(cfg.source, 'subscription');
  assert.equal(cfg.plan, 'max_20x');
  assert.equal(cfg.selfReported, true);
});

test('buildConfig — an exported API key overrules a claimed subscription tier', () => {
  const cfg = buildConfig({ plan: 'max_20x' }, { ANTHROPIC_API_KEY: 'sk-x' }, new Date());
  assert.equal(cfg.source, 'anthropic_api_key');
  assert.equal(cfg.plan, null, 'no plan may survive a non-subscription source');
});

// ─── self-reporting what a custom gateway bills ─────────────────────────────
// A gateway route cannot be resolved locally: it may carry this machine's own subscription
// credential or one the gateway holds. The user is asked, exactly as an unresolvable tier is.

test('buildConfig — --plan gateway declares provider billing, with no plan attached', () => {
  const cfg = buildConfig({ plan: 'gateway', via: 'login-user' }, {}, new Date('2026-08-18T00:00:00.000Z'));
  assert.equal(cfg.source, 'third_party');
  assert.equal(cfg.plan, null);
  assert.equal(cfg.subscriptionType, null);
  assert.equal(cfg.rateLimitTier, null);
  assert.equal(cfg.selfReported, true);
  assert.equal(cfg.capturedBy, 'login-user');
});

test('buildConfig — a declared tier survives a custom gateway (the proxy bills the subscription)', () => {
  const cfg = buildConfig(
    { plan: 'team', via: 'login-user' },
    { ANTHROPIC_BASE_URL: 'https://gw.corp.example' },
    new Date(),
  );
  assert.equal(cfg.source, 'subscription');
  assert.equal(cfg.plan, 'team');
  assert.equal(cfg.selfReported, true);
});

test('buildConfig — a gateway with no credential captures as unknown so login can ask', () => {
  const cfg = buildConfig(
    { subscriptionType: 'team', via: 'login' },
    { ANTHROPIC_BASE_URL: 'https://gw.corp.example' },
    new Date(),
    { subscriptionType: 'team' },
  );
  assert.equal(cfg.source, 'unknown');
  assert.equal(cfg.plan, null);
});

test('shouldKeepExisting — keeps a declared gateway when the fresh capture learned nothing', () => {
  // Without this, every /beezi:refresh on a gateway machine wipes the answer and re-asks.
  const fresh = { source: 'unknown', plan: null };
  assert.equal(shouldKeepExisting(fresh, { selfReported: true, source: 'third_party', plan: null }), true);
  assert.equal(shouldKeepExisting(fresh, { selfReported: true, source: 'anthropic_api_key', plan: null }), true);
});

test('shouldKeepExisting — a fresh capture that names a provider overwrites the declaration', () => {
  const fresh = { source: 'third_party', plan: null };
  assert.equal(shouldKeepExisting(fresh, { selfReported: true, source: 'third_party', plan: null }), false);
});

// ─── reconcileBillingConfig (session-start self-healing) ─────────────────────

const T0 = new Date('2026-08-21T10:00:00.000Z');
const iso = (msAgo) => new Date(T0.getTime() - msAgo).toISOString();
const DAY_MS = 24 * 60 * 60 * 1000;

// Harness: in-memory config store + spy-able readers; realistic defaults everywhere.
function harness({ existing = null, sub = null, fileAnchor = null, env = {}, stale = false } = {}) {
  const writes = [];
  let store = existing;
  const subCalls = { count: 0 };
  return {
    writes,
    subCalls,
    deps: {
      readBillingConfig: () => store,
      writeBillingConfig: (cfg) => { writes.push(cfg); store = cfg; },
      resolveSource: (cfg) => (cfg != null && cfg.plan && cfg.plan !== 'unknown' ? 'subscription' : 'unknown'),
      isStale: () => stale,
      resolveClaudeSubscription: () => { subCalls.count += 1; return sub; },
      readClaudeAccountAnchor: () => fileAnchor,
      env,
      now: T0,
    },
  };
}

const CLI_SUB = Object.freeze({
  accountUuid: null,
  subscriptionType: 'max',
  rateLimitTier: null,
  expiresAt: null,
  billingType: null,
  seatTier: null,
  organizationType: null,
  detectedVia: 'cli_status',
  anchor: { value: 'b@corp.co', source: 'email' },
});

test('reconcile — stuck machine heals: source unknown + a CLI answer → captured without user action', () => {
  const h = harness({
    existing: { version: 1, source: 'unknown', capturedAt: iso(30 * DAY_MS) },
    sub: CLI_SUB,
  });
  const { config, source } = reconcileBillingConfig(h.deps);
  assert.equal(h.subCalls.count, 1);
  assert.equal(config.plan, 'max');
  assert.equal(config.source, 'subscription');
  assert.equal(config.capturedBy, 'session-start');
  assert.equal(config.detectedVia, 'cli_status');
  assert.equal(config.version, 4);
  assert.deepEqual(
    { value: config.accountAnchor.value, source: config.accountAnchor.source },
    { value: 'b@corp.co', source: 'email' },
  );
  assert.equal(source, 'subscription');
});

test('reconcile — steady state spawns nothing and writes nothing', () => {
  const h = harness({
    existing: {
      version: 2,
      source: 'subscription',
      plan: 'max',
      subscriptionType: 'max',
      capturedAt: iso(DAY_MS),
      anchorCheckedAt: iso(DAY_MS),
      accountAnchor: { value: 'b@corp.co', source: 'email', updatedAt: iso(DAY_MS) },
    },
  });
  reconcileBillingConfig(h.deps);
  assert.equal(h.subCalls.count, 0, 'no trigger — the CLI must not be spawned');
  assert.equal(h.writes.length, 0);
});

test('reconcile — account switch: a different email anchor wipes the self-reported plan and re-captures', () => {
  const h = harness({
    existing: {
      version: 2,
      source: 'subscription',
      plan: 'pro',
      subscriptionType: 'pro',
      selfReported: true,
      capturedAt: iso(DAY_MS),
      anchorCheckedAt: iso(8 * DAY_MS),
      accountAnchor: { value: 'a@corp.co', source: 'email', updatedAt: iso(8 * DAY_MS) },
    },
    sub: CLI_SUB, // account B: max, b@corp.co
  });
  const { config } = reconcileBillingConfig(h.deps);
  assert.equal(h.subCalls.count, 1, 'the stale heartbeat re-checks the anchor');
  assert.equal(config.plan, 'max', 'account B observed plan replaces account A testimony');
  assert.equal(config.selfReported, undefined);
  assert.equal(config.accountAnchor.value, 'b@corp.co');
});

test('reconcile — account switch with a degraded capture still wipes: the unknown-nudge asks account B', () => {
  const h = harness({
    existing: {
      version: 2,
      source: 'subscription',
      plan: 'max_20x',
      subscriptionType: 'max',
      selfReported: true,
      capturedAt: iso(DAY_MS),
      anchorCheckedAt: iso(DAY_MS),
      accountAnchor: { value: 'uid-A', source: 'user_id', updatedAt: iso(DAY_MS) },
    },
    fileAnchor: { value: 'uid-B', source: 'user_id' }, // cheap precheck already sees the switch
    sub: null, // and the CLI has no answer
  });
  const { config, source } = reconcileBillingConfig(h.deps);
  assert.equal(config.plan, null, 'account A plan must not survive onto account B');
  assert.equal(config.accountAnchor.value, 'uid-B');
  assert.equal(source, 'unknown');
});

test('reconcile — cross-source anchor difference is inconclusive: self-reported plan survives, anchor adopted', () => {
  const h = harness({
    existing: {
      version: 2,
      source: 'subscription',
      plan: 'max_20x',
      subscriptionType: 'max',
      selfReported: true,
      capturedAt: iso(DAY_MS),
      anchorCheckedAt: iso(8 * DAY_MS),
      accountAnchor: { value: 'uid-A', source: 'user_id', updatedAt: iso(8 * DAY_MS) },
    },
    sub: { ...CLI_SUB, subscriptionType: null, anchor: { value: 'b@corp.co', source: 'email' } },
  });
  const { config } = reconcileBillingConfig(h.deps);
  assert.equal(config.plan, 'max_20x', 'testimony survives an inconclusive identity check');
  assert.equal(config.selfReported, true);
  assert.deepEqual(
    { value: config.accountAnchor.value, source: config.accountAnchor.source },
    { value: 'b@corp.co', source: 'email' },
  );
  assert.equal(config.anchorCheckedAt, T0.toISOString(), 'heartbeat stamped so the next check is a week out');
});

test('reconcile — v1 grandfathering adopts an anchor without trading max_20x for a bare max', () => {
  const h = harness({
    existing: {
      version: 1,
      source: 'subscription',
      plan: 'max_20x',
      subscriptionType: 'max',
      selfReported: true,
      capturedAt: iso(DAY_MS),
    },
    sub: { ...CLI_SUB, subscriptionType: 'max', anchor: { value: 'b@corp.co', source: 'email' } },
  });
  const { config } = reconcileBillingConfig(h.deps);
  // A CLI capture with no tier resolves 'max', which is the SAME product with the multiplier
  // missing — not a plan the user moved to. Letting it through cost the multiplier permanently,
  // since 'max' is not 'unknown' and nothing ever asks again. The identity work still lands.
  assert.equal(config.plan, 'max_20x');
  assert.equal(config.accountAnchor.value, 'b@corp.co');
  assert.equal(config.version, 4);
});

test('losesMultiplier — only same-product detail loss is refused, never a real plan change', () => {
  assert.equal(losesMultiplier('max', 'max_20x'), true);
  assert.equal(losesMultiplier('max', 'max_5x'), true);
  // Genuine moves off Max must still record, or a downgraded user is billed to the wrong plan.
  assert.equal(losesMultiplier('pro', 'max_20x'), false);
  assert.equal(losesMultiplier('team', 'max_5x'), false);
  assert.equal(losesMultiplier('max_5x', 'max_20x'), false);
  assert.equal(losesMultiplier('max', 'max'), false);
  assert.equal(losesMultiplier('unknown', 'max_20x'), false);
});

test('shouldKeepExisting — a detected bare max never replaces a stored multiplier, self-reported or not', () => {
  assert.equal(shouldKeepExisting({ plan: 'max' }, { plan: 'max_20x' }), true);
  assert.equal(shouldKeepExisting({ plan: 'max' }, { selfReported: true, plan: 'max_5x' }), true);
  // and the upgrade direction stays open, which is how already-degraded machines heal
  assert.equal(shouldKeepExisting({ plan: 'max_20x' }, { plan: 'max' }), false);
});

test('reconcile — a degraded capture never overwrites a good record without a switch', () => {
  const h = harness({
    existing: {
      version: 2,
      source: 'subscription',
      plan: 'max_20x',
      subscriptionType: 'max',
      capturedAt: iso(8 * DAY_MS),
      anchorCheckedAt: iso(DAY_MS),
      accountAnchor: { value: 'uid-A', source: 'user_id', updatedAt: iso(DAY_MS) },
    },
    stale: true, // stale plan nudge territory
    sub: null, // but nothing readable right now
    fileAnchor: { value: 'uid-A', source: 'user_id' },
  });
  const { config } = reconcileBillingConfig(h.deps);
  assert.equal(config.plan, 'max_20x', 'nulls must not replace a real capture');
  assert.equal(config.capturedAt, iso(8 * DAY_MS), 'capturedAt untouched — the plan was not re-read');
});

test('reconcile — no config and no signal: nothing invented, source unknown', () => {
  const h = harness({});
  const { config, source } = reconcileBillingConfig(h.deps);
  assert.equal(config, null);
  assert.equal(source, 'unknown');
  assert.equal(h.subCalls.count, 1, 'a machine with no record keeps trying');
});

test('reconcile — every dependency throwing still returns and never throws', () => {
  const boom = () => { throw new Error('boom'); };
  const r = reconcileBillingConfig({
    readBillingConfig: boom,
    writeBillingConfig: boom,
    resolveSource: boom,
    isStale: boom,
    resolveClaudeSubscription: boom,
    readClaudeAccountAnchor: boom,
    now: T0,
  });
  assert.equal(r.config, null);
  assert.equal(r.source, 'unknown');
});

// ─── forced mode (/beezi:login and /beezi:refresh go through the same reconcile) ──

test('reconcile force — captures even in a steady state the automatic path would skip', () => {
  const h = harness({
    existing: {
      version: 2,
      source: 'subscription',
      plan: 'pro',
      subscriptionType: 'pro',
      capturedAt: iso(DAY_MS),
      anchorCheckedAt: iso(DAY_MS),
      accountAnchor: { value: 'b@corp.co', source: 'email', updatedAt: iso(DAY_MS) },
    },
    sub: CLI_SUB,
  });
  const { config, outcome } = reconcileBillingConfig(h.deps, { force: true, via: 'refresh' });
  assert.equal(h.subCalls.count, 1, 'the user asked — always re-read');
  assert.equal(outcome, 'captured');
  assert.equal(config.plan, 'max');
  assert.equal(config.capturedBy, 'refresh');
});

test('reconcile force — no signal at all keeps the record and reports no-signal', () => {
  const h = harness({
    existing: {
      version: 2,
      source: 'subscription',
      plan: 'max_20x',
      subscriptionType: 'max',
      selfReported: true,
      capturedAt: iso(DAY_MS),
      anchorCheckedAt: iso(DAY_MS),
      accountAnchor: { value: 'b@corp.co', source: 'email', updatedAt: iso(DAY_MS) },
    },
    sub: null,
  });
  const { config, outcome } = reconcileBillingConfig(h.deps, { force: true, via: 'refresh' });
  assert.equal(outcome, 'no-signal');
  assert.equal(config.plan, 'max_20x', 'nothing readable — the record survives');
  assert.equal(config.anchorCheckedAt, T0.toISOString(), 'heartbeat still stamped');
});

test('reconcile force — an unresolvable tier keeps a protected self-reported plan (outcome kept)', () => {
  const h = harness({
    existing: {
      version: 2,
      source: 'subscription',
      plan: 'max_20x',
      subscriptionType: 'max',
      selfReported: true,
      capturedAt: iso(DAY_MS),
      anchorCheckedAt: iso(DAY_MS),
      accountAnchor: { value: 'b@corp.co', source: 'email', updatedAt: iso(DAY_MS) },
    },
    // Tuple that normalizes to 'unknown': shouldKeepExisting must protect the testimony.
    sub: { ...CLI_SUB, subscriptionType: 'mystery_tier' },
  });
  const { config, outcome } = reconcileBillingConfig(h.deps, { force: true, via: 'refresh' });
  assert.equal(outcome, 'kept');
  assert.equal(config.plan, 'max_20x');
  assert.equal(config.selfReported, true);
});

test('reconcile force — historical refresh contract: plan=unknown still overwrites an unprotected record', () => {
  // This is what routes /beezi:login to its tier question (Step 3c matches `plan=unknown`).
  const h = harness({
    existing: {
      version: 2,
      source: 'subscription',
      plan: 'max',
      subscriptionType: 'max',
      capturedAt: iso(DAY_MS),
      anchorCheckedAt: iso(DAY_MS),
      accountAnchor: { value: 'b@corp.co', source: 'email', updatedAt: iso(DAY_MS) },
    },
    sub: { ...CLI_SUB, subscriptionType: 'mystery_tier' },
  });
  const { config, outcome } = reconcileBillingConfig(h.deps, { force: true, via: 'refresh' });
  assert.equal(outcome, 'captured');
  assert.equal(config.plan, 'unknown');
});

test('reconcile force — account switch reports switched and drops the testimony', () => {
  const h = harness({
    existing: {
      version: 2,
      source: 'subscription',
      plan: 'pro',
      subscriptionType: 'pro',
      selfReported: true,
      capturedAt: iso(DAY_MS),
      anchorCheckedAt: iso(DAY_MS),
      accountAnchor: { value: 'a@corp.co', source: 'email', updatedAt: iso(DAY_MS) },
    },
    sub: CLI_SUB, // b@corp.co
  });
  const { config, outcome } = reconcileBillingConfig(h.deps, { force: true, via: 'login' });
  assert.equal(outcome, 'switched');
  assert.equal(config.plan, 'max');
  assert.equal(config.selfReported, undefined);
  assert.equal(config.accountAnchor.value, 'b@corp.co');
});

// ─── the CLAUDE_CODE_OAUTH_TOKEN identity axis ───────────────────────────────

const OAUTH_ANCHOR = Object.freeze({ value: 'sk-ant-oat01...yyyy:53', source: 'oauth_key' });

test('reconcile — an oauth_key anchor is stored verbatim (safeField never sees it)', () => {
  // safeField refuses anything matching /sk-ant/; the anchor value must not be routed through it.
  const h = harness({
    existing: { version: 3, source: 'unknown', capturedAt: iso(30 * DAY_MS) },
    sub: { ...CLI_SUB, anchor: OAUTH_ANCHOR },
  });
  const { config, outcome } = reconcileBillingConfig(h.deps);
  assert.equal(outcome, 'captured');
  assert.equal(config.accountAnchor.value, 'sk-ant-oat01...yyyy:53');
  assert.equal(config.accountAnchor.source, 'oauth_key');
});

test('reconcile — rotating to a different setup token is an account switch', () => {
  const h = harness({
    existing: {
      version: 3,
      source: 'subscription',
      plan: 'pro',
      subscriptionType: 'pro',
      selfReported: true,
      capturedAt: iso(DAY_MS),
      anchorCheckedAt: iso(DAY_MS),
      // The rotation is only visible AFTER the spawn (no file anchor on a token machine), so the
      // weekly heartbeat is what brings the reconcile here at all.
      accountAnchor: { value: 'sk-ant-oat01...aaaa:53', source: 'oauth_key', updatedAt: iso(DAY_MS) },
    },
    sub: { ...CLI_SUB, anchor: OAUTH_ANCHOR },
  });
  const { config, outcome } = reconcileBillingConfig(h.deps, { force: true, via: 'login' });
  assert.equal(outcome, 'switched');
  assert.equal(config.accountAnchor.value, 'sk-ant-oat01...yyyy:53');
  assert.equal(config.selfReported, undefined, "the previous account's testimony is dropped");
});

test('reconcile — an email→oauth_key source flip is inconclusive, not a switch (kept, adopted)', () => {
  // Cross-source anchors never prove a mismatch. The stored uuid/email survive on disk; the
  // payload boundary is what stops them from being sent while the token is exported.
  const h = harness({
    existing: {
      version: 3,
      source: 'subscription',
      plan: 'max_20x',
      subscriptionType: 'max',
      capturedAt: iso(DAY_MS),
      anchorCheckedAt: iso(30 * DAY_MS),
      accountAnchor: { value: 'a@corp.co', source: 'email', updatedAt: iso(30 * DAY_MS) },
      accountUuid: 'acc-uuid-1',
      accountEmail: 'a@corp.co',
    },
    sub: { ...CLI_SUB, plan: null, subscriptionType: null, anchor: OAUTH_ANCHOR },
  });
  const { config, outcome } = reconcileBillingConfig(h.deps);
  assert.equal(outcome, 'kept');
  assert.equal(config.plan, 'max_20x');
  assert.equal(config.accountAnchor.source, 'oauth_key');
  assert.equal(config.accountUuid, 'acc-uuid-1');
  assert.equal(config.accountEmail, 'a@corp.co');
});

test('reconcile — automatic mode still refuses the plan=unknown overwrite force allows', () => {
  const h = harness({
    existing: {
      version: 2,
      source: 'subscription',
      plan: 'max',
      subscriptionType: 'max',
      capturedAt: iso(DAY_MS),
      anchorCheckedAt: iso(8 * DAY_MS), // heartbeat trigger
      accountAnchor: { value: 'b@corp.co', source: 'email', updatedAt: iso(8 * DAY_MS) },
    },
    sub: { ...CLI_SUB, subscriptionType: 'mystery_tier' },
  });
  const { config } = reconcileBillingConfig(h.deps);
  assert.equal(config.plan, 'max', 'a session-start pass must not degrade a good record');
});

// ─── accountUuid capture (both identity fields must reach the check-in) ──────

test('buildConfig — stamps accountUuid from the resolved account fields', () => {
  const cfg = buildConfig(
    { subscriptionType: 'max', rateLimitTier: null, expiresAt: null, via: 'refresh' },
    {},
    T0,
    { ...CLI_SUB, accountUuid: 'uuid-from-file' },
    CLI_SUB.anchor, // the email anchor still wins the anchor slot
  );
  assert.equal(cfg.accountUuid, 'uuid-from-file');
  assert.equal(cfg.accountAnchor.source, 'email');
});

test('buildConfig — an account_uuid anchor fills accountUuid when the account fields carry none', () => {
  const cfg = buildConfig(
    { plan: 'max_5x', via: 'login' },
    {},
    T0,
    null,
    { value: 'uuid-from-anchor', source: 'account_uuid' },
  );
  assert.equal(cfg.accountUuid, 'uuid-from-anchor');
});

test('buildConfig — stamps accountEmail from the resolved account fields', () => {
  const cfg = buildConfig(
    { subscriptionType: 'max', rateLimitTier: null, expiresAt: null, via: 'refresh' },
    {},
    T0,
    { ...CLI_SUB, email: 'cli@corp.co' },
    { value: 'uuid-from-anchor', source: 'account_uuid' }, // a uuid anchor: only the account fields know the email
  );
  assert.equal(cfg.accountEmail, 'cli@corp.co');
  assert.equal(cfg.accountUuid, 'uuid-from-anchor');
});

test('buildConfig — an email anchor fills accountEmail when the account fields carry none', () => {
  const cfg = buildConfig(
    { plan: 'max_5x', via: 'login' },
    {},
    T0,
    null,
    { value: 'b@corp.co', source: 'email' },
  );
  assert.equal(cfg.accountEmail, 'b@corp.co');
});

test('buildConfig — an over-64-char email is copied raw, never through the token guard', () => {
  // safeField refuses anything over 64 chars, and emails run to 254 — routing the email through
  // it would throw the whole capture away.
  const longEmail = `${'a'.repeat(80)}@example.com`;
  const cfg = buildConfig({ plan: 'pro', via: 'login' }, {}, T0, { ...CLI_SUB, email: longEmail }, null);
  assert.equal(cfg.accountEmail, longEmail);
});

test('reconcile — kept path adopts a newly visible accountUuid (identity-only write)', () => {
  const h = harness({
    existing: {
      version: 2,
      source: 'subscription',
      plan: 'max_20x',
      subscriptionType: 'max',
      selfReported: true,
      capturedAt: iso(DAY_MS),
      anchorCheckedAt: iso(DAY_MS),
      accountAnchor: { value: 'b@corp.co', source: 'email', updatedAt: iso(DAY_MS) },
    },
    sub: { ...CLI_SUB, subscriptionType: 'mystery_tier', accountUuid: 'uuid-late' },
  });
  const { config, outcome } = reconcileBillingConfig(h.deps, { force: true, via: 'refresh' });
  assert.equal(outcome, 'kept');
  assert.equal(config.accountUuid, 'uuid-late');
  assert.equal(config.plan, 'max_20x', 'plan fields untouched');
});

test('reconcile — kept path adopts a newly visible accountEmail (identity-only write)', () => {
  const h = harness({
    existing: {
      version: 2,
      source: 'subscription',
      plan: 'max_20x',
      subscriptionType: 'max',
      selfReported: true,
      capturedAt: iso(DAY_MS),
      anchorCheckedAt: iso(DAY_MS),
      // A user_id anchor cannot donate the email — only the account fields can here.
      accountAnchor: { value: 'uid-A', source: 'user_id', updatedAt: iso(DAY_MS) },
    },
    sub: {
      ...CLI_SUB,
      subscriptionType: 'mystery_tier',
      email: 'b@corp.co',
      anchor: { value: 'uid-A', source: 'user_id' },
    },
  });
  const { config, outcome } = reconcileBillingConfig(h.deps, { force: true, via: 'refresh' });
  assert.equal(outcome, 'kept');
  assert.equal(config.accountEmail, 'b@corp.co');
  assert.equal(config.plan, 'max_20x', 'plan fields untouched');
});

test('reconcile — buildConfig stamps detectedVia and the anchor on a CLI capture', () => {
  const cfg = buildConfig(
    { subscriptionType: 'max', rateLimitTier: null, expiresAt: null, via: 'session-start' },
    {},
    T0,
    CLI_SUB,
    CLI_SUB.anchor,
  );
  assert.equal(cfg.version, 4);
  assert.equal(cfg.detectedVia, 'cli_status');
  assert.deepEqual(cfg.accountAnchor, { value: 'b@corp.co', source: 'email', updatedAt: T0.toISOString() });
  assert.equal(cfg.plan, 'max');
  assert.equal(JSON.stringify(cfg).includes('sk-ant'), false);
});

// ─── an unresolvable plan (setup token in force) ─────────────────────────────
//
// `claude auth status` answered `oauth_token`: the credential paying for this machine is the setup
// token, and everything ~/.claude.json says belongs to whichever login last touched the disk. The
// capture must record the ABSENCE as a verdict, and that verdict has to be able to win a write —
// otherwise a machine that once captured `team` keeps reporting it forever.

const UNRESOLVED_SUB = Object.freeze({
  accountUuid: 'acc-uuid-1',
  email: 'previous@corp.co',
  subscriptionType: null,
  rateLimitTier: null,
  expiresAt: null,
  billingType: null,
  seatTier: null,
  organizationType: null,
  planSource: 'unresolved',
  detectedVia: 'oauth_token',
  anchor: { value: 'sk-ant-oat01...yyyy:53', source: 'oauth_key' },
});

test('buildConfig — an unresolved subscription writes NO plan, not a guessed one', () => {
  const cfg = buildConfig(
    { subscriptionType: null, rateLimitTier: null, expiresAt: null, via: 'session-start' },
    {},
    new Date('2026-07-07T00:00:00.000Z'),
    UNRESOLVED_SUB,
    UNRESOLVED_SUB.anchor,
  );
  assert.equal(cfg.source, 'subscription', 'a token still bills a subscription — just not a known plan');
  assert.equal(cfg.subscriptionType, null);
  assert.equal(cfg.rateLimitTier, null);
  // normalizePlan(null, null) is 'unknown', which would read as "captured, could not classify".
  assert.equal(cfg.plan, null, "null says we did not capture, 'unknown' would say we failed to classify");
  assert.equal(cfg.planSource, 'unresolved');
  assert.equal(cfg.detectedVia, 'oauth_token');
});

test('buildConfig — an ordinary CLI capture stamps planSource claude_login', () => {
  const cfg = buildConfig(
    { subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x', via: 'login' },
    {},
    new Date('2026-07-07T00:00:00.000Z'),
    { subscriptionType: 'max', detectedVia: 'merged' },
  );
  assert.equal(cfg.plan, 'max_20x');
  assert.equal(cfg.planSource, 'claude_login');
});

test('reconcile — an unresolved verdict OVERWRITES a stored plan (learnedPlan must not block it)', () => {
  const h = harness({
    existing: {
      version: 3,
      source: 'subscription',
      plan: 'team',
      subscriptionType: 'team',
      planSource: 'claude_login',
      capturedAt: iso(DAY_MS),
      anchorCheckedAt: iso(8 * DAY_MS), // heartbeat trigger, automatic mode (no force)
      accountAnchor: { value: 'sk-ant-oat01...yyyy:53', source: 'oauth_key', updatedAt: iso(8 * DAY_MS) },
    },
    sub: UNRESOLVED_SUB,
  });
  const { config, outcome } = reconcileBillingConfig({ ...h.deps, resolveSource: () => 'subscription' });
  assert.equal(outcome, 'cleared');
  assert.equal(config.plan, null, "the stored 'team' named a different account");
  assert.equal(config.subscriptionType, null);
  assert.equal(config.planSource, 'unresolved');
});

test('reconcile — rotating the setup token does NOT re-stamp the stale plan', () => {
  // The path that made this worse than a no-op: anchorChanged on an oauth_key anchor fires
  // 'switched', which re-derives a fresh capture — previously from the very same stale profile.
  const h = harness({
    existing: {
      version: 3,
      source: 'subscription',
      plan: 'team',
      subscriptionType: 'team',
      planSource: 'claude_login',
      capturedAt: iso(DAY_MS),
      // A token machine writes no file anchor, so the rotation is only visible AFTER the spawn —
      // the weekly heartbeat is what brings the reconcile here at all.
      anchorCheckedAt: iso(8 * DAY_MS),
      accountAnchor: { value: 'sk-ant-oat01...aaaa:53', source: 'oauth_key', updatedAt: iso(8 * DAY_MS) },
    },
    sub: UNRESOLVED_SUB,
  });
  const { config, outcome } = reconcileBillingConfig({ ...h.deps, resolveSource: () => 'subscription' });
  assert.equal(outcome, 'switched');
  assert.equal(config.accountAnchor.value, 'sk-ant-oat01...yyyy:53');
  assert.equal(config.plan, null, 'a rotation must not re-stamp a plan read off the old login');
  assert.equal(config.planSource, 'unresolved');
});

test('reconcile — an unresolved verdict does NOT wipe a self-reported plan', () => {
  // The verdict says the on-disk PROFILE is not evidence for this credential. It says nothing
  // about the user's own testimony, which no automatic capture can ever reconstruct.
  const h = harness({
    existing: {
      version: 3,
      source: 'subscription',
      plan: 'max_20x',
      subscriptionType: 'max',
      selfReported: true,
      planSource: 'self_reported',
      capturedAt: iso(DAY_MS),
      anchorCheckedAt: iso(8 * DAY_MS),
      accountAnchor: { value: 'sk-ant-oat01...yyyy:53', source: 'oauth_key', updatedAt: iso(8 * DAY_MS) },
    },
    sub: UNRESOLVED_SUB,
  });
  const { config, outcome } = reconcileBillingConfig({ ...h.deps, resolveSource: () => 'subscription' });
  assert.equal(outcome, 'kept');
  assert.equal(config.plan, 'max_20x');
  assert.equal(config.planSource, 'self_reported');
});

test('reconcile — an unresolved verdict does NOT wipe a server-resolved key plan', () => {
  // planSource 'key_resolution' is written by plan-writeback.mjs from the Beezi portal's answer
  // for this key's fingerprint. It is the ONLY thing that can price a setup-token machine, and
  // every weekly heartbeat re-runs a capture that will keep saying 'unresolved'.
  const h = harness({
    existing: {
      version: 3,
      source: 'subscription',
      plan: 'max_20x',
      planSource: 'key_resolution',
      planResolvedAt: iso(DAY_MS),
      capturedAt: iso(DAY_MS),
      anchorCheckedAt: iso(8 * DAY_MS),
      accountAnchor: { value: 'sk-ant-oat01...yyyy:53', source: 'oauth_key', updatedAt: iso(8 * DAY_MS) },
    },
    sub: UNRESOLVED_SUB,
  });
  const { config, outcome } = reconcileBillingConfig({ ...h.deps, resolveSource: () => 'subscription' });
  assert.equal(outcome, 'kept');
  assert.equal(config.plan, 'max_20x');
  assert.equal(config.planSource, 'key_resolution');
});

test('reconcile — the setup token itself never reaches anything written to disk', () => {
  const token = `sk-ant-oat01-${'y'.repeat(40)}`;
  const h = harness({
    existing: {
      version: 3,
      source: 'subscription',
      plan: 'team',
      capturedAt: iso(DAY_MS),
      anchorCheckedAt: iso(8 * DAY_MS),
    },
    sub: UNRESOLVED_SUB,
    env: { CLAUDE_CODE_OAUTH_TOKEN: token },
  });
  reconcileBillingConfig({ ...h.deps, resolveSource: () => 'subscription' });
  assert.ok(h.writes.length > 0);
  const written = JSON.stringify(h.writes);
  assert.equal(written.includes(token), false, 'only the fingerprint may ever be persisted');
  assert.equal(written.includes('y'.repeat(20)), false, 'not even the middle of it');
});

// ─── key rotation is visible to the cheap precheck ───────────────────────────
//
// A setup token's anchor lives in the ENVIRONMENT, never in ~/.claude.json, so the file anchor
// does not move when the key rotates. Before the token anchor joined the precheck, a token machine
// compared two things that never differ: nothing triggered, and a plan the server had resolved for
// the PREVIOUS fingerprint kept shipping under the new one.
const OLD_TOKEN = `sk-ant-oat01-${'A'.repeat(91)}WXYZ`;
const NEW_TOKEN = `sk-ant-oat01-${'B'.repeat(91)}UQAA`;
const anchorOf = (token) => ({
  value: `sk-ant-oat01...${token.slice(-4)}:${token.length}`,
  source: 'oauth_key',
  updatedAt: iso(DAY_MS),
});

test('reconcile — a rotated setup token triggers a re-check even when everything else looks fresh', () => {
  const h = harness({
    existing: {
      version: 3,
      source: 'subscription',
      plan: 'pro',
      planSource: 'key_resolution',
      capturedAt: iso(DAY_MS),
      anchorCheckedAt: iso(DAY_MS),
      accountAnchor: anchorOf(OLD_TOKEN),
    },
    env: { CLAUDE_CODE_OAUTH_TOKEN: NEW_TOKEN },
  });
  reconcileBillingConfig(h.deps);
  assert.equal(h.subCalls.count, 1, 'the rotation must trigger the re-check');
});

test('reconcile — the SAME setup token is steady state: no spawn, no write', () => {
  const h = harness({
    existing: {
      version: 3,
      source: 'subscription',
      plan: 'pro',
      planSource: 'key_resolution',
      capturedAt: iso(DAY_MS),
      anchorCheckedAt: iso(DAY_MS),
      accountAnchor: anchorOf(OLD_TOKEN),
    },
    env: { CLAUDE_CODE_OAUTH_TOKEN: OLD_TOKEN },
  });
  reconcileBillingConfig(h.deps);
  assert.equal(h.subCalls.count, 0, 'an unchanged token must not spawn the CLI');
  assert.equal(h.writes.length, 0);
});
