import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSnapshotPayload, maybePostUsageSnapshot } from '../lib/usage-snapshot-report.mjs';

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
