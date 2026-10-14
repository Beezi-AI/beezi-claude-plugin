import { runPendingHistoryPasses } from '../lib/pending-history-run.mjs';
import { exitClean } from '../lib/shutdown.mjs';

// Detached: uploads the history a rule change owes a workspace (lib/pending-history-run.mjs). Spawned by
// rule writes, sync, login and SessionStart; the session-audit lock keeps it to one run at a time.
const WATCHDOG_MS = 30 * 60 * 1000;

let finished = false;
function finish(code) {
  if (finished) return;
  finished = true;
  clearTimeout(watchdog);
  exitClean(code);
}

const watchdog = setTimeout(() => finish(0), WATCHDOG_MS);
process.on('uncaughtException', () => finish(0));
process.on('unhandledRejection', () => finish(0));

const at = process.argv.indexOf('--account');
const key = at === -1 ? null : process.argv[at + 1];
(key == null ? Promise.resolve() : runPendingHistoryPasses(key)).then(() => finish(0), () => finish(0));
