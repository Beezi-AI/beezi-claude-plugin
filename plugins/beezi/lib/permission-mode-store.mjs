import path from 'path';
import { stateDir, claudeSessionsDir } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';

// The live permission mode, taken from the hook payload that states it outright.
//
// The transcript cannot answer this question. Three reasons, all observed rather than assumed:
//
//   1. Slash commands are never stamped. Every `/…` invocation writes a `type:'user'` line with
//      no `permissionMode` field at all — 341 of 341 across this machine's transcripts. So the
//      one line /beezi:login itself contributes carries no mode, and the newest stamp is from
//      whatever came BEFORE it: a typed prompt or a mode-change line, arbitrarily far back.
//   2. So a Shift+Tab out of plan or auto is invisible to the very next command. The user follows
//      the preflight's advice, re-runs /beezi:login, and the last stamp still reads 'plan' —
//      the guard repeats itself with no way out short of restarting Claude Code.
//   3. A session whose FIRST action is a slash command therefore has no mode anywhere. Nothing
//      before the first typed prompt is stamped, and a mode set at launch writes no line either.
//      Observed on a Claude Desktop session sitting in auto: zero `permission-mode` lines, one
//      stamp in the whole file, on the first thing the user typed. Had that been /beezi:login,
//      the transcript would have answered "no mode" — and the guard, failing open, would have let
//      the link start in the very mode it exists to refuse.
//   4. Claude Code documents the transcript as written asynchronously, lagging the in-memory
//      conversation, so even a stamped line is not guaranteed to be on disk when a hook or a
//      command reads the file.
//
// Hooks have none of those problems: `permission_mode` is a documented field on the hook payload,
// stating the mode in force at the instant the hook fires. UserPromptSubmit fires for a slash
// command too — before any of its commands run — so recording it there is what makes the mode
// the login flow reads the mode the user is actually in.
//
// One file per session under stateDir(), so a sibling session in the same directory can never
// answer for this one. No extension: transcript.mjs scans stateDir() for '.json' and reads those
// as checkpoint state, the same reason permission-markers.mjs uses '.perm.jsonl'.
const modeFile = (sessionId) => path.join(stateDir(), `${sessionId}.mode`);

const RECORD_VERSION = 1;

// Record the mode a hook payload reported. Best effort and silent: a hook must never fail over
// bookkeeping, and a missed record degrades to exactly the transcript read this replaced.
//
// Writes only on a CHANGE. PostToolUse fires for every tool call in the session, and the common
// case — the mode has not moved — then costs one read and no write at all.
// Returns true when a new value was written.
export function recordPermissionMode(sessionId, mode) {
  if (!sessionId || typeof mode !== 'string' || mode === '') return false;
  if (readRecordedPermissionMode(sessionId) === mode) return false;
  try {
    writeJsonSecure(modeFile(sessionId), { version: RECORD_VERSION, mode, at: new Date().toISOString() });
    return true;
  } catch {
    return false;
  }
}

// The mode last recorded for a session and when it was recorded, as { mode, at } — `at` in epoch
// ms, or null when the record carries no readable time. Both are null when nothing was recorded:
// no hook has fired yet, or the plugin's hooks are not running at all.
export function readPermissionModeRecord(sessionId) {
  if (!sessionId) return { mode: null, at: null };
  const record = readJson(modeFile(sessionId));
  if (record == null || typeof record.mode !== 'string' || record.mode === '') return { mode: null, at: null };
  const at = typeof record.at === 'string' ? Date.parse(record.at) : NaN;
  return { mode: record.mode, at: Number.isFinite(at) ? at : null };
}

// The recorded mode alone, or null when nothing was recorded.
export function readRecordedPermissionMode(sessionId) {
  return readPermissionModeRecord(sessionId).mode;
}

// This session's id, for a command that needs to find its own state.
//
// CLAUDE_CODE_SESSION_ID first. When it is absent — not every Claude Code surface exports it into
// the tool environment — fall back to the live session descriptor Claude Code writes per process
// at ~/.claude/sessions/<pid>.json, keyed by the pid it exports as CLAUDE_PID. Both keys name THIS
// process's session and nothing else, which is the property that matters: a sibling session in the
// same directory must never be able to answer for this one.
// Returns the id, or null when neither key is available.
export function resolveSessionId({ env = process.env } = {}) {
  const direct = env.CLAUDE_CODE_SESSION_ID;
  if (typeof direct === 'string' && direct !== '') return direct;

  const pid = env.CLAUDE_PID;
  if (typeof pid !== 'string' || !/^[0-9]+$/.test(pid)) return null;
  const record = readJson(path.join(claudeSessionsDir(), `${pid}.json`));
  if (record == null || typeof record.sessionId !== 'string' || record.sessionId === '') return null;
  return record.sessionId;
}
