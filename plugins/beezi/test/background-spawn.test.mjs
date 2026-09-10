import { test } from 'node:test';
import assert from 'node:assert';
import { spawnDetached } from '../lib/background-spawn.mjs';

function fakeChild() {
  let unrefed = false;
  return { unref: () => { unrefed = true; }, wasUnrefed: () => unrefed };
}

test('spawns the script with the current node binary, detached and silent', () => {
  const calls = [];
  const child = fakeChild();
  const ok = spawnDetached('/plugin/scripts/child.mjs', {
    spawnImpl: (cmd, args, options) => { calls.push({ cmd, args, options }); return child; },
  });
  assert.strictEqual(ok, true);
  assert.strictEqual(calls[0].cmd, process.execPath);
  assert.deepStrictEqual(calls[0].args, ['/plugin/scripts/child.mjs']);
  assert.strictEqual(calls[0].options.detached, true);
  // Load-bearing: an inherited pipe keeps a handle open in the PARENT and re-triggers the
  // Windows libuv assertion that lib/shutdown.mjs exists to avoid.
  assert.strictEqual(calls[0].options.stdio, 'ignore');
  assert.strictEqual(child.wasUnrefed(), true);
});

test('returns false and never throws when spawn fails', () => {
  const ok = spawnDetached('/plugin/scripts/child.mjs', {
    spawnImpl: () => { throw new Error('EPERM'); },
  });
  assert.strictEqual(ok, false);
});

test('returns false when spawn yields no child', () => {
  assert.strictEqual(spawnDetached('/x.mjs', { spawnImpl: () => null }), false);
});
