import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnDetached } from './background-spawn.mjs';
import { beeziHome } from './paths.mjs';
import { LOCK_STALE_MS, lockOwnerGone } from './single-instance-lock.mjs';
import { readUploadStatus, writeUploadStatus, postableQueueFiles, UPLOAD_LOCK } from './upload-worker.mjs';

// The spawn gate every hook runs after it has saved its state. Cheap on purpose: one stat of the
// lock dir, one small JSON read and a scan of the queue dirs, then at most one detached spawn.

export const UPLOAD_LAUNCHER_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'upload-launcher.mjs');

// A spawned worker that has not recorded a finish yet is given this long before the gate tries
// again: long enough for a slow machine to start Node, short enough that a launcher that died
// silently costs one turn's delay at most.
export const ATTEMPT_GAP_MS = 30000;

// → 'disabled' | 'running' | 'stalled' | 'throttled' | 'empty' | 'spawned' | 'failed'. Sync, never
// throws. 'failed' tells the caller no worker is coming, so it may flush inline itself.
export function maybeSpawnUploadWorker(deps = {}) {
  try {
    const env = deps.env == null ? process.env : deps.env;
    const now = deps.now == null ? Date.now : deps.now;
    const statSync = deps.statSync == null ? fs.statSync : deps.statSync;
    const readStatus = deps.readStatus == null ? readUploadStatus : deps.readStatus;
    const writeStatus = deps.writeStatus == null ? writeUploadStatus : deps.writeStatus;
    const postableFiles = deps.postableFiles == null ? postableQueueFiles : deps.postableFiles;

    // 1. Tests that run hooks as child processes set this so no real worker starts.
    if (env.BEEZI_TEST_NO_SPAWN === '1') return 'disabled';

    const t = now();
    // 2. A worker holds the lock and is heartbeating. A lock past LOCK_STALE_MS belongs to a
    // crashed worker, and so does one whose owner file names a dead pid (a killed worker, a
    // SessionStart killed mid inline flush): the next worker breaks either at once, so the gate
    // treats them as absent. The owner file is read only when the lock is fresh.
    try {
      const lockStat = statSync(path.join(beeziHome(), UPLOAD_LOCK + '.lock'));
      if (t - lockStat.mtimeMs < LOCK_STALE_MS && !lockOwnerGone(UPLOAD_LOCK, deps)) return 'running';
    } catch { /* no lock: nobody is sending */ }

    const status = readStatus();
    const retryAfterAt = Number(status.retryAfterAt) || 0;
    const attemptedAt = Number(status.attemptedAt) || 0;
    const lastRunAt = Number(status.lastRunAt) || 0;

    // 3. The last run stalled (offline, 401, nothing sendable), every workspace is dark, or no
    // account is linked: wait out the backoff rather than paying a credential read per turn.
    if (retryAfterAt > t) return 'stalled';

    // 4. A worker was spawned moments ago and has not finished yet; it will see this turn's files.
    if (attemptedAt > 0 && t - attemptedAt < ATTEMPT_GAP_MS && lastRunAt < attemptedAt) return 'throttled';

    // 5. Only files newer than the last run. Leftovers no worker could send (a dark workspace, a
    // revoked account) never start one on their own; the next new enqueue retries them.
    if (postableFiles(lastRunAt).length === 0) return 'empty';

    // 6. Stamp first, so a second hook in the same instant is throttled rather than spawning twice.
    writeStatus({ attemptedAt: t });
    return spawnDetached(UPLOAD_LAUNCHER_SCRIPT, deps) ? 'spawned' : 'failed';
  } catch {
    return 'failed';
  }
}
