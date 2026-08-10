import fs from 'node:fs';
import path from 'node:path';
import { computeDelta as _computeDelta } from './delta.mjs';
import { getAccessToken as _getAccessToken } from './token.mjs';
import { queueDir, stateDir } from './paths.mjs';
import { git, currentBranch, resolveOriginRemote } from './git.mjs';
import { readCheckoutEvents, buildBranchTimeline, branchAt as branchAtReflog } from './reflog.mjs';
import { resolveRepoRoot } from './repo-timeline.mjs';
import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';
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
import { readUsageUtilization as _readUsageUtilization } from './usage-utilization.mjs';
import { readClaudeAccount as _readClaudeAccount } from './claude-account.mjs';
import { maybePostUsageSnapshot as _maybePostUsageSnapshot } from './usage-snapshot-report.mjs';

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

// The machine's IANA timezone (e.g. Europe/Kyiv). Snapshotted per checkpoint so the server can
// bucket this session's activity in the user's local time even if they later travel. Null when
// the runtime can't resolve one — the field is then omitted from the payload.
function detectTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    return null;
  }
}

// `deps` holds substitutable implementations (test seams); `options` holds caller-driven execution
// modes. Keeping them separate stops a behavior flag from masquerading as an injectable.
// Returns { enqueued, flush } — flush is the flushQueue summary (or null when it never ran).
export async function runCheckpoint(input, deps = {}, options = {}) {
  const { session_id, transcript_path, cwd } = input;
  const getAccessToken = deps.getAccessToken ?? _getAccessToken;
  const gitImpl = deps.gitImpl ?? git;
  const computeDelta = deps.computeDelta ?? _computeDelta;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  let token = null;
  try { token = await getAccessToken(); } catch { return { enqueued: 0, flush: null }; }
  if (!token) return { enqueued: 0, flush: null };

  // Below the token gate: skip this work entirely on an unlinked machine.
  const resolvedSessionName = resolveSessionName(session_id, transcript_path);

  // Memoized git shell-outs for this checkpoint: dir→root, root→remote, root→reflog/HEAD.
  const rootCache = new Map();
  const remoteCache = new Map();
  const timelineCache = new Map();

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

  const state = loadState(session_id);
  // When the session file is unreadable (name resolves to null), keep the last name we sent
  // rather than overwriting the stored name with null.
  const sessionName = resolvedSessionName ?? state.sentSessionName ?? null;
  let delta;
  try {
    delta = computeDelta(transcript_path, state.cursor, { cwd, repoRootOf, branchAt: branchOf });
  } catch {
    return { enqueued: 0, flush: null };
  }
  const { nextCursor, segments, apiErrorEvents = [] } = delta;

  // Billing is resolved HERE, after the delta, not before it: a credit-balance error in this
  // window is proof the session bills an API key, and that proof has to be in hand before the
  // segments it belongs to are stamped. Persisted so later sessions resolve correctly too —
  // the switch that produced it is invisible to process.env.
  let billingConfig = readBillingConfig();
  if (isApiKeyBillingEvidence(apiErrorEvents)) {
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
  const readUtilization = deps.readUsageUtilization ?? _readUsageUtilization;
  const readAccount = deps.readClaudeAccount ?? _readClaudeAccount;
  let utilization = null;
  try { utilization = readUtilization(); } catch { utilization = null; }
  let claudeAccount = null;
  try { claudeAccount = readAccount(); } catch { claudeAccount = null; }
  const usageStamp = {
    ...(claudeAccount?.accountUuid ? { account_uuid: claudeAccount.accountUuid } : {}),
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
      const remote = resolveRemote(seg.repoRoot) ?? localRemote(seg.repoRoot ?? cwd);
      // Nothing left to name the work by — only reachable when the session has no cwd either.
      if (!remote) continue;
      // A single write failure must not abort the window (which would leave the cursor
      // unadvanced and re-process everything forever) — skip that segment and continue.
      // A subagent's context window is not the session's — its context fields never ship.
      const { context_peak_tokens, context_final_tokens, context_final_model, ...statsSansContext } = seg.stats;
      const stats = includeContext ? seg.stats : statsSansContext;
      try {
        const payload = {
          segmentId: `${segmentScope}:${seg.fromLine}-${seg.toLine}`,
          sessionId: session_id,
          remote,
          branch: seg.branch,
          from_line: seg.fromLine,
          to_line: seg.toLine,
          ...billingFields,
          ...usageStamp,
          session_name: sessionName,
          ...(timezone ? { timezone } : {}),
          ...(extra || {}),
          ...stats,
          duration_sec: durationSec,
        };
        enqueue(payload);
        // Claim only what actually reached the queue: a failed write must not swallow the window
        // for every later segment too.
        if (intervals?.length) {
          covered = claimIntervals(covered, intervals);
          coveredDirty = true;
        }
        lastPayload = payload;
        enqueued += 1;
      } catch { /* keep going; the cursor still advances below */ }
    }
  };
  enqueueSegments(segments, session_id);

  // Subagent turns live in <transcriptDir>/<sessionId>/subagents/agent-*.jsonl and never
  // appear in the main transcript, so each agent file gets its own delta window with its
  // own cursor. Line numbers are per-file: scope the segmentId by agent id so they can't
  // collide with main-transcript segments (or each other) on the server upsert.
  const agentCursors = state.agentCursors ?? {};
  let agentCursorsDirty = false;
  // Each subagent's display name is the `description` of the Task block that spawned it; join via
  // the meta.json toolUseId. Built once here (single main-transcript scan) for all subagents.
  const taskDescriptions = buildTaskDescriptionMap(transcript_path);
  for (const { agentId, path: agentPath, agentType, spawnDepth, toolUseId } of listSubagentTranscripts(transcript_path, session_id)) {
    const agentFrom = agentCursors[agentId] ?? 0;
    let agentDelta;
    try {
      agentDelta = computeDelta(agentPath, agentFrom, { cwd, repoRootOf, branchAt: branchOf });
    } catch { continue; }
    enqueueSegments(agentDelta.segments, `${session_id}:${agentId}`, {
      is_subagent: true,
      agent_id: agentId,
      agent_type: agentType,
      agent_name: toolUseId ? (taskDescriptions.get(toolUseId) ?? null) : null,
      spawn_depth: spawnDepth,
    }, { includeContext: false });
    // A subagent that dies on an API error never ends the main turn, so no StopFailure fires
    // for it — its transcript is the only place that failure is recorded.
    apiErrorEvents.push(...(agentDelta.apiErrorEvents ?? []));
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
    await postSessionError(
      {
        sessionId: session_id,
        error: event.error,
        errorDetails: null,
        lastAssistantMessage: event.text,
        occurredAt: event.occurredAt ?? new Date().toISOString(),
      },
      token,
      { fetchImpl },
    );
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
    const postSnapshot = deps.maybePostUsageSnapshot ?? _maybePostUsageSnapshot;
    try { await postSnapshot(token, { fetchImpl }); } catch { /* best-effort */ }
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
      enqueue({ ...state.anchor, session_name: sessionName });
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
    state.cwd = cwd ?? null;
    state.transcriptPath = transcript_path;
    state.updatedAt = new Date().toISOString();
    stateDirty = true;
  }
  if (stateDirty) {
    try { saveState(session_id, state); } catch { /* best-effort */ }
  }
  if (mapDirty) {
    try { saveRepoMap(map); } catch { /* best-effort */ }
  }

  const flush = await flushQueue(token, { fetchImpl });
  return { enqueued, flush };
}

// Returns { flushed, rejected, failed, lastError } — flushed = accepted (2xx),
// rejected = permanently declined by the server (4xx, e.g. branch not linked),
// failed = transient (5xx/network, file kept for retry).
export async function flushQueue(token, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const getAccessToken = deps.getAccessToken ?? _getAccessToken;
  const result = { flushed: 0, rejected: 0, failed: 0, lastError: null };
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

  const dir = queueDir();
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
      } else if (res.status < 500) {
        // Permanent rejection — drop the file, but remember why.
        result.rejected += 1;
        try {
          const body = await res.json();
          result.lastError = body?.message ?? `HTTP ${res.status}`;
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
