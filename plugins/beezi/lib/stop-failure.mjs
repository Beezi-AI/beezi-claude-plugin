import { scanTranscriptTail } from './transcript-reader.mjs';
import { linkedSessions as _linkedSessions, accountRecipient } from './sessions.mjs';
import { listAccounts as _listAccounts, AccountStatus } from './accounts.mjs';
import { enqueueOutbox, OUTBOX_KINDS } from './outbox.mjs';
import { maybeSpawnUploadWorker } from './upload-trigger.mjs';
import { postSessionError } from './session-error-report.mjs';
import { allowsLiveFor, readTrackingState } from './tracking.mjs';
import { resolveFetch } from './fetch-compat.mjs';
import { readSessionWorkspace, expandTargets, resolveTargets } from './workspace.mjs';
import { createTranscriptMemo as _createTranscriptMemo } from './transcript-memo.mjs';
import { CHECKPOINT_LOCK_WAIT_MS } from './single-instance-lock.mjs';
import { privateKinds, markPrivate } from './anonymization.mjs';
import { exactResetsAt } from './rate-limit-reset.mjs';

// Walks the memo's whole-file records newest first, so the tail scan reuses the parse the
// checkpoint needs anyway instead of reading the file a second time.
function memoTail(transcriptMemo) {
  return (transcriptPath, visit) => {
    const records = transcriptMemo.main(transcriptPath).records;
    for (let i = records.length - 1; i >= 0; i--) {
      if (visit(records[i].line) === true) return;
    }
  };
}

// Best-effort: pull the last assistant message text, any API-error detail, and the error line's
// own timestamp and exact reset from the transcript tail. The StopFailure `error` code is the
// reliable signal; these fill in whatever the hook payload didn't carry. With deps.transcriptMemo
// the records come from the memo's one read of the main transcript.
export function readErrorContext(transcriptPath, deps = {}) {
  let scanTail = deps.scanTail == null ? scanTranscriptTail : deps.scanTail;
  if (deps.transcriptMemo != null) scanTail = memoTail(deps.transcriptMemo);
  const empty = { lastAssistantMessage: null, errorDetails: null, occurredAt: null, resetsAt: null };
  if (!transcriptPath) return empty;

  let lastAssistantMessage = null;
  let errorDetails = null;
  let occurredAt = null;
  let resetsAt = null;
  try {
    scanTail(transcriptPath, (line) => {
      if (errorDetails == null) {
        errorDetails = extractErrorDetail(line);
        if (errorDetails != null && typeof line.timestamp === 'string') occurredAt = line.timestamp;
        if (errorDetails != null) resetsAt = exactResetsAt(line);
      }
      if (lastAssistantMessage == null && line.type === 'assistant') {
        lastAssistantMessage = extractText(line.message);
      }
      return lastAssistantMessage != null && errorDetails != null;
    });
  } catch {
    return empty;
  }
  return { lastAssistantMessage, errorDetails, occurredAt, resetsAt };
}

function extractText(message) {
  if (!message) return null;
  const c = message.content;
  if (typeof c === 'string') return truncate(c.trim()) || null;
  if (Array.isArray(c)) {
    const text = c
      .filter((b) => b != null && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim();
    return text ? truncate(text) : null;
  }
  return null;
}

// On an API-error transcript line `line.error` is the error CODE, which already travels as the
// payload's `error` — so take a detail off the object form only, then the rendered text.
function extractErrorDetail(line) {
  if (line == null) return null;
  if (!line.isApiErrorMessage && !line.is_error && line.type !== 'error') return null;
  let msg = line.error == null ? undefined : line.error.message;
  if (msg == null) msg = line.message == null ? undefined : line.message.content;
  if (msg == null) msg = null;
  if (typeof msg === 'string') return truncate(msg);
  return extractText(line.message);
}

function truncate(s, n = 1000) {
  return s.length > n ? s.slice(0, n) : s;
}

// Reports a StopFailure to Beezi so it can be attached to the session. Fire-and-forget:
// StopFailure ignores hook output/exit, so any failure here is swallowed by the caller.
//
// `deps.localOnly` (the hook): no credential read and no POST. The targets come from the linked
// account rows through accountRecipient (never the row's web-side tenantId), and each target's
// error becomes an outbox item the upload worker sends. -> { reported: false, outboxed }.
export async function reportSessionError(input, deps = {}) {
  const localOnly = deps.localOnly === true;
  const fetchImpl = localOnly ? null : (deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl);
  const now = deps.now == null ? () => new Date() : deps.now;
  const getSessions = deps.linkedSessions == null ? _linkedSessions : deps.linkedSessions;
  const listAccounts = deps.listAccounts == null ? _listAccounts : deps.listAccounts;
  // /sessions/errors carries the same tracking gate as /sessions/report — this path posts
  // outside runCheckpoint, so each account needs its own check or a dark tenant 403s on every failure.
  const isAllowed = deps.isLiveTrackingAllowedImpl == null
    ? ((s) => allowsLiveFor(s, readTrackingState(s.key)))
    : deps.isLiveTrackingAllowedImpl;

  const sessionId = input == null ? undefined : input.session_id;
  // Claude Code names this field `error` on the StopFailure payload; `error_type` was the
  // older spelling and costs nothing to keep accepting.
  let error = input == null ? undefined : input.error;
  if (error == null) error = input == null ? undefined : input.error_type;
  if (!sessionId || !error) return { reported: false, reason: 'missing-fields' };

  let all;
  if (localOnly) {
    let rows = [];
    try { rows = await listAccounts(deps); } catch { rows = []; }
    all = (rows || [])
      .filter((row) => row != null && row.status === AccountStatus.LINKED)
      .map(accountRecipient);
  } else {
    // deps.sessions lets a caller share one linkedSessions() result with runCheckpoint.
    all = deps.sessions == null ? await getSessions(deps).catch(() => []) : deps.sessions;
  }
  let workspaceState = null;
  try { workspaceState = readSessionWorkspace(sessionId); } catch { /* best-effort */ }
  // One clone per target workspace; an account with none left is skipped.
  const expanded = expandTargets(all, workspaceState);
  if (all.length === 0) return { reported: false, reason: 'no-token' };
  if (expanded.length === 0) {
    const pending = all.some((s) => resolveTargets(s, workspaceState).pendingAsk);
    return { reported: false, reason: pending ? 'workspace-pending' : 'no-targets' };
  }
  const sessions = expanded.filter(isAllowed);
  if (sessions.length === 0) return { reported: false, reason: 'tracking-disabled' };

  const context = readErrorContext(input.transcript_path, deps);
  const payload = {
    sessionId,
    error,
    // The hook hands us both of these; the transcript scan covers the case where it doesn't.
    errorDetails: input.error_details == null ? context.errorDetails : input.error_details,
    lastAssistantMessage: input.last_assistant_message == null ? context.lastAssistantMessage : input.last_assistant_message,
    // Stamp from the transcript's own error line so this lands on the same server row as the
    // checkpoint's transcript scan, which can't see the hook's clock.
    occurredAt: context.occurredAt == null ? now().toISOString() : context.occurredAt,
  };
  // Same line, same exact reset as the checkpoint's scan: the server's row key uses resetsAt when
  // there is one, so both paths must send it or one event becomes two rows.
  if (context.resetsAt != null) payload.resetsAt = context.resetsAt;
  if (localOnly) {
    let outboxed = 0;
    // Marked with the kinds the targets hide now, as queued reports are, for the worker's later send.
    const marked = markPrivate(payload, privateKinds(sessions.map((s) => ({ session: s, targets: [s.tenantId], hold: [] }))));
    for (const s of sessions) {
      try {
        enqueueOutbox(s.key, { kind: OUTBOX_KINDS.ERROR, tenantId: s.tenantId, sessionId, payload: marked });
        outboxed += 1;
      } catch { /* best-effort, as the POST was */ }
    }
    return { reported: false, outboxed };
  }
  const results = await Promise.all(sessions.map((s) => postSessionError(payload, s, { fetchImpl })));
  return { reported: results.some((r) => r.reported), results };
}

// The StopFailure hook body. StopFailure fires INSTEAD of Stop, so it owns both jobs for a turn
// that died on an API error: report the failure, and checkpoint the usage the turn spent before it
// died. Both run localOnly: no credential read, no network; the upload worker sends what they
// write. One main-transcript read (the shared memo) serves both. deps.runCheckpoint is the one the
// hook could import; without it only the report runs. Other deps are test seams passed to both.
//
// The checkpoint runs first: its transcript scan and this report can describe the same error line
// (same error code and timestamp, so the same outbox file), and the report's payload is the richer
// one (it carries the hook's error details), so it is written last. The checkpoint's spawn ran
// before the report's item existed, so a written item asks the spawn gate once more (a worker
// started moments ago makes that call a cheap 'throttled').
export async function runStopFailure(input, deps = {}) {
  const report = deps.reportSessionError == null ? reportSessionError : deps.reportSessionError;
  const newMemo = deps.createTranscriptMemo == null ? _createTranscriptMemo : deps.createTranscriptMemo;
  const checkpoint = deps.runCheckpoint == null ? null : deps.runCheckpoint;
  const spawnUploadWorker = deps.spawnUploadWorker == null ? maybeSpawnUploadWorker : deps.spawnUploadWorker;

  const transcriptMemo = newMemo();
  const shared = Object.assign({}, deps, { transcriptMemo });
  // Each job settles on its own: a throw in one never cancels the other.
  if (checkpoint != null) {
    try {
      await checkpoint(input, shared, { emitTimeline: true, backgroundFlush: true, localOnly: true, lockWaitMs: CHECKPOINT_LOCK_WAIT_MS });
    } catch { /* the report still runs */ }
  }
  let reported = null;
  try {
    reported = await report(input, Object.assign({}, shared, { localOnly: true }));
  } catch { reported = null; }
  if (reported != null && reported.outboxed > 0) {
    try { spawnUploadWorker(); } catch { /* the next hook retries */ }
  }
}
