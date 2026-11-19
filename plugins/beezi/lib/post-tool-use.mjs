import { isGitCheckpointCommand } from './hook-input.mjs';
import { recordPermissionMode as _recordPermissionMode } from './permission-mode-store.mjs';
import { maybeRunPulse as _maybeRunPulse, refreshPulseClaim as _refreshPulseClaim } from './pulse.mjs';

// The one PostToolUse hook process. It used to be two (a Bash-matched git checkpoint and the
// every-tool pulse), so every Bash call started two Node processes. checkpoint.mjs is imported
// only on the git path: the pulse path must stay at node-startup cost for almost every tool call.

// True for a Bash call whose command moves HEAD or records a commit: the segment boundary.
export function isCheckpointToolUse(input) {
  if (input == null || input.tool_name !== 'Bash') return false;
  const command = input.tool_input == null ? undefined : input.tool_input.command;
  return isGitCheckpointCommand(typeof command === 'string' ? command : '');
}

// -> { job: 'checkpoint' | 'pulse', result }. Throws only what the job throws (runHook records it).
export async function dispatchPostToolUse(input, deps = {}) {
  const recordPermissionMode = deps.recordPermissionMode == null ? _recordPermissionMode : deps.recordPermissionMode;
  const refreshPulseClaim = deps.refreshPulseClaim == null ? _refreshPulseClaim : deps.refreshPulseClaim;
  const maybeRunPulse = deps.maybeRunPulse == null ? _maybeRunPulse : deps.maybeRunPulse;

  // PostToolUse fires for every tool call, so this is the record's heartbeat: a mode switched
  // mid-turn is picked up by the next tool rather than waiting for the next prompt.
  recordPermissionMode(input.session_id, input.permission_mode);

  if (isCheckpointToolUse(input)) {
    const runCheckpoint = deps.runCheckpoint == null
      ? (await import('./checkpoint.mjs')).runCheckpoint
      : deps.runCheckpoint;
    // The queue goes to the background uploader. No lockWaitMs: a PostToolUse run skips when the
    // session lock is held (a Stop or another checkpoint is already covering this window).
    const result = await runCheckpoint(input, {}, { backgroundFlush: true, localOnly: true });
    // This checkpoint covered the window a pulse would: no pulse within the next interval.
    if (input.session_id) refreshPulseClaim(input.session_id);
    return { job: 'checkpoint', result };
  }
  return { job: 'pulse', result: await maybeRunPulse(input) };
}
