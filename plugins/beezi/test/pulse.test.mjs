import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claimPulse, maybeRunPulse, PULSE_INTERVAL_MS } from '../lib/pulse.mjs';

function useTmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-test-'));
  process.env.BEEZI_HOME = dir;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const input = { session_id: 'sess-1', transcript_path: '/tmp/t.jsonl', cwd: '/tmp' };

test('claimPulse — first claim wins, an immediate second claim is refused', (t) => {
  useTmpHome(t);
  assert.equal(claimPulse('sess-1'), true);
  assert.equal(claimPulse('sess-1'), false);
});

test('claimPulse — claimable again once the interval has passed', (t) => {
  useTmpHome(t);
  const t0 = Date.now();
  assert.equal(claimPulse('sess-1', { now: () => t0 }), true);
  assert.equal(claimPulse('sess-1', { now: () => t0 + PULSE_INTERVAL_MS - 1000 }), false);
  assert.equal(claimPulse('sess-1', { now: () => t0 + PULSE_INTERVAL_MS + 1000 }), true);
});

test('claimPulse — sessions gate independently', (t) => {
  useTmpHome(t);
  assert.equal(claimPulse('sess-1'), true);
  assert.equal(claimPulse('sess-2'), true);
});

test('maybeRunPulse — runs the full turn-end checkpoint on a fresh claim', async (t) => {
  useTmpHome(t);
  const calls = [];
  const runCheckpoint = async (inp, _deps, options) => {
    calls.push({ inp, options });
    return { enqueued: 0, flush: null };
  };
  const r = await maybeRunPulse(input, { runCheckpoint });
  assert.equal(r.ran, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].inp, input);
  assert.equal(calls[0].options.emitTimeline, true, 'pulse substitutes for a Stop — must ship timeline + snapshots');
});

test('maybeRunPulse — a second firing inside the window does not checkpoint', async (t) => {
  useTmpHome(t);
  let calls = 0;
  const runCheckpoint = async () => { calls += 1; return {}; };
  await maybeRunPulse(input, { runCheckpoint });
  const r = await maybeRunPulse(input, { runCheckpoint });
  assert.equal(r.ran, false);
  assert.equal(calls, 1);
});

test('maybeRunPulse — hook input without a session is ignored', async (t) => {
  useTmpHome(t);
  let calls = 0;
  const runCheckpoint = async () => { calls += 1; return {}; };
  const r = await maybeRunPulse({ tool_name: 'Read' }, { runCheckpoint });
  assert.equal(r.ran, false);
  assert.equal(calls, 0);
});

test('maybeRunPulse — a checkpoint that dies still consumes the interval', async (t) => {
  useTmpHome(t);
  let calls = 0;
  const runCheckpoint = async () => { calls += 1; throw new Error('boom'); };
  await maybeRunPulse(input, { runCheckpoint }).catch(() => {});
  const r = await maybeRunPulse(input, { runCheckpoint }).catch(() => ({ ran: false }));
  assert.equal(r.ran, false, 'failed checkpoint must not retry on every tool call');
  assert.equal(calls, 1);
});
