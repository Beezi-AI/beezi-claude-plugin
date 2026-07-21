import fs from 'node:fs';
import { getAccessToken } from './token.mjs';
import { postSessionError } from './session-error-report.mjs';

// Best-effort: pull the last assistant message text and any API-error detail from the
// transcript tail. The StopFailure error_type is the reliable signal; these are extra context.
export function readErrorContext(transcriptPath, deps = {}) {
  const readFile = deps.readFile ?? ((p) => fs.readFileSync(p, 'utf-8'));
  const empty = { lastAssistantMessage: null, errorDetails: null };
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
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    let line;
    try { line = JSON.parse(lines[i]); } catch { continue; }
    if (errorDetails == null) errorDetails = extractErrorDetail(line);
    if (lastAssistantMessage == null && line.type === 'assistant') {
      lastAssistantMessage = extractText(line.message);
    }
    if (lastAssistantMessage != null && errorDetails != null) break;
  }
  return { lastAssistantMessage, errorDetails };
}

function extractText(message) {
  if (!message) return null;
  const c = message.content;
  if (typeof c === 'string') return truncate(c.trim()) || null;
  if (Array.isArray(c)) {
    const text = c
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim();
    return text ? truncate(text) : null;
  }
  return null;
}

function extractErrorDetail(line) {
  if (!line?.isApiErrorMessage && !line?.is_error && line?.type !== 'error') return null;
  const msg = line.error?.message ?? line.error ?? line.message?.content ?? null;
  if (typeof msg === 'string') return truncate(msg);
  return extractText(line.message);
}

function truncate(s, n = 1000) {
  return s.length > n ? s.slice(0, n) : s;
}

// Reports a StopFailure to Beezi so it can be attached to the session. Fire-and-forget:
// StopFailure ignores hook output/exit, so any failure here is swallowed by the caller.
export async function reportSessionError(input, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const now = deps.now ?? (() => new Date());
  const getTokenImpl = deps.getAccessToken ?? getAccessToken;

  const sessionId = input?.session_id;
  const error = input?.error_type;
  if (!sessionId || !error) return { reported: false, reason: 'missing-fields' };

  const token = await getTokenImpl(deps);
  if (!token) return { reported: false, reason: 'no-token' };

  const { lastAssistantMessage, errorDetails } = readErrorContext(input.transcript_path, deps);
  const payload = {
    sessionId,
    error,
    errorDetails,
    lastAssistantMessage,
    occurredAt: now().toISOString(),
  };
  return postSessionError(payload, token, { fetchImpl });
}
