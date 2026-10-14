import { runAudit as _runAudit, planWorkspaceRuns as _planWorkspaceRuns, createRunCache as _createRunCache, dontTrackSessionIds, SYNC_MODE } from './session-audit.mjs';
import { BackfillHalt } from './audit-flush.mjs';
import { isMultiTenant } from './workspace.mjs';
import { usesRules } from './workspace-rules.mjs';
import { readSessionShell as _readSessionShell } from './transcript-shell.mjs';
import { pendingHistoryOf, waitingOnRecent, RunOutcome } from './pending-history.mjs';

const REFUSED_REASONS = ['no-account', 'workspace-required', 'audit-only'];
const REFUSED_HALTS = [BackfillHalt.NOT_ALLOWED, BackfillHalt.FORBIDDEN, BackfillHalt.UNSUPPORTED_SERVER];

// One sync-mode run's meaning for the marker; `waiting` = a recent session predates the request.
export function classifyRun(result, waiting) {
  if (result == null) return RunOutcome.FAILED;
  if (result.reason === 'busy') return RunOutcome.BUSY;
  if (REFUSED_REASONS.indexOf(result.reason) !== -1 || REFUSED_HALTS.indexOf(result.halt) !== -1) return RunOutcome.REFUSED;
  if (result.ok !== true || result.reason != null || result.halt != null) return RunOutcome.FAILED;
  if (result.reportsFailed > 0 || (result.coverageKnown === false && result.candidates > 0)) return RunOutcome.FAILED;
  return waiting ? RunOutcome.WAITING : RunOutcome.CLEAN;
}

function startedAtMs(recent, readShell) {
  try {
    const shell = readShell(recent.path);
    const ms = shell == null ? NaN : Date.parse(shell.startedAt);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

// Each pending workspace's runAudit options, as sync plans them; null when no route reaches it.
function plannedRuns(row, entries, planRuns) {
  if (!isMultiTenant(row)) {
    const options = { tenantId: null };
    if (usesRules(row)) options.excludedSessionIds = dontTrackSessionIds(planRuns(row));
    return entries.slice(0, 1).map((entry) => ({ entry, options }));
  }
  const plan = planRuns(row);
  return entries.map((entry) => ({
    entry,
    options: plan.tenantIds.indexOf(entry.tenantId) === -1 ? null : { tenantId: entry.tenantId, sessionRoutes: plan.routes },
  }));
}

async function linkedRow(accounts, key) {
  return (await accounts.listAccounts()).find((a) => a.key === key && a.status === accounts.AccountStatus.LINKED);
}

async function loadAccounts(deps) {
  return deps.accounts == null ? import('./accounts.mjs') : deps.accounts;
}

// Runs every pending workspace of one account once and settles each entry.
export async function runPendingHistory(key, deps = {}) {
  const accounts = await loadAccounts(deps);
  const runAudit = deps.runAudit == null ? _runAudit : deps.runAudit;
  const planRuns = deps.planWorkspaceRuns == null ? _planWorkspaceRuns : deps.planWorkspaceRuns;
  const readShell = deps.readSessionShell == null ? _readSessionShell : deps.readSessionShell;
  const now = deps.now == null ? () => Date.now() : deps.now;
  // Stamped before the row is read: a request written after the read is newer than the plan, so it stays.
  const plannedAtMs = now();
  const row = await linkedRow(accounts, key);
  if (row == null) return [];
  const entries = pendingHistoryOf(row);
  if (entries.length === 0) return [];
  await accounts.notePendingAttempt(key, entries.map((e) => e.tenantId), new Date(plannedAtMs).toISOString());
  // One git cache for every workspace's run, so each session's git correlation runs once.
  const runCache = (deps.createRunCache == null ? _createRunCache : deps.createRunCache)();
  const done = [];
  let busy = false;
  for (const { entry, options } of plannedRuns(row, entries, planRuns)) {
    let run = { outcome: busy ? RunOutcome.BUSY : RunOutcome.CLEAN, sent: 0, skipped: 0 };
    if (!busy && options != null) {
      // A throwing run settles as failed (classifyRun's null) rather than leaving the entry unsettled.
      const result = await runAudit({ runCache }, { ...options, account: key, mode: SYNC_MODE }).catch(() => null);
      const recent = result != null && Array.isArray(result.recent) ? result.recent.map((r) => startedAtMs(r, readShell)) : [];
      run = { outcome: classifyRun(result, waitingOnRecent(recent, entry.requestedAt)), sent: result == null ? 0 : result.sessionsImported || 0, skipped: 0 };
      busy = run.outcome === RunOutcome.BUSY;
    }
    const state = await accounts.settlePendingHistory(key, entry.tenantId, run, { plannedAtMs, nowMs: now() });
    done.push({ tenantId: entry.tenantId, outcome: run.outcome, state });
  }
  return done;
}

// Repeats the pass while a request written during it is still pending (a later answer's rule write), up to
// maxPasses. A pass that met a busy lock stops: its entries are due again at the next retry.
export async function runPendingHistoryPasses(key, deps = {}, maxPasses = 3) {
  const accounts = await loadAccounts(deps);
  const now = deps.now == null ? () => Date.now() : deps.now;
  for (let pass = 1; pass <= maxPasses; pass += 1) {
    const startedMs = now();
    const done = await runPendingHistory(key, deps);
    if (done.length === 0 || done.some((d) => d.outcome === RunOutcome.BUSY)) return;
    const row = await linkedRow(accounts, key);
    if (row == null || !pendingHistoryOf(row).some((e) => Date.parse(e.requestedAt) > startedMs)) return;
  }
}
