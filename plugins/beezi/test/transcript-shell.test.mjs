import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSessionShell, SHELL_SCAN_BYTES } from '../lib/transcript-shell.mjs';

function withTranscript(lines, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-shell-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  try {
    return run(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('1. reads the first stamp, the last stamp and the first cwd', () => {
  const shell = withTranscript(
    [
      { type: 'user', timestamp: '2026-03-01T09:00:00.000Z', cwd: 'C:/work/app' },
      { type: 'assistant', timestamp: '2026-03-01T09:30:00.000Z', cwd: 'C:/work/app' },
      { type: 'assistant', timestamp: '2026-03-01T11:15:00.000Z' },
    ],
    readSessionShell,
  );

  assert.equal(shell.startedAt, '2026-03-01T09:00:00.000Z');
  assert.equal(shell.endedAt, '2026-03-01T11:15:00.000Z');
  assert.equal(shell.cwd, 'C:/work/app');
});

test('2. skips records that carry no stamp when looking for the end', () => {
  const shell = withTranscript(
    [
      { type: 'user', timestamp: '2026-03-01T09:00:00.000Z', cwd: 'C:/work/app' },
      { type: 'assistant', timestamp: '2026-03-01T10:00:00.000Z' },
      // The cost-state block itself: a flat record with no timestamp and no cwd.
      { type: 'cost-state', sessionId: 's1', totalCostUSD: 1.5, modelUsage: {} },
    ],
    readSessionShell,
  );

  assert.equal(shell.endedAt, '2026-03-01T10:00:00.000Z');
});

test('3. collapses the span to its start when nothing else carries a stamp', () => {
  const shell = withTranscript(
    [{ type: 'user', timestamp: '2026-03-01T09:00:00.000Z', cwd: 'C:/work/app' }],
    readSessionShell,
  );

  assert.equal(shell.startedAt, '2026-03-01T09:00:00.000Z');
  assert.equal(shell.endedAt, '2026-03-01T09:00:00.000Z');
});

test('4. never reports an inverted span', () => {
  const shell = withTranscript(
    [
      { type: 'user', timestamp: '2026-03-01T09:00:00.000Z', cwd: 'C:/work/app' },
      { type: 'assistant', timestamp: '2026-02-01T08:00:00.000Z' },
    ],
    readSessionShell,
  );

  assert.equal(shell.endedAt, shell.startedAt);
});

test('5. rejects a stamp that is not a real instant', () => {
  const shell = withTranscript(
    [{ type: 'user', timestamp: 'yesterday', cwd: 'C:/work/app' }],
    readSessionShell,
  );

  assert.equal(shell.startedAt, null);
  assert.equal(shell.endedAt, null);
  assert.equal(shell.cwd, 'C:/work/app');
});

test('6. survives malformed lines on either side', () => {
  const shell = withTranscript(
    [
      '{ not json',
      { type: 'user', timestamp: '2026-03-01T09:00:00.000Z', cwd: 'C:/work/app' },
      '}{',
      { type: 'assistant', timestamp: '2026-03-01T10:00:00.000Z' },
      'truncated',
    ],
    readSessionShell,
  );

  assert.equal(shell.startedAt, '2026-03-01T09:00:00.000Z');
  assert.equal(shell.endedAt, '2026-03-01T10:00:00.000Z');
});

test('7. reads both ends of a file far larger than one window', () => {
  // Records in the middle are never read; the windows only have to reach the two ends.
  const filler = Array.from({ length: 400 }, (_, i) => ({
    type: 'assistant',
    timestamp: '2026-03-01T10:00:00.000Z',
    padding: 'x'.repeat(1000),
    index: i,
  }));
  const shell = withTranscript(
    [
      { type: 'user', timestamp: '2026-03-01T09:00:00.000Z', cwd: 'C:/work/app' },
      ...filler,
      { type: 'assistant', timestamp: '2026-03-01T23:59:00.000Z' },
    ],
    (file) => {
      assert.ok(fs.statSync(file).size > SHELL_SCAN_BYTES * 2, 'fixture must exceed both windows');
      return readSessionShell(file);
    },
  );

  assert.equal(shell.startedAt, '2026-03-01T09:00:00.000Z');
  assert.equal(shell.endedAt, '2026-03-01T23:59:00.000Z');
  assert.equal(shell.cwd, 'C:/work/app');
});

test('8. an unreadable transcript yields nulls rather than throwing', () => {
  const shell = readSessionShell('C:/nope/missing.jsonl');

  assert.deepEqual(shell, { startedAt: null, endedAt: null, cwd: null });
});

test('9. an empty transcript yields nulls', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-shell-'));
  const file = path.join(dir, 'empty.jsonl');
  fs.writeFileSync(file, '');
  try {
    assert.deepEqual(readSessionShell(file), { startedAt: null, endedAt: null, cwd: null });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
