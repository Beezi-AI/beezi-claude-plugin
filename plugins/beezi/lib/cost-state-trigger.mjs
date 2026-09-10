import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { readSyncState, isDue, markAttempt } from './cost-state-sync-state.mjs';
import { spawnDetached } from './background-spawn.mjs';
import { readTrackingState, isTrackingDisabled } from './tracking.mjs';
import { credentialsFile } from './paths.mjs';

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', 'scripts', 'cost-state-sync.mjs',
);

// Called at the very END of the Stop hook, after its own work is done. Everything here is
// synchronous and cheap — one small JSON read and, at most once an hour, one spawn — because the
// hook's whole budget is 10s and it already spends seconds on network I/O.
//
// The attempt is stamped BEFORE the spawn on purpose: a child that dies on startup then costs one
// hour of silence instead of respawning on every single turn for the rest of the day.
//
// Never throws. A failure to schedule a background backfill must not turn into "Stop hook error".
export function maybeSpawnCostStateSync(deps = {}) {
  const readState = deps.readState == null ? readSyncState : deps.readState;
  const markAttemptImpl = deps.markAttemptImpl == null ? markAttempt : deps.markAttemptImpl;
  const spawnImpl = deps.spawnImpl == null ? spawnDetached : deps.spawnImpl;
  const existsImpl = deps.existsSyncImpl == null ? fs.existsSync : deps.existsSyncImpl;
  const readTracking = deps.readTrackingImpl == null ? readTrackingState : deps.readTrackingImpl;
  const now = deps.now == null ? (() => Date.now()) : deps.now;
  try {
    // Cheapest possible "is this machine even linked" hint, before anything else. Without it,
    // every user who never ran /beezi:login gets an hourly process that shells out to
    // PowerShell/DPAPI and writes state into ~/.beezi, only to find no token.
    //
    // It is a HINT, not the answer: the authoritative resolution is the full backend chain
    // (OS store -> credentials.json -> null) that the detached child already runs via
    // getAccessToken(), where there is no hook budget to protect. Reaching for that chain here
    // would cost a PowerShell + Add-Type round trip (~1s) inside a 10s hook that already spends
    // seconds on network I/O.
    //
    // Both signals are plain file reads, and between them they cover every backend. The
    // credentials file only exists on the DPAPI/plaintext fallback path, so keying off it alone
    // read as "not linked" on every machine whose token lives in the OS store — CredMan on
    // Windows, Keychain on macOS, libsecret on Linux, i.e. the DEFAULT on all three. tracking.json
    // is stamped by login (markLinked) and removed by logout (clearTrackingState) whatever backend
    // took the token, so it is the signal that actually tracks the link. Its mere presence counts:
    // recordWhoami only writes after a valid whoami, and links made before the linkedAt stamp
    // existed have a record without it. Same fix session-audit.mjs already applied for this bug.
    const tracking = readTracking();
    if (!existsImpl(credentialsFile()) && tracking == null) return false;
    // Tenant gate, and deliberately a SEPARATE check rather than a clause merged into the one
    // above: a dark-mode machine that also happens to have a credentials file (the DPAPI/plaintext
    // fallback path) would sail straight through a merged condition. runCostStateScan carries no
    // tracking gate of its own, so without this a disabled tenant spawns a child every hour to
    // collect a 403 forever. Fail-open on a null record or a null mode — see isTrackingDisabled.
    if (isTrackingDisabled(tracking)) return false;
    const nowMs = now();
    if (!isDue(readState(), nowMs)) return false;
    markAttemptImpl(nowMs);
    return spawnImpl(SCRIPT) === true;
  } catch {
    return false;
  }
}
