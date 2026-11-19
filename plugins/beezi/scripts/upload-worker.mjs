import { runUploadWorker, writeUploadStatus, workerExitStatus } from '../lib/upload-worker.mjs';
import { exitClean } from '../lib/shutdown.mjs';

// The background uploader, started by scripts/upload-launcher.mjs. Detached and unwatched: every
// path out of here ends in an exit, including the ones nobody planned.
//
// REF'D watchdog, so an idle event loop cannot end the run while an upload is in flight. A ref'd
// timer only guarantees a MINIMUM lifetime; clearing it in finish() is what lets the process end,
// and finish() is the single exit funnel for exactly that reason.
const WATCHDOG_MS = 5 * 60 * 1000;
// runUploadWorker starts no pass that could end after this, so a normal run finishes (and writes
// its own status) well before the watchdog would cut it off.
const RUN_MARGIN_MS = 30000;

let finished = false;
// Set only once runUploadWorker holds the upload lock. A worker that was refused (`busy`) never
// gets one, so it can never release another worker's lock.
let lock = null;

// The ONLY way out. `outcome` is given on the watchdog and crash paths, where runUploadWorker's
// own finally never ran: the status would otherwise stay `running` and the lock held until it
// goes stale. release() is a no-op once the owner file is gone, so a second call is harmless.
function finish(code, outcome) {
  if (finished) return;
  finished = true;
  clearTimeout(watchdog);
  if (outcome != null) {
    // workerExitStatus sets retryAfterAt for `crash` and `watchdog`, so the gate backs off.
    try { writeUploadStatus(workerExitStatus(outcome, Date.now())); } catch { /* best-effort */ }
  }
  if (lock != null) {
    try { lock.release(); } catch { /* best-effort: a leaked lock self-heals after LOCK_STALE_MS */ }
  }
  exitClean(code);
}

const watchdog = setTimeout(() => finish(0, 'watchdog'), WATCHDOG_MS);

// Nothing may escape. A throw from any depth, or a rejected promise nobody awaited, still exits
// through finish(), so the lock and the timer are handled the same way.
process.on('uncaughtException', () => finish(0, 'crash'));
process.on('unhandledRejection', () => finish(0, 'crash'));

runUploadWorker({
  onLock: (l) => { lock = l; },
  deadline: Date.now() + WATCHDOG_MS - RUN_MARGIN_MS,
}).then(() => finish(0), () => finish(0, 'crash'));
