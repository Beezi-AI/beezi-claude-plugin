import fs from 'fs';
import path from 'path';
import { beeziHome } from './paths.mjs';

// A crashed holder must not lock the feature out forever. Ten minutes is far longer than a full
// scan (bounded tail reads plus a handful of HTTP posts) and far shorter than the hourly gate.
export const LOCK_STALE_MS = 10 * 60 * 1000;

function lockDir(name) {
  // Built inside the call, not at module load: beeziHome() reads BEEZI_HOME at call time.
  return path.join(beeziHome(), name + '.lock');
}

// mkdir is the atomic primitive here — same approach as token.mjs's refresh mutex. Every hook is
// its own process, and N open Claude windows all reach the Stop hook, so without this each one
// spawns a full scan of every transcript on the machine.
//
// rmdirSync, NOT rmSync. fs.rmSync landed in Node 14.14 and the floor is 13.2, where it is
// undefined — the call would throw inside the try, the directory would never be removed, the next
// run would be refused, and the stale-break path would throw too. The feature would lock itself
// out permanently after one run. The lock dir is empty by construction, so rmdirSync suffices.
// (token.mjs:34,44, tracking.mjs:124, login.mjs:147 and logout.mjs:77 all carry this same latent
// bug today; fixing them is out of scope here but worth a follow-up ticket.)
export function acquireLock(name, deps = {}) {
  const mkdirSync = deps.mkdirSync == null ? fs.mkdirSync : deps.mkdirSync;
  const statSync = deps.statSync == null ? fs.statSync : deps.statSync;
  const rmdirSync = deps.rmdirSync == null ? fs.rmdirSync : deps.rmdirSync;
  const now = deps.now == null ? (() => Date.now()) : deps.now;
  const dir = lockDir(name);
  try {
    mkdirSync(dir, { recursive: false });
    return true;
  } catch {
    // Held — unless the holder died. Break it only when clearly stale.
    try {
      if (now() - statSync(dir).mtimeMs > LOCK_STALE_MS) {
        rmdirSync(dir);
        mkdirSync(dir, { recursive: false });
        return true;
      }
    } catch { /* lost the race to another breaker; that process holds it */ }
    return false;
  }
}

// Call this ONLY from a process that actually acquired the lock. A refused caller that released
// anyway would delete the holder's directory and let a third window scan concurrently — the exact
// thing the lock exists to prevent.
export function releaseLock(name, deps = {}) {
  const rmdirSync = deps.rmdirSync == null ? fs.rmdirSync : deps.rmdirSync;
  try {
    rmdirSync(lockDir(name));
  } catch { /* best-effort: a leaked lock self-heals after LOCK_STALE_MS */ }
}
