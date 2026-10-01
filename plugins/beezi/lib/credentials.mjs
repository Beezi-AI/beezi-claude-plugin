import fs from 'fs';
import path from 'path';
import {
  credentialService, legacyCredentialService, homeSuffix,
  credentialControlFile, credentialGenerationFile, credentialsFile,
  credentialStoreDir, legacyGenerationStoreDir,
} from './paths.mjs';
import { writeJsonSecure } from './fs-store.mjs';
import { backendsFor, backendByName } from './credential-backends.mjs';
import { acquireCredentialLock, releaseCredentialLock, holdsCredentialLock, LOCK_WAIT_MS } from './credential-lock.mjs';
import { UserError } from './friendly-error.mjs';

// Generation-versioned store, one whole set per ACCOUNT. Each credential set is an immutable entry
// <key>-gen-<n> in one backend; control.json (atomic temp+rename) names the committed generation
// and the backend holding it. Readers follow the control record and never fall back to another
// generation or backend copy.

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

// The OS-store entry field carries the account key, so two accounts never share an entry.
function generationEntry(account, generation) {
  const service = credentialService();
  const entry = `${account}-gen-${generation}`;
  return {
    service, account: entry, target: `${service}/${entry}`, file: credentialGenerationFile(account, generation),
  };
}

function legacyEntry() {
  const service = legacyCredentialService();
  return { service, account: 'token', target: service, file: credentialsFile() };
}

// { value } for a parsed record, { value: null } when absent, { unreadable: true } otherwise.
function readControlAt(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (error) {
    return error != null && error.code === 'ENOENT' ? { value: null } : { unreadable: true };
  }
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === 'object' && 'generation' in value) return { value };
  } catch { /* corrupt */ }
  return { unreadable: true };
}

function readControl(account) {
  return readControlAt(credentialControlFile(account));
}

function writeControl(account, generation, backend, highestGeneration) {
  writeJsonSecure(credentialControlFile(account), {
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
function retireEntry(account, record, deps) {
  const b = backendByName(record.backend, deps);
  if (b == null || !b.available()) return;
  try { b.delete(generationEntry(account, record.generation)); } catch { /* orphan; never read again */ }
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

async function readLegacyCopies(deps) {
  const entry = legacyEntry();
  const copies = [];
  for (const b of legacySources(deps)) {
    if (!b.available()) continue;
    const credentials = parseCredentials(await b.get(entry));
    if (credentials) copies.push({ source: b.name, credentials });
  }
  return copies;
}

const canonical = (credentials) => JSON.stringify(Object.keys(credentials).sort().map((k) => [k, credentials[k]]));

// First read with no control record. One credential set (or identical copies) becomes `account`'s
// generation 1 under the lock; the legacy copies stay for any pre-generation process still
// running. Nothing is persisted when nothing is found, so a legacy entry behind a locked keychain
// is never sealed out. Differing copies are left alone and reported: a login resolves them with a
// new generation.
async function migrateLegacy(account, deps, heldLock) {
  const copies = await readLegacyCopies(deps);
  if (copies.length === 0) return { status: CREDENTIAL_STATUS.NONE };
  if (new Set(copies.map((c) => canonical(c.credentials))).size > 1) {
    return { status: CREDENTIAL_STATUS.STORAGE_CONFLICT, sources: copies.map((c) => c.source) };
  }
  const lock = heldLock == null
    ? await acquireCredentialLock({ account, waitMs: lockWait(deps, LOCK_WAIT_MS) }, deps)
    : heldLock;
  if (lock == null) return { status: CREDENTIAL_STATUS.UNAVAILABLE, reason: UNAVAILABLE_REASONS.LOCKED };
  try {
    // published while we waited
    if (readControl(account).value != null) return readCredentials(deps, { account, lock });
    const r = await commitCredentials(copies[0].credentials, { account, lock, expectedGeneration: null }, deps);
    if (r.status === COMMIT_STATUS.COMMITTED) {
      // `migrated` marks the one read that performed the migration: a pre-generation process may
      // still be running, so the caller owes the user a restart notice.
      return {
        status: CREDENTIAL_STATUS.READY, generation: r.generation, backend: r.backend, credentials: copies[0].credentials, migrated: true,
      };
    }
    if (readControl(account).value != null) return readCredentials(deps, { account, lock });
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
  const account = options.account;
  const control = readControl(account);
  if (control.unreadable) {
    return { status: CREDENTIAL_STATUS.UNAVAILABLE, reason: UNAVAILABLE_REASONS.CONTROL_UNREADABLE };
  }
  if (control.value == null) return { status: CREDENTIAL_STATUS.NONE };
  const { generation, backend } = control.value;
  if (generation == null) return { status: CREDENTIAL_STATUS.NONE };
  const unavailable = (reason) => ({ status: CREDENTIAL_STATUS.UNAVAILABLE, reason, generation, backend });
  const b = backendByName(backend, deps);
  if (b == null) return unavailable(UNAVAILABLE_REASONS.BACKEND_MISSING);
  if (!b.available()) return unavailable(UNAVAILABLE_REASONS.BACKEND_UNREADABLE);
  const entry = generationEntry(account, generation);
  const interactive = options.interactive === true;
  let attempt = await b.read(entry, { interactive });
  // A killed read says nothing about whether the credential is still there, so it is worth one
  // more try — after a jittered pause, because the readers that lost the race are the ones that
  // started together, and retrying them in lockstep just recreates the pile-up that killed them.
  if (attempt.token == null && attempt.timedOut && interactive) {
    await retryPause(deps);
    attempt = await b.read(entry, { interactive });
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
  if (options.lock.account !== options.account) throw new TypeError("Credential lock belongs to a different account.");
  if (!holdsCredentialLock(options.lock)) return { status: COMMIT_STATUS.LOCK_LOST };
  const account = options.account;
  const control = readControl(account);
  if (control.unreadable && !guard.force) return { status: COMMIT_STATUS.SUPERSEDED, generation: null };
  const current = control.value == null ? null : control.value.generation;
  if (!guard.force && guard.expectedGeneration !== current) {
    return { status: COMMIT_STATUS.SUPERSEDED, generation: current };
  }
  const generation = highestOf(control) + 1;
  const entry = generationEntry(account, generation);
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
  writeControl(account, generation, backend.name, generation);
  if (typeof current === 'number') retireEntry(account, control.value, deps);
  return { status: COMMIT_STATUS.COMMITTED, generation, backend: backend.name, where };
}

// Publishes "nothing committed" (keeping the generation counter), then removes the entry — in
// that order, so a crash in between leaves no permanently unavailable generation. Same
// lock/expectedGeneration/force contract as commitCredentials.
// { status: 'deleted', generation } | { status: 'superseded', generation } | { status: 'lock_lost' }.
export async function deleteCredentialGeneration(options = {}, deps = {}) {
  const guard = casGuard(options);
  if (options.lock.account !== options.account) throw new TypeError("Credential lock belongs to a different account.");
  if (!holdsCredentialLock(options.lock)) return { status: DELETE_STATUS.LOCK_LOST };
  const account = options.account;
  const control = readControl(account);
  if (control.unreadable && !guard.force) return { status: DELETE_STATUS.SUPERSEDED, generation: null };
  const current = control.value == null ? null : control.value.generation;
  if (!guard.force && guard.expectedGeneration !== current) {
    return { status: DELETE_STATUS.SUPERSEDED, generation: current };
  }
  writeControl(account, null, null, highestOf(control));
  if (typeof current === 'number') retireEntry(account, control.value, deps);
  return { status: DELETE_STATUS.DELETED, generation: current };
}

// ── pre-generation accessors, kept for login/logout until they are rewired ────────────────────

// The committed credentials, or null for every other status.
export async function getCredentials(account, deps = {}) {
  const r = await readCredentials(deps, { account });
  return r.status === CREDENTIAL_STATUS.READY ? r.credentials : null;
}

// Login's final write: queues behind any refresh, then replaces whatever is committed. Returns a
// human-readable description of where the credentials were actually stored.
export async function setCredentials(account, credentials, deps = {}) {
  const lock = await acquireCredentialLock({ account, waitMs: lockWait(deps, WRAPPER_LOCK_WAIT_MS) }, deps);
  if (lock == null) throw new UserError(BUSY_MESSAGE);
  try {
    const r = await commitCredentials(credentials, { account, lock, force: true }, deps);
    if (r.status !== COMMIT_STATUS.COMMITTED) throw new UserError(BUSY_MESSAGE);
    return r.where;
  } finally {
    releaseCredentialLock(lock);
  }
}

// Logout: removes the committed generation and this namespace's legacy copies.
export async function deleteCredentials(account, deps = {}) {
  const lock = await acquireCredentialLock({ account, waitMs: lockWait(deps, WRAPPER_LOCK_WAIT_MS) }, deps);
  if (lock == null) throw new UserError(BUSY_MESSAGE);
  try {
    await deleteCredentialGeneration({ account, lock, force: true }, deps);
    deleteAllGenerationEntries({ ...deps, account, lock });
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
  if (!holdsCredentialLock(deps.lock) || deps.lock.account !== deps.account) return 0;
  const account = deps.account;
  const control = readControl(account);
  // highest + 1: a lock-lost commit writes gen-<highest+1> and never reaches writeControl, so the
  // control record has no idea that entry exists. That number IS the orphan this sweep is for.
  const highest = (control.unreadable ? 0 : highestOf(control)) + 1;
  let removed = 0;
  for (let generation = 1; generation <= highest; generation += 1) {
    const entry = generationEntry(account, generation);
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

// Called only under the index migration lock. Also holds the old generation-store lock so
// an older refresh process cannot rotate the source while it is being transferred.
export async function migrateSingleAccountStore(account, deps = {}) {
  const sourceDir = legacyGenerationStoreDir();
  const sourceControl = path.join(sourceDir, 'control.json');
  const oldLock = await acquireCredentialLock({ legacyStore: true, waitMs: lockWait(deps, 1500) }, deps);
  if (!oldLock) return { status: CREDENTIAL_STATUS.UNAVAILABLE, reason: UNAVAILABLE_REASONS.LOCKED };
  const lock = await acquireCredentialLock({ account, waitMs: lockWait(deps, 1500) }, deps);
  if (!lock) { releaseCredentialLock(oldLock); return { status: CREDENTIAL_STATUS.UNAVAILABLE, reason: UNAVAILABLE_REASONS.LOCKED }; }
  try {
    let existing = await readCredentials(deps, { account, lock });
    const source = readControlAt(sourceControl);
    if (source.unreadable) return { status: CREDENTIAL_STATUS.UNAVAILABLE };
    if (existing.status !== CREDENTIAL_STATUS.READY
      || (source.value && source.value.generation != null && source.value.generation !== existing.generation)) {
      if (source.value && source.value.generation != null) {
        const { generation, backend } = source.value;
        const service = credentialService();
        const oldEntry = { service, account: `gen-${generation}`, target: `${service}/gen-${generation}`,
          file: path.join(sourceDir, `gen-${generation}.json`) };
        const b = backendByName(backend, deps);
        if (!b || !b.available()) return { status: CREDENTIAL_STATUS.UNAVAILABLE };
        const credentials = parseCredentials(await b.get(oldEntry));
        if (!credentials) return { status: CREDENTIAL_STATUS.UNAVAILABLE };
        // Keep the generation numbers so rejection/backoff markers continue to bind correctly.
        const dest = generationEntry(account, generation);
        if (!b.set(dest, JSON.stringify(credentials))) return { status: CREDENTIAL_STATUS.UNAVAILABLE };
        writeControl(account, generation, backend, highestOf(source));
      } else if (source.value == null) {
        const migrated = await migrateLegacy(account, deps, lock);
        if (migrated.status !== CREDENTIAL_STATUS.READY) return migrated;
      } else return { status: CREDENTIAL_STATUS.NONE };
      existing = await readCredentials(deps, { account, lock });
    }
    if (!source.value || source.value.generation != null) {
      for (const name of ['auth-state.json', 'refresh.inflight.json']) {
        const marker = path.join(sourceDir, name);
        if (fs.existsSync(marker)) writeJsonSecure(path.join(credentialStoreDir(account), name), JSON.parse(fs.readFileSync(marker, 'utf8')));
      }
    }
    // Tombstone the old control before publishing the index: old workers cannot consume the
    // transferred grant. A persisted migration key lets a retry finish the same destination.
    writeJsonSecure(sourceControl, { version: CONTROL_VERSION, generation: null, backend: null,
      highestGeneration: highestOf(source), migratedAccount: account });
    deleteLegacyCredentials(deps);
    if (source.value && typeof source.value.generation === 'number') {
      const service = credentialService();
      const generation = source.value.generation;
      const b = backendByName(source.value.backend, deps);
      try { b.delete({ service, account: `gen-${generation}`, target: `${service}/gen-${generation}`,
        file: path.join(sourceDir, `gen-${generation}.json`) }); } catch { /* inaccessible orphan */ }
    }
    return existing;
  } finally { releaseCredentialLock(lock); releaseCredentialLock(oldLock); }
}
