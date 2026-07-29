import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exitClean } from '../lib/shutdown.mjs';

test('drains the dispatcher and sets the exit code without forcing an exit', async () => {
  const order = [];
  const dispatcher = { close: async () => { order.push('close'); }, destroy: async () => { order.push('destroy'); } };
  let exitCode = null;
  await exitClean(3, {
    getDispatcher: () => dispatcher,
    exit: () => order.push('exit'),
    setExitCode: (c) => { order.push('set-code'); exitCode = c; },
    schedule: () => {},
  });
  // process.exit() is what trips the libuv async.c assertion on Windows; the process must be
  // left to end on its own once the pool is drained.
  assert.deepEqual(order, ['close', 'set-code'], 'pool drained, then the code is recorded — no exit call');
  assert.equal(exitCode, 3);
});

test('falls back to destroy() when close() throws', async () => {
  const order = [];
  const dispatcher = {
    close: async () => { throw new Error('close failed'); },
    destroy: async () => { order.push('destroy'); },
  };
  await exitClean(0, {
    getDispatcher: () => dispatcher,
    setExitCode: () => order.push('set-code'),
    schedule: () => {},
  });
  assert.deepEqual(order, ['destroy', 'set-code']);
});

test('sets the exit code when there is no undici dispatcher', async () => {
  let exitCode = null;
  await exitClean(1, {
    getDispatcher: () => undefined,
    setExitCode: (c) => { exitCode = c; },
    schedule: () => {},
  });
  assert.equal(exitCode, 1);
});

test('arms an unref’d last-resort force exit for a loop that never drains', async () => {
  const scheduled = [];
  let exited = null;
  await exitClean(2, {
    getDispatcher: () => undefined,
    exit: (c) => { exited = c; },
    setExitCode: () => {},
    schedule: (fn, ms) => scheduled.push({ fn, ms }),
    forceExitAfterMs: 1234,
  });
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].ms, 1234);
  assert.equal(exited, null, 'the fallback must not fire on its own');
  scheduled[0].fn();
  assert.equal(exited, 2, 'firing the fallback force-exits with the requested code');
});
