import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSnapshotPayload, maybePostUsageSnapshot, drainStatuslineSnapshots } from '../lib/usage-snapshot-report.mjs';

const UTILIZATION = {
  fetchedAtMs: 1785953089424,
  accountUuid: 'acc-1',
  fiveHourPct: 1,
  fiveHourResetsAt: '2026-08-05T22:19:59.360Z',
  sevenDayPct: 20,
  sevenDayResetsAt: '2026-08-10T12:00:00.360Z',
  limits: [{ kind: 'session', percent: 1 }],
  raw: { five_hour: { utilization: 1 } },
};

const ACCOUNT = {
  accountUuid: 'acc-1',
  subscriptionType: 'max',
  rateLimitTier: 'default_claude_max_5x',
};

// Each test gets its own BEEZI_HOME so marker state can't leak between tests.
async function withTempHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-usage-'));
  const prev = process.env.BEEZI_HOME;
  process.env.BEEZI_HOME = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.BEEZI_HOME; else process.env.BEEZI_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const okFetch = (calls = []) => async (url, opts) => {
  calls.push({ url, body: JSON.parse(opts.body) });
  return { status: 200, json: async () => ({}) };
};

test('buildSnapshotPayload — plan enrichment when cache account matches login', () => {
  const p = buildSnapshotPayload(UTILIZATION, ACCOUNT);
  assert.equal(p.fetched_at, new Date(1785953089424).toISOString());
  assert.equal(p.account_uuid, 'acc-1');
  assert.equal(p.subscription_type, 'max');
  assert.equal(p.subscription_plan, 'max_5x');
  assert.equal(p.five_hour_pct, 1);
  assert.equal(p.seven_day_resets_at, '2026-08-10T12:00:00.360Z');
  assert.equal(p.limits.length, 1);
  assert.equal(p.limits[0].kind, 'session');
  assert.equal(p.limits[0].percent, 1);
});

test('buildSnapshotPayload — NO plan fields when accounts mismatch (stale cache)', () => {
  const p = buildSnapshotPayload(UTILIZATION, { ...ACCOUNT, accountUuid: 'acc-OTHER' });
  assert.equal(p.account_uuid, 'acc-1'); // truth: whose numbers these are
  assert.equal(p.subscription_type, null);
  assert.equal(p.rate_limit_tier, null);
  assert.equal(p.subscription_plan, null);
});

test('buildSnapshotPayload — limit entries are sanitized to the known wire keys', () => {
  const withUnknown = {
    ...UTILIZATION,
    limits: [{ kind: 'session', percent: 1, some_new_upstream_key: true }],
  };
  const p = buildSnapshotPayload(withUnknown, ACCOUNT);
  // The API's ValidationPipe whitelists nested DTOs; an unknown key would 400 the snapshot.
  assert.equal('some_new_upstream_key' in p.limits[0], false);
});

test('maybePostUsageSnapshot — posts once, then dedupes on (account, fetchedAt)', async () => {
  await withTempHome(async () => {
    const calls = [];
    const deps = {
      fetchImpl: okFetch(calls),
      readUsageUtilization: () => UTILIZATION,
      readClaudeAccount: () => ACCOUNT,
    };
    const first = await maybePostUsageSnapshot('tok', deps);
    assert.equal(first.reported, true);
    const second = await maybePostUsageSnapshot('tok', deps);
    assert.equal(second.reported, false);
    assert.equal(second.reason, 'already-sent');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith('/me/claude-code/usage'));
  });
});

test('maybePostUsageSnapshot — a NEW account posts even with an older fetchedAtMs', async () => {
  await withTempHome(async () => {
    const calls = [];
    const base = { fetchImpl: okFetch(calls), readClaudeAccount: () => ACCOUNT };
    await maybePostUsageSnapshot('tok', { ...base, readUsageUtilization: () => UTILIZATION });
    const older = { ...UTILIZATION, accountUuid: 'acc-2', fetchedAtMs: 1000 };
    const res = await maybePostUsageSnapshot('tok', { ...base, readUsageUtilization: () => older });
    assert.equal(res.reported, true);
    assert.equal(calls.length, 2);
  });
});

test('maybePostUsageSnapshot — failed POST leaves the marker, next call retries', async () => {
  await withTempHome(async () => {
    let status = 500;
    const calls = [];
    const deps = {
      fetchImpl: async (url) => { calls.push(url); return { status, json: async () => ({}) }; },
      readUsageUtilization: () => UTILIZATION,
      readClaudeAccount: () => ACCOUNT,
    };
    assert.equal((await maybePostUsageSnapshot('tok', deps)).reported, false);
    status = 200;
    assert.equal((await maybePostUsageSnapshot('tok', deps)).reported, true);
    assert.equal(calls.length, 2);
  });
});

test('maybePostUsageSnapshot — no token / no utilization → skipped, nothing fetched', async () => {
  await withTempHome(async () => {
    const calls = [];
    assert.equal((await maybePostUsageSnapshot(null, { fetchImpl: okFetch(calls) })).reported, false);
    const res = await maybePostUsageSnapshot('tok', {
      fetchImpl: okFetch(calls),
      readUsageUtilization: () => null,
    });
    assert.equal(res.reported, false);
    assert.equal(res.reason, 'no-utilization');
    assert.equal(calls.length, 0);
  });
});

// ─── drainStatuslineSnapshots — plan fields on surfaces without oauthAccount ──

const PENDING_ROW = {
  fetched_at: '2026-08-21T09:00:00.000Z',
  five_hour_pct: 10,
  five_hour_resets_at: '2026-08-21T12:00:00.000Z',
  seven_day_pct: 30,
  seven_day_resets_at: '2026-08-25T00:00:00.000Z',
};

test('drain — a fresh CLI-observed billing.json supplies the plan when oauthAccount is unreadable', async () => {
  const calls = [];
  let cleared = 0;
  const res = await drainStatuslineSnapshots('tok', {
    fetchImpl: okFetch(calls),
    readPendingStatuslineUsage: () => [PENDING_ROW],
    clearPendingStatuslineUsage: (n) => { cleared = n; },
    readClaudeAccount: () => null,
    readBillingConfig: () => ({
      version: 2,
      source: 'subscription',
      subscriptionType: 'max',
      rateLimitTier: null,
      plan: 'max',
      capturedAt: new Date().toISOString(),
      detectedVia: 'cli_status',
    }),
  });
  assert.equal(res.posted, 1);
  assert.equal(cleared, 1);
  assert.equal(calls[0].body.subscription_type, 'max');
  assert.equal(calls[0].body.subscription_plan, 'max');
  assert.equal(calls[0].body.account_uuid, null, 'no identity fallback — null stays honest');
});

// billing.json is the plan, whatever wrote it. A self-reported plan is the only answer on a machine
// exposing no observable signal at all, and the session-report path has always shipped one
// (subscriptionReportFields has no selfReported gate) — this brings the drain in line rather than
// widening what reaches the server.
test('drain — a self-reported billing.json donates its plan too', async () => {
  const calls = [];
  const res = await drainStatuslineSnapshots('tok', {
    fetchImpl: okFetch(calls),
    readPendingStatuslineUsage: () => [PENDING_ROW],
    clearPendingStatuslineUsage: () => {},
    readClaudeAccount: () => null,
    readBillingConfig: () => ({
      version: 2,
      source: 'subscription',
      subscriptionType: 'max',
      plan: 'max_20x',
      selfReported: true,
      capturedAt: new Date().toISOString(),
    }),
  });
  assert.equal(res.posted, 1);
  assert.equal(calls[0].body.subscription_plan, 'max_20x');
  assert.equal(calls[0].body.subscription_type, 'max');
});

// The bug this precedence exists to fix: a plan the Beezi server resolved for this machine's setup
// key, on a box whose ~/.claude.json still carries a readable oauthAccount from a previous
// interactive login. The old order took the file's coarse tier and threw the key's answer away.
test('drain — a key-resolved plan is not displaced by a stale oauthAccount', async () => {
  const calls = [];
  await drainStatuslineSnapshots('tok', {
    fetchImpl: okFetch(calls),
    env: {},
    readPendingStatuslineUsage: () => [PENDING_ROW],
    clearPendingStatuslineUsage: () => {},
    readClaudeAccount: () => ({ ...ACCOUNT, subscriptionType: 'pro', rateLimitTier: null }),
    readBillingConfig: () => ({
      version: 4,
      source: 'subscription',
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
      plan: 'max_20x',
      planSource: 'key_resolution',
      capturedAt: new Date().toISOString(),
    }),
  });
  assert.equal(calls[0].body.subscription_plan, 'max_20x');
  assert.equal(calls[0].body.rate_limit_tier, 'default_claude_max_20x');
});

// The null rule, on the plan fields. A record that captured no plan says so; reaching past it to
// ~/.claude.json is what the whole precedence exists to stop.
test('drain — a billing.json with no plan does not fall back to oauthAccount', async () => {
  const calls = [];
  await drainStatuslineSnapshots('tok', {
    fetchImpl: okFetch(calls),
    env: {},
    readPendingStatuslineUsage: () => [PENDING_ROW],
    clearPendingStatuslineUsage: () => {},
    readClaudeAccount: () => ACCOUNT,
    readBillingConfig: () => ({ version: 4, source: 'subscription', plan: null, capturedAt: new Date().toISOString() }),
  });
  assert.equal(calls[0].body.subscription_plan, null);
  assert.equal(calls[0].body.subscription_type, null);
});

// ─── identity stamp on the wire (shared with the session report) ──────────────

// 56 characters, so keyFingerprint's 20-char floor is cleared.
const TOKEN = `sk-ant-oat01-${'x'.repeat(39)}ab12`;
const KEY_ENV = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN };

const BILLING_WITH_EMAIL = {
  version: 4,
  source: 'subscription',
  accountEmail: 'dev@example.com',
  capturedAt: new Date().toISOString(),
};

test('drain — carries the email so the server can reach an account', async () => {
  const calls = [];
  await drainStatuslineSnapshots('tok', {
    fetchImpl: okFetch(calls),
    env: {},
    readPendingStatuslineUsage: () => [PENDING_ROW],
    clearPendingStatuslineUsage: () => {},
    readClaudeAccount: () => null,
    readBillingConfig: () => BILLING_WITH_EMAIL,
  });
  assert.equal(calls[0].body.account_email, 'dev@example.com');
  assert.equal(calls[0].body.oauth_key_prefix, undefined);
});

// The CI case this whole link exists for: no oauthAccount, no email, only a key. Before the
// fingerprint rode along, these rows reached the server with no identity at all.
test('drain — a setup-token machine reports its fingerprint', async () => {
  const calls = [];
  await drainStatuslineSnapshots('tok', {
    fetchImpl: okFetch(calls),
    env: KEY_ENV,
    readPendingStatuslineUsage: () => [PENDING_ROW],
    clearPendingStatuslineUsage: () => {},
    readClaudeAccount: () => null,
    readBillingConfig: () => null,
  });
  assert.equal(calls[0].body.oauth_key_prefix, 'sk-ant-oat01');
  assert.equal(calls[0].body.oauth_key_last4, 'ab12');
  assert.equal(calls[0].body.oauth_key_length, TOKEN.length);
});

// The deliberate account_uuid change, and the only one. This payload's uuid is a claim about who
// is logged in NOW, and under setup-token auth ~/.claude.json names whoever logged in last — while
// the server matches a uuid BEFORE a fingerprint. Left on the wire it would win the resolution and
// attribute this machine's limits to someone else's account.
test('drain — a live fingerprint suppresses the stale login identity', async () => {
  const calls = [];
  await drainStatuslineSnapshots('tok', {
    fetchImpl: okFetch(calls),
    env: KEY_ENV,
    readPendingStatuslineUsage: () => [PENDING_ROW],
    clearPendingStatuslineUsage: () => {},
    readClaudeAccount: () => ({ ...ACCOUNT, email: 'stale@example.com' }),
    readBillingConfig: () => ({ ...BILLING_WITH_EMAIL, subscriptionType: 'max', plan: 'max_20x' }),
  });
  assert.equal(calls[0].body.account_uuid, null, 'the stale uuid must not reach the wire');
  assert.equal(calls[0].body.account_email, undefined);
  assert.equal(calls[0].body.oauth_key_prefix, 'sk-ant-oat01');
  // Suppressing identity must not cost the plan: the key's plan still rides, and the server
  // reaches the account through the credential row instead.
  assert.equal(calls[0].body.subscription_plan, 'max_20x');
});

// Everything outside that one case is byte-identical to before.
test('drain — account_uuid is unchanged when no fingerprintable token is in force', async () => {
  const calls = [];
  await drainStatuslineSnapshots('tok', {
    fetchImpl: okFetch(calls),
    env: {},
    readPendingStatuslineUsage: () => [PENDING_ROW],
    clearPendingStatuslineUsage: () => {},
    readClaudeAccount: () => ACCOUNT,
    readBillingConfig: () => null,
  });
  assert.equal(calls[0].body.account_uuid, 'acc-1');
});

// The cache path's account_uuid names whose numbers these are, not who this machine is, and it is
// half the server's dedupe key — so billing.json never displaces it. A setup token is the one
// exception: that uuid is read out of the same ~/.claude.json that names whoever logged in
// interactively last, and the server matches a uuid BEFORE a fingerprint, so on the wire it would
// win the resolution and attribute this machine's limits to someone else.
test('cache path — a setup token suppresses the cache\'s stale uuid', async () => {
  await withTempHome(async () => {
    const calls = [];
    await maybePostUsageSnapshot('tok', {
      fetchImpl: okFetch(calls),
      env: KEY_ENV,
      readUsageUtilization: () => UTILIZATION,
      readClaudeAccount: () => ACCOUNT,
      readBillingConfig: () => BILLING_WITH_EMAIL,
    });
    assert.equal(calls[0].body.account_uuid, null);
    assert.equal(calls[0].body.oauth_key_prefix, 'sk-ant-oat01');
    assert.equal(calls[0].body.account_email, undefined);
  });
});

// With no key in force the cache keeps the column, and the plan comes from billing.json beside it.
test('cache path — the cache keeps the uuid while billing.json supplies the plan', async () => {
  await withTempHome(async () => {
    const calls = [];
    await maybePostUsageSnapshot('tok', {
      fetchImpl: okFetch(calls),
      env: {},
      readUsageUtilization: () => UTILIZATION,
      readClaudeAccount: () => ACCOUNT,
      readBillingConfig: () => ({ ...BILLING_WITH_EMAIL, accountUuid: 'acc-1', subscriptionType: 'max', plan: 'max_20x' }),
    });
    assert.equal(calls[0].body.account_uuid, 'acc-1');
    assert.equal(calls[0].body.subscription_plan, 'max_20x');
  });
});

// The guard that survives the change: the cache and the plan record demonstrably name different
// accounts, so the limits must not be stamped with that plan.
test('cache path — a positive uuid mismatch still drops the plan', async () => {
  await withTempHome(async () => {
    const calls = [];
    await maybePostUsageSnapshot('tok', {
      fetchImpl: okFetch(calls),
      env: {},
      readUsageUtilization: () => UTILIZATION,
      readClaudeAccount: () => ACCOUNT,
      readBillingConfig: () => ({ ...BILLING_WITH_EMAIL, accountUuid: 'acc-OTHER', subscriptionType: 'max', plan: 'max_20x' }),
    });
    assert.equal(calls[0].body.account_uuid, 'acc-1', 'truth: whose numbers these are');
    assert.equal(calls[0].body.subscription_plan, null);
    assert.equal(calls[0].body.subscription_type, null);
  });
});

// A null on either side is "not stated", never "different" — the rule billing-capture.mjs follows.
// Treating an uncomparable pair as a mismatch would drop the plan on every machine whose login
// surface never writes a uuid, which is the population billing.json exists to serve.
test('cache path — an uncomparable pair is not a mismatch', async () => {
  await withTempHome(async () => {
    const calls = [];
    await maybePostUsageSnapshot('tok', {
      fetchImpl: okFetch(calls),
      env: {},
      readUsageUtilization: () => UTILIZATION,
      readClaudeAccount: () => null,
      readBillingConfig: () => ({ ...BILLING_WITH_EMAIL, accountUuid: null, subscriptionType: 'max', plan: 'max_20x' }),
    });
    assert.equal(calls[0].body.subscription_plan, 'max_20x');
  });
});

test('cache path — carries the email when no token is in force', async () => {
  await withTempHome(async () => {
    const calls = [];
    await maybePostUsageSnapshot('tok', {
      fetchImpl: okFetch(calls),
      env: {},
      readUsageUtilization: () => UTILIZATION,
      readClaudeAccount: () => null,
      readBillingConfig: () => BILLING_WITH_EMAIL,
    });
    assert.equal(calls[0].body.account_email, 'dev@example.com');
    assert.equal(calls[0].body.account_uuid, 'acc-1', 'still the cache\'s own');
  });
});

// The two ingest paths resolve an account the same way server-side, so the same machine must not
// describe itself differently to each. This is what the shared builder buys.
test('both paths report the same identity for the same machine', async () => {
  await withTempHome(async () => {
    const drainCalls = [];
    const cacheCalls = [];
    const shared = {
      env: KEY_ENV,
      readClaudeAccount: () => ACCOUNT,
      readBillingConfig: () => BILLING_WITH_EMAIL,
    };
    await drainStatuslineSnapshots('tok', {
      ...shared,
      fetchImpl: okFetch(drainCalls),
      readPendingStatuslineUsage: () => [PENDING_ROW],
      clearPendingStatuslineUsage: () => {},
    });
    await maybePostUsageSnapshot('tok', {
      ...shared,
      fetchImpl: okFetch(cacheCalls),
      readUsageUtilization: () => UTILIZATION,
    });
    const identityOf = (body) => ({
      account_email: body.account_email,
      oauth_key_prefix: body.oauth_key_prefix,
      oauth_key_last4: body.oauth_key_last4,
      oauth_key_length: body.oauth_key_length,
    });
    assert.deepEqual(identityOf(drainCalls[0].body), identityOf(cacheCalls[0].body));
  });
});

test('neither path lets the middle of the token reach the wire', async () => {
  await withTempHome(async () => {
    const calls = [];
    await maybePostUsageSnapshot('tok', {
      fetchImpl: okFetch(calls),
      env: KEY_ENV,
      readUsageUtilization: () => UTILIZATION,
      readClaudeAccount: () => ACCOUNT,
      readBillingConfig: () => null,
    });
    assert.ok(!JSON.stringify(calls[0].body).includes(TOKEN.slice(12, -4)));
  });
});

// account_uuid on the DRAIN is a claim about who this machine is — unlike the cache path, where it
// labels the measurement — so it comes from billing.json like the rest of the identity. It is half
// the server's dedupe key (tenant, user, account_uuid, fetched_at) and the analytics reads group by
// it, so the move is deliberate: billing.json's uuid is a copy of the same vendor uuid on every
// machine that has one, and on the machines where it is not, the honest answer is no uuid at all.
test('drain — billing.json supplies account_uuid alongside the email', async () => {
  const calls = [];
  await drainStatuslineSnapshots('tok', {
    fetchImpl: okFetch(calls),
    env: {},
    readPendingStatuslineUsage: () => [PENDING_ROW],
    clearPendingStatuslineUsage: () => {},
    readClaudeAccount: () => null,
    readBillingConfig: () => ({ ...BILLING_WITH_EMAIL, accountUuid: 'acc-billing' }),
  });
  assert.equal(calls[0].body.account_uuid, 'acc-billing');
  assert.equal(calls[0].body.account_email, 'dev@example.com');
});

// The column stays present as an explicit null rather than being omitted — the server's dedupe key
// wants it on the wire either way.
test('drain — an unstated uuid is an explicit null, not an omission', async () => {
  const calls = [];
  await drainStatuslineSnapshots('tok', {
    fetchImpl: okFetch(calls),
    env: {},
    readPendingStatuslineUsage: () => [PENDING_ROW],
    clearPendingStatuslineUsage: () => {},
    readClaudeAccount: () => ACCOUNT,
    readBillingConfig: () => ({ ...BILLING_WITH_EMAIL, accountUuid: null }),
  });
  assert.equal('account_uuid' in calls[0].body, true);
  assert.equal(calls[0].body.account_uuid, null);
});
