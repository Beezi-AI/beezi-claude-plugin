// Pure helpers for the per-account pending-history marker and its notice results; no I/O.

export const HISTORY_RETRY_MS = 60 * 60 * 1000;
export const HISTORY_GIVE_UP_MS = 7 * 24 * 60 * 60 * 1000;
export const HISTORY_RETRY_NOTICE_AT = 3;
// A run refused because another held the lock is due again this soon, not in an hour and not on the next watcher tick.
export const HISTORY_BUSY_RETRY_MS = 5 * 60 * 1000;
// A pass stamped this long ago and never settled died (the worker's watchdog is 30 minutes).
export const HISTORY_PASS_MAX_MS = 40 * 60 * 1000;

export const HistoryStatus = Object.freeze({ SENT: 'sent', RETRYING: 'retrying', GAVE_UP: 'gave-up' });

// clean: nothing left to do; waiting: sessions that predate the request were skipped as recent;
// failed: worth retrying; refused: the server will not take it; busy: another run holds the lock.
export const RunOutcome = Object.freeze({
  CLEAN: 'clean', WAITING: 'waiting', FAILED: 'failed', REFUSED: 'refused', BUSY: 'busy',
});

export const SettleState = Object.freeze({ CLEARED: 'cleared', KEPT: 'kept', GAVE_UP: 'gave-up', MISSING: 'missing' });

function memberIds(row) {
  return Array.isArray(row.tenants)
    ? row.tenants.filter((t) => t != null && typeof t.id === 'string').map((t) => t.id)
    : [];
}

function entriesOf(row) {
  return Array.isArray(row.pendingHistory)
    ? row.pendingHistory.filter((e) => e != null && typeof e.tenantId === 'string')
    : [];
}

function count(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

// New folders "send" targets that are still workspaces of a multi-workspace account.
export function newFoldersSendIds(row) {
  const members = memberIds(row);
  const nf = row.newFolders;
  if (members.length < 2 || nf == null || nf.mode !== 'send' || !Array.isArray(nf.tenantIds)) return [];
  return nf.tenantIds.filter((id) => members.indexOf(id) !== -1);
}

// Every workspace a written rule sends to (members only, in member order); a one-workspace account sends unless the rule is [].
// Requesting ids the place already sent to is harmless: the worker uploads only sessions a workspace lacks.
export function ruleRequestIds(row, tenantIds) {
  const members = memberIds(row);
  if (members.length === 1) return tenantIds.length === 0 ? [] : members;
  return members.filter((id) => tenantIds.indexOf(id) !== -1);
}

// After a rule is removed its places fall through to some remaining rule or New folders "send", so this requests
// every member those still reach (a one-workspace account: its workspace); over-requesting is harmless, as above.
export function removalRequestIds(row) {
  const members = memberIds(row);
  if (members.length === 1) return members;
  const rules = Array.isArray(row.workspaceRules) ? row.workspaceRules : [];
  const reached = newFoldersSendIds(row);
  for (const r of rules) if (r != null && Array.isArray(r.tenantIds)) reached.push(...r.tenantIds);
  return members.filter((id) => reached.indexOf(id) !== -1);
}

// Ids in `after` that `before` lacks, once each, in `after` order.
export function gainedIds(before, after) {
  return after.filter((id, i) => before.indexOf(id) === -1 && after.indexOf(id) === i);
}

// Adds an entry per gained workspace, or refreshes one (due now, counts kept); drops workspaces the account left.
export function requestHistory(row, tenantIds, nowIso) {
  const members = memberIds(row);
  const entries = entriesOf(row).filter((e) => members.indexOf(e.tenantId) !== -1);
  for (const id of tenantIds) {
    if (members.indexOf(id) === -1) continue;
    const found = entries.find((e) => e.tenantId === id);
    if (found != null) {
      found.requestedAt = nowIso;
      found.lastAttemptAt = null;
      continue;
    }
    entries.push({ tenantId: id, requestedAt: nowIso, attempts: 0, lastAttemptAt: null, inFlight: false, sent: 0, skipped: 0, retryNoticed: false });
  }
  if (entries.length > 0 || Array.isArray(row.pendingHistory)) row.pendingHistory = entries;
  return entries;
}

export function pendingHistoryOf(row) {
  const members = memberIds(row);
  return entriesOf(row).filter((e) => members.indexOf(e.tenantId) !== -1);
}

// A retry trigger may start the worker: some entry was never tried, or not within the hour.
export function historyDue(row, nowMs) {
  return pendingHistoryOf(row).some((e) => {
    const last = typeof e.lastAttemptAt === 'string' ? Date.parse(e.lastAttemptAt) : NaN;
    return !Number.isFinite(last) || last > nowMs || nowMs - last >= HISTORY_RETRY_MS;
  });
}

// Stamps the start of a pass; one still in flight from a pass long past its watchdog died, and counts as failed.
export function noteAttempt(row, tenantIds, nowIso) {
  const nowMs = Date.parse(nowIso);
  for (const e of entriesOf(row)) {
    if (tenantIds.indexOf(e.tenantId) === -1) continue;
    const last = typeof e.lastAttemptAt === 'string' ? Date.parse(e.lastAttemptAt) : NaN;
    if (e.inFlight === true && nowMs - last >= HISTORY_PASS_MAX_MS) countFailure(row, e);
    e.inFlight = true;
    e.lastAttemptAt = nowIso;
  }
}

function addResult(row, tenantId, status, sent, skipped) {
  const results = Array.isArray(row.historyResults) ? row.historyResults : [];
  results.push({ tenantId, status, sent, skipped });
  row.historyResults = results;
}

// One more failed attempt; the third adds the single retrying result.
function countFailure(row, entry) {
  entry.attempts = count(entry.attempts) + 1;
  if (entry.attempts >= HISTORY_RETRY_NOTICE_AT && entry.retryNoticed !== true) {
    entry.retryNoticed = true;
    addResult(row, entry.tenantId, HistoryStatus.RETRYING, 0, 0);
  }
}

// Applies one run to the workspace's entry. `run` = { outcome, sent, skipped }; `plannedAtMs` = when the run built its plan.
export function settleHistory(row, tenantId, run, { plannedAtMs, nowMs }) {
  const entries = entriesOf(row);
  const entry = entries.find((e) => e.tenantId === tenantId);
  if (entry == null) return SettleState.MISSING;
  entry.inFlight = false;
  entry.sent = count(entry.sent) + count(run.sent);
  entry.skipped = count(entry.skipped) + count(run.skipped);
  if (run.outcome === RunOutcome.BUSY) entry.lastAttemptAt = new Date(nowMs - HISTORY_RETRY_MS + HISTORY_BUSY_RETRY_MS).toISOString();
  if (run.outcome === RunOutcome.FAILED) countFailure(row, entry);
  const requestedMs = Date.parse(entry.requestedAt);
  // A request newer than the plan was not covered by this run.
  const coveredByRun = Number.isFinite(requestedMs) && requestedMs <= plannedAtMs;
  let state = SettleState.KEPT;
  if (run.outcome === RunOutcome.CLEAN && coveredByRun) {
    if (entry.sent > 0 || entry.skipped > 0) addResult(row, tenantId, HistoryStatus.SENT, entry.sent, entry.skipped);
    state = SettleState.CLEARED;
  } else if (run.outcome === RunOutcome.REFUSED || !Number.isFinite(requestedMs) || nowMs - requestedMs >= HISTORY_GIVE_UP_MS) {
    // A week spent only waiting on open sessions (or a busy lock) is not a failure: report what was sent.
    const failed = run.outcome === RunOutcome.REFUSED || count(entry.attempts) > 0;
    if (failed) addResult(row, tenantId, HistoryStatus.GAVE_UP, entry.sent, entry.skipped);
    else if (entry.sent > 0 || entry.skipped > 0) addResult(row, tenantId, HistoryStatus.SENT, entry.sent, entry.skipped);
    state = failed ? SettleState.GAVE_UP : SettleState.CLEARED;
  }
  row.pendingHistory = state === SettleState.KEPT ? entries : entries.filter((e) => e !== entry);
  return state;
}

// Removes and returns up to `limit` results (all when limit is null), oldest first.
export function takeResults(row, limit = null) {
  const results = Array.isArray(row.historyResults) ? row.historyResults.filter((r) => r != null && typeof r.tenantId === 'string') : [];
  const taken = limit == null ? results : results.slice(0, limit);
  row.historyResults = results.slice(taken.length);
  return taken;
}

function sessions(n) {
  return `${n} past session${n === 1 ? '' : 's'}`;
}

// One notice line per result; `nameOf(id)` names a workspace, `prefix` is "Beezi" or "Beezi (<email>)".
export function resultLine(result, { prefix, nameOf, syncName }) {
  const name = nameOf(result.tenantId);
  if (result.status === HistoryStatus.RETRYING) return `${prefix}: couldn't send history to ${name} yet, will retry.`;
  if (result.status === HistoryStatus.GAVE_UP) return `${prefix}: couldn't send history to ${name}. Run ${syncName} to try again.`;
  const skipped = count(result.skipped);
  const tail = skipped > 0 ? `; ${skipped} couldn't be matched safely and were skipped.` : '.';
  return `${prefix}: sent ${sessions(count(result.sent))} to ${name}${tail}`;
}

// A pass is waiting when a session skipped as recent started before the request. An unknown start counts as
// after: a session older than the request already has a readable first record.
export function waitingOnRecent(recentStartsMs, requestedAtIso) {
  const requestedMs = Date.parse(requestedAtIso);
  if (!Number.isFinite(requestedMs)) return false;
  return recentStartsMs.some((ms) => ms != null && Number.isFinite(ms) && ms <= requestedMs);
}
