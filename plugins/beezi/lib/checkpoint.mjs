import fs from 'fs';
import path from 'path';
import { computeDelta as _computeDelta } from './delta.mjs';
import { getAccessToken as _getAccessToken } from './token.mjs';
import { queueDir, stateDir } from './paths.mjs';
import { git, currentBranch, resolveOriginRemote } from './git.mjs';
import { readCheckoutEvents, buildBranchTimeline, branchAt as branchAtReflog } from './reflog.mjs';
import { resolveRepoRoot } from './repo-timeline.mjs';
import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';
import { resolveFetch } from './fetch-compat.mjs';
import { postSessionError } from './session-error-report.mjs';
import { computeSessionTimeline, postSessionTimeline } from './session-timeline.mjs';
import { isApiKeyBillingEvidence } from './billing.mjs';
import {
  readBillingConfig,
  writeBillingConfig,
  resolveBilling,
  recordApiKeyEvidence,
} from './billing-config.mjs';
import { resolveSessionName } from './session-name.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { listSubagentTranscripts, buildTaskDescriptionMap } from './subagents.mjs';
import { claimIntervals, mergeIntervals, subtractIntervals, totalMs } from './active-time.mjs';
import { loadRepoMap, saveRepoMap, upsertRoot, knownOrigin, originFromGitConfig } from './repo-map.mjs';
import { claudeMdLines } from './claude-md.mjs';
import { isLiveTrackingAllowed, markTrackingDisabled } from './tracking.mjs';
import { readUsageUtilization as _readUsageUtilization } from './usage-utilization.mjs';
import { readClaudeAccount as _readClaudeAccount } from './claude-account.mjs';
import {
  maybePostUsageSnapshot as _maybePostUsageSnapshot,
  drainStatuslineSnapshots as _drainStatuslineSnapshots,
} from './usage-snapshot-report.mjs';

function loadState(id) {
  return readJson(path.join(stateDir(), `${id}.json`), {
    cursor: 0,
    sentSessionName: null,
    anchor: null,
  });
}

function saveState(id, state) {
  writeJsonSecure(path.join(stateDir(), `${id}.json`), state);
}

function enqueue(payload) {
  // 0600: these payloads carry session_name (prompt text), remote, and branch.
  const filename = payload.segmentId.replace(/[:/\s]/g, '_') + '.json';
  writeJsonSecure(path.join(queueDir(), filename), payload);
}

// Stand-in "remote" for work with no git origin behind it — a directory that isn't a repo, or a
// repo with no origin. Only the folder name travels, never the path around it, and the `local:`
// prefix keeps it from ever canonicalizing onto a real remote server-side.
function localRemote(dir) {
  if (!dir) return null;
  const name = path.basename(dir);
  return name ? `local:${name}` : null;
}

// Server-side DTO caps. One over-long field 400s the whole request (and on the batch route the
// whole 50-session chunk), so clamp at the source. `remote` is deliberately NOT clamped: a
// truncated remote would fabricate a bogus repo key — let it be rejected honestly.
const clamp = (value, max) =>
  typeof value === 'string' && value.length > max ? value.slice(0, max) : value;
const BRANCH_MAX = 255;
const AGENT_NAME_MAX = 200;
const AGENT_TYPE_MAX = 100;

// The machine's IANA timezone (e.g. Europe/Kyiv). Snapshotted per checkpoint so the server can
// bucket this session's activity in the user's local time even if they later travel. Null when
// the runtime can't resolve one — the field is then omitted from the payload.
function detectTimezone() {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return timeZone == null ? null : timeZone;
  } catch {
    return null;
  }
}

// `deps` holds substitutable implementations (test seams); `options` holds caller-driven execution
// modes. Keeping them separate stops a behavior flag from masquerading as an injectable.
// Returns { enqueued, flush, sessionErrors } — flush is the flushQueue summary (or null when it
// never ran); sessionErrors is populated only under options.collectSessionErrors.
//
// The bulk import (/beezi:import) drives this same function per past session, which is why three
// options exist to redirect its side effects: `sink` (payloads to the caller instead of the disk
// queue), `skipFlush` (no per-session HTTP), `collectSessionErrors` (buffer API-error reports
// instead of POSTing them one at a time). All default to today's hook behavior.
export async function runCheckpoint(input, deps = {}, options = {}) {
  const { session_id, transcript_path, cwd } = input;
  const getAccessToken = deps.getAccessToken == null ? _getAccessToken : deps.getAccessToken;
  const gitImpl = deps.gitImpl == null ? git : deps.gitImpl;
  const computeDelta = deps.computeDelta == null ? _computeDelta : deps.computeDelta;
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  // Where a built payload goes. The import collects them in memory and batches them itself;
  // letting it fall through to the disk queue would drip-feed hundreds of segments to the
  // single-report endpoint on the next hook, bypassing the batch route's whole-session dedupe.
  const emit = options.sink == null ? enqueue : options.sink;
  const collectedErrors = [];

  let token = null;
  try { token = await getAccessToken(); } catch { return { enqueued: 0, flush: null, sessionErrors: collectedErrors }; }
  if (!token) return { enqueued: 0, flush: null, sessionErrors: collectedErrors };

  // Tenant gate: audit-mode workspaces never track live — the server would 403 every report
  // anyway (TrackingEnabledGuard), this just spares the work and the noise. `gated` lets
  // /beezi:track tell "tracking is off" apart from "nothing new". The audit run passes
  // skipLiveTrackingGate — an explicit flag, never inferred from the sink seam.
  if (options.skipLiveTrackingGate !== true && !isLiveTrackingAllowed()) {
    return { enqueued: 0, flush: null, sessionErrors: collectedErrors, gated: true };
  }

  // Below the token gate: skip this work entirely on an unlinked machine.
  const resolvedSessionName = resolveSessionName(session_id, transcript_path);

  // Memoized git shell-outs for this checkpoint: dir→root, root→remote, root→reflog/HEAD.
  const rootCache = new Map();
  const remoteCache = new Map();
  const timelineCache = new Map();
  const claudeMdCache = new Map();

  // Persisted known-root map: seeds resolution (prefix match) and gets refreshed with any root→origin
  // we learn this checkpoint. A best-effort hint — a load failure yields an empty map, not a throw.
  const map = loadRepoMap();
  let mapDirty = false;

  const repoRootOf = (dir) => resolveRepoRoot(gitImpl, dir, rootCache, map);

  const branchOf = (root, ms) => {
    if (!root) return '(unknown)';
    let entry = timelineCache.get(root);
    if (!entry) {
      let timeline = null;
      let headBranch = '(unknown)';
      try { timeline = buildBranchTimeline(readCheckoutEvents(gitImpl, root)); } catch { /* no reflog */ }
      // Always resolve current HEAD too: it's the fallback for any line lacking a
      // timestamp even when a reflog timeline exists (otherwise those bill to '(unknown)').
      try { headBranch = currentBranch(root, gitImpl) || '(unknown)'; } catch { /* keep '(unknown)' */ }
      entry = { timeline, headBranch };
      timelineCache.set(root, entry);
    }
    return (entry.timeline && ms != null) ? branchAtReflog(entry.timeline, ms) : entry.headBranch;
  };

  const resolveRemote = (root) => {
    if (!root) return null;
    if (remoteCache.has(root)) return remoteCache.get(root);
    // git first (authoritative), then a git-free .git/config parse (rescues dubious-ownership), then
    // the persisted map (rescues a fully-blocked git binary). Remember any origin we learn.
    let r = resolveOriginRemote(gitImpl, root);
    if (!r) r = originFromGitConfig(root);
    if (!r) r = knownOrigin(root, map);
    if (r) { upsertRoot(map, root, r); mapDirty = true; }
    remoteCache.set(root, r);
    return r;
  };

  // Read per root, not per segment: repo-hopping splits one window into several segments against
  // the same checkout, and the file cannot change meaningfully inside a single checkpoint.
  const resolveClaudeMdLines = (root) => {
    if (!root) return null;
    if (claudeMdCache.has(root)) return claudeMdCache.get(root);
    const lines = claudeMdLines(root);
    claudeMdCache.set(root, lines);
    return lines;
  };

  // Why segments did not become reports. A caller that gets zero reports cannot otherwise tell a
  // session that genuinely holds no usage (a transcript with no assistant tokens — nothing to
  // upload, and nothing wrong) from one we dropped for a reason worth reporting. Only the
  // problem cases are counted: "no usage" is the absence of all of them.
  const skipped = { noRemote: 0, emitFailed: 0, deltaFailed: false };
  const emptyResult = { enqueued: 0, flush: null, sessionErrors: collectedErrors, skipped };
  const state = loadState(session_id);
  // When the session file is unreadable (name resolves to null), keep the last name we sent
  // rather than overwriting the stored name with null.
  const sessionName =
    resolvedSessionName != null ? resolvedSessionName
    : state.sentSessionName != null ? state.sentSessionName
    : null;
  let delta;
  try {
    delta = computeDelta(transcript_path, state.cursor, { cwd, repoRootOf, branchAt: branchOf });
  } catch {
    skipped.deltaFailed = true;
    return emptyResult;
  }
  const { nextCursor, segments, apiErrorEvents = [] } = delta;

  // Billing is resolved HERE, after the delta, not before it: a credit-balance error in this
  // window is proof the session bills an API key, and that proof has to be in hand before the
  // segments it belongs to are stamped. Persisted so later sessions resolve correctly too —
  // the switch that produced it is invisible to process.env.
  //
  // Historical transcripts must not rewrite this machine's CURRENT billing state: an API-key
  // error from months ago is not evidence about today, and stamping it would flip the live
  // billing source for the next 24h. persistState:false is the audit run.
  let billingConfig = readBillingConfig();
  if (options.persistState !== false && isApiKeyBillingEvidence(apiErrorEvents)) {
    const recorded = recordApiKeyEvidence(billingConfig);
    if (recorded) {
      try { writeBillingConfig(recorded); } catch { /* best-effort */ }
      billingConfig = recorded;
    }
  }
  const billingFields = resolveBilling(billingConfig);

  // Subscription-usage stamp: account-level utilization correlated onto every payload of this
  // checkpoint. Keys are omitted (not null) when unknown. usage_account_uuid is the CACHE's own
  // account — after a switch it names the previous account until Claude Code refetches, which is
  // the truth about whose numbers these are; account_uuid is who is logged in NOW.
  const readUtilization = deps.readUsageUtilization == null ? _readUsageUtilization : deps.readUsageUtilization;
  const readAccount = deps.readClaudeAccount == null ? _readClaudeAccount : deps.readClaudeAccount;
  let utilization = null;
  try { utilization = readUtilization(); } catch { utilization = null; }
  let claudeAccount = null;
  try { claudeAccount = readAccount(); } catch { claudeAccount = null; }
  const usageStamp = {
    ...(claudeAccount != null && claudeAccount.accountUuid ? { account_uuid: claudeAccount.accountUuid } : {}),
    ...(utilization
      ? {
          usage_five_hour_pct: utilization.fiveHourPct,
          usage_seven_day_pct: utilization.sevenDayPct,
          usage_fetched_at: new Date(utilization.fetchedAtMs).toISOString(),
          ...(utilization.accountUuid ? { usage_account_uuid: utilization.accountUuid } : {}),
        }
      : {}),
  };

  let enqueued = 0;
  // The last enqueued payload becomes the "anchor" we can replay to push a later rename.
  let lastPayload = null;
  const timezone = detectTimezone();

  // Wall clock already billed for this session, as merged [startMs, endMs) intervals. The main
  // transcript and every subagent transcript cover the SAME stretch of clock — the parent blocks on
  // the Task tool_use while its agents run, and parallel agents overlap each other — so a segment
  // may only bill the part no earlier segment claimed. Summing them instead multiplied a session's
  // reported time by roughly (1 + number of parallel agents). Persisted across checkpoints because
  // a subagent's lines can land in a later window than the main lines covering the same minutes.
  let covered = mergeIntervals(Array.isArray(state.coveredIntervals) ? state.coveredIntervals : []);
  let coveredDirty = false;

  const enqueueSegments = (segs, segmentScope, extra = null, { includeContext = true } = {}) => {
    for (const seg of segs) {
      // Main-transcript segments run through here first and so keep their full span; subagents bill
      // only the residual. Deterministic, and it puts the time on the thread that was blocked for
      // the whole fan-out. A computeDelta without interval tracking (an injected double) keeps its
      // own scalar rather than silently zeroing.
      const intervals = Array.isArray(seg.activeIntervals) ? seg.activeIntervals : null;
      const durationSec = intervals
        ? Math.round(totalMs(subtractIntervals(intervals, covered)) / 1000)
        : seg.stats.duration_sec;
      if (seg.stats.token_total === 0 && durationSec === 0) continue;
      const resolvedRemote = resolveRemote(seg.repoRoot);
      const remote = resolvedRemote == null ? localRemote(seg.repoRoot == null ? cwd : seg.repoRoot) : resolvedRemote;
      // Nothing left to name the work by — only reachable when the session has no cwd either.
      if (!remote) { skipped.noRemote += 1; continue; }
      // A single write failure must not abort the window (which would leave the cursor
      // unadvanced and re-process everything forever) — skip that segment and continue.
      // A subagent's context window is not the session's — its context fields never ship.
      const { context_peak_tokens, context_final_tokens, context_final_model, ...statsSansContext } = seg.stats;
      const stats = includeContext ? seg.stats : statsSansContext;
      // Reported off the segment's own repo root, so a session that spans repositories describes
      // the CLAUDE.md each part of it actually ran under.
      const mdLines = resolveClaudeMdLines(seg.repoRoot);
      try {
        const payload = {
          segmentId: `${segmentScope}:${seg.fromLine}-${seg.toLine}`,
          sessionId: session_id,
          remote,
          branch: clamp(seg.branch, BRANCH_MAX),
          from_line: seg.fromLine,
          to_line: seg.toLine,
          ...billingFields,
          ...usageStamp,
          session_name: sessionName,
          ...(timezone ? { timezone } : {}),
          ...(mdLines != null ? { claude_md_lines: mdLines } : {}),
          ...(extra || {}),
          ...stats,
          duration_sec: durationSec,
        };
        emit(payload);
        // Claim only what actually reached the queue: a failed write must not swallow the window
        // for every later segment too.
        if (intervals != null && intervals.length) {
          covered = claimIntervals(covered, intervals);
          coveredDirty = true;
        }
        lastPayload = payload;
        enqueued += 1;
      } catch { skipped.emitFailed += 1; /* keep going; the cursor still advances below */ }
    }
  };
  enqueueSegments(segments, session_id);

  // Subagent turns live in <transcriptDir>/<sessionId>/subagents/agent-*.jsonl and never
  // appear in the main transcript, so each agent file gets its own delta window with its
  // own cursor. Line numbers are per-file: scope the segmentId by agent id so they can't
  // collide with main-transcript segments (or each other) on the server upsert.
  const agentCursors = state.agentCursors == null ? {} : state.agentCursors;
  let agentCursorsDirty = false;
  // Each subagent's display name is the `description` of the Task block that spawned it; join via
  // the meta.json toolUseId. Built once here (single main-transcript scan) for all subagents.
  const taskDescriptions = buildTaskDescriptionMap(transcript_path);
  for (const { agentId, path: agentPath, agentType, spawnDepth, toolUseId } of listSubagentTranscripts(transcript_path, session_id)) {
    const agentFrom = agentCursors[agentId] == null ? 0 : agentCursors[agentId];
    let agentDelta;
    try {
      agentDelta = computeDelta(agentPath, agentFrom, { cwd, repoRootOf, branchAt: branchOf });
    } catch { continue; }
    const taskDescription = toolUseId ? taskDescriptions.get(toolUseId) : null;
    enqueueSegments(agentDelta.segments, `${session_id}:${agentId}`, {
      is_subagent: true,
      agent_id: agentId,
      agent_type: clamp(agentType, AGENT_TYPE_MAX),
      agent_name: toolUseId ? clamp(taskDescription == null ? null : taskDescription, AGENT_NAME_MAX) : null,
      spawn_depth: spawnDepth,
    }, { includeContext: false });
    // A subagent that dies on an API error never ends the main turn, so no StopFailure fires
    // for it — its transcript is the only place that failure is recorded.
    apiErrorEvents.push(...(agentDelta.apiErrorEvents == null ? [] : agentDelta.apiErrorEvents));
    if (agentDelta.nextCursor !== agentFrom) {
      agentCursors[agentId] = agentDelta.nextCursor;
      agentCursorsDirty = true;
    }
  }

  // postSessionError swallows its own failures (never rejects), so an error-report
  // problem can't break the checkpoint — no wrapper needed. This is also the safety net for
  // a StopFailure hook that never fired: the server keys on session+error+minute and both
  // paths stamp the transcript line's timestamp, so the two collapse onto one row.
  for (const event of apiErrorEvents) {
    const errorPayload = {
      sessionId: session_id,
      error: event.error,
      errorDetails: null,
      lastAssistantMessage: event.text,
      occurredAt: event.occurredAt == null ? new Date().toISOString() : event.occurredAt,
    };
    // The audit run buffers these instead: one awaited POST per event across hundreds of
    // sessions is minutes of dead time, and follow-ups only make sense for sessions the server
    // accepted — the backfill route dedupes via its upsert keys, so ordering is about
    // attribution, not skip-existing (the old batch route's premise is gone).
    if (options.collectSessionErrors) {
      collectedErrors.push(errorPayload);
      continue;
    }
    await postSessionError(errorPayload, token, { fetchImpl });
  }

  let stateDirty = false;

  // The activity timeline is whole-session, so it's re-derived from the full transcript and shipped
  // only at turn-ends (Stop / SessionEnd) — not on the frequent PostToolUse:Bash path. Skip the POST
  // when the derived content is identical to the last one we sent (a Stop with no new activity), so
  // we don't re-upsert the same growing jsonb every turn. Best-effort: a failure must never break the
  // checkpoint.
  if (options.emitTimeline) {
    try {
      const timeline = computeSessionTimeline(transcript_path, session_id);
      if (timeline && (timeline.periods.length > 0 || timeline.subagents.length > 0 || timeline.plan_events.length > 0)) {
        const sig = `${JSON.stringify(timeline.periods)}|${JSON.stringify(timeline.subagents)}|${JSON.stringify(timeline.plan_events)}`;
        if (sig !== state.sentTimelineSig) {
          const { reported } = await postSessionTimeline(
            { sessionId: session_id, ...timeline },
            token,
            { fetchImpl },
          );
          // Only remember the signature on a confirmed send, so a failed post retries next turn.
          if (reported) {
            state.sentTimelineSig = sig;
            stateDirty = true;
          }
        }
      }
    } catch { /* best-effort */ }

    // Fleet utilization snapshot — deduped by (account, fetchedAt); best-effort like the
    // timeline. StopFailure also runs with emitTimeline, so a turn that died on a rate-limit
    // error still ships its snapshot — the moment it matters most.
    const postSnapshot = deps.maybePostUsageSnapshot == null ? _maybePostUsageSnapshot : deps.maybePostUsageSnapshot;
    try { await postSnapshot(token, { fetchImpl }); } catch { /* best-effort */ }
    // Live rate-limit rows the status line recorded between hooks — the observations no
    // hook was running to see.
    const drainSnapshots = deps.drainStatuslineSnapshots == null ? _drainStatuslineSnapshots : deps.drainStatuslineSnapshots;
    try { await drainSnapshots(token, { fetchImpl }); } catch { /* best-effort */ }
  }

  // Claude Code renames a session after the first prompt. The new name normally rides on the
  // next billable segment (each report re-reads it), but a session whose rename lands with no
  // further activity would keep the first-prompt title forever. So: remember the anchor segment
  // and the name we last sent; when the name changes but no new segment carried it, replay the
  // anchor with the corrected name. The server upserts by segmentId (idempotent tokens/cost) and
  // takes the latest non-null session_name, so this only fixes the name.
  if (enqueued > 0) {
    state.anchor = lastPayload;
    state.sentSessionName = sessionName;
    stateDirty = true;
  } else if (sessionName != null && sessionName !== state.sentSessionName && state.anchor) {
    try {
      emit({ ...state.anchor, session_name: sessionName });
      state.sentSessionName = sessionName;
      stateDirty = true;
    } catch { /* best-effort; retry next checkpoint */ }
  }

  if (nextCursor !== state.cursor) {
    state.cursor = nextCursor;
    stateDirty = true;
  }
  if (agentCursorsDirty) {
    state.agentCursors = agentCursors;
    stateDirty = true;
  }
  if (coveredDirty) {
    state.coveredIntervals = covered;
    stateDirty = true;
  }
  // Remember where this session lives. The session's cwd drifts (cd, worktree switches)
  // while Claude Code keys the transcript dir by the LAUNCH cwd, so /beezi:track can't
  // rely on process.cwd() to find the transcript — it reads this mapping instead. Only
  // recorded once the transcript has content, so an empty session writes no state.
  if (nextCursor > 0 && (state.cwd !== cwd || state.transcriptPath !== transcript_path)) {
    state.cwd = cwd == null ? null : cwd;
    state.transcriptPath = transcript_path;
    state.updatedAt = new Date().toISOString();
    stateDirty = true;
  }
  // The import never persists the cursor. It builds payloads first and delivers them afterwards,
  // so advancing the cursor here would consume a session's lines before the server ever accepted
  // them: a failed delivery leaves the session unledgered AND unreadable, and the re-run finds
  // nothing left to send. Not advancing costs nothing — segmentIds are deterministic, so if that
  // session is later resumed live its hooks re-report the same ids and the server upserts.
  if (stateDirty && options.persistState !== false) {
    try { saveState(session_id, state); } catch { /* best-effort */ }
  }
  if (mapDirty) {
    try { saveRepoMap(map); } catch { /* best-effort */ }
  }

  // The import owns its own batched delivery, so it must not drain the live queue per session —
  // that would add unrelated HTTP calls mid-import and muddy its summary.
  const flush = options.skipFlush ? null : await flushQueue(token, { fetchImpl });
  return { enqueued, flush, sessionErrors: collectedErrors, skipped };
}

// Once tracking is off, queued reports are held for this long: a tenant that converts to paid
// inside the window flushes them normally on its first live session; after it they expire.
export const QUEUE_HOLD_MS = 3 * 24 * 60 * 60 * 1000;

// Expire queue files older than the hold window. Only meaningful while tracking is off — a
// live-mode queue drains through flushing, not expiry.
function sweepHeldQueue(dir, result, now = Date.now()) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      if (now - fs.statSync(filePath).mtimeMs > QUEUE_HOLD_MS) {
        fs.unlinkSync(filePath);
        result.expired += 1;
      }
    } catch { /* best-effort */ }
  }
}

// Returns { flushed, rejected, failed, expired, trackingDisabled, lastError } —
// flushed = accepted (2xx), rejected = permanently declined by the server (4xx, e.g. branch not
// linked), failed = transient or reversible (5xx/network/code-less 403, file kept for retry),
// expired = held files past the 3-day window, trackingDisabled = the server said the workspace
// is dark (audit mode) and the flush stopped.
export async function flushQueue(token, deps = {}) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const getAccessToken = deps.getAccessToken == null ? _getAccessToken : deps.getAccessToken;
  const result = { flushed: 0, rejected: 0, failed: 0, expired: 0, trackingDisabled: false, lastError: null };
  const dir = queueDir();

  // Dark workspace: no readdir-and-post loop, just the hold-window sweep. Files stay for
  // QUEUE_HOLD_MS in case the tenant converts to paid, then expire.
  if (!isLiveTrackingAllowed()) {
    result.trackingDisabled = true;
    sweepHeldQueue(dir, result);
    return result;
  }

  // A 401 is authentication, not a verdict on the payload, so it must not count as a permanent
  // rejection — that would delete queued analytics that were never actually refused. Renew once
  // for the whole flush and retry; if renewal fails, keep every file for the next attempt.
  let renewed = false;
  const renewToken = async () => {
    if (renewed) return null;
    renewed = true;
    const next = await getAccessToken({}, { forceRefresh: true }).catch(() => null);
    if (next && next !== token) { token = next; return next; }
    return null;
  };

  const reportUrl = `${apiBase()}${ENDPOINTS.sessionsReport}`;

  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return result;
  }

  for (const file of files) {
    const filePath = path.join(dir, file);
    const payload = readJson(filePath);
    if (payload == null) continue;

    try {
      let res = await postJson(reportUrl, token, payload, { fetchImpl });
      // 401 only: a 403 is authenticated-but-not-permitted, which no new token resolves.
      if (res.status === 401) {
        const next = await renewToken();
        if (next) res = await postJson(reportUrl, next, payload, { fetchImpl });
      }
      if (res.status >= 200 && res.status < 300) {
        result.flushed += 1;
        fs.unlinkSync(filePath);
      } else if (res.status === 401) {
        // Still unauthenticated after a renewal attempt — keep the file; the payload was
        // never judged, and re-linking should let it through later.
        result.failed += 1;
        result.lastError = `HTTP ${res.status}`;
      } else if (res.status === 403) {
        // Branch on the machine-readable code, never the message. TRACKING_DISABLED = the
        // workspace is in audit mode: record it, stop the storm, and HOLD the files — they
        // flush if the tenant converts within the window, and expire after it. A code-less 403
        // (seat revoked, deactivated user) is reversible: keep the file, count it failed.
        let body = null;
        try { body = await res.json(); } catch { /* non-JSON body */ }
        if (body != null && body.code === 'TRACKING_DISABLED') {
          try { markTrackingDisabled(body.message == null ? null : body.message); } catch { /* best-effort */ }
          result.trackingDisabled = true;
          result.lastError = body.message == null ? 'HTTP 403' : body.message;
          sweepHeldQueue(dir, result);
          break;
        }
        result.failed += 1;
        result.lastError = body == null || body.message == null ? `HTTP ${res.status}` : body.message;
      } else if (res.status < 500) {
        // Permanent rejection — drop the file, but remember why.
        result.rejected += 1;
        try {
          const body = await res.json();
          result.lastError = body == null || body.message == null ? `HTTP ${res.status}` : body.message;
        } catch {
          result.lastError = `HTTP ${res.status}`;
        }
        fs.unlinkSync(filePath);
      } else {
        result.failed += 1; // keep for retry
      }
    } catch {
      result.failed += 1; // keep file for retry on network error / throw
    }
  }

  return result;
}
