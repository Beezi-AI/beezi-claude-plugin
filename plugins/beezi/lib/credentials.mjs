import fs from 'fs';
import {
  credentialService, legacyCredentialService, homeSuffix,
  credentialControlFile, credentialGenerationFile, credentialsFile,
} from './paths.mjs';
import { writeJsonSecure } from './fs-store.mjs';
import { backendsFor, backendByName } from './credential-backends.mjs';
import { acquireCredentialLock, releaseCredentialLock, holdsCredentialLock, LOCK_WAIT_MS } from './credential-lock.mjs';
import { UserError } from './friendly-error.mjs';

// Generation-versioned store. Each credential set is an immutable entry gen-<n> in one backend;
// control.json (atomic temp+rename) names the committed generation and the backend holding it.
// Readers follow the control record and never fall back to another generation or backend copy.

export const CREDENTIAL_STATUS = Object.freeze({
  READY: 'ready',
  NONE: 'none',
  UNAVAILABLE: 'unavailable',
  STORAGE_CONFLICT: 'storage_conflict',
});

export const UNAVAILABLE_REASONS = Object.freeze({
  BACKEND_UNREADABLE: 'backend_unreadable',
  // The backend never answered — its helper was killed for taking too long. Distinct from
  // BACKEND_UNREADABLE because it says nothing about whether the credential is still there, and
  // the caller should say so rather than send the user to /beezi:login.
  BACKEND_TIMEOUT: 'backend_timeout',
  ENTRY_MALFORMED: 'entry_malformed',
  BACKEND_MISSING: 'backend_missing',
  CONTROL_UNREADABLE: 'control_unreadable',
  LOCKED: 'locked',
});

export const COMMIT_STATUS = Object.freeze({
  COMMITTED: 'committed',
  SUPERSEDED: 'superseded',
  LOCK_LOST: 'lock_lost',
});

export const DELETE_STATUS = Object.freeze({
  DELETED: 'deleted',
  SUPERSEDED: 'superseded',
  LOCK_LOST: 'lock_lost',
});

const CONTROL_VERSION = 1;
// The login/logout wrappers are interactive and can afford to queue behind a whole hook refresh.
const WRAPPER_LOCK_WAIT_MS = 10_000;
const BUSY_MESSAGE = 'Credentials are being updated by another Beezi process. Try again in a moment.';

const lockWait = (deps, fallback) => (deps.lockWaitMs == null ? fallback : deps.lockWaitMs);

function generationEntry(generation) {
  const service = credentialService();
  const account = `gen-${generation}`;
  return { service, account, target: `${service}/${account}`, file: credentialGenerationFile(generation) };
}

function legacyEntry() {
  const service = legacyCredentialService();
  return { service, account: 'token', target: service, file: credentialsFile() };
}

// { value } for a parsed record, { value: null } when absent, { unreadable: true } otherwise.
function readControl() {
  let raw;
  try {
    raw = fs.readFileSync(credentialControlFile(), 'utf-8');
  } catch (error) {
    return error != null && error.code === 'ENOENT' ? { value: null } : { unreadable: true };
  }
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === 'object' && 'generation' in value) return { value };
  } catch { /* corrupt */ }
  return { unreadable: true };
}

function writeControl(generation, backend, highestGeneration) {
  writeJsonSecure(credentialControlFile(), {
    version: CONTROL_VERSION, generation, backend, highestGeneration, committedAt: Date.now(),
  });
}

const highestOf = (control) => (
  control.value && typeof control.value.highestGeneration === 'number' ? control.value.highestGeneration : 0
);

// The backends store an opaque string. Since the Clerk OAuth migration that
// string is a JSON credentials object: { client_id, redirect_uri,
// token_endpoint, access_token, refresh_token, expires_at }. Legacy bare
// device tokens fail to parse and read as "not linked".
function parseCredentials(raw) {
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' && typeof obj.access_token === 'string' ? obj : null;
  } catch {
    return null;
  }
}

// Best-effort removal of a generation that is no longer committed.
function retireEntry(record, deps) {
  const b = backendByName(record.backend, deps);
  if (b == null || !b.available()) return;
  try { b.delete(generationEntry(record.generation)); } catch { /* orphan; never read again */ }
}

// A lock handle plus exactly one of expectedGeneration / force, so "no check" is never implicit.
function casGuard(options) {
  if (options.lock == null || typeof options.lock.nonce !== 'string') {
    throw new TypeError('A credential lock handle is required.');
  }
  const force = options.force === true;
  if ((options.expectedGeneration !== undefined) === force) {
    throw new TypeError('Pass exactly one of expectedGeneration or force.');
  }
  return { force, expectedGeneration: options.expectedGeneration };
}

// ── legacy migration ──────────────────────────────────────────────────────────────────────────

// The stores the pre-generation plugin wrote: the OS entry (default home only — a custom
// BEEZI_HOME never owned the shared entry, and inheriting it would let two namespaces refresh one
// grant) and <home>/credentials.json through the first file-capable backend, which understands
// both the DPAPI and plaintext forms.
function legacySources(deps) {
  const sources = [];
  let fileSeen = false;
  for (const b of backendsFor(deps)) {
    if (b.kind === 'os') {
      if (homeSuffix() === '') sources.push(b);
    } else if (!fileSeen) {
      fileSeen = true;
      sources.push(b);
    }
  }
  return sources;
}

function readLegacyCopies(deps) {
  const entry = legacyEntry();
  const copies = [];
  for (const b of legacySources(deps)) {
    if (!b.available()) continue;
    const credentials = parseCredentials(b.get(entry));
    if (credentials) copies.push({ source: b.name, credentials });
  }
  return copies;
}

const canonical = (credentials) => JSON.stringify(Object.keys(credentials).sort().map((k) => [k, credentials[k]]));

// First read with no control record. One credential set (or identical copies) becomes generation
// 1 under the lock; the legacy copies stay for any pre-generation process still running. Nothing
// is persisted when nothing is found, so a legacy entry behind a locked keychain is never sealed
// out. Differing copies are left alone and reported: a login resolves them with a new generation.
async function migrateLegacy(deps, heldLock) {
  const copies = readLegacyCopies(deps);
  if (copies.length === 0) return { status: CREDENTIAL_STATUS.NONE };
  if (new Set(copies.map((c) => canonical(c.credentials))).size > 1) {
    return { status: CREDENTIAL_STATUS.STORAGE_CONFLICT, sources: copies.map((c) => c.source) };
  }
  const lock = heldLock == null ? await acquireCredentialLock({ waitMs: lockWait(deps, LOCK_WAIT_MS) }, deps) : heldLock;
  if (lock == null) return { status: CREDENTIAL_STATUS.UNAVAILABLE, reason: UNAVAILABLE_REASONS.LOCKED };
  try {
    if (readControl().value != null) return readCredentials(deps, { lock }); // published while we waited
    const r = await commitCredentials(copies[0].credentials, { lock, expectedGeneration: null }, deps);
    if (r.status === COMMIT_STATUS.COMMITTED) {
      // `migrated` marks the one read that performed the migration: a pre-generation process may
      // still be running, so the caller owes the user a restart notice.
      return {
        status: CREDENTIAL_STATUS.READY, generation: r.generation, backend: r.backend, credentials: copies[0].credentials, migrated: true,
      };
    }
    if (readControl().value != null) return readCredentials(deps, { lock });
    return { status: CREDENTIAL_STATUS.UNAVAILABLE, reason: UNAVAILABLE_REASONS.LOCKED };
  } finally {
    if (heldLock == null) releaseCredentialLock(lock);
  }
}

// Spread the retries of readers that were killed together. The window is small enough that an
// interactive command still feels immediate and large enough to break the lockstep.
const RETRY_PAUSE_MIN_MS = 150;
const RETRY_PAUSE_SPREAD_MS = 600;

function retryPause(deps) {
  const random = deps.randomImpl == null ? Math.random : deps.randomImpl;
  const sleep = deps.sleepImpl == null
    ? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }))
    : deps.sleepImpl;
  return sleep(RETRY_PAUSE_MIN_MS + Math.floor(random() * RETRY_PAUSE_SPREAD_MS));
}

// ── public store API ──────────────────────────────────────────────────────────────────────────

// { status: 'ready', generation, backend, credentials, migrated? } | { status: 'none' }
// | { status: 'unavailable', reason, generation?, backend? } | { status: 'storage_conflict', sources }.
// `options.lock` lets a caller that already holds the namespace lock reread without re-acquiring.
// `options.interactive` says a human is waiting: the backend read gets the longer cap AND one more
// attempt when its helper was killed before answering. Hooks must leave it off — their whole
// budget is 10s and they still have work to do after the read.
export async function readCredentials(deps = {}, options = {}) {
  const control = readControl();
  if (control.unreadable) {
    return { status: CREDENTIAL_STATUS.UNAVAILABLE, reason: UNAVAILABLE_REASONS.CONTROL_UNREADABLE };
  }
  if (control.value == null) return migrateLegacy(deps, options.lock);
  const { generation, backend } = control.value;
  if (generation == null) return { status: CREDENTIAL_STATUS.NONE };
  const unavailable = (reason) => ({ status: CREDENTIAL_STATUS.UNAVAILABLE, reason, generation, backend });
  const b = backendByName(backend, deps);
  if (b == null) return unavailable(UNAVAILABLE_REASONS.BACKEND_MISSING);
  if (!b.available()) return unavailable(UNAVAILABLE_REASONS.BACKEND_UNREADABLE);
  const entry = generationEntry(generation);
  const interactive = options.interactive === true;
  let attempt = b.read(entry, { interactive });
  // A killed read says nothing about whether the credential is still there, so it is worth one
  // more try — after a jittered pause, because the readers that lost the race are the ones that
  // started together, and retrying them in lockstep just recreates the pile-up that killed them.
  if (attempt.token == null && attempt.timedOut && interactive) {
    await retryPause(deps);
    attempt = b.read(entry, { interactive });
  }
  const raw = attempt.token;
  if (!raw) {
    return unavailable(
      attempt.timedOut ? UNAVAILABLE_REASONS.BACKEND_TIMEOUT : UNAVAILABLE_REASONS.BACKEND_UNREADABLE,
    );
  }
  const credentials = parseCredentials(raw);
  if (!credentials) return unavailable(UNAVAILABLE_REASONS.ENTRY_MALFORMED);
  return { status: CREDENTIAL_STATUS.READY, generation, backend, credentials };
}

// Writes `credentials` as the next generation into the first backend that accepts it, then
// publishes the control record — only while the caller still owns the lock, and only if the
// committed generation still equals `expectedGeneration` (null = none committed) unless `force`.
// { status: 'committed', generation, backend, where } | { status: 'superseded', generation }
// | { status: 'lock_lost' }.
export async function commitCredentials(credentials, options = {}, deps = {}) {
  const guard = casGuard(options);
  if (!holdsCredentialLock(options.lock)) return { status: COMMIT_STATUS.LOCK_LOST };
  const control = readControl();
  if (control.unreadable && !guard.force) return { status: COMMIT_STATUS.SUPERSEDED, generation: null };
  const current = control.value == null ? null : control.value.generation;
  if (!guard.force && guard.expectedGeneration !== current) {
    return { status: COMMIT_STATUS.SUPERSEDED, generation: current };
  }
  const generation = highestOf(control) + 1;
  const entry = generationEntry(generation);
  const raw = JSON.stringify(credentials);
  let backend = null;
  let where = null;
  for (const b of backendsFor(deps)) {
    if (!b.available()) continue;
    where = b.set(entry, raw);
    if (where) { backend = b; break; }
  }
  if (backend == null) throw new Error('No credential backend accepted the write.');
  // The entry stays as an orphan on purpose: never read (no control record names it) and
  // overwritten by name by the next commit, whereas a by-name delete here could remove an entry
  // a concurrent holder just wrote under the same number.
  if (!holdsCredentialLock(options.lock)) return { status: COMMIT_STATUS.LOCK_LOST };
  writeControl(generation, backend.name, generation);
  if (typeof current === 'number') retireEntry(control.value, deps);
  return { status: COMMIT_STATUS.COMMITTED, generation, backend: backend.name, where };
}

// Publishes "nothing committed" (keeping the generation counter), then removes the entry — in
// that order, so a crash in between leaves no permanently unavailable generation. Same
// lock/expectedGeneration/force contract as commitCredentials.
// { status: 'deleted', generation } | { status: 'superseded', generation } | { status: 'lock_lost' }.
export async function deleteCredentialGeneration(options = {}, deps = {}) {
  const guard = casGuard(options);
  if (!holdsCredentialLock(options.lock)) return { status: DELETE_STATUS.LOCK_LOST };
  const control = readControl();
  if (control.unreadable && !guard.force) return { status: DELETE_STATUS.SUPERSEDED, generation: null };
  const current = control.value == null ? null : control.value.generation;
  if (!guard.force && guard.expectedGeneration !== current) {
    return { status: DELETE_STATUS.SUPERSEDED, generation: current };
  }
  writeControl(null, null, highestOf(control));
  if (typeof current === 'number') retireEntry(control.value, deps);
  return { status: DELETE_STATUS.DELETED, generation: current };
}

// ── pre-generation accessors, kept for login/logout until they are rewired ────────────────────

// The committed credentials, or null for every other status.
export async function getCredentials(deps = {}) {
  const r = await readCredentials(deps);
  return r.status === CREDENTIAL_STATUS.READY ? r.credentials : null;
}

// Login's final write: queues behind any refresh, then replaces whatever is committed. Returns a
// human-readable description of where the credentials were actually stored.
export async function setCredentials(credentials, deps = {}) {
  const lock = await acquireCredentialLock({ waitMs: lockWait(deps, WRAPPER_LOCK_WAIT_MS) }, deps);
  if (lock == null) throw new UserError(BUSY_MESSAGE);
  try {
    const r = await commitCredentials(credentials, { lock, force: true }, deps);
    if (r.status !== COMMIT_STATUS.COMMITTED) throw new UserError(BUSY_MESSAGE);
    return r.where;
  } finally {
    releaseCredentialLock(lock);
  }
}

// Logout: removes the committed generation and this namespace's legacy copies.
export async function deleteCredentials(deps = {}) {
  const lock = await acquireCredentialLock({ waitMs: lockWait(deps, WRAPPER_LOCK_WAIT_MS) }, deps);
  if (lock == null) throw new UserError(BUSY_MESSAGE);
  try {
    await deleteCredentialGeneration({ lock, force: true }, deps);
    deleteLegacyCredentials(deps);
  } finally {
    releaseCredentialLock(lock);
  }
}

// Removes every generation entry this namespace could still hold, committed or orphaned.
//
// commitCredentials deliberately leaves an entry behind when it loses the lock mid-write, because
// a by-name delete there can remove what a concurrent holder just wrote under the same number.
// That hazard is specific to the lock-lost path: a caller that HOLDS the lock — logout — has no
// concurrent holder, and an orphan created by a refresh holds the freshly ROTATED refresh token
// while the committed generation's is the dead one. Leaving it is a live grant sitting in the
// keychain of a machine the user just signed out of.
export function deleteAllGenerationEntries(deps = {}) {
  if (!holdsCredentialLock(deps.lock)) return 0;
  const control = readControl();
  // highest + 1: a lock-lost commit writes gen-<highest+1> and never reaches writeControl, so the
  // control record has no idea that entry exists. That number IS the orphan this sweep is for.
  const highest = (control.unreadable ? 0 : highestOf(control)) + 1;
  let removed = 0;
  for (let generation = 1; generation <= highest; generation += 1) {
    const entry = generationEntry(generation);
    for (const b of backendsFor(deps)) {
      if (!b.available()) continue;
      try { if (b.delete(entry) !== false) removed += 1; } catch { /* ignore */ }
    }
  }
  return removed;
}

// Removes this namespace's pre-generation copies. Nothing in the new store reads them, but a
// downgraded install or a pre-upgrade process still running does — so an explicit logout that
// left them behind would leave a live credential on the machine. Callers hold the lock.
export function deleteLegacyCredentials(deps = {}) {
  const entry = legacyEntry();
  for (const b of legacySources(deps)) {
    if (b.available()) { try { b.delete(entry); } catch { /* ignore */ } }
  }
}
