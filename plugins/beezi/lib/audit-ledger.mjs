import { auditLedgerFile } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';

const LEDGER_VERSION = 1;

// Which past sessions the history backfill (the last step of /beezi:login) has already handed
// to the server, and what the server said.
//
// This has to be durable in a way ~/.beezi/state/<id>.json is not: pruneStale() deletes anything
// in state/, telemetry/ and the account queues older than 14 days, so a marker there expires and
// every old session looks importable again on the next run. auditLedgerFile(key) sits at the
// account root, outside the dirs pruneStale walks.
//
// The ledger is per account and the server's pull record is per (tenant, user, tool), so it also
// binds to the login that wrote it: a ledger recorded under another identity is discarded, or a
// logout→login into a different workspace would skip the old login's sessions on the backfill engine
// and let segment repair push them into the new workspace.
export function loadLedger(key, identity = null, tenantId = null) {
  const raw = readJson(auditLedgerFile(key, tenantId), null);
  // A ledger from a future/foreign shape is discarded rather than merged: re-sending is
  // idempotent server-side, whereas trusting an unknown shape is not.
  if (!raw || raw.version !== LEDGER_VERSION || typeof raw.sessions !== 'object' || raw.sessions === null) {
    return emptyLedger(identity);
  }
  if (raw.identity && identity && raw.identity !== identity) {
    return emptyLedger(identity);
  }
  if (!raw.identity && identity) raw.identity = identity;
  // Added after v1 shipped, so a ledger written before it has no such key. Normalised here rather
  // than guarded at every use site.
  if (!raw.unreadable || typeof raw.unreadable !== 'object') raw.unreadable = {};
  return raw;
}

function emptyLedger(identity) {
  return {
    version: LEDGER_VERSION,
    identity: identity == null ? null : identity,
    sessions: {},
    unreadable: {},
    complete: false,
    updatedAt: null,
  };
}

// The pull was sealed server-side (an earlier plugin finalized it, and a chunk answered ALREADY_COMPLETED).
export function markComplete(ledger, { at = new Date() } = {}) {
  ledger.complete = true;
  ledger.updatedAt = at.toISOString();
  return ledger;
}

export function isComplete(ledger) {
  return ledger != null && ledger.complete === true;
}

// Rejected sessions count as imported. A repository that was never connected to Beezi rejects
// every one of its reports and always will, so resending it each run is pure waste; --force is the
// escape hatch when the repo has since been connected.
export function isImported(ledger, sessionId) {
  const sessions = ledger == null ? undefined : ledger.sessions;
  return Object.prototype.hasOwnProperty.call(sessions == null ? {} : sessions, sessionId);
}

// A consented stamp is written only as true and survives every later re-mark.
export function markImported(ledger, sessionId, { outcome, reports = 0, consented = false, at = new Date() } = {}) {
  const previous = ledger.sessions[sessionId];
  const entry = { at: at.toISOString(), outcome, reports };
  if (consented === true || (previous != null && previous.consented === true)) entry.consented = true;
  ledger.sessions[sessionId] = entry;
  // A session that read fine this time is not unreadable any more; leaving the marker would make
  // wasUnreadable() answer yes forever for a session that has since imported.
  if (ledger.unreadable != null) delete ledger.unreadable[sessionId];
  ledger.updatedAt = at.toISOString();
  return ledger;
}

// A transcript that could not be read. Deliberately NOT in `sessions`: the session stays eligible,
// so the next run parses it again. It only records that we already gave it one chance, so only the
// first failure counts as retriable and a file that fails deterministically (a permission error
// reads exactly like a transient one) is not reported as retriable forever.
export function markUnreadable(ledger, sessionId, { at = new Date() } = {}) {
  ledger.unreadable[sessionId] = { at: at.toISOString() };
  ledger.updatedAt = at.toISOString();
  return ledger;
}

export function wasUnreadable(ledger, sessionId) {
  const unreadable = ledger == null ? undefined : ledger.unreadable;
  return Object.prototype.hasOwnProperty.call(unreadable == null ? {} : unreadable, sessionId);
}

// 0600 — the ledger records which projects the user worked on, by session id only, but the file
// lives alongside the account's credential store and follows the same rule.
export function saveLedger(key, ledger, tenantId = null) {
  writeJsonSecure(auditLedgerFile(key, tenantId), ledger);
}
