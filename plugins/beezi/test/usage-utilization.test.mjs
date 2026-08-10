import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readUsageUtilization } from '../lib/usage-utilization.mjs';

const CACHE = {
  cachedUsageUtilization: {
    fetchedAtMs: 1785953089424,
    accountUuid: 'acc-123',
    utilization: {
      five_hour: { utilization: 1, resets_at: '2026-08-05T22:19:59.360Z' },
      seven_day: { utilization: 20, resets_at: '2026-08-10T12:00:00.360Z' },
      limits: [{ kind: 'session', group: 'session', percent: 1, severity: 'normal' }],
      extra_usage: { is_enabled: false },
    },
  },
};

const deps = (json) => ({
  exists: () => true,
  readFile: () => JSON.stringify(json),
  env: {},
  homedir: '/home/u',
});

test('readUsageUtilization — promotes the verified cache shape', () => {
  const u = readUsageUtilization(deps(CACHE));
  assert.equal(u.fetchedAtMs, 1785953089424);
  assert.equal(u.accountUuid, 'acc-123');
  assert.equal(u.fiveHourPct, 1);
  assert.equal(u.fiveHourResetsAt, '2026-08-05T22:19:59.360Z');
  assert.equal(u.sevenDayPct, 20);
  assert.equal(u.sevenDayResetsAt, '2026-08-10T12:00:00.360Z');
  assert.equal(u.limits.length, 1);
  assert.equal(u.raw.extra_usage.is_enabled, false);
});

test('readUsageUtilization — null when key absent, file missing, or malformed', () => {
  assert.equal(readUsageUtilization(deps({})), null);
  assert.equal(readUsageUtilization({ ...deps({}), exists: () => false }), null);
  assert.equal(readUsageUtilization({ ...deps({}), readFile: () => 'not json' }), null);
});

test('readUsageUtilization — null without a numeric fetchedAtMs (no dedupe key)', () => {
  const noFetch = { cachedUsageUtilization: { utilization: { five_hour: { utilization: 5 } } } };
  assert.equal(readUsageUtilization(deps(noFetch)), null);
});

test('readUsageUtilization — missing windows and non-array limits degrade to nulls', () => {
  const sparse = { cachedUsageUtilization: { fetchedAtMs: 5, utilization: { limits: 'nope' } } };
  const u = readUsageUtilization(deps(sparse));
  assert.equal(u.fiveHourPct, null);
  assert.equal(u.sevenDayResetsAt, null);
  assert.equal(u.limits, null);
  assert.equal(u.accountUuid, null);
});

test('readUsageUtilization — CLAUDE_CONFIG_DIR wins over homedir', () => {
  const seen = [];
  readUsageUtilization({
    exists: (p) => { seen.push(p); return false; },
    readFile: () => '',
    env: { CLAUDE_CONFIG_DIR: '/custom' },
    homedir: '/home/u',
  });
  assert.ok(seen[0].startsWith('/custom'));
});
