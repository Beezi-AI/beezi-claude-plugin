import { runRefreshWorker, WORKER_BUDGET_MS } from '../lib/refresh-worker.mjs';
import { maybeSpawnDiagnostics } from '../lib/diagnostics-trigger.mjs';

// Detached entry point. Argv carries only what a bystander could already read from the store —
// which generation to refresh and whether to force it. Never a token, never a home path.
function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

const generation = Number(argValue('--generation'));
// Belt and braces over the in-band budget: a spawn that wedges inside a native call never
// returns to JavaScript, and this process must not outlive its own lock hold.
const watchdog = setTimeout(() => process.exit(0), WORKER_BUDGET_MS + 5_000);

runRefreshWorker({
  generation: Number.isFinite(generation) ? generation : null,
  force: process.argv.includes('--force'),
})
  .catch(() => {})
  // Exiting IS the contract. On budget expiry the operation promise is still pending, so the
  // lock release never runs and the hung socket keeps a handle alive; only the process dying
  // lets the next attempt reclaim the lock and read the in-flight marker as interrupted.
  // An authentication state change is a trigger point, and this process is not a hook: the
  // diagnostic it just recorded would otherwise wait for the next one.
  .then(() => { try { maybeSpawnDiagnostics(); } catch { /* never */ } })
  .then(() => process.exit(0));
