import { readHookInput } from '../lib/hook-input.mjs';
import { recordPermissionMode } from '../lib/permission-mode-store.mjs';
import { runHook, importHookModule } from '../lib/hook-runner.mjs';
import { DIAGNOSTIC_SOURCES } from '../lib/telemetry-codes.mjs';

// UserPromptSubmit hook: when the user submits /beezi:track, run the tracking flow HERE and
// surface the result as a hook systemMessage — rendered by the terminal with no model round
// trip, so /beezi:track shows its result even when the API is down (no credits, outage),
// which is exactly when it gets reached for. Every other prompt exits on this fast path.
const input = readHookInput();

// Before the fast exit, and whatever the prompt turns out to be: this is the hook that fires for
// a SLASH COMMAND — verified carrying permission_mode on Claude Code 2.1.263 — and a slash
// command's transcript line carries no mode at all. It also fires BEFORE any of that command's
// own commands run, which is what lets /beezi:login's preflight see a Shift+Tab the user made a
// second ago instead of the mode of the last thing they typed.
// Cheap: a read, and a write only when the mode moved.
if (input != null) recordPermissionMode(input.session_id, input.permission_mode);

const prompt = input != null && typeof input.prompt === 'string' ? input.prompt.trim() : '';
if (!/^\/beezi:track\b/.test(prompt)) process.exit(0);

runHook(DIAGNOSTIC_SOURCES.TRACK_PROMPT, async () => {
  // Heavy imports only on the slow path so the every-prompt cost stays at node startup.
  const track = await importHookModule('./track-session.mjs');
  const { friendlyMessage } = await import('../lib/friendly-error.mjs');
  if (track == null) return null;

  const { ok, message } = await track.trackSession({
    sessionId: input.session_id,
    transcriptPath: input.transcript_path,
    cwd: input.cwd,
  }).catch((error) => ({ ok: false, message: friendlyMessage(error) }));

  return `${ok ? '✓' : '✗'} ${message}`;
}, {
  onResult: (msg) => { console.log(JSON.stringify({ systemMessage: msg })); },
});
