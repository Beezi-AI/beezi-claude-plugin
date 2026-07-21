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
import { detectBillingSource } from './billing.mjs';
import { readBillingConfig, subscriptionReportFields, thirdPartyReportFields } from './billing-config.mjs';
import { resolveSessionName } from './session-name.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { listSubagentTranscripts, buildTaskDescriptionMap } from './subagents.mjs';
import { loadRepoMap, saveRepoMap, upsertRoot, knownOrigin, originFromGitConfig } from './repo-map.mjs';

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
  const billingSource = detectBillingSource();
  const subscriptionFields = subscriptionReportFields(billingSource, readBillingConfig());
  const thirdPartyFields = thirdPartyReportFields(billingSource);
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
  const { nextCursor, segments, rateLimitEvents = [] } = delta;

  let enqueued = 0;
  // The last enqueued payload becomes the "anchor" we can replay to push a later rename.
  let lastPayload = null;
  const timezone = detectTimezone();
  const enqueueSegments = (segs, segmentScope, extra = null) => {
    for (const seg of segs) {
      if (seg.stats.token_total === 0 && seg.stats.duration_sec === 0) continue;
      const remote = resolveRemote(seg.repoRoot);
      if (!remote) continue;
      // A single write failure must not abort the window (which would leave the cursor
      // unadvanced and re-process everything forever) — skip that segment and continue.
      try {
        const payload = {
          segmentId: `${segmentScope}:${seg.fromLine}-${seg.toLine}`,
          sessionId: session_id,
          remote,
          branch: seg.branch,
          from_line: seg.fromLine,
          to_line: seg.toLine,
          billing_source: billingSource,
          ...subscriptionFields,
          ...thirdPartyFields,
          session_name: sessionName,
          ...(timezone ? { timezone } : {}),
          ...(extra || {}),
          ...seg.stats,
        };
        enqueue(payload);
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
    });
    if (agentDelta.nextCursor !== agentFrom) {
      agentCursors[agentId] = agentDelta.nextCursor;
      agentCursorsDirty = true;
    }
  }

  // postSessionError swallows its own failures (never rejects), so a limit-report
  // problem can't break the checkpoint — no wrapper needed.
  for (const event of rateLimitEvents) {
    await postSessionError(
      {
        sessionId: session_id,
        error: 'rate_limit',
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
  const result = { flushed: 0, rejected: 0, failed: 0, lastError: null };

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
      const res = await postJson(reportUrl, token, payload, { fetchImpl });
      if (res.status >= 200 && res.status < 300) {
        result.flushed += 1;
        fs.unlinkSync(filePath);
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
