import { auditLedgerFile } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';

const LEDGER_VERSION = 1;

// Which past sessions the history backfill (the last step of /beezi:login) has already handed
// to the server, and what the server said.
//
// This has to be durable in a way ~/.beezi/state/<id>.json is not: pruneStale() deletes anything
// in state/ and queue/ older than 14 days, so a marker there expires and every old session looks
// importable again on the next run. auditLedgerFile() sits at the beeziHome() root, outside the
// dirs pruneStale walks.
//
// The ledger is machine-global but the server's pull record is per (tenant, user, tool), so it
// binds to the login that wrote it: a ledger recorded under another identity is discarded, or a
// logout→login into a different workspace would replay it, find zero candidates, and seal the
// new tenant's pull EMPTY (there is no reopen).
export function loadLedger(identity = null) {
  const raw = readJson(auditLedgerFile(), null);
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

// The pull was sealed server-side (we finalized it, or a chunk answered ALREADY_COMPLETED).
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

export function markImported(ledger, sessionId, { outcome, reports = 0, at = new Date() } = {}) {
  ledger.sessions[sessionId] = { at: at.toISOString(), outcome, reports };
  // A session that read fine this time is not unreadable any more; leaving the marker would make
  // wasUnreadable() answer yes forever for a session that has since imported.
  if (ledger.unreadable != null) delete ledger.unreadable[sessionId];
  ledger.updatedAt = at.toISOString();
  return ledger;
}

// A transcript that could not be read. Deliberately NOT in `sessions`: the session stays eligible,
// so the next run parses it again. It only records that we already gave it one chance, which is
// what lets the pull seal on the second attempt instead of blocking forever on a file that fails
// deterministically (a permission error reads exactly like a transient one).
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
// lives alongside credentials.json and follows the same rule.
export function saveLedger(ledger) {
  writeJsonSecure(auditLedgerFile(), ledger);
}
