import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { readSyncState, isDue, markAttempt } from './cost-state-sync-state.mjs';
import { spawnDetached } from './background-spawn.mjs';
import { readTrackingState, isTrackingDisabled } from './tracking.mjs';
import { accountsIndexFile, credentialsFile, beeziHome } from './paths.mjs';
import { readJson } from './fs-store.mjs';

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
    const index = (deps.readAccountsImpl == null
      ? () => readJson(accountsIndexFile(), null) : deps.readAccountsImpl)();
    let eligible = false;
    if (index && Array.isArray(index.accounts)) {
      eligible = index.accounts.some((row) => row && row.status === 'linked'
        && /^[0-9a-f]{8}$/.test(row.key) && !isTrackingDisabled(readTracking(row.key)));
    } else {
      // A pre-upgrade install still needs a child to perform the account migration.
      const tracking = readJson(path.join(beeziHome(), 'tracking.json'), null);
      eligible = (existsImpl(credentialsFile()) || tracking != null) && !isTrackingDisabled(tracking);
    }
    if (!eligible) return false;
    const nowMs = now();
    if (!isDue(readState(), nowMs)) return false;
    markAttemptImpl(nowMs);
    return spawnImpl(SCRIPT) === true;
  } catch {
    return false;
  }
}
