import { runAudit as _runAudit, planWorkspaceRuns as _planWorkspaceRuns, createRunCache as _createRunCache, AuditReason } from './session-audit.mjs';
import { BackfillHalt } from './audit-flush.mjs';
import { readSessionShell as _readSessionShell } from './transcript-shell.mjs';
import { pendingHistoryOf, waitingOnRecent, RunOutcome } from './pending-history.mjs';
import {
  OfferEngine, coverageUnknown, replayOptions, offerTenantKey, answeredBy, readOffer as _readOffer, removeOffer as _removeOffer,
} from './history-offer.mjs';
import { createProgressWriter as _createProgressWriter } from './upload-progress.mjs';
import { tenantById } from './workspace.mjs';

const REFUSED_REASONS = [AuditReason.NO_ACCOUNT, AuditReason.WORKSPACE_REQUIRED, AuditReason.AUDIT_ONLY, AuditReason.ALREADY_COMPLETED];
const REFUSED_HALTS = [BackfillHalt.ALREADY_COMPLETED, BackfillHalt.NOT_ALLOWED, BackfillHalt.FORBIDDEN, BackfillHalt.UNSUPPORTED_SERVER];

// One run's meaning for the marker; `waiting` = a recent session predates the request. Only sync runs ask coverage.
export function classifyRun(result, waiting, engine = OfferEngine.SYNC) {
  if (result == null) return RunOutcome.FAILED;
  if (result.reason === AuditReason.BUSY) return RunOutcome.BUSY;
  if (REFUSED_REASONS.indexOf(result.reason) !== -1 || REFUSED_HALTS.indexOf(result.halt) !== -1) return RunOutcome.REFUSED;
  if (result.ok !== true || result.reason != null || result.halt != null) return RunOutcome.FAILED;
  if (result.reportsFailed > 0) return RunOutcome.FAILED;
  if (engine !== OfferEngine.BACKFILL && coverageUnknown(result)) return RunOutcome.FAILED;
  // Sessions held back because the live queue still holds their reports: the uploader is mid-drain,
  // so retry soon like a busy run instead of closing the request with them left out.
  if (result.pendingLive > 0) return RunOutcome.BUSY;
  return waiting ? RunOutcome.WAITING : RunOutcome.CLEAN;
}

export function workspaceName(row, tenantId) {
  const t = tenantById(row, tenantId);
  if (t != null && t.name) return t.name;
  if (row.tenantName) return row.tenantName;
  return tenantId == null ? 'your workspace' : tenantId;
}

// A progress-record write is best-effort: one that fails never fails or changes the upload.
function quietly(write) {
  try {
    write();
  } catch {}
}

// runAudit under `runDeps`, also writing the run's progress record through `writer`; the run's result. The record
// finishes failed unless the run ended clean under `engine`, and reported when the caller prints the result itself.
export async function runWithProgress(runAudit, runDeps, options, writer, { engine = OfferEngine.SYNC, reported = false } = {}) {
  let counts = { processed: 0, total: 0, sent: 0 };
  const onProgress = (p) => {
    if (runDeps.onProgress != null) runDeps.onProgress(p);
    counts = { processed: p.processed, total: p.total, sent: p.sessionsImported };
    quietly(() => writer.update(counts));
  };
  let result = null;
  try {
    result = await runAudit({ ...runDeps, onProgress }, options);
    return result;
  } finally {
    // A run that met another run's lock leaves that run's record alone.
    if (result == null || result.reason !== AuditReason.BUSY) {
      const failed = classifyRun(result, false, engine) !== RunOutcome.CLEAN;
      quietly(() => writer.finish(counts, { failed, reported }));
    }
  }
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

// Each consented workspace with the offer accepted for it and its replay options; options are null without one.
function plannedRuns(row, entries, planWorkspaceRuns) {
  let plan = null;
  const planOnce = (r) => {
    if (plan == null) plan = planWorkspaceRuns(r);
    return plan;
  };
  return entries.map((entry) => {
    const offer = entry.accepted != null && Array.isArray(entry.accepted.sessionIds) ? entry.accepted : null;
    const options = offer == null ? null : replayOptions(row, entry.tenantId, offer, { planWorkspaceRuns: planOnce });
    return { entry, tenantKey: offerTenantKey(row, entry.tenantId), offer, options };
  });
}

async function linkedRow(accounts, key) {
  return (await accounts.listAccounts()).find((a) => a.key === key && a.status === accounts.AccountStatus.LINKED);
}

async function loadAccounts(deps) {
  return deps.accounts == null ? import('./accounts.mjs') : deps.accounts;
}

// Runs every consented workspace of one account once and settles each entry; the workspace's current choice is not consulted (K6).
export async function runPendingHistory(key, deps = {}) {
  const accounts = await loadAccounts(deps);
  const runAudit = deps.runAudit == null ? _runAudit : deps.runAudit;
  const readShell = deps.readSessionShell == null ? _readSessionShell : deps.readSessionShell;
  const readOffer = deps.readOffer == null ? _readOffer : deps.readOffer;
  const removeOffer = deps.removeOffer == null ? _removeOffer : deps.removeOffer;
  const createWriter = deps.createProgressWriter == null ? _createProgressWriter : deps.createProgressWriter;
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
  const runs = plannedRuns(row, entries, deps.planWorkspaceRuns == null ? _planWorkspaceRuns : deps.planWorkspaceRuns);
  const done = [];
  let busy = false;
  for (const { entry, tenantKey, offer, options } of runs) {
    let run = { outcome: busy ? RunOutcome.BUSY : RunOutcome.REFUSED, sent: 0, skipped: 0 };
    if (!busy && options != null) {
      // A throwing run settles as failed (classifyRun's null) rather than leaving the entry unsettled.
      const writer = createWriter({ key, tenantId: tenantKey, workspace: workspaceName(row, entry.tenantId) });
      const result = await runWithProgress(runAudit, { runCache }, options, writer, { engine: offer.engine }).catch(() => null);
      const recent = result != null && Array.isArray(result.recent) ? result.recent.map((r) => startedAtMs(r, readShell)) : [];
      run = { outcome: classifyRun(result, waitingOnRecent(recent, entry.requestedAt), offer.engine), sent: result == null ? 0 : result.sessionsImported || 0, skipped: 0 };
      busy = run.outcome === RunOutcome.BUSY;
    }
    // Only a run that answered the offer file now on disk settles it; a newer question stays (final M3).
    if (run.outcome === RunOutcome.CLEAN && answeredBy(readOffer(key, tenantKey), offer.sessionIds)) {
      // Nothing settles while a session the offer covers is still open (final M6).
      if (offer.active === 0) await accounts.recordOfferSettled(key, tenantKey, { changedAt: offer.changedAt == null ? null : offer.changedAt });
      else await accounts.recordOfferRescan(key, tenantKey);
      removeOffer(key, tenantKey);
    }
    const state = await accounts.settlePendingHistory(key, entry.tenantId, run, { plannedAtMs, nowMs: now() });
    done.push({ tenantId: entry.tenantId, outcome: run.outcome, state });
  }
  return done;
}

// Repeats the pass while a request written during it is still pending (a later Upload), up to
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
