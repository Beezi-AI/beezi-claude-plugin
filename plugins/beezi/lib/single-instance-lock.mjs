import fs from 'fs';
import path from 'path';
import { beeziHome } from './paths.mjs';

// A crashed holder must not lock the feature out forever. Ten minutes is far longer than a full
// scan (bounded tail reads plus a handful of HTTP posts) and far shorter than the hourly gate.
export const LOCK_STALE_MS = 10 * 60 * 1000;

// The per-session checkpoint lock (lib/checkpoint.mjs). A checkpoint holds it for seconds, so two
// minutes without a heartbeat is a dead holder. Stop, StopFailure and SessionEnd wait up to
// CHECKPOINT_LOCK_WAIT_MS for it; PostToolUse never waits — the next sync hook catches its window up.
// Kept here, not in checkpoint.mjs, so lib/stop-failure.mjs can name the wait without loading the
// checkpoint module (it gets runCheckpoint through deps, so a broken checkpoint.mjs cannot stop the
// error report from loading).
export const CHECKPOINT_LOCK_STALE_MS = 2 * 60 * 1000;
export const CHECKPOINT_LOCK_WAIT_MS = 5000;
export const CHECKPOINT_LOCK_PREFIX = 'checkpoint-';

// The session's lock name: a session id is used as a file name, so anything outside [A-Za-z0-9_-] becomes `_`.
export function checkpointLockName(sessionId) {
  return CHECKPOINT_LOCK_PREFIX + String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_');
}

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
  const staleMs = deps.staleMs == null ? LOCK_STALE_MS : deps.staleMs;
  const dir = lockDir(name);
  try {
    mkdirSync(dir, { recursive: false });
    return true;
  } catch {
    // Held — unless the holder died. Break it only when clearly stale.
    try {
      if (now() - statSync(dir).mtimeMs > staleMs) {
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

function ownerFile(name) {
  return path.join(beeziHome(), name + '.lock-owner');
}

// The pid an owner token starts with (`<pid>.<ms>.<random>`), or null when the token names none.
function ownerPid(token) {
  const pid = Number(String(token).split('.')[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

// True only when the OS says the process does not exist. EPERM means it exists under another user.
function processGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err != null && err.code === 'ESRCH';
  }
}

// The owner token, or null when there is no owner file or it cannot be read.
function readOwner(name, deps) {
  const readFileSync = deps.readFileSync == null ? fs.readFileSync : deps.readFileSync;
  try { return String(readFileSync(ownerFile(name), 'utf8')); } catch { return null; }
}

function tokenOwnerGone(token, deps) {
  const gone = deps.processGone == null ? processGone : deps.processGone;
  const pid = ownerPid(token);
  return pid != null && pid !== process.pid && gone(pid);
}

// True when the lock's owner file names a process that is no longer running (never this one).
// No owner file, an unreadable one or a live owner → false: the lock's age decides then. The
// spawn gate (lib/upload-trigger.mjs) uses it so a killed holder does not read as a running one.
export function lockOwnerGone(name, deps = {}) {
  const token = readOwner(name, deps);
  return token != null && tokenOwnerGone(token, deps);
}

// The claim on breaking one dead owner, keyed on its token: `<name>.lock-owner.<token>.break`.
// Not `.lock`/`.lock-owner`-suffixed, so pruneStaleLocks's own suffix rules never mistake it.
function breakClaimFile(name, token) {
  return ownerFile(name) + '.' + String(token).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) + '.break';
}

// A held lock whose owner file names a process that is no longer running is broken at once, not
// after the stale age: a hook killed while holding it (an async hook cancelled at `claude -p`
// teardown) must not block the sync hooks behind it.
//
// Two breakers can read the same dead token, and the winner's owner file names that token until
// it writes its own, so a re-read alone cannot tell them apart. The break is therefore claimed
// first, by an exclusive create keyed on the dead token: of the breakers of one token only the
// claimant goes on. It then re-reads the owner file; a changed token means a new owner already
// holds the lock, so the claim is dropped and the break abandoned. Otherwise the claim stays until
// the next owner token is in place (installOwner removes it), so no later breaker can take the
// lock from whoever holds the dir in between. A claim older than the stale age is a breaker that
// died mid-break: it is ignored and the age break decides.
// → 'won' (this process holds the dir), 'lost' (another breaker or owner has it), 'none' (no dead owner).
function breakDeadOwner(name, deps) {
  const writeFileSync = deps.writeFileSync == null ? fs.writeFileSync : deps.writeFileSync;
  const unlinkSync = deps.unlinkSync == null ? fs.unlinkSync : deps.unlinkSync;
  const statSync = deps.statSync == null ? fs.statSync : deps.statSync;
  const mkdirSync = deps.mkdirSync == null ? fs.mkdirSync : deps.mkdirSync;
  const rmdirSync = deps.rmdirSync == null ? fs.rmdirSync : deps.rmdirSync;
  const now = deps.now == null ? (() => Date.now()) : deps.now;
  const staleMs = deps.staleMs == null ? LOCK_STALE_MS : deps.staleMs;
  const token = readOwner(name, deps);
  if (token == null || !tokenOwnerGone(token, deps)) return 'none';
  const claim = breakClaimFile(name, token);
  try {
    writeFileSync(claim, String(process.pid), { flag: 'wx' });
  } catch {
    try { if (now() - statSync(claim).mtimeMs > staleMs) return 'none'; } catch { /* claim just went: lost */ }
    return 'lost';
  }
  if (readOwner(name, deps) !== token) {
    try { unlinkSync(claim); } catch { /* best-effort: the next owner token write removes it */ }
    return 'lost';
  }
  try {
    rmdirSync(lockDir(name));
  } catch (err) {
    // ENOENT: the dir went, and whoever takes it next may not have written its token yet, so the
    // claim stays (see above). Anything else (a Windows handle on the dir: EBUSY, EPERM) left the
    // dead owner's dir in place and nobody else can hold it: drop the claim so the next call retries.
    if (err == null || err.code !== 'ENOENT') {
      try { unlinkSync(claim); } catch { /* best-effort: it then expires by age */ }
    }
    return 'lost';
  }
  try {
    mkdirSync(lockDir(name), { recursive: false });
    return 'won';
  } catch {
    // Another process took the dir in between. The claim stays (see above).
    return 'lost';
  }
}

// Writes the owner token to a temp file and renames it into place, so a reader never sees a
// half-written token. Then removes the break claim on the token it replaced, if any: from here a
// breaker of that token re-reads a new one and backs off.
function installOwner(name, token, deps) {
  const writeFileSync = deps.writeFileSync == null ? fs.writeFileSync : deps.writeFileSync;
  const renameSync = deps.renameSync == null ? fs.renameSync : deps.renameSync;
  const unlinkSync = deps.unlinkSync == null ? fs.unlinkSync : deps.unlinkSync;
  const previous = readOwner(name, deps);
  const tmp = ownerFile(name) + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp';
  try {
    writeFileSync(tmp, token);
    renameSync(tmp, ownerFile(name));
  } catch {
    try { unlinkSync(tmp); } catch { /* never written */ }
    // Kept from before the temp-file write: a direct write still beats no owner file.
    try { writeFileSync(ownerFile(name), token); } catch { return; /* an ownerless lock still expires by age */ }
  }
  if (previous != null && previous !== token) {
    try { unlinkSync(breakClaimFile(name, previous)); } catch { /* no claim on it */ }
  }
}

// acquireLock plus an owner token and a heartbeat; → { refresh, release } or null when held.
// Order: a free lock; then a dead owner's break; only then the age break. The age break comes
// last so it cannot slip past a dead-owner break claim that another process holds.
export function acquireOwnedLock(name, deps = {}) {
  const readFileSync = deps.readFileSync == null ? fs.readFileSync : deps.readFileSync;
  const utimesSync = deps.utimesSync == null ? fs.utimesSync : deps.utimesSync;
  const unlinkSync = deps.unlinkSync == null ? fs.unlinkSync : deps.unlinkSync;
  const rmdirSync = deps.rmdirSync == null ? fs.rmdirSync : deps.rmdirSync;
  let held = acquireLock(name, Object.assign({}, deps, { staleMs: Infinity }));
  if (!held) {
    const broke = breakDeadOwner(name, deps);
    held = broke === 'won' || (broke === 'none' && acquireLock(name, deps));
  }
  if (!held) return null;
  const token = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  installOwner(name, token, deps);
  const owns = () => {
    try { return String(readFileSync(ownerFile(name), 'utf8')) === token; } catch { return false; }
  };
  return {
    // Touching the dir keeps a long run from reading as abandoned.
    refresh() {
      if (!owns()) return false;
      try {
        const now = new Date();
        utimesSync(lockDir(name), now, now);
        return true;
      } catch { return false; }
    },
    release() {
      if (!owns()) return;
      try { unlinkSync(ownerFile(name)); } catch { /* best-effort */ }
      try { rmdirSync(lockDir(name)); } catch { /* best-effort: a leaked lock self-heals after LOCK_STALE_MS */ }
    },
  };
}

// Removes `<prefix>*.lock` dirs and `<prefix>*.lock-owner` files under BEEZI_HOME older than
// maxAgeMs, and the `<prefix>*.lock-owner.*` leftovers of a process killed mid-write (an owner
// temp file, a break claim). One lock per session id means a killed holder leaves one leaked dir
// per session, which nothing else would ever take again. rmdirSync/unlinkSync only (see the
// rmSync note above). Best-effort: never throws.
export function pruneStaleLocks(prefix, maxAgeMs, now = Date.now()) {
  let names;
  try { names = fs.readdirSync(beeziHome()); } catch { return; }
  for (const file of names) {
    if (file.indexOf(prefix) !== 0) continue;
    const isDir = file.endsWith('.lock');
    const leftover = file.indexOf('.lock-owner.') !== -1;
    if (!isDir && !leftover && !file.endsWith('.lock-owner')) continue;
    const p = path.join(beeziHome(), file);
    // The heartbeat touches the dir, not the owner file: a live holder's owner file is judged by its dir.
    const judged = isDir || leftover ? p : p.slice(0, -'-owner'.length);
    try {
      if (now - fs.statSync(fs.existsSync(judged) ? judged : p).mtimeMs <= maxAgeMs) continue;
      if (isDir) fs.rmdirSync(p);
      else fs.unlinkSync(p);
    } catch { /* racing holder or non-empty dir: leave it */ }
  }
}
