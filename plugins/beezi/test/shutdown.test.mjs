import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exitClean } from '../lib/shutdown.mjs';

test('drains the dispatcher, then exits with the code (close before exit)', async () => {
  const order = [];
  const dispatcher = { close: async () => { order.push('close'); }, destroy: async () => { order.push('destroy'); } };
  let exitCode = null;
  await exitClean(3, { getDispatcher: () => dispatcher, exit: (c) => { order.push('exit'); exitCode = c; } });
  assert.deepEqual(order, ['close', 'exit'], 'undici pool drained before the process exits');
  assert.equal(exitCode, 3);
});

test('the loop-tick flush runs between close and exit (avoids the Windows async.c race)', async () => {
  const order = [];
  // A setImmediate scheduled the moment close() resolves must run BEFORE exit — proving the
  // exitClean flush yields a full loop tick after draining.
  const dispatcher = {
    close: async () => { setImmediate(() => order.push('socket-close-callback')); },
  };
  await exitClean(0, { getDispatcher: () => dispatcher, exit: () => order.push('exit') });
  assert.deepEqual(order, ['socket-close-callback', 'exit']);
});

test('falls back to destroy() when close() throws', async () => {
  const order = [];
  const dispatcher = {
    close: async () => { throw new Error('close failed'); },
    destroy: async () => { order.push('destroy'); },
  };
  await exitClean(0, { getDispatcher: () => dispatcher, exit: () => order.push('exit') });
  assert.deepEqual(order, ['destroy', 'exit']);
});

test('exits cleanly when there is no undici dispatcher', async () => {
  let exitCode = null;
  await exitClean(1, { getDispatcher: () => undefined, exit: (c) => { exitCode = c; } });
  assert.equal(exitCode, 1);
});
