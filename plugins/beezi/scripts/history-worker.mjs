import { runPendingHistoryPasses } from '../lib/pending-history-run.mjs';
import { HISTORY_WATCHDOG_MS } from '../lib/pending-history.mjs';
import { exitClean } from '../lib/shutdown.mjs';

// Detached: uploads the sessions a session-start Upload accepted (lib/pending-history-run.mjs). Spawned by
// that answer, sync, login and SessionStart; the session-audit lock keeps it to one run at a time.

let finished = false;
function finish(code) {
  if (finished) return;
  finished = true;
  clearTimeout(watchdog);
  exitClean(code);
}

const watchdog = setTimeout(() => finish(0), HISTORY_WATCHDOG_MS);
process.on('uncaughtException', () => finish(0));
process.on('unhandledRejection', () => finish(0));

const at = process.argv.indexOf('--account');
const key = at === -1 ? null : process.argv[at + 1];
(key == null ? Promise.resolve() : runPendingHistoryPasses(key)).then(() => finish(0), () => finish(0));
