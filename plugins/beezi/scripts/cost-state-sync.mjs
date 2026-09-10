import { runCostStateScan } from '../lib/cost-state-scan.mjs';
import { acquireLock, releaseLock } from '../lib/single-instance-lock.mjs';
import { exitClean } from '../lib/shutdown.mjs';

const LOCK_NAME = 'cost-state-sync';

// Hard ceiling on the whole run. This process is detached and nobody is watching it: an orphan
// that hangs sits in the user's environment until they reboot, so every path out of here ends in
// an exit — including the paths nobody planned.
//
// REF'D so an idle event loop cannot end the run early while a slow upload is still in flight.
// A ref'd timer only guarantees a MINIMUM lifetime, though — clearing it in finish() is what
// actually lets the process end, and finish() is the single exit funnel for exactly that reason.
const WATCHDOG_MS = 5 * 60 * 1000;

let finished = false;
// Tracked separately from "did we call acquireLock": a REFUSED child must never release, or it
// deletes the running holder's lock directory and a third window starts scanning alongside it.
let held = false;

// The ONLY way out. Clearing the watchdog belongs here and not in a try/catch tail inside main():
// the lock-refused path returns before any such block would be entered, and a ref'd timer left
// running there would hold this process open for the full five minutes.
function finish(code) {
  if (finished) return;
  finished = true;
  clearTimeout(watchdog);
  if (held) releaseLock(LOCK_NAME);
  exitClean(code);
}

const watchdog = setTimeout(() => finish(0), WATCHDOG_MS);

// Nothing may escape. A throw from any depth, or a rejected promise nobody awaited, still exits —
// and still goes through finish(), so the lock and the timer are handled the same way.
process.on('uncaughtException', () => finish(0));
process.on('unhandledRejection', () => finish(0));

async function main() {
  // Refused means another window's child is already scanning. Not an error — just leave.
  held = acquireLock(LOCK_NAME);
  if (!held) return;
  await runCostStateScan();
}

main().then(() => finish(0), () => finish(0));
