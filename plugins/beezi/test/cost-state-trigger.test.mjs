import { test } from 'node:test';
import assert from 'node:assert';
import { maybeSpawnCostStateSync } from '../lib/cost-state-trigger.mjs';

function makeDeps(overrides) {
  const spawned = [];
  const attempts = [];
  return {
    spawned, attempts,
    deps: {
      readState: () => null,
      markAttemptImpl: (ms) => attempts.push(ms),
      spawnImpl: (script) => { spawned.push(script); return true; },
      existsSyncImpl: () => true,
      readTrackingImpl: () => null,
      now: () => 1_000_000,
      ...overrides,
    },
  };
}

test('spawns when due, and stamps the attempt BEFORE spawning', () => {
  const { spawned, attempts, deps } = makeDeps();
  assert.strictEqual(maybeSpawnCostStateSync(deps), true);
  assert.strictEqual(spawned.length, 1);
  assert.ok(spawned[0].endsWith('cost-state-sync.mjs'));
  assert.deepStrictEqual(attempts, [1_000_000]);
});

test('does not spawn inside the hour', () => {
  const { spawned, deps } = makeDeps({
    readState: () => ({ version: 1, attemptedAt: new Date(1_000_000 - 60_000).toISOString() }),
  });
  assert.strictEqual(maybeSpawnCostStateSync(deps), false);
  assert.strictEqual(spawned.length, 0);
});

test('never throws when spawning fails', () => {
  const { deps } = makeDeps({ spawnImpl: () => { throw new Error('EPERM'); } });
  assert.doesNotThrow(() => maybeSpawnCostStateSync(deps));
});

test('never throws when the state file is unreadable', () => {
  const { deps } = makeDeps({ readState: () => { throw new Error('EACCES'); } });
  assert.doesNotThrow(() => maybeSpawnCostStateSync(deps));
});

// Also the post-logout state: logout deletes the credentials AND clears tracking.json, so both
// signals disappear together.
test('does not spawn for a machine that was never linked', () => {
  const { spawned, deps } = makeDeps({ existsSyncImpl: () => false, readTrackingImpl: () => null });
  assert.strictEqual(maybeSpawnCostStateSync(deps), false);
  assert.strictEqual(spawned.length, 0);
});

// The bug this gate shipped with: on Windows (CredMan), macOS (Keychain) and Linux (libsecret)
// the token lives in the OS store and credentials.json is never written, so the file check alone
// read every normally-linked machine as "never linked" and the sync never ran once.
test('spawns for an OS-secret-store machine, which writes no credentials file', () => {
  const { spawned, deps } = makeDeps({
    existsSyncImpl: () => false,
    readTrackingImpl: () => ({ version: 1, linkedAt: '2026-08-31T07:32:02.887Z', trackingMode: 'live' }),
  });
  assert.strictEqual(maybeSpawnCostStateSync(deps), true);
  assert.strictEqual(spawned.length, 1);
});

// Links made before the linkedAt stamp existed have a whoami record without it. recordWhoami only
// writes after a valid whoami, so the record itself is proof a token once worked here.
test('spawns on a tracking record that predates the linkedAt stamp', () => {
  const { spawned, deps } = makeDeps({
    existsSyncImpl: () => false,
    readTrackingImpl: () => ({ version: 1, trackingMode: 'live', backfillCompleted: true }),
  });
  assert.strictEqual(maybeSpawnCostStateSync(deps), true);
  assert.strictEqual(spawned.length, 1);
});

// The credentials file is still a valid signal on its own — the DPAPI/plaintext fallback path
// writes it and never touches the OS store.
test('spawns on a credentials-file-only machine with no tracking record', () => {
  const { spawned, deps } = makeDeps({ existsSyncImpl: () => true, readTrackingImpl: () => null });
  assert.strictEqual(maybeSpawnCostStateSync(deps), true);
  assert.strictEqual(spawned.length, 1);
});

// Tenant gate. The credentials file is present here on purpose: a dark-mode machine on the
// DPAPI/plaintext fallback path would sail through a condition merged with the link check.
test('does not spawn for a tenant whose tracking is disabled', () => {
  const { spawned, deps } = makeDeps({
    existsSyncImpl: () => true,
    readTrackingImpl: () => ({ version: 1, trackingMode: 'disabled' }),
  });
  assert.strictEqual(maybeSpawnCostStateSync(deps), false);
  assert.strictEqual(spawned.length, 0);
});

// backfill_only is NOT disabled: it declines live tracking while still wanting its past sessions,
// and cost state is exactly that. Guards against a later swap to isLiveTrackingAllowed.
test('spawns for a backfill_only tenant', () => {
  const { spawned, deps } = makeDeps({
    existsSyncImpl: () => false,
    readTrackingImpl: () => ({ version: 1, trackingMode: 'backfill_only' }),
  });
  assert.strictEqual(maybeSpawnCostStateSync(deps), true);
  assert.strictEqual(spawned.length, 1);
});

// Fail-open, matching every other gate in tracking.mjs: a record from a server that reports no
// mode at all must not read as an opt-out.
test('spawns when the tracking record carries no mode', () => {
  const { spawned, deps } = makeDeps({
    existsSyncImpl: () => false,
    readTrackingImpl: () => ({ version: 1, trackingMode: null, backfillCompleted: true }),
  });
  assert.strictEqual(maybeSpawnCostStateSync(deps), true);
  assert.strictEqual(spawned.length, 1);
});

test('never throws when the tracking record is unreadable', () => {
  const { deps } = makeDeps({
    existsSyncImpl: () => false,
    readTrackingImpl: () => { throw new Error('EACCES'); },
  });
  assert.doesNotThrow(() => maybeSpawnCostStateSync(deps));
  assert.strictEqual(maybeSpawnCostStateSync(deps), false);
});
