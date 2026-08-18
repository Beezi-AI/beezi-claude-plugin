import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  recordStatuslineUsage,
  readPendingStatuslineUsage,
  clearPendingStatuslineUsage,
} from '../lib/statusline-usage.mjs';

function useTmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-usage-test-'));
  process.env.BEEZI_HOME = dir;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const payload = (fivePct, sevenPct = 10) => ({
  rate_limits: {
    five_hour: { used_percentage: fivePct, resets_at: 1738425600 },
    seven_day: { used_percentage: sevenPct, resets_at: 1738857600 },
  },
});

const at = (iso) => ({ now: () => new Date(iso) });

test('recordStatuslineUsage — first observation always records', (t) => {
  useTmpHome(t);
  const r = recordStatuslineUsage(payload(23.5), at('2026-08-11T10:00:00Z'));
  assert.equal(r.recorded, true);
  const pending = readPendingStatuslineUsage();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].five_hour_pct, 23.5);
  assert.equal(pending[0].fetched_at, '2026-08-11T10:00:00.000Z');
});

test('recordStatuslineUsage — immaterial move inside the floor window is skipped', (t) => {
  useTmpHome(t);
  recordStatuslineUsage(payload(23.5), at('2026-08-11T10:00:00Z'));
  const r = recordStatuslineUsage(payload(24.0), at('2026-08-11T10:05:00Z'));
  assert.equal(r.recorded, false);
  assert.equal(r.reason, 'immaterial');
  assert.equal(readPendingStatuslineUsage().length, 1);
});

test('recordStatuslineUsage — unchanged reading records again once the 15-minute floor passes', (t) => {
  useTmpHome(t);
  recordStatuslineUsage(payload(23.5), at('2026-08-11T10:00:00Z'));
  const r = recordStatuslineUsage(payload(23.5), at('2026-08-11T10:15:00Z'));
  assert.equal(r.recorded, true);
  assert.equal(readPendingStatuslineUsage().length, 2);
});

test('recordStatuslineUsage — a floor row resets the floor window', (t) => {
  useTmpHome(t);
  recordStatuslineUsage(payload(23.5), at('2026-08-11T10:00:00Z'));
  recordStatuslineUsage(payload(23.5), at('2026-08-11T10:15:00Z'));
  const r = recordStatuslineUsage(payload(23.5), at('2026-08-11T10:20:00Z'));
  assert.equal(r.recorded, false);
  assert.equal(readPendingStatuslineUsage().length, 2);
});

test('recordStatuslineUsage — material move records regardless of the floor', (t) => {
  useTmpHome(t);
  recordStatuslineUsage(payload(23.5), at('2026-08-11T10:00:00Z'));
  const r = recordStatuslineUsage(payload(29.0), at('2026-08-11T10:01:00Z'));
  assert.equal(r.recorded, true);
  assert.equal(readPendingStatuslineUsage().length, 2);
});

test('recordStatuslineUsage — draining does not disturb the floor marker', (t) => {
  useTmpHome(t);
  recordStatuslineUsage(payload(23.5), at('2026-08-11T10:00:00Z'));
  clearPendingStatuslineUsage(1);
  assert.equal(readPendingStatuslineUsage().length, 0);
  const r = recordStatuslineUsage(payload(23.5), at('2026-08-11T10:05:00Z'));
  assert.equal(r.recorded, false, 'drain must not reopen the floor window');
});

test('recordStatuslineUsage — no rate limits on stdin records nothing', (t) => {
  useTmpHome(t);
  const r = recordStatuslineUsage({ cwd: '/x' }, at('2026-08-11T10:00:00Z'));
  assert.equal(r.recorded, false);
  assert.equal(r.reason, 'no-rate-limits');
});
