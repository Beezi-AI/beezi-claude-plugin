import fs from 'fs';
import { findTranscriptBySessionId } from './transcript.mjs';
import { readPermissionModeRecord, resolveSessionId } from './permission-mode-store.mjs';

// The two permission modes that stop /beezi:login.
//
// 'plan' gates the shell commands the link is made of, so the sign-in script is never reached.
//
// 'auto' hands every command to Claude Code's permission classifier instead of prompting, and the
// classifier denies this plugin's node scripts. Observed on a real machine: the sign-in was allowed
// and completed, then billing-capture.mjs was refused — via both Bash and PowerShell — leaving the
// machine linked with no plan captured and the backfill unrunnable. That half-linked state is the
// exact outcome this guard exists to prevent, and no local check can predict a classifier verdict
// before running the command, so the mode itself has to be the signal.
//
// Every other mode ('default', 'acceptEdits', 'dontAsk', 'bypassPermissions') runs the flow.
// Verified against Claude Code 2.1.235, which stamps 'default' for the `manual` CLI flag.
//
// Plan is matched by substring, the same way session-timeline.mjs matches planning, so a schema
// tweak — 'plan_mode', 'planning' — still catches instead of silently passing the guard. Auto is
// matched exactly: it is a whole mode name, not a family.
export function isPlanMode(mode) {
  return typeof mode === 'string' && mode.toLowerCase().includes('plan');
}

export function isAutoMode(mode) {
  return typeof mode === 'string' && mode.toLowerCase() === 'auto';
}

// The permission mode carried by one transcript line, from either a dedicated
// `type:'permission-mode'` change line or the `permissionMode` stamped on a user prompt line.
// Claude Code's `type:'mode'` lines carry the EDITOR mode ('normal'/'insert'), never this one.
function permissionModeOf(line) {
  if (line == null || typeof line.permissionMode !== 'string' || line.permissionMode === '') return null;
  return line.permissionMode;
}

// Last permission mode set anywhere in a transcript. Forward scan, not a tail read: the field is
// stamped sparsely (a session that never toggled can carry a single stamp near the top and
// nothing after), so reading only the last N lines returns null in the common case.
// Sidechain lines are skipped — a subagent runs under its own mode and must not overwrite the
// main thread's.
// Returns the mode string, or null when the transcript is unreadable or never stamped one.
export function readPermissionMode(transcriptPath) {
  return readPermissionModeStamp(transcriptPath).mode;
}

// The same scan, plus WHEN the mode it found was set — so a caller holding a second, independent
// reading of the mode can tell which of the two is the more recent.
//
// `at` is epoch ms, or null when no time can be established. Mode-change lines
// (`type:'permission-mode'`) carry no timestamp of their own, so they inherit the newest timestamp
// seen earlier in the file: a lower bound on when the change happened, which is all a
// "which is newer" comparison needs. User-line stamps carry their own.
// Returns { mode, at }.
export function readPermissionModeStamp(transcriptPath) {
  let content;
  try {
    content = fs.readFileSync(transcriptPath, 'utf-8');
  } catch {
    return { mode: null, at: null };
  }
  let mode = null;
  let at = null;
  let newestSeen = null;
  for (const raw of content.split('\n')) {
    if (!raw.trim()) continue;
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (line != null && line.isSidechain === true) continue;
    const ts = line == null || typeof line.timestamp !== 'string' ? NaN : Date.parse(line.timestamp);
    if (Number.isFinite(ts) && (newestSeen === null || ts > newestSeen)) newestSeen = ts;
    const pm = permissionModeOf(line);
    if (pm !== null) {
      mode = pm;
      at = Number.isFinite(ts) ? ts : newestSeen;
    }
  }
  return { mode, at };
}

// The permission mode of the session this command runs inside.
//
// Two independent readings, and the NEWER one wins. The hook record is what a hook payload said
// the mode was at the instant it fired; the transcript stamp is what Claude Code last logged.
// Normally the record is newer, and that is the whole point: the transcript stamps typed prompts
// and mode changes but never a slash-command line, so at the moment /beezi:login runs its newest
// stamp predates the command — and predates a Shift+Tab the user made in between. See
// permission-mode-store.mjs for the evidence.
//
// The transcript is not merely a fallback for a missing record, though, which is why this compares
// times instead of preferring the record outright: hooks can stop firing mid-session (disabled,
// or erroring) while Claude Code keeps stamping prompts, and a record frozen at 'plan' would then
// block a login forever with advice that changes nothing. Whichever reading is newer is the one
// that saw the user last; the record wins ties and wins whenever the other side carries no time.
//
// Keyed on THIS session and nothing else. The cwd-based fallbacks resolveSessionTranscript() uses
// (newest transcript in the project dir, newest checkpoint state for the cwd) can resolve a
// SIBLING session running in the same directory — and a sibling sitting in plan mode would
// hard-block a login from a session that is already in normal mode, with advice ("press
// Shift+Tab") that changes nothing. A guard with no way out is worse than a guard that misses.
//
// Fails OPEN everywhere: no session id, no record, no transcript, or a session that never stamped
// a mode all report null, so a detection miss never bricks /beezi:login.
// Returns the mode string, or null when it cannot be determined.
export function detectPermissionMode({ env = process.env } = {}) {
  const sessionId = resolveSessionId({ env });
  if (!sessionId) return null;

  const record = readPermissionModeRecord(sessionId);
  const session = findTranscriptBySessionId(sessionId);
  const stamp = session == null ? { mode: null, at: null } : readPermissionModeStamp(session.transcriptPath);

  if (record.mode === null) return stamp.mode;
  if (stamp.mode === null) return record.mode;
  if (stamp.at !== null && record.at !== null && stamp.at > record.at) return stamp.mode;
  return record.mode;
}
