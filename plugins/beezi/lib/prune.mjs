import fs from 'fs';
import path from 'path';
import { outboxDir, queueDir, stateDir, telemetryDir } from './paths.mjs';
import { finishOutbox, isSnapshotItem, keepSnapshotClaim } from './outbox.mjs';
import { readJson } from './fs-store.mjs';

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
// No send holds a claim this long (a worker run is capped at 5 min), so a claim older than this
// is a dead worker's even when its pid probes alive: Windows reuses pids.
const CLAIM_MAX_AGE_MS = 24 * ONE_HOUR_MS;
// A claimed outbox item: <item>.json.<pid>.sending (lib/outbox.mjs claimOutbox).
const SENDING_SUFFIX = /\.(\d+)\.sending$/;
// lib/outbox.mjs's usage snapshot item, the one outbox item that merges rather than overwrites.
const SNAPSHOT_FILE = 'snapshot.json';

// Signal 0 only checks the process exists. EPERM means it exists under another user.
function defaultPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error != null && error.code === 'EPERM';
  }
}

// Deletes files in state/, telemetry/ and every account's queue/ and outbox/ whose mtime is older
// than maxAgeMs. In queue and outbox dirs a `.tmp` (a write killed before its rename) goes after
// tmpMaxAgeMs instead. In outbox dirs a `.sending` older than tmpMaxAgeMs (a worker that died
// mid-send) is not deleted: it goes back to its item name unless a newer item took that name
// (finishOutbox's not-delivered rule). A claimed snapshot is the exception: it merges into a newer
// snapshot.json instead of being dropped by it, as the delivery worker does (keepSnapshotClaim).
// A `.sending` whose claiming pid is still running is left alone: that worker is mid-send and will
// finish the item itself. Unless the claim itself is older than claimMaxAgeMs: then it is restored
// by the same rule whatever the probe says, since the pid may have been reused. The claim's age is
// its ctime, which the claim rename sets; its mtime is still the item's write time.
// Best-effort: never throws. `now` and `pidAlive` injectable for tests.
export function pruneStale({ accountKeys = [], now = Date.now(), maxAgeMs = FOURTEEN_DAYS_MS, tmpMaxAgeMs = ONE_HOUR_MS, claimMaxAgeMs = CLAIM_MAX_AGE_MS, pidAlive = defaultPidAlive } = {}) {
  const dirs = [{ dir: stateDir(), queue: false, outbox: false }, { dir: telemetryDir(), queue: false, outbox: false }];
  // queueDir/outboxDir throw on a malformed key; building the list here keeps one bad row from
  // aborting the sweep.
  for (const key of accountKeys) {
    try { dirs.push({ dir: queueDir(key), queue: true, outbox: false }); } catch { /* skip bad key */ }
    try { dirs.push({ dir: outboxDir(key), queue: true, outbox: true, key }); } catch { /* skip bad key */ }
  }
  for (const { dir, queue, outbox, key } of dirs) {
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; } // dir missing → skip
    for (const file of files) {
      const p = path.join(dir, file);
      try {
        const { mtimeMs, ctimeMs } = fs.statSync(p);
        const age = now - mtimeMs;
        const claim = outbox ? SENDING_SUFFIX.exec(file) : null;
        if (claim != null) {
          // ctime is never older than mtime; the max guards a filesystem that reports less.
          const claimAge = now - Math.max(mtimeMs, ctimeMs);
          // Age first: a young claim is kept anyway, so the liveness probe runs only for old ones.
          if (age > tmpMaxAgeMs && (claimAge > claimMaxAgeMs || !pidAlive(Number(claim[1])))) {
            const original = p.replace(SENDING_SUFFIX, '');
            const item = file.replace(SENDING_SUFFIX, '') === SNAPSHOT_FILE ? readJson(p, null) : null;
            if (isSnapshotItem(item)) keepSnapshotClaim(key, p, original, item);
            else finishOutbox(p, original, false);
          }
          continue;
        }
        const limit = queue && file.endsWith('.tmp') ? tmpMaxAgeMs : maxAgeMs;
        if (age > limit) fs.unlinkSync(p);
      } catch { /* skip unreadable/racing file */ }
    }
  }
}
