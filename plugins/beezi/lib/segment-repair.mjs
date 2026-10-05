import { linkedSessions } from './sessions.mjs';
import { listAllTranscripts } from './transcript-index.mjs';
import { loadLedger as _loadLedger } from './audit-ledger.mjs';
import { fetchCoverage as _fetchCoverage } from './session-coverage.mjs';
import { runAudit as _runAudit, SYNC_MODE } from './session-audit.mjs';
import { BackfillHalt, BackfillSessionStatus } from './audit-flush.mjs';
import { readSyncState, isSegmentRepaired, markSegmentRepaired } from './cost-state-sync-state.mjs';
import { readTrackingState, isTrackingDisabled } from './tracking.mjs';
import { resolveFetch } from './fetch-compat.mjs';

// Retrying these cannot help: the workspace refuses uploads for good, so the repair stops asking.
const FINAL_HALTS = [BackfillHalt.NOT_ALLOWED, BackfillHalt.ALREADY_COMPLETED];

// Before 0.32.2 the backfill and /beezi:sync uploaded a session's Claude Code cost record INSTEAD of
// its segments. The server holds every such session with billing 'unknown' and no plan,
// operations, subagents or timeline. /beezi:sync repairs them, but only when the user runs it —
// this is the same repair, run by the hourly background worker so nobody has to.
//
// Scoped to exactly those sessions, never the whole history: an unprompted upload of sessions the
// user never sent is not this job's call.
// 1. The ledger names the candidates — an accepted Claude Code session that went up with zero
//    reports. Loaded under the CURRENT login's identity, so a ledger left by another workspace's
//    login can never push its sessions into this one.
// 2. Coverage narrows them to the ones the server holds no segments for. A live-tracked session
//    that only got a cost-record overlay is in the ledger too, but is not broken — and re-parsing it
//    every hour would cost a full transcript read for nothing.
// 3. The rest goes through the regular sync path, which resumes them from line 0 and sends the
//    cost record alongside the segments.
//
// A repaired session gains coverage and drops out on its own, so a pass cut short by the deadline
// still makes progress. The account is stamped done once a pass leaves nothing it can fix — a
// session that cannot be segmented (no working directory) stays at coverage 0 for good, and
// without the stamp it would be re-read every hour forever.
export async function runSegmentRepair(deps = {}, options = {}) {
  const getSessions = deps.linkedSessions == null ? linkedSessions : deps.linkedSessions;
  const readTracking = deps.readTrackingState == null ? readTrackingState : deps.readTrackingState;
  const readState = deps.readState == null ? readSyncState : deps.readState;
  const sessions = await getSessions(deps);
  const results = [];
  for (const session of sessions) {
    if (isTrackingDisabled(readTracking(session.key))) continue;
    if (isSegmentRepaired(readState({ account: session.key }))) continue;
    results.push({ key: session.key, ...await repairAccount(session, deps, options) });
  }
  return { results };
}

async function repairAccount(session, deps, options) {
  const loadLedger = deps.loadLedgerImpl == null ? _loadLedger : deps.loadLedgerImpl;
  const listTranscripts = deps.listTranscripts == null ? listAllTranscripts : deps.listTranscripts;
  const fetchCoverage = deps.fetchCoverageImpl == null ? _fetchCoverage : deps.fetchCoverageImpl;
  const runAudit = deps.runAuditImpl == null ? _runAudit : deps.runAuditImpl;
  const markRepaired = deps.markSegmentRepairedImpl == null ? markSegmentRepaired : deps.markSegmentRepairedImpl;
  const now = deps.now == null ? (() => Date.now()) : deps.now;
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const done = () => { markRepaired(now(), { account: session.key }); };
  // runAudit only consults the deadline between batches, after it has taken the session-audit lock
  // and spent round trips on auth, whoami and coverage. Out of time already? Leave it for the next
  // pass rather than start work the watchdog would kill with that lock still held.
  const deadlineMs = options.deadlineMs;
  const outOfTime = () => deadlineMs != null && now() >= deadlineMs;
  if (outOfTime()) return { repaired: false, reason: 'deadline' };

  // No identity to bind the ledger to means no way to tell this login's sessions from another's.
  if (session.token == null || session.clientId == null) return { repaired: false, reason: 'not-linked' };

  const ledger = loadLedger(session.key, session.clientId);
  const suspects = new Set();
  for (const sessionId of Object.keys(ledger.sessions)) {
    const entry = ledger.sessions[sessionId];
    if (entry == null || entry.reports !== 0) continue;
    if (entry.outcome !== BackfillSessionStatus.ACCEPTED && entry.outcome !== BackfillSessionStatus.PARTIAL) continue;
    suspects.add(sessionId);
  }
  // listAllTranscripts is Claude Code only. A Cowork session never has segments, so it is excluded
  // by construction rather than by a check that could drift.
  const transcripts = suspects.size === 0 ? [] : listTranscripts().filter((entry) => suspects.has(entry.sessionId));
  if (transcripts.length === 0) { done(); return { repaired: true, candidates: 0 }; }

  // Null is "could not ask", not "nothing stored" — repairing on it would re-parse every suspect.
  const coverage = await fetchCoverage(transcripts.map((entry) => entry.sessionId), session, { fetchImpl });
  if (coverage == null) return { repaired: false, reason: 'coverage-unavailable' };
  const broken = transcripts.filter((entry) => !coverage.has(entry.sessionId));
  if (broken.length === 0) { done(); return { repaired: true, candidates: 0 }; }
  if (outOfTime()) return { repaired: false, reason: 'deadline' };

  // Halt at a batch boundary before the worker's watchdog kills the process mid-upload. The batch
  // dropped by the halt stays at coverage 0 and is picked up on the next pass.
  const result = await runAudit(
    {
      ...deps,
      fetchImpl,
      listTranscripts: () => broken,
      shouldContinue: () => !outOfTime(),
    },
    { mode: SYNC_MODE, account: session.key },
  );

  const final = result.halt != null && FINAL_HALTS.indexOf(result.halt) >= 0;
  // A transcript that failed to read for the first time gets one more pass, as in shouldFinalize;
  // the ledger's unreadable marker lets the pass after that stamp the account regardless.
  const clean = result.ok === true && result.halt == null &&
    result.reportsFailed === 0 && result.costStatesFailed === 0 && result.unattributed === 0 &&
    !(result.retriableUnreadable > 0);
  if (final || clean) done();
  return {
    repaired: final || clean,
    candidates: broken.length,
    reason: result.reason == null ? result.halt : result.reason,
    sessionsImported: result.sessionsImported,
  };
}
