import fs from 'fs';
import { getAccessToken } from './token.mjs';
import { postSessionError } from './session-error-report.mjs';
import { isLiveTrackingAllowed } from './tracking.mjs';
import { resolveFetch } from './fetch-compat.mjs';

// Best-effort: pull the last assistant message text, any API-error detail, and the error line's
// own timestamp from the transcript tail. The StopFailure `error` code is the reliable signal;
// these fill in whatever the hook payload didn't carry.
export function readErrorContext(transcriptPath, deps = {}) {
  const readFile = deps.readFile == null ? ((p) => fs.readFileSync(p, 'utf-8')) : deps.readFile;
  const empty = { lastAssistantMessage: null, errorDetails: null, occurredAt: null };
  if (!transcriptPath) return empty;

  let content;
  try {
    content = readFile(transcriptPath);
  } catch {
    return empty;
  }
  const trimmed = String(content).replace(/\n+$/, '');
  if (!trimmed) return empty;

  const lines = trimmed.split('\n');
  let lastAssistantMessage = null;
  let errorDetails = null;
  let occurredAt = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    let line;
    try { line = JSON.parse(lines[i]); } catch { continue; }
    if (errorDetails == null) {
      errorDetails = extractErrorDetail(line);
      if (errorDetails != null && typeof line.timestamp === 'string') occurredAt = line.timestamp;
    }
    if (lastAssistantMessage == null && line.type === 'assistant') {
      lastAssistantMessage = extractText(line.message);
    }
    if (lastAssistantMessage != null && errorDetails != null) break;
  }
  return { lastAssistantMessage, errorDetails, occurredAt };
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
export async function reportSessionError(input, deps = {}) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const now = deps.now == null ? () => new Date() : deps.now;
  const getTokenImpl = deps.getAccessToken == null ? getAccessToken : deps.getAccessToken;
  const isAllowed = deps.isLiveTrackingAllowedImpl == null ? isLiveTrackingAllowed : deps.isLiveTrackingAllowedImpl;

  // /sessions/errors carries the same tracking gate as /sessions/report — this path posts
  // outside runCheckpoint, so it needs its own check or a dark tenant 403s on every failure.
  if (!isAllowed()) return { reported: false, reason: 'tracking-disabled' };

  const sessionId = input == null ? undefined : input.session_id;
  // Claude Code names this field `error` on the StopFailure payload; `error_type` was the
  // older spelling and costs nothing to keep accepting.
  let error = input == null ? undefined : input.error;
  if (error == null) error = input == null ? undefined : input.error_type;
  if (!sessionId || !error) return { reported: false, reason: 'missing-fields' };

  const token = await getTokenImpl(deps);
  if (!token) return { reported: false, reason: 'no-token' };

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
  return postSessionError(payload, token, { fetchImpl });
}
