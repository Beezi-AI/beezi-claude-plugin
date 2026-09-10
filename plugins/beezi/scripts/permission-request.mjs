import { readHookInput } from '../lib/hook-input.mjs';
import { appendPermissionMarker } from '../lib/permission-markers.mjs';

// Records the instant Claude Code is about to put a permission prompt on screen, so the session
// timeline can charge the wait that follows to the human instead of to the agent. An APPROVED
// prompt leaves nothing in the transcript to find later — this line is the only evidence.
//
// Deliberately the leanest hook in the plugin: two imports, no network, no telemetry wrapper. The
// permission dialog does not appear until this process exits, so every millisecond here is one the
// human spends looking at a frozen terminal. That is also why it does NOT go through runHook —
// that pulls in the telemetry stack and its file I/O for a hook whose whole job is one append.
//
// Prints nothing and always exits 0. Anything written to stdout would be read as a permission
// DECISION, and an empty matcher plus a stray decision would auto-approve every prompt in the
// session — the failure mode is silent and total, so this file must never gain a console call.
const input = readHookInput();
if (input != null && input.session_id) {
  appendPermissionMarker(input.session_id, {
    at: new Date().toISOString(),
    // Lets the classifier drop prompts for tools the transcript already accounts for
    // (AskUserQuestion / ExitPlanMode), rather than relabelling those waits.
    tool_name: typeof input.tool_name === 'string' ? input.tool_name : null,
    // The hook also fires where a call would be auto-denied with nobody present to ask, so the
    // mode is what separates a real wait from a machine one.
    permission_mode: typeof input.permission_mode === 'string' ? input.permission_mode : null,
  });
}
