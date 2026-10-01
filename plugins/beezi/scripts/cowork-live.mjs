import { runCoworkLiveLoop, eligibleCoworkAccounts, eligibleCoworkAccountKeys, liveStateFile } from '../lib/cowork-live.mjs';
import { acquireCoworkLease } from '../lib/cowork-live-lease.mjs';
import { runCoworkSync } from '../lib/cowork-sync.mjs';
import { readJson, writeJsonSecure } from '../lib/fs-store.mjs';
import { exitClean } from '../lib/shutdown.mjs';

const lease = acquireCoworkLease();
if (!lease) exitClean(0);
let finished = false, heartbeat = null, watchdog = null;
const status = (value) => {
  if (!lease || !lease.owns()) return;
  try { writeJsonSecure(liveStateFile(), { ...readJson(liveStateFile(), {}), ...value, heartbeatAt: Date.now() }); } catch { /* diagnostics only */ }
};
function finish(reason) {
  if (finished) return;
  finished = true; clearInterval(heartbeat); clearTimeout(watchdog);
  status({ state: 'stopped', reason });
  if (lease) lease.release();
  setTimeout(() => process.exit(0), 2000).unref();
  exitClean(0);
}
process.on('SIGTERM', () => finish('terminated'));
process.on('SIGINT', () => finish('interrupted'));
process.on('uncaughtException', () => finish('worker-error'));
process.on('unhandledRejection', () => finish('worker-error'));
if (lease) {
  heartbeat = setInterval(() => { if (!lease.heartbeat()) finish('lease-lost'); }, 5000);
  runCoworkLiveLoop({ status, eligible: () => !finished && eligibleCoworkAccounts(), sync: async () => {
    // Exit the PROCESS on a hung pass. Never start a second pass while an old upload survives.
    watchdog = setTimeout(() => finish('pass-timeout'), 5 * 60 * 1000);
    try { return await runCoworkSync({ isEligible: (key) => !finished && !!eligibleCoworkAccounts(key), expectedAccountKeys: eligibleCoworkAccountKeys }, { live: true }); }
    finally { clearTimeout(watchdog); }
  } }).then((result) => finish(result.reason), () => finish('worker-error'));
}
