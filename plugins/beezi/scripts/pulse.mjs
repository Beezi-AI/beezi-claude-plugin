import { readHookInput } from '../lib/hook-input.mjs';
import { recordPermissionMode } from '../lib/permission-mode-store.mjs';
import { runHook, importHookModule } from '../lib/hook-runner.mjs';
import { DIAGNOSTIC_SOURCES } from '../lib/telemetry-codes.mjs';

const input = readHookInput();
if (!input) process.exit(0);
// PostToolUse fires for every tool call, so this is the record's heartbeat: a mode switched
// mid-turn is picked up by the next tool rather than waiting for the next prompt.
recordPermissionMode(input.session_id, input.permission_mode);
runHook(DIAGNOSTIC_SOURCES.PULSE, async () => {
  const mod = await importHookModule('./pulse.mjs');
  if (mod != null) await mod.maybeRunPulse(input);
});
