import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TrackingMode,
  readTrackingState,
  writeTrackingState,
  isLiveTrackingAllowed,
  shouldBackfill,
  matchesIdentity,
  recordWhoami,
  markTrackingDisabled,
  markBackfillCompleted,
  clearTrackingState,
  markLinked,
  linkedAtMs,
} from '../lib/tracking.mjs';
import { trackingStateFile } from '../lib/paths.mjs';
import { pruneStale } from '../lib/prune.mjs';

function makeHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracking-test-'));
  process.env.BEEZI_HOME = dir;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The gate is a UX/efficiency optimization — the server's guard is the boundary. Failing closed
// on a missing file would dark-mode every fresh install.
test('1. fail-open: missing file, null mode and a corrupt file all allow tracking', (t) => {
  const home = makeHome(t);

  assert.equal(isLiveTrackingAllowed(), true, 'missing file');

  writeTrackingState({ trackingMode: null });
  assert.equal(isLiveTrackingAllowed(), true, 'null mode (pre-audit server)');

  fs.writeFileSync(trackingStateFile(), '{ torn wri', 'utf-8');
  assert.equal(readTrackingState(), null, 'corrupt file reads as absent');
  assert.equal(isLiveTrackingAllowed(), true, 'corrupt file');
  assert.ok(home);
});

test('2. both audit modes block live tracking; live allows it', (t) => {
  makeHome(t);

  writeTrackingState({ trackingMode: TrackingMode.BACKFILL_ONLY });
  assert.equal(isLiveTrackingAllowed(), false);

  writeTrackingState({ trackingMode: TrackingMode.DISABLED });
  assert.equal(isLiveTrackingAllowed(), false);

  writeTrackingState({ trackingMode: TrackingMode.LIVE });
  assert.equal(isLiveTrackingAllowed(), true);
});

// Mirrors the server's resolveTrackingMode: everything except disabled is offered the pull until
// it completes — paid tenants included. A null mode is a pre-audit server: no pull to offer.
test('3. shouldBackfill truth table', (t) => {
  makeHome(t);

  const cases = [
    [{ trackingMode: TrackingMode.BACKFILL_ONLY, backfillCompleted: false }, true],
    [{ trackingMode: TrackingMode.BACKFILL_ONLY, backfillCompleted: true }, false],
    [{ trackingMode: TrackingMode.LIVE, backfillCompleted: false }, true],
    [{ trackingMode: TrackingMode.LIVE, backfillCompleted: true }, false],
    [{ trackingMode: TrackingMode.DISABLED, backfillCompleted: false }, false],
    [{ trackingMode: null, backfillCompleted: false }, false],
    [null, false],
  ];
  for (const [state, expected] of cases) {
    assert.equal(shouldBackfill(state), expected, JSON.stringify(state));
  }
});

// pruneStale() sweeps state/ and queue/ after 14 days; the tracking cache must survive it or
// dark-mode tenants silently light back up.
test('4. tracking.json lives at the root and survives pruneStale', (t) => {
  const home = makeHome(t);
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  fs.mkdirSync(path.join(home, 'queue'), { recursive: true });

  writeTrackingState({ trackingMode: TrackingMode.DISABLED });
  const fifteenDaysAgo = (Date.now() - 15 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(trackingStateFile(), fifteenDaysAgo, fifteenDaysAgo);

  pruneStale();

  assert.ok(fs.existsSync(trackingStateFile()));
  assert.equal(isLiveTrackingAllowed(), false);
});

// The state is machine-global but the server scope is per (tenant, user, tool): a state written
// under another login must be discarded, never trusted.
test('5. identity mismatch discards the state; missing identities stay permissive', (t) => {
  makeHome(t);

  assert.equal(matchesIdentity({ identity: 'client-a' }, 'client-a'), true);
  assert.equal(matchesIdentity({ identity: 'client-a' }, 'client-b'), false);
  assert.equal(matchesIdentity({ identity: null }, 'client-b'), true);
  assert.equal(matchesIdentity(null, 'client-b'), true);
  assert.equal(matchesIdentity({ identity: 'client-a' }, null), true);
});

test('6. recordWhoami persists the policy fields bound to the identity', (t) => {
  makeHome(t);

  recordWhoami(
    { valid: true, tenantTier: 'audit', trackingMode: TrackingMode.BACKFILL_ONLY, backfillCompleted: false },
    'client-1',
  );

  const state = readTrackingState();
  assert.equal(state.trackingMode, TrackingMode.BACKFILL_ONLY);
  assert.equal(state.tenantTier, 'audit');
  assert.equal(state.backfillCompleted, false);
  assert.equal(state.identity, 'client-1');
  assert.ok(state.fetchedAt);

  // An invalid or absent whoami must never overwrite the recorded state.
  recordWhoami({ valid: false }, 'client-1');
  recordWhoami(null, 'client-1');
  assert.equal(readTrackingState().trackingMode, TrackingMode.BACKFILL_ONLY);
});

test('7. markTrackingDisabled flips the mode and keeps the rest; markBackfillCompleted seals', (t) => {
  makeHome(t);

  recordWhoami(
    { valid: true, tenantTier: 'audit', trackingMode: TrackingMode.BACKFILL_ONLY, backfillCompleted: false },
    'client-1',
  );
  markTrackingDisabled('server said so');

  let state = readTrackingState();
  assert.equal(state.trackingMode, TrackingMode.DISABLED);
  assert.equal(state.tenantTier, 'audit');
  assert.equal(state.reason, 'server said so');

  markBackfillCompleted();
  state = readTrackingState();
  assert.equal(state.backfillCompleted, true);

  clearTrackingState();
  assert.equal(readTrackingState(), null);
});

// The audit's "already tracked live" cutoff reads this stamp. It used to read the credentials
// file's mtime, which the CredMan/Keychain/secret-tool backends never write — so on most machines
// the cutoff was null and every transcript, live-tracked or not, was a backfill candidate.
test('8. markLinked stamps the link instant and survives later whoami refreshes', (t) => {
  makeHome(t);

  assert.equal(linkedAtMs(readTrackingState()), null, 'no stamp before login');

  const before = Date.now();
  markLinked();
  const stamped = linkedAtMs(readTrackingState());
  assert.ok(stamped >= before, 'stamp is the link instant');

  recordWhoami(
    { valid: true, tenantTier: 'pro', trackingMode: TrackingMode.LIVE, backfillCompleted: false },
    'client-1',
  );
  assert.equal(linkedAtMs(readTrackingState()), stamped, 'whoami refresh keeps the stamp');
  assert.equal(readTrackingState().trackingMode, TrackingMode.LIVE, 'verdict still wins');

  markTrackingDisabled('server said so');
  assert.equal(linkedAtMs(readTrackingState()), stamped, 'dark-mode flip keeps the stamp');
});

test('9. linkedAtMs ignores a missing or unparseable stamp', () => {
  assert.equal(linkedAtMs(null), null);
  assert.equal(linkedAtMs({}), null);
  assert.equal(linkedAtMs({ linkedAt: 'not-a-date' }), null);
  assert.equal(
    linkedAtMs({ linkedAt: '2026-08-10T00:00:00.000Z' }),
    Date.parse('2026-08-10T00:00:00.000Z'),
  );
});
