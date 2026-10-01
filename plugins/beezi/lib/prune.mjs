import fs from 'fs';
import path from 'path';
import { queueDir, stateDir, telemetryDir } from './paths.mjs';

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

// Deletes files in state/, telemetry/ and every account's queue/ whose mtime is older than
// maxAgeMs. Best-effort: never throws. `now` injectable for deterministic tests.
export function pruneStale({ accountKeys = [], now = Date.now(), maxAgeMs = FOURTEEN_DAYS_MS } = {}) {
  const dirs = [stateDir(), telemetryDir()];
  // queueDir throws on a malformed key; building the list here keeps one bad row from aborting the sweep.
  for (const key of accountKeys) {
    try { dirs.push(queueDir(key)); } catch { /* skip bad key */ }
  }
  for (const dir of dirs) {
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; } // dir missing → skip
    for (const file of files) {
      const p = path.join(dir, file);
      try {
        const { mtimeMs } = fs.statSync(p);
        if (now - mtimeMs > maxAgeMs) fs.unlinkSync(p);
      } catch { /* skip unreadable/racing file */ }
    }
  }
}
