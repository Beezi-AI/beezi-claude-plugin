import fs from 'fs';
import { getAccessToken as _getAccessToken } from './token.mjs';
import { runCheckpoint as _runCheckpoint } from './checkpoint.mjs';
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
  completeBackfill as _completeBackfill,
  planChunks,
  BackfillSessionStatus,
  BackfillHalt,
  MAX_BODY_BYTES,
  MAX_CHUNK_ITEMS,
} from './audit-flush.mjs';
import { computeSessionTimeline as _computeSessionTimeline } from './session-timeline.mjs';
import { postSessionError as _postSessionError } from './session-error-report.mjs';
import { resolveSessionTranscript } from './transcript.mjs';
import { getMachineClientId } from './machine-identity.mjs';
import { resolveFetch } from './fetch-compat.mjs';
import { whoami as _whoami } from './whoami.mjs';
import { credentialsFile } from './paths.mjs';
import {
  readTrackingState,
  matchesIdentity,
  isLiveTrackingAllowed,
  markBackfillCompleted,
  recordWhoami,
  linkedAtMs as _linkedAtMs,
  TrackingMode,
} from './tracking.mjs';
import { UserError } from './friendly-error.mjs';

// A transcript this big is read three times over (segments, timeline, task descriptions) and would
// put the process into the hundreds of MB. Report it rather than let node die mid-run.
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

// Error posts are single small upserts, so a little parallelism is free — but not unbounded,
// or a 200-session run opens 200 sockets at once.
const FOLLOWUP_CONCURRENCY = 4;

const AUDIT_TIMEOUT_MS = 60_000;

// A transcript touched this recently is probably an OPEN session in another window: its hooks are
// mid-flight between checkpoints, and backfilling it would re-segment the same lines on different
// boundaries than the next live report — double-counted spend. Skip and let the user rerun.
const ACTIVE_SESSION_WINDOW_MS = 30 * 60 * 1000;

const SINCE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

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

// When live tracking is on, everything after the machine link was (or will be) tracked live —
// re-sending it through the audit would re-segment the same transcript lines on different
// boundaries once the per-session cursor has been pruned, and double-count the spend.
//
// The link instant comes from tracking.json, stamped by login. It used to be read as the
// credentials file's mtime, which is written only by the DPAPI/plaintext fallbacks: on any machine
// with a real credential store (CredMan, Keychain, secret-tool) the file does not exist, so this
// returned null and the guard below never fired. The mtime stays as the fallback for links made
// before the stamp existed — and it is the weaker signal, since token refresh rewrites it.
function linkedAtMs(tracking, deps) {
  const stamped = _linkedAtMs(tracking);
  if (stamped != null) return stamped;
  const statImpl = deps.statImpl == null ? ((p) => fs.statSync(p)) : deps.statImpl;
  try {
    const stats = statImpl(credentialsFile());
    return stats.mtimeMs == null ? null : stats.mtimeMs;
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

// Seal only when a re-run could not improve the outcome, and only when the run covered
// everything: any retryable failure, unattributable chunk, whole-chunk rejection, halt or scope
// flag leaves the pull open. Per-item errors[] (unconnected repos on platform tenants) and
// oversize/unreadable transcripts deliberately do NOT block — a re-run cannot help them, and
// blocking would deadlock the seal forever.
export function shouldFinalize(result, options = {}) {
  if (!result.ok) return false;
  if (options.dryRun === true) return false;
  if (options.sinceMs != null) return false;
  if (result.halt !== null) return false;
  if (result.reportsFailed > 0) return false;
  if (result.unattributed > 0) return false;
  if (result.permanentRejections > 0) return false;
  // A transcript we could not read is a retryable failure like any other, and sealing over it
  // loses that session for good — the seal is one-time per account and tool, and --force skips
  // only the LOCAL caches, never the server's verdict. So the first failure holds the pull open.
  //
  // Only the FIRST failure, though: a permission error is indistinguishable from transient I/O at
  // the call site, so gating on every occurrence would let one permanently unreadable file block
  // the seal forever and tell the user to re-run login on a loop.
  //
  // `empty` and `noRemote` never block: the first has nothing to upload, and the second can never
  // succeed (a transcript with no recorded cwd will have none on the next run either).
  if (result.retriableUnreadable > 0) return false;
  return true;
}

// Backfill every past session on this machine into Beezi via the chunked backfill route, then
// seal the one-time pull. Timelines ride IN the chunk payload (the tracking-gated standalone
// timeline route is unreachable for audit tenants); only rate-limit error reports remain a
// live-only follow-up — and only for sessions the server judged accepted, so a failed session
// stays fully retryable.
export async function runAudit(deps = {}, options = {}) {
  const getAccessToken = deps.getAccessToken == null ? _getAccessToken : deps.getAccessToken;
  const listTranscripts = deps.listTranscripts == null ? _listAllTranscripts : deps.listTranscripts;
  const recordedCwd = deps.firstRecordedCwd == null ? _firstRecordedCwd : deps.firstRecordedCwd;
  const runCheckpoint = deps.runCheckpointImpl == null ? _runCheckpoint : deps.runCheckpointImpl;
  const flushBackfillChunks = deps.flushBackfillChunksImpl == null ? _flushBackfillChunks : deps.flushBackfillChunksImpl;
  const completeBackfill = deps.completeBackfillImpl == null ? _completeBackfill : deps.completeBackfillImpl;
  const loadLedger = deps.loadLedgerImpl == null ? _loadLedger : deps.loadLedgerImpl;
  const saveLedger = deps.saveLedgerImpl == null ? _saveLedger : deps.saveLedgerImpl;
  const computeSessionTimeline = deps.computeSessionTimelineImpl == null ? _computeSessionTimeline : deps.computeSessionTimelineImpl;
  const postSessionError = deps.postSessionErrorImpl == null ? _postSessionError : deps.postSessionErrorImpl;
  const readTracking = deps.readTrackingStateImpl == null ? readTrackingState : deps.readTrackingStateImpl;
  const markCompleted = deps.markBackfillCompletedImpl == null ? markBackfillCompleted : deps.markBackfillCompletedImpl;
  const whoamiImpl = deps.whoamiImpl == null ? _whoami : deps.whoamiImpl;
  const recordWhoamiImpl = deps.recordWhoamiImpl == null ? recordWhoami : deps.recordWhoamiImpl;
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const onProgress = deps.onProgress == null ? (() => {}) : deps.onProgress;
  const env = deps.env == null ? process.env : deps.env;
  const now = deps.now == null ? (() => Date.now()) : deps.now;

  const result = {
    ok: false,
    reason: null,
    halt: null,
    scanned: 0,
    live: 0,
    active: 0,
    liveTracked: 0,
    alreadyImported: 0,
    oversize: 0,
    candidates: 0,
    plannedChunks: 0,
    // Reports built and handed to the flush — in a dry run, what WOULD have been sent. Counted in
    // both modes so "stored" has something to be compared against: without it a server that
    // quietly stores fewer than it was sent is undetectable.
    plannedReports: 0,
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
    // Unreadable sessions this run is willing to hold the pull open for: the ones we had not
    // already tried. A file that fails on the retry too is deterministic (a permission error is
    // indistinguishable from a transient one at the call site), and blocking on it forever would
    // trade the old silent-loss bug for a pull that can never seal.
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
    finalized: false,
    // Set when the server said the pull is sealed AND the workspace has no live tracking — the
    // audit window is the only reason to run again, so the summary points at an upgrade.
    upgradeAdvised: false,
    followupsAllowed: true,
    timelines: 0,
    // Client-side twin of `timelines` (which is purely the server's number), so a gap between
    // what we sent and what landed is attributable instead of a bare unexplained difference.
    timelinesOffered: 0,
    timelinesDropped: 0,
    sessionErrors: 0,
    lastError: null,
  };

  const token = await getAccessToken().catch(() => null);
  if (!token) {
    result.reason = 'no-token';
    return result;
  }

  // getAccessToken primed the machine client id — the binding key for the machine-global
  // ledger and tracking cache (a new login mints a new id, so a workspace switch invalidates
  // both instead of sealing the new tenant's pull empty).
  const identity = getMachineClientId();
  const tracking = readTracking();
  const trackingValid = matchesIdentity(tracking, identity);

  // Fast path: the local cache already knows the pull is sealed. --force skips the LOCAL
  // caches only — the server verdict below is never bypassed.
  if (!options.force && trackingValid && tracking != null && tracking.backfillCompleted === true) {
    result.ok = true;
    result.reason = 'already-completed';
    result.upgradeAdvised = tracking.trackingMode != null && tracking.trackingMode !== TrackingMode.LIVE;
    return result;
  }

  // The server is the authority on "has this pull been used": local caches can be deleted (or
  // a reinstall never had them), and without this check a re-run would re-parse every
  // transcript only to be 403'd on its first chunk. Offline/old servers answer null — proceed;
  // the chunk-level ALREADY_COMPLETED guard still stands behind us.
  const who = await whoamiImpl(token, { fetchImpl }).catch(() => null);
  if (who != null && who.valid) {
    try { recordWhoamiImpl(who, identity); } catch { /* best-effort */ }
    if (who.backfillCompleted === true) {
      try { markCompleted(); } catch { /* best-effort */ }
      result.ok = true;
      result.reason = 'already-completed';
      result.upgradeAdvised = who.trackingMode != null && who.trackingMode !== TrackingMode.LIVE;
      return result;
    }
  }

  const ledger = loadLedger(identity);
  if (!options.force && isComplete(ledger)) {
    result.ok = true;
    result.reason = 'already-completed';
    return result;
  }

  const live = liveSessionId(env, deps);
  const all = listTranscripts();
  result.scanned = all.length;

  // Live-tracking tenants: everything since the machine link was tracked live; re-sending it
  // would double-count once its per-session cursor was pruned. Dark-mode tenants never tracked
  // live, so every transcript is fair game.
  const liveMode = trackingValid && tracking != null && tracking.trackingMode === TrackingMode.LIVE;
  const linkCutoffMs = liveMode ? linkedAtMs(tracking, deps) : null;
  const activeCutoffMs = now() - ACTIVE_SESSION_WINDOW_MS;

  const candidates = [];
  for (const entry of all) {
    if (live && entry.sessionId === live) { result.live += 1; continue; }
    if (entry.mtimeMs > activeCutoffMs) { result.active += 1; continue; }
    if (linkCutoffMs != null && entry.mtimeMs >= linkCutoffMs) { result.liveTracked += 1; continue; }
    if (!options.force && isImported(ledger, entry.sessionId)) { result.alreadyImported += 1; continue; }
    if (options.sinceMs != null && entry.mtimeMs < options.sinceMs) continue;
    if (entry.size > MAX_TRANSCRIPT_BYTES) { result.oversize += 1; continue; }
    candidates.push(entry);
  }
  result.candidates = candidates.length;

  const finalize = async () => {
    if (!shouldFinalize(result, options)) return;
    const sealed = await completeBackfill(token, { fetchImpl }, { timeoutMs: AUDIT_TIMEOUT_MS });
    if (sealed.completed || sealed.code === 'BACKFILL_ALREADY_COMPLETED') {
      result.finalized = true;
      markComplete(ledger);
      try { saveLedger(ledger); } catch { /* best-effort */ }
      try { markCompleted(); } catch { /* best-effort */ }
    } else {
      result.lastError = sealed.reason == null ? result.lastError : sealed.reason;
    }
  };

  if (candidates.length === 0) {
    result.ok = true;
    // A previous run delivered everything but its finalize POST was lost: retry the seal here,
    // or the pull stays IN_PROGRESS forever while every rerun early-returns.
    await finalize();
    return result;
  }

  // Rate-limit error follow-ups hit a tracking-gated route: a dark-mode tenant would take one
  // 403 per session. Timelines are exempt — they ride inside the backfill chunks themselves.
  const followupsAllowed = !trackingValid || isLiveTrackingAllowed(tracking);
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

  const dispatchBatch = async (batch) => {
    result.plannedReports += batch.reduce((sum, g) => sum + g.reports.length, 0);
    if (options.dryRun) {
      const chunks = planChunks(batch);
      result.plannedChunks += chunks.length;
      for (const group of batch) followups.delete(group.sessionId);
      return;
    }

    const flushed = await flushBackfillChunks(batch, token, { fetchImpl }, { timeoutMs: AUDIT_TIMEOUT_MS });
    result.plannedChunks += flushed.chunks;
    result.timelinesDropped += flushed.timelinesDropped == null ? 0 : flushed.timelinesDropped;
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
        result.sessionsImported += 1;
        landed.push(group.sessionId);
      }
      if (status === BackfillSessionStatus.REJECTED) {
        result.reportsRejected += group.reports.length;
        result.sessionsRejected += 1;
      }
      if (status === BackfillSessionStatus.FAILED) result.reportsFailed += group.reports.length;
      // Anything the server judged is ledgered, including a rejection: an unconnected repository
      // will reject on every future run too. Failures and unattributed chunks stay eligible.
      if (
        status === BackfillSessionStatus.ACCEPTED ||
        status === BackfillSessionStatus.PARTIAL ||
        status === BackfillSessionStatus.REJECTED
      ) {
        markImported(ledger, group.sessionId, { outcome: status, reports: group.reports.length });
      } else {
        followups.delete(group.sessionId);
      }
    }
    // Written per dispatch, not once at the end, so Ctrl-C keeps the progress made so far.
    try { saveLedger(ledger); } catch { /* best-effort */ }

    if (flushed.halt) {
      result.halt = flushed.halt;
      halted = true;
      if (flushed.halt === BackfillHalt.ALREADY_COMPLETED) {
        markComplete(ledger);
        try { saveLedger(ledger); } catch { /* best-effort */ }
        try { markCompleted(); } catch { /* best-effort */ }
      }
      return;
    }

    if (followupsAllowed) {
      await mapLimited(landed, FOLLOWUP_CONCURRENCY, async (sessionId) => {
        const followup = followups.get(sessionId);
        followups.delete(sessionId);
        if (!followup) return;
        for (const errorPayload of followup.sessionErrors) {
          const { reported } = await postSessionError(errorPayload, token, { fetchImpl, timeoutMs: AUDIT_TIMEOUT_MS });
          if (reported) result.sessionErrors += 1;
        }
      });
    }

    onProgress({ processed, total: candidates.length, ...result });
  };

  // One-deep pipeline: at most one batch in flight while the loop parses the next sessions —
  // the run used to alternate CPU-bound parsing (network idle) with awaiting the upload (CPU
  // idle). Dispatches stay strictly sequential (await the previous flight before starting the
  // next), so the ledger writes and the never-two-POSTs invariant are untouched, and peak
  // memory grows by exactly one pending batch.
  let inFlight = null;
  const dispatch = async () => {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    pendingBytes = 0;
    pendingItems = 0;
    if (inFlight) await inFlight;
    // A halt discovered by the previous flight drops this batch — its sessions stay
    // unledgered and eligible, exactly like the loop break below.
    if (halted) return;
    inFlight = dispatchBatch(batch);
  };

  // First failure earns a retry and holds the pull open; a second one does not, so a permanently
  // unreadable file costs one extra login rather than sealing the pull never.
  let unreadableDirty = false;
  const noteUnreadable = (sessionId) => {
    if (!wasUnreadable(ledger, sessionId)) result.retriableUnreadable += 1;
    markUnreadable(ledger, sessionId);
    unreadableDirty = true;
  };

  // Parsing itself stays strictly sequential. computeDelta reads and JSON.parses the whole
  // transcript, so parsing sessions in parallel multiplies peak memory with no gain on a
  // single thread.
  for (const entry of candidates) {
    if (halted) break;
    const reports = [];
    let sessionErrors = [];
    let skipped = null;
    try {
      const checkpoint = await runCheckpoint(
        {
          session_id: entry.sessionId,
          transcript_path: entry.transcriptPath,
          cwd: recordedCwd(entry.transcriptPath),
        },
        { getAccessToken: async () => token, fetchImpl },
        {
          sink: (payload) => reports.push(payload),
          skipFlush: true,
          collectSessionErrors: true,
          persistState: false,
          skipLiveTrackingGate: true,
        },
      );
      sessionErrors = checkpoint == null || checkpoint.sessionErrors == null ? [] : checkpoint.sessionErrors;
      skipped = checkpoint == null || checkpoint.skipped == null ? null : checkpoint.skipped;
    } catch {
      // One unreadable transcript must not end the run — but it is no longer silent.
      result.unreadable += 1;
      noteUnreadable(entry.sessionId);
      processed += 1;
      continue;
    }
    processed += 1;
    if (reports.length === 0) {
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
      const computed = computeSessionTimeline(entry.transcriptPath, entry.sessionId);
      if (
        computed &&
        (computed.periods.length > 0 || computed.subagents.length > 0 || computed.plan_events.length > 0)
      ) {
        timeline = { sessionId: entry.sessionId, ...computed };
        result.timelinesOffered += 1;
      }
    } catch { /* best-effort */ }

    followups.set(entry.sessionId, { sessionErrors });
    pending.push({ sessionId: entry.sessionId, reports, timeline });
    pendingBytes += Buffer.byteLength(JSON.stringify({ reports, timeline }), 'utf-8');
    pendingItems += reports.length;
    if (pendingBytes >= MAX_BODY_BYTES || pendingItems >= MAX_CHUNK_ITEMS) await dispatch();
  }
  await dispatch();
  if (inFlight) await inFlight;

  // A run can hit unreadable transcripts and dispatch nothing at all, so this cannot ride on the
  // per-dispatch save — without it the retry marker is lost and the next run blocks again.
  if (unreadableDirty) {
    try { saveLedger(ledger); } catch { /* best-effort */ }
  }

  result.ok = true;
  await finalize();
  return result;
}
