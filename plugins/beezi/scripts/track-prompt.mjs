import { readHookInput } from '../lib/hook-input.mjs';
import { recordPermissionMode } from '../lib/permission-mode-store.mjs';

// UserPromptSubmit hook: records the permission mode for /beezi:login's preflight.
const input = readHookInput();

// This is the hook that fires for a SLASH COMMAND — verified carrying permission_mode on Claude
// Code 2.1.263 — and a slash command's transcript line carries no mode at all. It also fires
// BEFORE any of that command's own commands run, which is what lets /beezi:login's preflight see
// a Shift+Tab the user made a second ago instead of the mode of the last thing they typed.
// Cheap: a read, and a write only when the mode moved.
if (input != null) recordPermissionMode(input.session_id, input.permission_mode);
