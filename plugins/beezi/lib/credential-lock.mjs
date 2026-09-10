import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { credentialLockDir } from './paths.mjs';
import { readJson } from './fs-store.mjs';
import { processStartTime as _processStartTime, ownStartTime } from './process-start-time.mjs';

// Bounded wait for hook callers: keychain calls run up to 5s each and the refresh itself 7s
// inside a 10s hook, so a refresher cannot afford to queue for long.
export const LOCK_WAIT_MS = 1500;
export const LOCK_POLL_MS = 50;
// A lock directory with no valid owner record is a holder that crashed between mkdir and the owner
// write, one still writing it, or a reclaimer that died mid-reclaim. Only this ownerless case is
// judged by age: an owned lock is held until its owner is verifiably gone, however old its stamp.
export const OWNERLESS_GRACE_MS = 5000;
// Recorded (process.uptime) and probed (ps / proc / Get-Process) start times round differently and
// the probe has its own latency; anything closer than this is the same process.
export const START_TIME_TOLERANCE_S = 3;

// Files inside the lock directory: the live owner record, tombstones a reclaimer renames it to
// while verifying it, and the temp an owner write goes through.
const OWNER = 'owner.json';
const NONCE = /^[0-9a-f]{32}$/;
const TOMBSTONE = /^owner\.[0-9a-f]{32}\.dead$/;
const ownerFile = (dir) => path.join(dir, OWNER);

// Signal 0 probes without killing. EPERM means the pid exists under another user: alive.
function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error != null && error.code === 'EPERM';
  }
}

function asRecord(value) {
  return value && typeof value === 'object' && typeof value.pid === 'number' && NONCE.test(String(value.nonce))
    ? value : null;
}

const readOwner = (dir) => asRecord(readJson(ownerFile(dir)));

// The file carrying `nonce` — owner.json, or a tombstone while a reclaimer verifies it — or null.
function findRecord(dir, nonce) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  for (const name of names) {
    if (name !== OWNER && !TOMBSTONE.test(name)) continue;
    const record = asRecord(readJson(path.join(dir, name)));
    if (record && record.nonce === nonce) return path.join(dir, name);
  }
  return null;
}

// Exclusive create + rename inside the directory mkdir just made. Deliberately not writeJsonSecure:
// its recursive mkdir would let a late owner write resurrect a directory a reclaimer removed.
function writeOwner(dir, record) {
  const tmp = path.join(dir, `${OWNER}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(record), { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, ownerFile(dir));
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* never created */ }
    throw error;
  }
}

// Empties and removes the lock directory; true once it is gone. Unlinks by name only what no live
// holder can own: tombstones, temp files, and an owner.json that is not a record. A valid
// owner.json is a fresh holder's — it stays, rmdir refuses ENOTEMPTY, and the caller keeps polling.
// unlinkSync + rmdirSync, never rmSync: the floor is Node 13.2 and rmSync is 14.14+.
function remove(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { names = []; }
  for (const name of names) {
    let removable;
    if (name === OWNER) removable = readOwner(dir) == null;
    else removable = TOMBSTONE.test(name) || name.endsWith('.tmp');
    if (!removable) continue;
    try { fs.unlinkSync(path.join(dir, name)); } catch { /* renamed away meanwhile */ }
  }
  try {
    fs.rmdirSync(dir);
    return true;
  } catch (error) {
    return error != null && error.code === 'ENOENT';
  }
}

// mkdir is the atomic primitive: it either creates the lock or fails because someone holds it.
function tryAcquire(dir) {
  try {
    fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
    fs.mkdirSync(dir, { recursive: false });
  } catch {
    return null;
  }
  const lock = { pid: process.pid, nonce: crypto.randomBytes(16).toString('hex') };
  try {
    writeOwner(dir, { pid: lock.pid, nonce: lock.nonce, startedAt: ownStartTime(), acquiredAt: Date.now() });
  } catch (error) {
    remove(dir);
    throw error;
  }
  return lock;
}

// Alive: the pid exists AND, when the record carries a start time, the process at that pid started
// when the record says. Pid gone → dead. Pid alive with a different start → the number was
// recycled → dead. Start time unknown (older record, probe failed) → alive, conservatively.
// The probe spawns, so it runs only here — never on the uncontended acquire path.
function ownerAlive(owner, probes) {
  if (!probes.isAlive(owner.pid)) return false;
  if (typeof owner.startedAt !== 'number') return true;
  const started = probes.processStartTime(owner.pid);
  if (typeof started !== 'number') return true;
  return Math.abs(started - owner.startedAt) <= START_TIME_TOLERANCE_S;
}

// True when a tombstone in the directory still carries a live owner — a reclaimer that renamed a
// record away and stalled before renaming it back. Without this the ownerless branch would unlink
// that tombstone and strip a holder that is very much alive.
function liveTombstone(dir, probes) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return false; }
  for (const name of names) {
    if (!TOMBSTONE.test(name)) continue;
    const record = asRecord(readJson(path.join(dir, name)));
    if (record && ownerAlive(record, probes)) return true;
  }
  return false;
}

// Reclaims only a lock whose owner is verifiably gone; returns whether the directory is gone.
// Identity-based: the owner record is renamed to a tombstone named by the dead nonce (atomic, so
// one waiter wins), then re-read — a different nonce inside means a fresh holder got in between
// and its record goes straight back. The ownerless path clears only tombstones, temps and an
// invalid owner.json, so a live record always makes rmdir refuse.
async function reclaimIfDead(dir, probes) {
  const owner = readOwner(dir);
  if (owner) {
    if (ownerAlive(owner, probes)) return false;
    await probes.reclaimStep('tombstone');
    const tombstone = path.join(dir, `owner.${owner.nonce}.dead`);
    try { fs.renameSync(ownerFile(dir), tombstone); } catch { return false; }
    const claimed = asRecord(readJson(tombstone));
    if (claimed == null || claimed.nonce !== owner.nonce) {
      try { fs.renameSync(tombstone, ownerFile(dir)); } catch { /* its holder released meanwhile */ }
      return false;
    }
    await probes.reclaimStep('remove');
    return remove(dir);
  }
  try {
    if (Date.now() - fs.statSync(dir).mtimeMs <= OWNERLESS_GRACE_MS) return false;
  } catch {
    return false; // gone already: the next mkdir decides
  }
  if (liveTombstone(dir, probes)) return false;
  return remove(dir);
}

// Waits up to `waitMs`, polling every `pollMs`, for the namespace's credential lock. Returns the
// handle { pid, nonce } to pass to the store's commit/delete and to release, or null on timeout.
// The deadline runs on the real clock on purpose: callers inject fake clocks for token expiry.
// deps: isAlive(pid), processStartTime(pid) → epoch seconds | null, sleep(ms), and reclaimStep(name)
// — a test seam awaited before the 'tombstone' rename and before the 'remove'.
export async function acquireCredentialLock(options = {}, deps = {}) {
  const waitMs = options.waitMs == null ? LOCK_WAIT_MS : options.waitMs;
  const pollMs = options.pollMs == null ? LOCK_POLL_MS : options.pollMs;
  const sleep = deps.sleep == null ? ((ms) => new Promise((r) => setTimeout(r, ms))) : deps.sleep;
  const probe = deps.processStartTime == null ? _processStartTime : deps.processStartTime;
  // A living pid's start time never changes, so probe it once per acquire however many times we
  // poll: on Windows each probe is a PowerShell spawn that would otherwise eat the whole deadline.
  const started = new Map();
  const probes = {
    isAlive: deps.isAlive == null ? defaultIsAlive : deps.isAlive,
    processStartTime: (pid) => {
      if (!started.has(pid)) started.set(pid, probe(pid));
      return started.get(pid);
    },
    reclaimStep: deps.reclaimStep == null ? (() => undefined) : deps.reclaimStep,
  };
  const dir = credentialLockDir();
  const deadline = Date.now() + waitMs;
  for (;;) {
    const lock = tryAcquire(dir);
    if (lock) return lock;
    if (await reclaimIfDead(dir, probes)) continue;
    if (Date.now() >= deadline) return null;
    await sleep(pollMs);
  }
}

// True while a record carrying the caller's nonce is in the lock directory — as owner.json, or as
// a tombstone a reclaimer is about to hand back.
export function holdsCredentialLock(lock) {
  return lock != null && findRecord(credentialLockDir(), lock.nonce) != null;
}

// Releases only a lock the caller still owns; anything else is a no-op that returns false.
export function releaseCredentialLock(lock) {
  if (lock == null) return false;
  const dir = credentialLockDir();
  for (let attempt = 0; attempt < 3; attempt++) {
    const record = findRecord(dir, lock.nonce);
    if (record == null) return false;
    try {
      fs.unlinkSync(record);
      return remove(dir);
    } catch { /* a reclaimer renamed it between the scan and the unlink; scan again */ }
  }
  return false;
}

// The current owner record { pid, nonce, startedAt, acquiredAt }, or null when nothing holds it.
export function readCredentialLockOwner() {
  return readOwner(credentialLockDir());
}
