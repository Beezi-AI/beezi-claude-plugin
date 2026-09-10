import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnDetached } from './background-spawn.mjs';
import { telemetryDir, telemetrySendStateFile } from './paths.mjs';
import { writeJsonSecure } from './fs-store.mjs';
import { isTelemetryGranted } from './telemetry-consent.mjs';
import { readSendState, MIN_SEND_INTERVAL_MS } from './telemetry-flush.mjs';

const WORKER_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'diagnostics-worker.mjs',
);

function hasPending() {
  try { return fs.readdirSync(telemetryDir()).some((file) => file.endsWith('.json')); }
  catch { return false; }
}

// The gate every trigger point shares: consent, something to send, and the backoff window. All
// three are cheap file reads, so a hook that has nothing to deliver pays a stat and returns.
//
// The window is CLAIMED here rather than inside the worker: hook startup and completion fire
// within milliseconds of each other, and without the claim every hook in a turn would spawn its
// own worker. A lost race costs one duplicate delivery, which the route dedups on eventId.
export function maybeSpawnDiagnostics(deps = {}) {
  try {
    if (!isTelemetryGranted()) return false;
    if (!hasPending()) return false;
    const now = (deps.now == null ? () => Date.now() : deps.now)();
    const state = readSendState();
    if (now < state.nextAttemptAt) return false;
    writeJsonSecure(telemetrySendStateFile(), {
      version: 1, attempts: state.attempts, nextAttemptAt: now + MIN_SEND_INTERVAL_MS,
    });
    return spawnDetached(WORKER_SCRIPT, deps);
  } catch {
    return false; // a machine that cannot spawn must cost the hook nothing at all
  }
}
