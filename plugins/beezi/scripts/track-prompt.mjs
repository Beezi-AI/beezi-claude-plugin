import { readHookInput } from '../lib/hook-input.mjs';
import { recordPermissionMode } from '../lib/permission-mode-store.mjs';
import { linkedAccountKeys, promptUploadLines } from '../lib/prompt-upload-line.mjs';

// UserPromptSubmit hook: records the permission mode for /beezi:login's preflight, and shows a running past-session upload when the card isn't drawing.
const input = readHookInput();

// This is the hook that fires for a SLASH COMMAND — verified carrying permission_mode on Claude
// Code 2.1.263 — and a slash command's transcript line carries no mode at all. It also fires
// BEFORE any of that command's own commands run, which is what lets /beezi:login's preflight see
// a Shift+Tab the user made a second ago instead of the mode of the last thing they typed.
// Cheap: a read, and a write only when the mode moved.
if (input != null) recordPermissionMode(input.session_id, input.permission_mode);

// Never throws and prints nothing on any error: a hook must not fail over a progress line.
try {
  if (input != null) {
    const lines = promptUploadLines({
      keys: linkedAccountKeys(),
      sessionId: input.session_id,
      cardSession: process.env.BEEZI_CARD,
      now: Date.now(),
    });
    if (lines.length > 0) process.stdout.write(JSON.stringify({ systemMessage: lines.join('\n') }));
  }
} catch {
  // no output
}
