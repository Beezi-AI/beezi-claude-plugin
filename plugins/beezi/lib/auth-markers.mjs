import fs from 'fs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { authStateFile, refreshInflightFile, upgradeNoticeFile } from './paths.mjs';
import { processStartTime as _processStartTime } from './process-start-time.mjs';

// Two small files inside ONE ACCOUNT's credential store, so every function here takes the account
// key first. Neither ever holds a token, so a read costs one file open instead of a
// `security`/`secret-tool`/PowerShell spawn — which is what makes the hook-side 1.5s wait
// affordable.
//
// auth-state.json  { lastState, lastReason, at, backoff: { generation, attempts, nextAttemptAt },
//                    reauth: { generation, reason, at } }
// refresh.inflight.json  { generation, pid, startedAt }
//
// The worker owns every write that happens under the credential lock (backoff, reauth,
// in-flight); the accessor only ever updates lastState/lastReason, and only on a transition.

// Fixed ladder, keyed on the rejected generation and reset by any successful commit. Without it
// a machine that is offline for an hour spawns a refresh worker on every single hook.
export const RETRY_BACKOFF_MS = Object.freeze([15_000, 30_000, 60_000, 120_000, 300_000]);

function readState(account) {
  const value = readJson(authStateFile(account), null);
  return value == null || typeof value !== 'object' ? {} : value;
}

function writeState(account, next) {
  try {
    writeJsonSecure(authStateFile(account), next);
    return true;
  } catch {
    return false; // a store we cannot write is never worth failing a hook over
  }
}

export function readAuthState(account) {
  return readState(account);
}

// Records the state the user was last shown. Returns true when this call CHANGED it, which is
// how a `ready` following any non-ready state is recognised as a recovery.
export function recordLastAuthState(account, authState, reason) {
  const state = readState(account);
  if (state.lastState === authState && state.lastReason === reason) return false;
  writeState(account, { ...state, lastState: authState, lastReason: reason, at: Date.now() });
  return true;
}

// An account with no record has never reported a failure, so its first `ready` is normal traffic
// — not a recovery. Getting this backwards makes every fresh install and every login emit one.
export function wasLastStateReady(account) {
  const state = readState(account);
  return state.lastState == null || state.lastState === 'ready';
}

// Backoff for `generation`. A different generation's record never applies: a fresh login or a
// completed refresh is a new grant and deserves an immediate attempt.
export function readBackoff(account, generation) {
  const backoff = readState(account).backoff;
  if (backoff == null || backoff.generation !== generation) return null;
  return backoff;
}

export function recordBackoff(account, generation, reason, now = Date.now()) {
  const state = readState(account);
  const previous = state.backoff != null && state.backoff.generation === generation
    ? state.backoff.attempts
    : 0;
  const attempts = previous + 1;
  const step = RETRY_BACKOFF_MS[Math.min(attempts - 1, RETRY_BACKOFF_MS.length - 1)];
  writeState(account, {
    ...state,
    backoff: { generation, attempts, reason, nextAttemptAt: now + step },
  });
}

export function clearBackoff(account) {
  const state = readState(account);
  if (state.backoff == null) return;
  const next = { ...state };
  delete next.backoff;
  writeState(account, next);
}

// The provider rejected exactly this generation. Recorded INSTEAD of deleting anything: the
// refresh token, the registered client and the diagnostic identity all survive, and only the
// automatic retries of this one generation stop (findings 1, 3, 4).
export function readReauthMarker(account, generation) {
  const reauth = readState(account).reauth;
  if (reauth == null || reauth.generation !== generation) return null;
  return reauth;
}

export function recordReauthRequired(account, generation, reason, now = Date.now()) {
  const state = readState(account);
  writeState(account, { ...state, reauth: { generation, reason, at: now } });
}

// Called by login after committing a new generation, and by logout. A marker for a generation
// that is no longer committed is already inert; clearing it keeps the file honest. The upgrade
// notice survives: it is machine-level, in its own file, not about any one grant.
export function clearAuthMarkers(account) {
  writeState(account, {});
  clearInflight(account);
}

// The legacy store was migrated into the versioned one, so a pre-upgrade Claude Code process
// still running would refresh against the old copies. Whichever process happens to perform the
// migration flags it here; session-start is what actually says so, exactly once per machine.
function readNotice() {
  const value = readJson(upgradeNoticeFile(), null);
  return value == null || typeof value !== 'object' ? {} : value;
}

export function markUpgradeNoticePending() {
  const state = readNotice();
  if (state.upgradeNotice != null) return;
  try { writeJsonSecure(upgradeNoticeFile(), { ...state, upgradeNotice: 'pending' }); } catch { /* never fails a hook */ }
}

export function takeUpgradeNotice() {
  const state = readNotice();
  if (state.upgradeNotice !== 'pending') return false;
  try { writeJsonSecure(upgradeNoticeFile(), { ...state, upgradeNotice: 'shown' }); } catch { /* shown twice beats crashing */ }
  return true;
}

export function readInflight(account) {
  const value = readJson(refreshInflightFile(account), null);
  if (value == null || typeof value !== 'object' || typeof value.pid !== 'number') return null;
  return value;
}

export function recordInflight(account, generation, pid, startedAt) {
  try {
    writeJsonSecure(refreshInflightFile(account), { generation, pid, startedAt, at: Date.now() });
    return true;
  } catch {
    return false;
  }
}

export function clearInflight(account) {
  try {
    fs.unlinkSync(refreshInflightFile(account));
  } catch {
    /* already gone */
  }
}

// A successful commit retires both failure records for good: the grant that failed is gone.
export function clearRefreshFailureState(account) {
  const state = readState(account);
  const next = { ...state };
  delete next.backoff;
  delete next.reauth;
  writeState(account, next);
}

// Same identity rule the credential lock uses: a live pid whose start time disagrees with the
// record is a recycled number, and an undeterminable start time counts as alive so a running
// worker is never declared dead.
const START_TIME_TOLERANCE_S = 3;

export function isWorkerAlive(marker, deps = {}) {
  if (marker == null) return false;
  const isAlive = deps.isAlive == null ? defaultIsAlive : deps.isAlive;
  if (!isAlive(marker.pid)) return false;
  if (typeof marker.startedAt !== 'number') return true;
  const probe = deps.processStartTime == null ? _processStartTime : deps.processStartTime;
  const started = probe(marker.pid);
  if (started == null) return true;
  return Math.abs(started - marker.startedAt) <= START_TIME_TOLERANCE_S;
}

function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error != null && error.code === 'EPERM';
  }
}
