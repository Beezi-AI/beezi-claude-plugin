import { acquireCredentialLock, releaseCredentialLock } from './credential-lock.mjs';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  accountsIndexFile,
  accountDir,
  accountSyncStateFile,
  auditLedgerFile,
  beeziHome,
  keyNoticeFile,
  oauthKeyStatusFile,
  queueDir,
  trackingStateFile,
  usageSnapshotStateFile,
} from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { migrateSingleAccountStore, CREDENTIAL_STATUS } from './credentials.mjs';
import { markUpgradeNoticePending } from './auth-markers.mjs';
import { UserError } from './friendly-error.mjs';

const INDEX_VERSION = 1;
const LOCK_WAIT_MS = 8_000;
const INDEX_LOCK_WAIT_MS = 2_000;

export const AccountStatus = Object.freeze({ LINKED: 'linked', REVOKED: 'revoked' });

export function newAccountKey() {
  return crypto.randomBytes(4).toString('hex');
}

function emptyIndex() {
  return { version: INDEX_VERSION, default: null, accounts: [] };
}

function normalize(raw) {
  if (!raw || raw.version !== INDEX_VERSION || !Array.isArray(raw.accounts)) return null;
  const accounts = raw.accounts.filter((a) => a && typeof a.key === 'string' && /^[0-9a-f]{8}$/.test(a.key));
  let def = accounts.some((a) => a.key === raw.default) ? raw.default : null;
  // A lone linked account is the default in memory, so a lost `default` is never a dead end.
  if (def == null) {
    const linked = accounts.filter((a) => a.status === AccountStatus.LINKED);
    if (linked.length === 1) def = linked[0].key;
  }
  return { version: INDEX_VERSION, default: def, accounts };
}

export function writeIndex(index) {
  writeJsonSecure(accountsIndexFile(), index);
}

// Each pre-multi-account root-level file keeps its basename inside the account directory.
function legacyMoves(key) {
  return [
    trackingStateFile(key),
    auditLedgerFile(key),
    accountSyncStateFile(key),
    usageSnapshotStateFile(key),
    oauthKeyStatusFile(key),
    keyNoticeFile(key),
    queueDir(key),
  ].map((to) => ({ from: path.join(beeziHome(), path.basename(to)), to }));
}

// Copy rather than move, so the original survives until the index naming the new home is published.
function copyIfPresent(from, to) {
  try {
    if (fs.statSync(from).isDirectory()) {
      fs.mkdirSync(to, { recursive: true, mode: 0o700 });
      for (const entry of fs.readdirSync(from)) copyIfPresent(path.join(from, entry), path.join(to, entry));
      return;
    }
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    fs.copyFileSync(from, to);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function removeIfPresent(target) {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* ignore */ }
}

// Account one inherits the single-account install: the generation store first, then the
// root-level state files that sat beside it.
async function migrateSingleAccount(deps) {
  const index = emptyIndex();
  const journalFile = path.join(beeziHome(), 'accounts.migration.json');
  const journal = readJson(journalFile, null);
  const key = journal && /^[0-9a-f]{8}$/.test(journal.key) ? journal.key : newAccountKey();
  writeJsonSecure(journalFile, { key });
  const moves = legacyMoves(key);
  const migrated = await migrateSingleAccountStore(key, deps);
  // An inaccessible store is retried later; never publish an empty index that seals it out.
  if (migrated.status !== CREDENTIAL_STATUS.READY) {
    if (migrated.status !== CREDENTIAL_STATUS.NONE) {
      const error = new UserError('Saved Beezi authorization is temporarily unavailable. Retry when the credential store is accessible.');
      error.credentialStatus = migrated.status;
      error.reason = migrated.reason;
      throw error;
    }
    return index;
  }
  fs.mkdirSync(accountDir(key), { recursive: true, mode: 0o700 });
  for (const move of moves) copyIfPresent(move.from, move.to);
  const tracking = readJson(trackingStateFile(key), null);
  index.default = key;
  index.accounts.push({
    key,
    email: null,
    name: null,
    tenantId: null,
    tenantName: null,
    clientId: migrated.credentials.client_id == null ? null : migrated.credentials.client_id,
    linkedAt: tracking && typeof tracking.linkedAt === 'string' ? tracking.linkedAt : null,
    status: AccountStatus.LINKED,
  });
  writeIndex(index);
  markUpgradeNoticePending();
  // Last, and best-effort: a crash before this re-runs the migration instead of losing the login.
  for (const move of moves) removeIfPresent(move.from);
  return index;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The same pid/start-time/nonce lock discipline as credential writes, including crash recovery.
async function withIndexLock(fn) {
  const lock = await acquireCredentialLock({ index: true, waitMs: INDEX_LOCK_WAIT_MS });
  if (!lock) throw new UserError('Accounts are being updated by another Beezi process. Try again.');
  try {
    if (fs.existsSync(accountsIndexFile()) && !normalize(readJson(accountsIndexFile(), null))) {
      throw new UserError('The Beezi accounts index is unreadable. Restore accounts.json before changing linked accounts.');
    }
    return await fn();
  } finally { releaseCredentialLock(lock); }
}

// Missing index + a single-account install → migrate once under a lock; the lock-loser waits for
// the winner's file.
export async function readIndex(deps = {}) {
  const existing = normalize(readJson(accountsIndexFile(), null));
  if (existing) return existing;
  if (fs.existsSync(accountsIndexFile())) return emptyIndex();
  const lock = await acquireCredentialLock({ migration: true, waitMs: LOCK_WAIT_MS }, deps);
  if (!lock) {
    const until = Date.now() + LOCK_WAIT_MS;
    while (Date.now() < until) {
      await sleep(100);
      const again = normalize(readJson(accountsIndexFile(), null));
      if (again) return again;
    }
    const error = new UserError('Beezi accounts migration is in progress. Retry in a moment.');
    error.credentialStatus = CREDENTIAL_STATUS.UNAVAILABLE;
    error.reason = 'locked';
    throw error;
  }
  try {
    const again = normalize(readJson(accountsIndexFile(), null));
    if (again) return again;
    return await migrateSingleAccount(deps);
  } finally {
    releaseCredentialLock(lock);
  }
}

export async function listAccounts(deps = {}) {
  return (await readIndex(deps)).accounts;
}

export async function getAccount(key, deps = {}) {
  const found = (await listAccounts(deps)).find((a) => a.key === key);
  return found == null ? null : found;
}

export async function findByEmail(email, deps = {}) {
  if (!email) return null;
  const wanted = String(email).toLowerCase();
  const found = (await listAccounts(deps)).find((a) => a.email != null && a.email.toLowerCase() === wanted);
  return found == null ? null : found;
}

export async function getDefaultKey(deps = {}) {
  return (await readIndex(deps)).default;
}

export function setDefault(key, deps = {}) {
  return withIndexLock(async () => {
    const index = await readIndex(deps);
    if (!index.accounts.some((a) => a.key === key)) throw new UserError('No such linked account.');
    index.default = key;
    writeIndex(index);
    return index;
  });
}

export function addAccount(row, deps = {}) {
  return withIndexLock(async () => {
    const index = await readIndex(deps);
    index.accounts = index.accounts.filter((a) => a.key !== row.key);
    index.accounts.push({
      key: row.key,
      email: row.email == null ? null : String(row.email).toLowerCase(),
      name: row.name == null ? null : row.name,
      tenantId: row.tenantId == null ? null : row.tenantId,
      tenantName: row.tenantName == null ? null : row.tenantName,
      clientId: row.clientId == null ? null : row.clientId,
      linkedAt: row.linkedAt == null ? new Date().toISOString() : row.linkedAt,
      status: row.status == null ? AccountStatus.LINKED : row.status,
    });
    if (index.default == null) index.default = row.key;
    fs.mkdirSync(accountDir(row.key), { recursive: true, mode: 0o700 });
    writeIndex(index);
    return index;
  });
}

// null and undefined both mean "leave it alone": no caller clears a field.
export function updateAccount(key, patch, deps = {}) {
  return withIndexLock(async () => {
    const index = await readIndex(deps);
    const row = index.accounts.find((a) => a.key === key);
    if (!row) return index;
    for (const field of ['email', 'name', 'tenantId', 'tenantName', 'clientId', 'linkedAt', 'status']) {
      if (patch[field] == null) continue;
      row[field] = field === 'email' ? String(patch[field]).toLowerCase() : patch[field];
    }
    writeIndex(index);
    return index;
  });
}

export function removeAccount(key, deps = {}) {
  return withIndexLock(async () => {
    const index = await readIndex(deps);
    index.accounts = index.accounts.filter((a) => a.key !== key);
    if (index.default === key) index.default = null;
    writeIndex(index);
    try { fs.rmSync(accountDir(key), { recursive: true, force: true }); } catch { /* best-effort */ }
    return index;
  });
}

export function describeAccount(a) {
  if (a == null) return 'unknown account';
  let who;
  if (a.name) who = `${a.name} <${a.email == null ? 'unknown' : a.email}>`;
  else if (a.email) who = a.email;
  else who = 'linked account (details on next session)';
  return a.tenantName ? `${who} · ${a.tenantName}` : who;
}

// A key, an email, or a 1-based position in listAccounts() order.
export async function resolveAccountRef(ref, deps = {}) {
  const accounts = await listAccounts(deps);
  const value = ref == null ? '' : String(ref).trim();
  if (!value) throw new UserError('No account given.');
  const byKey = accounts.find((a) => a.key === value);
  if (byKey) return byKey.key;
  const byEmail = accounts.find((a) => a.email != null && a.email.toLowerCase() === value.toLowerCase());
  if (byEmail) return byEmail.key;
  if (/^\d+$/.test(value)) {
    const row = accounts[Number(value) - 1];
    if (row) return row.key;
  }
  throw new UserError(`No linked account matches "${value}". Run /beezi:accounts to list them.`);
}

// Strips --account <ref> out of argv; `account` is the resolved key or null.
export async function parseAccountFlag(argv, deps = {}) {
  const rest = [];
  let ref = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--account') {
      ref = argv[++i];
      if (ref == null) throw new UserError('--account needs a value: a key, an email, or a position from /beezi:accounts.');
      continue;
    }
    rest.push(argv[i]);
  }
  return { account: ref == null ? null : await resolveAccountRef(ref, deps), rest };
}

export async function findByTenant(tenantId, deps = {}) {
  if (!tenantId) return null;
  return (await listAccounts(deps)).find((a) => a.tenantId === tenantId && a.status === AccountStatus.LINKED) || null;
}
