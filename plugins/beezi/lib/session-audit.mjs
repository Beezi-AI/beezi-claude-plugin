import fs from 'fs';
import path from 'path';
import { sessionFor as _sessionFor } from './sessions.mjs';
import { getAuthentication as _getAuthentication, getAccessToken as _getAccessToken, INTERACTIVE_REFRESH_WAIT_MS } from './token.mjs';
import { AUTH_STATES } from './auth-state.mjs';
import { runCheckpoint as _runCheckpoint, flushQueue as _flushQueue } from './checkpoint.mjs';
import { git } from './git.mjs';
import { memoizeGit } from './git-memo.mjs';
import { listAllTranscripts as _listAllTranscripts, firstRecordedCwd as _firstRecordedCwd } from './transcript-index.mjs';
import {
  loadLedger as _loadLedger,
  saveLedger as _saveLedger,
  isImported,
  markImported,
  markUnreadable,
  wasUnreadable,
  markComplete,
  isComplete,
} from './audit-ledger.mjs';
import {
  flushBackfillChunks as _flushBackfillChunks,
  planChunks,
  BackfillSessionStatus,
  BackfillHalt,
  MAX_BODY_BYTES,
  MAX_CHUNK_ITEMS,
} from './audit-flush.mjs';
import { ENDPOINTS } from './config.mjs';
import { readLastCostState as _readLastCostState, toCostStateItem } from './cost-state.mjs';
import { listAnalyticsSessions } from './analytics-sessions.mjs';
import { nonRegressingSnapshot, sameCumulativeUsage } from './cowork-snapshot.mjs';
import { acquireOwnedLock } from './single-instance-lock.mjs';
import { drainQueueLocked, queuedSessionNames, queueSessionName } from './upload-drain.mjs';
import { readSessionShell as _readSessionShell } from './transcript-shell.mjs';
import { sessionNameFrom as _sessionNameFrom } from './session-name.mjs';
import { loadRepoMap as _loadRepoMap, resolveRemoteOffline } from './repo-map.mjs';
import { fetchCoverage as _fetchCoverage } from './session-coverage.mjs';
import { computeSessionTimeline as _computeSessionTimeline } from './session-timeline.mjs';
import { createTranscriptMemo } from './transcript-memo.mjs';
import { postSessionError as _postSessionError } from './session-error-report.mjs';
import { resolveSessionTranscript } from './transcript.mjs';
import { isMultiTenant, tenantsOf } from './workspace.mjs';
import { createRouteContext, planSessionRoutes } from './workspace-rules.mjs';
import { resolveFetch } from './fetch-compat.mjs';
import { whoami as _whoami } from './whoami.mjs';
import { bindInstallationIfNeeded as _bindInstallationIfNeeded } from './installation-binding.mjs';
import { readUsageUtilization as _readUsageUtilization } from './usage-utilization.mjs';
import { readClaudeAccount as _readClaudeAccount } from './claude-account.mjs';
import {
  readTrackingState,
  matchesIdentity,
  isLiveTrackingAllowed,
  isTenantDark,
  markBackfillCompleted,
  recordWhoami,
  TrackingMode,
} from './tracking.mjs';
import { UserError } from './friendly-error.mjs';
import { anonymizationFor } from './anonymization.mjs';

// Error posts are single small upserts, so a little parallelism is free — but not unbounded,
// or a 200-session run opens 200 sockets at once.
const FOLLOWUP_CONCURRENCY = 4;

const AUDIT_TIMEOUT_MS = 60_000;

// At most two chunk POSTs in flight: what today's server takes safely; more needs server work first.
const UPLOAD_LANES = 2;

// The repeatable sync engine: it resumes each session from the coverage the server reports.
export const SYNC_MODE = 'sync';

// Why a run stopped before uploading anything; read by the scripts and the history worker.
export const AuditReason = Object.freeze({
  NO_ACCOUNT: 'no-account',
  AUTH_UNAVAILABLE: 'auth-unavailable',
  WORKSPACE_REQUIRED: 'workspace-required',
  ALREADY_COMPLETED: 'already-completed',
  AUDIT_ONLY: 'audit-only',
  BUSY: 'busy',
});

// Refreshes the session-audit lock well inside LOCK_STALE_MS so a long history run is never broken into.
const AUDIT_LOCK_HEARTBEAT_MS = 60 * 1000;

// A transcript touched this recently is probably an OPEN session in another window: its hooks are
// mid-flight between checkpoints, and backfilling it would re-segment the same lines on different
// boundaries than the next live report — double-counted spend. Skip and let the user rerun.
const ACTIVE_SESSION_WINDOW_MS = 30 * 60 * 1000;

const SINCE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

// The server's cap on a cost-state shell's repo_urls entries. Mirrored here because one over-long
// field 400s the whole chunk, and on this path that chunk is the session's entire cost record.
const MAX_REPO_URL_LENGTH = 500;

// Same shape as lib/billing-capture.mjs: a plain loop, `argv[++i]` for valued flags, UserError for
// anything malformed so the script surfaces it verbatim.
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--force') out.force = true;
    else if (flag === '--dry-run') out.dryRun = true;
    else if (flag === '--since') out.since = argv[++i];
    else if (flag === '--via') out.via = argv[++i];
  }
  if (out.since != null) {
    const since = String(out.since);
    if (!SINCE_FORMAT.test(since) || Number.isNaN(Date.parse(since))) {
      throw new UserError('Beezi: --since expects a date like 2026-01-31.');
    }
    out.sinceMs = Date.parse(since);
  }
  return out;
}

// The session this command is running inside. It is already tracked, and its hooks own
// ~/.beezi/state/<id>.json concurrently — auditing it would race them over the cursor.
function liveSessionId(env, deps) {
  const fromEnv = env.CLAUDE_CODE_SESSION_ID;
  if (fromEnv) return fromEnv;
  try {
    const resolveImpl = deps.resolveSessionTranscriptImpl == null ? resolveSessionTranscript : deps.resolveSessionTranscriptImpl;
    const resolved = resolveImpl(process.cwd(), { env });
    if (resolved == null || resolved.sessionId == null) return null;
    return resolved.sessionId;
  } catch {
    return null;
  }
}

// Run `worker` over `items` with at most `limit` in flight.
async function mapLimited(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      await worker(item);
    }
  });
  await Promise.all(runners);
}

// Calls `read` on first use only and keeps its answer for the run; a throw is kept as null, as runCheckpoint's own catch makes it.
function readOnce(read) {
  let done = false;
  let value = null;
  return () => {
    if (!done) {
      done = true;
      try { value = read(); } catch { value = null; }
    }
    return value;
  };
}

// Routes every past session of a multi-workspace account (its rule, else New folders) and lists the workspaces any route reaches, in row order.
export function planWorkspaceRuns(row) {
  const entries = _listAllTranscripts();
  const routes = planSessionRoutes(row, entries, createRouteContext());
  const counts = { rule: 0, 'new-folders': 0, none: 0, pending: 0 };
  const reached = new Set();
  for (const route of routes.values()) {
    if (counts[route.source] != null) counts[route.source] += 1;
    for (const id of route.tenantIds) reached.add(id);
  }
  const tenantIds = (tenantsOf(row) || []).map((t) => t.id).filter((id) => reached.has(id));
  return { scanned: entries.length, routes, counts, tenantIds };
}

// Sessions a run skipped for being open or just touched: the history worker waits for the ones older than its request.
function noteRecent(result, entry) {
  if (typeof entry.transcriptPath === 'string') result.recent.push({ sessionId: entry.sessionId, path: entry.transcriptPath });
}

// A one-workspace account's Don't-track sessions, from a planWorkspaceRuns plan.
export function dontTrackSessionIds(plan) {
  return new Set([...plan.routes].filter(([, route]) => route.source === 'rule' && route.tenantIds.length === 0).map(([sessionId]) => sessionId));
}

// A memoized git and repo-root map; one per process lets every workspace's run reuse the same git answers.
export function createRunCache() {
  return { git: memoizeGit(git), gitRoots: new Map() };
}

// Backfill every past session on this machine into Beezi via the chunked backfill route.
// Timelines ride IN the chunk payload (the tracking-gated standalone
// timeline route is unreachable for audit tenants); only rate-limit error reports remain a
// live-only follow-up — and only for sessions the server judged accepted, so a failed session
// stays fully retryable.
export async function runAudit(deps = {}, options = {}) {
  if (options.account == null) return runAuditUnlocked(deps, options);
  const acquire = deps.acquireAuditLock == null ? acquireOwnedLock : deps.acquireAuditLock;
  const lock = acquire('session-audit');
  if (lock == null) return { ok: false, reason: AuditReason.BUSY, scanned: 0 };
  const heartbeat = setInterval(() => { lock.refresh(); }, AUDIT_LOCK_HEARTBEAT_MS);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();
  try { return await runAuditUnlocked(deps, options); }
  finally {
    clearInterval(heartbeat);
    lock.release();
  }
}

async function runAuditUnlocked(deps, options) {
  const getAuthentication = deps.getAuthentication == null ? _getAuthentication : deps.getAuthentication;
  const listTranscripts = deps.listTranscripts == null ? listAnalyticsSessions : deps.listTranscripts;
  const recordedCwd = deps.firstRecordedCwd == null ? _firstRecordedCwd : deps.firstRecordedCwd;
  const runCheckpoint = deps.runCheckpointImpl == null ? _runCheckpoint : deps.runCheckpointImpl;
  const flushBackfillChunks = deps.flushBackfillChunksImpl == null ? _flushBackfillChunks : deps.flushBackfillChunksImpl;
  const loadLedger = deps.loadLedgerImpl == null ? _loadLedger : deps.loadLedgerImpl;
  const saveLedger = deps.saveLedgerImpl == null ? _saveLedger : deps.saveLedgerImpl;
  const fetchCoverage = deps.fetchCoverageImpl == null ? _fetchCoverage : deps.fetchCoverageImpl;
  const flushQueue = deps.flushQueueImpl == null ? _flushQueue : deps.flushQueueImpl;
  const computeSessionTimeline = deps.computeSessionTimelineImpl == null ? _computeSessionTimeline : deps.computeSessionTimelineImpl;
  const readCostState = deps.readLastCostStateImpl == null ? _readLastCostState : deps.readLastCostStateImpl;
  const readShell = deps.readSessionShellImpl == null ? _readSessionShell : deps.readSessionShellImpl;
  const sessionNameFrom = deps.sessionNameFromImpl == null ? _sessionNameFrom : deps.sessionNameFromImpl;
  const loadRepoMapImpl = deps.loadRepoMapImpl == null ? _loadRepoMap : deps.loadRepoMapImpl;
  const postSessionError = deps.postSessionErrorImpl == null ? _postSessionError : deps.postSessionErrorImpl;
  const readTracking = deps.readTrackingStateImpl == null ? readTrackingState : deps.readTrackingStateImpl;
  const markCompleted = deps.markBackfillCompletedImpl == null ? markBackfillCompleted : deps.markBackfillCompletedImpl;
  const whoamiImpl = deps.whoamiImpl == null ? _whoami : deps.whoamiImpl;
  const recordWhoamiImpl = deps.recordWhoamiImpl == null ? recordWhoami : deps.recordWhoamiImpl;
  const getAccessTokenImpl = deps.getAccessTokenImpl == null ? _getAccessToken : deps.getAccessTokenImpl;
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const onProgress = deps.onProgress == null ? (() => {}) : deps.onProgress;
  const env = deps.env == null ? process.env : deps.env;
  const now = deps.now == null ? (() => Date.now()) : deps.now;
  const bindInstallation = deps.bindInstallationImpl == null ? _bindInstallationIfNeeded : deps.bindInstallationImpl;
  // ~/.claude.json once per run instead of twice per session, handed to runCheckpoint's own reader seams.
  const readUsageUtilization = readOnce(deps.readUsageUtilizationImpl == null ? _readUsageUtilization : deps.readUsageUtilizationImpl);
  const readClaudeAccount = readOnce(deps.readClaudeAccountImpl == null ? _readClaudeAccount : deps.readClaudeAccountImpl);

  const result = {
    ok: false,
    reason: null,
    halt: null,
    scanned: 0,
    live: 0,
    active: 0,
    // The live and active sessions above that this workspace would take: [{ sessionId, path }].
    recent: [],
    alreadyImported: 0,
    candidates: 0,
    plannedChunks: 0,
    // Reports built and handed to the flush — in a dry run, what WOULD have been sent. Counted in
    // both modes so "stored" has something to be compared against: without it a server that
    // quietly stores fewer than it was sent is undetectable.
    plannedReports: 0,
    // Sessions sent with Claude Code's own whole-session cost record (read off the transcript's
    // tail) — alongside their segments where the segment path produced any.
    costStateSessions: 0,
    // Of those, the ones whose cost record is ALL Beezi gets: no segments sent this run, and none the
    // server is known to hold. They carry no repository split, operations, timeline or billing.
    costStateOnlySessions: 0,
    costStatesStored: 0,
    costStatesSkipped: 0,
    // Cost-state sessions the server never judged. They contribute nothing to reportsFailed (they
    // have no reports), so they are counted separately.
    costStatesFailed: 0,
    costStatesUnsupported: false,
    sessionsImported: 0,
    // Candidates that produced no report, split by cause — every one of these used to vanish
    // between `candidates` and `sessionsImported` with nothing printed, which is why the totals
    // never added up. `empty` is the benign one: the transcript genuinely carries no usage.
    empty: 0,
    noRemote: 0,
    emitFailed: 0,
    // A transcript we could not read, whether the throw escaped runCheckpoint or was caught
    // inside it — the user-visible fact is the same, so it is one number.
    unreadable: 0,
    // Unreadable sessions this run had not already tried; a file that fails again is counted only in `unreadable`.
    retriableUnreadable: 0,
    // Sessions, not reports: reportsRejected counts reports and was never printed at all.
    sessionsRejected: 0,
    reportsStored: 0,
    reportsSkipped: 0,
    itemErrors: 0,
    reportsRejected: 0,
    reportsFailed: 0,
    unattributed: 0,
    permanentRejections: 0,
    // Set when the server said the pull is sealed AND the workspace has no live tracking — the
    // audit window is the only reason to run again, so the summary points at an upgrade.
    upgradeAdvised: false,
    followupsAllowed: true,
    // Sync only: false means the server could not answer, so this run resumed from local cursors.
    coverageKnown: false,
    timelines: 0,
    // Client-side twin of `timelines` (which is purely the server's number), so a gap between
    // what we sent and what landed is attributable instead of a bare unexplained difference.
    timelinesOffered: 0,
    timelinesDropped: 0,
    sessionErrors: 0,
    lastError: null,
    // Multi-workspace runs only: sessions whose route leaves this workspace out.
    routedElsewhere: 0,
    // One-workspace runs only: sessions a matched rule excludes from tracking (`excludedSessionIds`).
    excluded: 0,
    // Every session handed to an upload, dry or real: [{ sessionId, startedAtMs, folder }].
    plannedSessions: [],
    // Sync only: sessions left out of this run because the live queue still holds a report of theirs.
    pendingLive: 0,
  };

  if (options.account == null) { result.reason = AuditReason.NO_ACCOUNT; return result; }
  const key = options.account;
  const auth = await getAuthentication(deps, { account: key, waitMs: INTERACTIVE_REFRESH_WAIT_MS }).catch(() => null);
  if (auth == null || auth.authState !== AUTH_STATES.READY) {
    result.reason = auth != null && auth.authState === AUTH_STATES.UNLINKED ? AuditReason.NO_ACCOUNT : AuditReason.AUTH_UNAVAILABLE;
    result.authState = auth == null ? null : auth.authState;
    result.authReason = auth == null ? null : auth.reason;
    return result;
  }
  const sessionFor = deps.sessionFor == null ? _sessionFor : deps.sessionFor;
  const resolved = await sessionFor(key, { ...deps, getAccessToken: async () => auth.accessToken }).catch(() => null);
  if (resolved == null) { result.reason = AuditReason.NO_ACCOUNT; return result; }
  // --tenant picks the workspace; a single-workspace account goes headerless.
  const tenantId = options.tenantId == null ? null : options.tenantId;
  // A multi-workspace account never sends headerless.
  if (isMultiTenant(resolved) && tenantId == null) { result.reason = AuditReason.WORKSPACE_REQUIRED; return result; }
  // Each workspace of a multi-workspace account keeps its own ledger, so one import never blocks the rest.
  const ledgerTenant = isMultiTenant(resolved) ? tenantId : null;
  // Rebound by renewSession; dispatches and follow-ups read it when they run.
  let session = { ...resolved, token: auth.accessToken, tenantId };
  const identity = session.clientId;
  // Sync drops every gate that encodes one-timeness and every skip keyed on the session id alone;
  // the server's per-session line coverage decides what is already uploaded.
  const syncMode = options.mode === SYNC_MODE;
  const tracking = readTracking(key);
  const trackingValid = matchesIdentity(tracking, identity);

  // Fast path: the local cache already knows the pull is sealed. --force skips the LOCAL
  // caches only — the server verdict below is never bypassed.
  // The sealed flag is per account, so it cannot vouch for one of several workspaces.
  if (!syncMode && !options.force && !isMultiTenant(resolved) && trackingValid && tracking != null && tracking.backfillCompleted === true) {
    result.ok = true;
    result.reason = AuditReason.ALREADY_COMPLETED;
    result.upgradeAdvised = tracking.trackingMode != null && tracking.trackingMode !== TrackingMode.LIVE;
    return result;
  }

  // The server is the authority on "has this pull been used": local caches can be deleted (or
  // a reinstall never had them), and without this check a re-run would re-parse every
  // transcript only to be 403'd on its first chunk. With no valid answer a dry run still counts,
  // but an upload sends nothing (see freshBlock below).
  const who = await whoamiImpl(session, { fetchImpl }).catch(() => null);
  // Every send hides what the owner hides now: the fresh blocks replace the cached row's, never fall back to them.
  const freshBlock = who != null && who.valid ? anonymizationFor(who, tenantId) : null;
  if (who != null && who.valid) {
    session = { ...session, tenants: who.tenants, anonymization: who.anonymization };
    // One workspace's answer must not overwrite a multi-workspace account's cache.
    if (!isMultiTenant(resolved)) {
      try { recordWhoamiImpl(key, who, identity); } catch { /* best-effort */ }
    }
    if (!syncMode && who.backfillCompleted === true) {
      try { markCompleted(key); } catch { /* best-effort */ }
      result.ok = true;
      result.reason = AuditReason.ALREADY_COMPLETED;
      result.upgradeAdvised = who.trackingMode != null && who.trackingMode !== TrackingMode.LIVE;
      return result;
    }
    // liveOnly stops the run before anything is sent when this workspace is not live.
    if (syncMode && options.liveOnly === true && who.trackingMode != null && who.trackingMode !== TrackingMode.LIVE) {
      result.ok = true;
      result.reason = AuditReason.AUDIT_ONLY;
      return result;
    }
  }

  const ledger = loadLedger(key, identity, ledgerTenant);
  if (!syncMode && !options.force && isComplete(ledger)) {
    result.ok = true;
    result.reason = AuditReason.ALREADY_COMPLETED;
    return result;
  }

  // Drain the live queue FIRST. A settled session can still hold an undelivered narrow window in
  // queue/<segmentId>.json; if it landed after this run's wide re-send, the server would hold a
  // narrow row inside a wider one — the one direction its containment supersede cannot dedupe, so
  // both would count in every SUM. Draining first also makes the coverage answer below current.
  // The drain runs under the background uploader's `upload` lock (taken after `session-audit`,
  // never the other way round). If a worker holds it past the bounded wait, report busy before
  // any re-send: an unlocked drain beside the worker could reorder narrow and wide windows.
  if (syncMode && !options.coworkLive) {
    const drained = await drainQueueLocked(session, Object.assign({}, deps.uploadLockDeps, {
      fetchImpl,
      flushQueue,
      acquireLock: deps.acquireUploadLock,
    }));
    if (!drained.locked) return { ok: false, reason: 'busy', scanned: 0 };
  }
  // A drain can leave files queued (5xx, 401, offline, a stopped group). Re-sending such a session
  // from coverage to EOF would post a wide window around a narrow one still queued, and the worker
  // would post the narrow one after it: the order the server counts twice. Those sessions sit this
  // run out and the next sync takes them once their queue has drained. Skipped, never deleted.
  const queuedLive = syncMode ? queuedSessionNames(key) : new Set();

  const live = liveSessionId(env, deps);
  const all = listTranscripts();
  result.coworkWarnings = all.coworkWarnings || 0;
  result.scanned = all.length;

  const activeCutoffMs = now() - ACTIVE_SESSION_WINDOW_MS;
  const sessionRoutes = options.sessionRoutes == null ? null : options.sessionRoutes;
  const excludedSessionIds = options.excludedSessionIds == null ? null : options.excludedSessionIds;
  const offered = options.onlySessionIds == null ? null : new Set(options.onlySessionIds);
  const historyCutoffMs = options.historyCutoffMs == null ? null : options.historyCutoffMs;
  const coworkSince = options.coworkSince == null ? null : options.coworkSince;
  const coworkStartedMs = (entry) => (entry.shell == null ? NaN : Date.parse(entry.shell.startedAt));
  // Non-Cowork entries are tested on their last write; Cowork ones on their start.
  const isAfterLink = (entry) => (entry.source === 'claude-cowork'
    ? coworkStartedMs(entry) >= historyCutoffMs
    : entry.mtimeMs >= historyCutoffMs);
  // An unparsable start fails closed, like a pre-link one; a ledgered session was uploaded before.
  const isCoworkBeforeLink = (entry) => !(coworkStartedMs(entry) >= coworkSince) && ledger.sessions[entry.sessionId] == null;
  const routedHere = (entry) => {
    if (sessionRoutes == null) return true;
    const route = sessionRoutes.get(entry.sessionId);
    return route != null && route.tenantIds.indexOf(tenantId) !== -1;
  };

  const candidates = [];
  for (const entry of all) {
    if (offered != null && !offered.has(entry.sessionId)) continue;
    if (historyCutoffMs != null && isAfterLink(entry)) continue;
    if (coworkSince != null && entry.source === 'claude-cowork' && isCoworkBeforeLink(entry)) continue;
    const liveCowork = options.coworkLive === true && entry.source === 'claude-cowork';
    if (!liveCowork && live && entry.sessionId === live) {
      result.live += 1;
      // The live skip precedes the route filter, so only a session routed here is one to wait on.
      if (routedHere(entry)) noteRecent(result, entry);
      continue;
    }
    // One-workspace accounts only: a matched Don't-track rule. Anything not in the set flows through unchanged.
    if (excludedSessionIds != null && excludedSessionIds.has(entry.sessionId)) { result.excluded += 1; continue; }
    // Filtered before the ledger and the cost-state pass, so a later rule can still send it here.
    if (sessionRoutes != null) {
      const route = sessionRoutes.get(entry.sessionId);
      if (route == null || route.tenantIds.indexOf(tenantId) === -1) { result.routedElsewhere += 1; continue; }
    }
    if (!liveCowork && entry.mtimeMs > activeCutoffMs) { result.active += 1; noteRecent(result, entry); continue; }
    // Session-keyed, so it goes stale the moment a session grows — coverage supersedes it in sync.
    if (!syncMode && !options.force && isImported(ledger, entry.sessionId)) { result.alreadyImported += 1; continue; }
    if (options.sinceMs != null && entry.mtimeMs < options.sinceMs) continue;
    if (queuedLive.has(queueSessionName(entry.sessionId))) { result.pendingLive += 1; continue; }
    candidates.push(entry);
  }
  result.candidates = candidates.length;

  // How far the server already reaches in each session. Asked below, once the fast path has
  // decided which sessions still need a line cursor at all — a cost-state block carries no line
  // window, so a session taking that path has nothing to resume.
  //
  // Null (old server, transport failure) means the answer cannot be trusted, so every session falls
  // back to its local cursor rather than re-sending from line 0 on a blip.
  let coverage = null;

  if (candidates.length === 0) {
    result.ok = true;
    return result;
  }

  // No block for this workspace in the run's own whoami: send nothing, so an owed upload stays owed for a retry.
  if (!options.dryRun && freshBlock == null) {
    result.ok = true;
    result.halt = BackfillHalt.ANONYMIZATION_UNKNOWN;
    result.lastError = BackfillHalt.ANONYMIZATION_UNKNOWN;
    return result;
  }

  // Rate-limit error follow-ups hit a tracking-gated route: a dark-mode tenant would take one
  // 403 per session. Timelines are exempt — they ride inside the backfill chunks themselves.
  const followupsAllowed = isMultiTenant(resolved) ? !isTenantDark(tracking, tenantId) : (!trackingValid || isLiveTrackingAllowed(tracking));
  result.followupsAllowed = followupsAllowed;

  // Accumulated but not yet delivered. Bounded by the same caps the request planner uses, so
  // peak memory stays at roughly one request's worth of payloads regardless of session count.
  let pending = [];
  let pendingBytes = 0;
  let pendingItems = 0;
  // sessionId → what the follow-up phase needs once the server confirms the session landed.
  const followups = new Map();
  let processed = 0;
  let halted = false;

  // Renews the run's token at most once per stale token; concurrent callers share one refresh.
  let renewal = null;
  // Tokens already refreshed from or minted by a refresh; a 401 on one of them answers null with no new refresh.
  const spentTokens = new Set();
  const renewSession = (stale) => {
    if (stale.token !== session.token) return Promise.resolve(session);
    if (renewal != null) return renewal;
    if (spentTokens.has(stale.token)) return Promise.resolve(null);
    spentTokens.add(stale.token);
    renewal = new Promise((resolve) => { resolve(getAccessTokenImpl({}, { account: session.key, forceRefresh: true })); })
      .catch(() => null)
      .then((next) => {
        renewal = null;
        if (!next || next === session.token) return null;
        spentTokens.add(next);
        session = { ...session, token: next };
        return session;
      });
    return renewal;
  };

  // One per run, shared by every flush: the first proxy refusal of gzip turns it off for the rest of the run.
  const compression = { enabled: true };

  const candidateById = new Map(candidates.map((entry) => [entry.sessionId, entry]));
  // Block-only groups for sessions the server already holds segments of: an overlay, not a session the offer counts.
  const overlayOnly = new Set();
  // Sessions whose main transcript the server holds and whose only new reports are subagent ones: sent, but not owed.
  const subagentOnly = new Set();
  const plannedSession = (entry) => {
    const cowork = entry.source === 'claude-cowork';
    let startedAtMs = NaN;
    try {
      const shell = cowork ? entry.shell : readShell(entry.transcriptPath);
      if (shell != null) startedAtMs = Date.parse(shell.startedAt);
    } catch { /* falls back to the last write */ }
    let cwd = null;
    if (!cowork) {
      try { cwd = recordedCwd(entry.transcriptPath); } catch { /* folder unknown */ }
    }
    return {
      sessionId: entry.sessionId,
      startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : entry.mtimeMs,
      folder: cowork ? 'Cowork' : (cwd == null ? null : path.basename(cwd)),
    };
  };

  const dispatchBatch = async (batch) => {
    if (deps.shouldContinue != null && !deps.shouldContinue()) {
      if (result.halt === null) result.halt = 'tracking-stopped';
      halted = true; return;
    }
    result.plannedReports += batch.reduce((sum, g) => sum + g.reports.length, 0);
    for (const group of batch) {
      if (!overlayOnly.has(group.sessionId) && !subagentOnly.has(group.sessionId)) result.plannedSessions.push(plannedSession(candidateById.get(group.sessionId)));
    }
    if (options.dryRun) {
      const chunks = planChunks(batch);
      result.plannedChunks += chunks.length;
      for (const group of batch) followups.delete(group.sessionId);
      return;
    }

    const flushed = await flushBackfillChunks(
      batch,
      session,
      { fetchImpl, renewSession, compression },
      { timeoutMs: AUDIT_TIMEOUT_MS, endpoint: syncMode ? ENDPOINTS.sessionsSync : ENDPOINTS.sessionsBackfill },
    );
    result.plannedChunks += flushed.chunks;
    result.timelinesDropped += flushed.timelinesDropped == null ? 0 : flushed.timelinesDropped;
    result.costStatesStored += flushed.costStatesStored == null ? 0 : flushed.costStatesStored;
    result.costStatesSkipped += flushed.costStatesSkipped == null ? 0 : flushed.costStatesSkipped;
    if (flushed.costStatesUnsupported === true) result.costStatesUnsupported = true;
    result.reportsStored += flushed.stored;
    result.reportsSkipped += flushed.skipped;
    result.timelines += flushed.timelines;
    result.itemErrors += flushed.itemErrors;
    result.unattributed += flushed.unattributed;
    result.permanentRejections += flushed.permanentRejections;
    if (flushed.lastError) result.lastError = flushed.lastError;

    // Follow-ups only for sessions the server accepted — a failed one must stay unledgered so a
    // re-run retries it, and posting a timeline for it would create a session row with no usage.
    const landed = [];
    for (const group of batch) {
      const verdict = flushed.bySession.get(group.sessionId);
      const status = verdict == null || verdict.status == null ? BackfillSessionStatus.FAILED : verdict.status;
      if (status === BackfillSessionStatus.ACCEPTED || status === BackfillSessionStatus.PARTIAL) {
        if (!subagentOnly.has(group.sessionId)) result.sessionsImported += 1;
        landed.push(group.sessionId);
      }
      if (status === BackfillSessionStatus.REJECTED) {
        result.reportsRejected += group.reports.length;
        result.sessionsRejected += 1;
      }
      if (status === BackfillSessionStatus.FAILED) {
        result.reportsFailed += group.reports.length;
        // A cost-record-only group carries no reports, so the line above counts zero for it.
        // A group with reports is already counted there — counting it again would double-report.
        if (group.costState != null && group.reports.length === 0) result.costStatesFailed += 1;
      }
      // Anything the server judged is ledgered, including a rejection: an unconnected repository
      // will reject on every future run too. Failures and unattributed chunks stay eligible.
      if (
        status === BackfillSessionStatus.ACCEPTED ||
        status === BackfillSessionStatus.PARTIAL ||
        status === BackfillSessionStatus.REJECTED
      ) {
        const previousEntry = ledger.sessions[group.sessionId];
        markImported(ledger, group.sessionId, { outcome: status, reports: group.reports.length, consented: options.consented === true });
        if (previousEntry != null && previousEntry.coworkSnapshot != null) {
          ledger.sessions[group.sessionId].coworkSnapshot = previousEntry.coworkSnapshot;
        }
        if (group.cowork === true && status === BackfillSessionStatus.ACCEPTED) {
          ledger.sessions[group.sessionId].coworkSnapshot = group.costState;
        }
      } else {
        followups.delete(group.sessionId);
      }
    }
    // Written per dispatch, not once at the end, so Ctrl-C keeps the progress made so far.
    if (deps.shouldContinue == null || deps.shouldContinue()) {
      try { saveLedger(key, ledger, ledgerTenant); } catch { /* best-effort */ }
    }

    if (flushed.halt) {
      // With two lanes the first halt is the one reported; a later lane must not overwrite it.
      if (result.halt === null) result.halt = flushed.halt;
      halted = true;
      if (flushed.halt === BackfillHalt.ALREADY_COMPLETED) {
        markComplete(ledger);
        try { saveLedger(key, ledger, ledgerTenant); } catch { /* best-effort */ }
        try { markCompleted(key); } catch { /* best-effort */ }
      }
      return;
    }

    if (followupsAllowed) {
      await mapLimited(landed, FOLLOWUP_CONCURRENCY, async (sessionId) => {
        const followup = followups.get(sessionId);
        followups.delete(sessionId);
        if (!followup) return;
        for (const errorPayload of followup.sessionErrors) {
          const { reported } = await postSessionError(errorPayload, session, { fetchImpl, timeoutMs: AUDIT_TIMEOUT_MS });
          if (reported) result.sessionErrors += 1;
        }
      });
    }

    onProgress({ processed, total: candidates.length, ...result });
  };

  // Up to UPLOAD_LANES batches upload while the loop parses; each holds whole sessions, so a split session stays in one flush.
  const flights = new Set();
  let flightError = null;
  // A failed flight surfaces at the next dispatch or the final drain, once every other flight has landed.
  const surfaceFlightError = async () => {
    await Promise.all(flights);
    throw flightError;
  };
  const dispatch = async ({ alone = false } = {}) => {
    if (flightError != null) await surfaceFlightError();
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    pendingBytes = 0;
    pendingItems = 0;
    while (flights.size >= (alone ? 1 : UPLOAD_LANES)) await Promise.race(flights);
    if (flightError != null) await surfaceFlightError();
    // A halt discovered by an earlier flight drops this batch — its sessions stay
    // unledgered and eligible, exactly like the loop break below.
    if (halted) return;
    // The stored promise never rejects, so a failure waits in flightError instead of going unhandled.
    const flight = dispatchBatch(batch).then(
      () => { flights.delete(flight); },
      (error) => {
        flights.delete(flight);
        if (flightError == null) flightError = error;
      },
    );
    flights.add(flight);
  };

  // Only a session's first unreadable run counts as retriable; the ledger marker records the attempt.
  let unreadableDirty = false;
  const noteUnreadable = (sessionId) => {
    if (!wasUnreadable(ledger, sessionId)) result.retriableUnreadable += 1;
    markUnreadable(ledger, sessionId);
    unreadableDirty = true;
  };

  // computeDelta counts lines already consumed, and the server reports to_line 1-based inclusive, so
  // a coverage of N maps straight onto a start cursor of N — the next window opens at line N+1.
  // Backfill reads from line 0.
  const startCursorFor = (sessionId) => {
    if (!syncMode) return 0;
    if (coverage == null) return null;
    const covered = coverage.get(sessionId);
    return covered == null ? 0 : covered;
  };

  // Claude Code writes its OWN whole-session cost accounting into the last records of a
  // transcript. It is more accurate than anything we can tally (advisor iterations and retried API
  // attempts never reach the transcript at all), so when a past session has one it rides along
  // with that session's segments: the server stores both, lets the block supersede only the
  // segment-derived cost and tokens, and keeps everything the block cannot speak for — billing
  // and plan, repository and branch split, subagents, operations (tools, MCP, skills, plugins),
  // effort and mode breakdowns, and the timeline — from the segments.
  //
  // The block goes up ALONE only when the segment path has nothing to give: every line is already
  // on the server (it then overlays the stored segments), or the transcript could not be segmented
  // (no working directory, unreadable, emit failure). For a session Beezi has never seen, that
  // last case is the one where cost is all it gets.
  //
  // Cowork sessions have no transcript to segment, so for them the block is always the whole record.
  //
  // The repo map is loaded ONCE for the run: matchKnownRoot walks its roots per lookup, and this
  // resolves one remote per candidate.
  let repoMap = null;
  const costStateGroupFor = (entry) => {
    let block;
    try {
      block = entry.source === 'claude-cowork' ? entry.costState : readCostState(entry.transcriptPath, entry.sessionId);
    } catch {
      return null;
    }
    if (block == null) return null;
    // captured_at is the file mtime for the same reason the hourly scan uses it: the block itself
    // carries no timestamp. Observability only — never a date basis.
    const item = toCostStateItem(entry.sessionId, block, new Date(entry.mtimeMs).toISOString());
    if (item == null) return null;
    let shell;
    try {
      shell = entry.source === 'claude-cowork' ? entry.shell : readShell(entry.transcriptPath);
    } catch {
      return null;
    }
    // No usable start means no date basis at all: every CLI read filters and buckets on
    // started_at, and the server refuses a retrospective session without one. Hand the session
    // back to the segment path, which can still recover a span from its own timing anchors.
    if (shell == null || shell.startedAt == null) return null;

    let costState = { ...item, started_at: shell.startedAt };
    if (shell.endedAt != null) costState.ended_at = shell.endedAt;
    let name = null;
    try { name = entry.source === 'claude-cowork' ? entry.sessionName : sessionNameFrom(entry.transcriptPath); } catch { /* best-effort */ }
    if (name != null) costState.session_name = name;
    if (shell.cwd != null) {
      try {
        if (repoMap == null) repoMap = loadRepoMapImpl();
        const remote = resolveRemoteOffline(shell.cwd, repoMap);
        // Attribution the block itself cannot carry, recovered git-free from the transcript's own
        // cwd. Best-effort by nature: it is the session's FIRST directory, not a per-segment
        // split, so a session that hopped repositories records only where it started.
        //
        // Dropped rather than clamped past the server's cap: a truncated remote would fabricate a
        // bogus repo key, and sending it whole would 400 the chunk and cost the session its cost
        // record entirely. The session still lands — without repository attribution.
        if (remote != null && remote.length <= MAX_REPO_URL_LENGTH) costState.repo_urls = [remote];
      } catch { /* best-effort */ }
    }
    const cowork = entry.source === 'claude-cowork';
    let unchanged = false;
    if (cowork) {
      const previous = ledger.sessions[entry.sessionId];
      costState = nonRegressingSnapshot(costState, previous == null ? null : previous.coworkSnapshot);
      unchanged = options.coworkLive === true && previous != null && sameCumulativeUsage(costState, previous.coworkSnapshot);
    }
    return { sessionId: entry.sessionId, reports: [], timeline: null, costState: costState, cowork, unchanged };
  };

  // Resolved for every candidate up front: two bounded reads per transcript (a 256KB tail, a 64KB
  // head). Holds one small wire item per session for the length of the run — a few hundred bytes
  // each against the megabytes a single transcript parse costs.
  const costStateBySession = new Map();
  for (const entry of candidates) {
    const group = costStateGroupFor(entry);
    if (group != null) costStateBySession.set(entry.sessionId, group);
  }

  // Every session that goes through the segment path needs its resume point, block or not. A
  // session the server holds only as a cost record has no line coverage, so it resumes from line
  // 0 — which is exactly what backfills its billing, operations and timeline. Cowork sessions are
  // never segmented and so never asked about.
  if (syncMode) {
    const needsCursor = candidates
      .filter((entry) => {
        const group = costStateBySession.get(entry.sessionId);
        return group == null || !group.cowork;
      })
      .map((entry) => entry.sessionId);
    if (needsCursor.length > 0) {
      coverage = await fetchCoverage(needsCursor, session, { fetchImpl });
      result.coverageKnown = coverage != null;
    } else {
      // Nothing needed a cursor, so the resume basis is trivially sound. Reporting this as
      // "unknown" would have /beezi:sync warn that it could not confirm what Beezi already holds —
      // on a run that had nothing to confirm.
      result.coverageKnown = true;
    }
  }

  // The block as it should travel with this session, or null when it must stay home.
  //
  // - repo_urls is dropped whenever the session has segments, here or on the server: the server
  //   UNIONS repo_urls, and the offline-resolved remote can be spelled differently from the
  //   segments' own, which would file one session under two repositories.
  // - A block with unknown-model cost does not supersede the segment tally server-side, so next to
  //   segments both would count in every cost sum. Such a block only goes up for a session that has
  //   no segments anywhere.
  const blockFor = (group, reports) => {
    if (group == null) return null;
    const covered = coverage == null ? null : coverage.get(group.sessionId);
    const hasSegments = reports.length > 0 || (covered != null && covered > 0);
    if (!hasSegments) return { costState: group.costState, only: true };
    if (group.costState.has_unknown_model_cost === true) return null;
    const costState = { ...group.costState };
    delete costState.repo_urls;
    return { costState, only: false };
  };

  // A full batch flies before the next group joins, so batches close where they always did and the last one goes alone.
  const queueGroup = async (group, bytes, items) => {
    if (pending.length > 0 && (pendingBytes >= MAX_BODY_BYTES || pendingItems >= MAX_CHUNK_ITEMS)) await dispatch();
    pending.push(group);
    pendingBytes += bytes;
    pendingItems += items;
  };

  const queueBlockOnly = async (group) => {
    const block = blockFor(group, []);
    if (block == null) return false;
    result.costStateSessions += 1;
    if (block.only) result.costStateOnlySessions += 1;
    else overlayOnly.add(group.sessionId);
    await queueGroup(
      { sessionId: group.sessionId, reports: [], timeline: null, costState: block.costState, cowork: group.cowork },
      Buffer.byteLength(JSON.stringify(block.costState), 'utf-8'),
      1,
    );
    return true;
  };

  // Run-wide memoized git shared by every checkpoint; a caller looping workspaces passes one for all of them.
  const runCache = deps.runCache == null ? createRunCache() : deps.runCache;

  // The installation binding each checkpoint used to attempt, once per run; a Cowork-only run reaches no checkpoint, so it never binds.
  const reachesCheckpoint = candidates.some((entry) => {
    const group = costStateBySession.get(entry.sessionId);
    return group == null || !group.cowork;
  });
  if (reachesCheckpoint) {
    try { await bindInstallation(session, {}); } catch { /* best-effort */ }
  }

  // Parsing itself stays strictly sequential. computeDelta reads and JSON.parses the whole
  // transcript, so parsing sessions in parallel multiplies peak memory with no gain on a
  // single thread.
  try {
    for (const entry of candidates) {
      // One event-loop turn per session so in-flight uploads progress; parsing alone never reaches I/O.
      await new Promise((resolve) => setImmediate(resolve));
      if (halted) break;
      const costGroup = costStateBySession.get(entry.sessionId);
      if (costGroup != null && costGroup.cowork) {
        processed += 1;
        if (costGroup.unchanged) { result.empty += 1; continue; }
        await queueBlockOnly(costGroup);
        continue;
      }
      const reports = [];
      let sessionErrors = [];
      let skipped = null;
      // This session's transcripts are read and parsed once, for its checkpoint and its timeline.
      const transcriptMemo = createTranscriptMemo();
      try {
        const checkpoint = await runCheckpoint(
          {
            session_id: entry.sessionId,
            transcript_path: entry.transcriptPath,
            cwd: recordedCwd(entry.transcriptPath),
          },
          { fetchImpl, runCache, transcriptMemo, readUsageUtilization, readClaudeAccount },
          {
            sessions: [session],
            sink: (payload) => reports.push(payload),
            skipFlush: true,
            collectSessionErrors: true,
            persistState: false,
            skipLiveTrackingGate: true,
            startCursor: startCursorFor(entry.sessionId),
            skipInstallationBinding: true,
          },
        );
        sessionErrors = checkpoint == null || checkpoint.sessionErrors == null ? [] : checkpoint.sessionErrors;
        skipped = checkpoint == null || checkpoint.skipped == null ? null : checkpoint.skipped;
      } catch {
        transcriptMemo.clear();
        processed += 1;
        // The cost record was read off the tail on its own, so the session still lands with it.
        if (await queueBlockOnly(costGroup)) continue;
        // One unreadable transcript must not end the run — but it is no longer silent.
        result.unreadable += 1;
        noteUnreadable(entry.sessionId);
        continue;
      }
      processed += 1;
      if (reports.length === 0) {
        transcriptMemo.clear();
        // Nothing new to segment — every line is already on the server, or the transcript could not
        // be segmented. The block still goes up: as an overlay in the first case, as the session's
        // only record in the second.
        if (await queueBlockOnly(costGroup)) continue;
        // Classify rather than drop on the floor. `empty` is the only benign outcome, so it is the
        // fallback ONLY once every reason worth reporting has been ruled out — telling a user that
        // a session we failed to upload "held no usage data" is the silent loss this exists to end.
        if (skipped != null && skipped.deltaFailed) {
          result.unreadable += 1;
          noteUnreadable(entry.sessionId);
        } else if (skipped != null && skipped.emitFailed != null && skipped.emitFailed > 0) result.emitFailed += 1;
        else if (skipped != null && skipped.noRemote != null && skipped.noRemote > 0) result.noRemote += 1;
        else result.empty += 1;
        continue;
      }

      // Timeline travels with the session's own chunk. Best-effort: a timeline that fails to
      // compute never blocks the usage upload.
      let timeline = null;
      try {
        const computed = computeSessionTimeline(entry.transcriptPath, entry.sessionId, { transcriptMemo });
        if (
          computed &&
          (computed.periods.length > 0 || computed.subagents.length > 0 || computed.plan_events.length > 0)
        ) {
          timeline = { sessionId: entry.sessionId, ...computed };
          result.timelinesOffered += 1;
        }
      } catch { /* best-effort */ }
      // The timeline was the memo's last reader; drop this session's parsed records before queueing.
      transcriptMemo.clear();

      const block = blockFor(costGroup, reports);
      const costState = block == null ? null : block.costState;
      if (costState != null) result.costStateSessions += 1;

      if (coverage != null && coverage.get(entry.sessionId) > 0 && reports.every((r) => r.is_subagent === true)) {
        subagentOnly.add(entry.sessionId);
      }
      followups.set(entry.sessionId, { sessionErrors });
      await queueGroup(
        { sessionId: entry.sessionId, reports, timeline, costState },
        Buffer.byteLength(JSON.stringify({ reports, timeline, costState }), 'utf-8'),
        reports.length + (costState == null ? 0 : 1),
      );
    }
  } finally {
    // A throw from the loop itself still waits for every flight, so none writes after the lock is released.
    await Promise.all(flights);
  }
  // Every session is read; without this the record sits short of total while the last batch uploads alone.
  onProgress({ processed, total: candidates.length, ...result });
  // The last batch flies alone once both lanes are clear.
  await dispatch({ alone: true });
  await Promise.all(flights);
  if (flightError != null) throw flightError;

  // A run can hit unreadable transcripts and dispatch nothing at all, so this cannot ride on the
  // per-dispatch save — without it the retry marker is lost and the next run blocks again.
  if (unreadableDirty) {
    try { saveLedger(key, ledger, ledgerTenant); } catch { /* best-effort */ }
  }

  result.ok = true;
  return result;
}
