import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveAbortController } from '../lib/abort-compat.mjs';

test('resolveAbortController — returns the real global when present', () => {
  assert.equal(typeof globalThis.AbortController, 'function');
  assert.strictEqual(resolveAbortController(), globalThis.AbortController);
});

test('resolveAbortController — falls back to the shim without the global', () => {
  const real = globalThis.AbortController;
  globalThis.AbortController = undefined;
  try {
    const Shim = resolveAbortController();
    assert.notStrictEqual(Shim, real);
    assert.equal(typeof Shim, 'function');
  } finally {
    globalThis.AbortController = real;
  }
});

function makeShimController() {
  const real = globalThis.AbortController;
  globalThis.AbortController = undefined;
  try {
    const Shim = resolveAbortController();
    return new Shim();
  } finally {
    globalThis.AbortController = real;
  }
}

test('shim — abort() flips signal.aborted and fires listeners once per abort', () => {
  const controller = makeShimController();
  assert.equal(controller.signal.aborted, false);

  let fired = 0;
  controller.signal.addEventListener('abort', () => {
    fired += 1;
  });

  controller.abort();
  assert.equal(controller.signal.aborted, true);
  assert.equal(fired, 1);

  // Second abort is a no-op, matching the platform behavior.
  controller.abort();
  assert.equal(fired, 1);
});

test('shim — { once: true } listener is removed after firing', () => {
  const controller = makeShimController();
  let fired = 0;
  controller.signal.addEventListener('abort', () => {
    fired += 1;
  }, { once: true });

  controller.abort();
  assert.equal(fired, 1);
  assert.equal(controller.signal._listeners.size, 0);
});

test('shim — removeEventListener detaches by function identity', () => {
  const controller = makeShimController();
  let fired = 0;
  const listener = () => {
    fired += 1;
  };
  controller.signal.addEventListener('abort', listener);
  controller.signal.removeEventListener('abort', listener);

  controller.abort();
  assert.equal(fired, 0);
});

test('shim — non-abort event types are ignored', () => {
  const controller = makeShimController();
  let fired = 0;
  controller.signal.addEventListener('load', () => {
    fired += 1;
  });
  controller.abort();
  assert.equal(fired, 0);
});

test('shim — signal works with fetch-compat sendOnce-style usage', () => {
  const controller = makeShimController();
  const signal = controller.signal;

  // Mirrors fetch-compat.mjs: guard, { once: true } listener, cleanup on settle.
  assert.equal(signal.aborted, false);
  const onAbort = () => {};
  signal.addEventListener('abort', onAbort, { once: true });
  signal.removeEventListener('abort', onAbort);
  controller.abort();
  assert.equal(signal.aborted, true);
});
