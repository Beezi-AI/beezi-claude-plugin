import { readHookInput, isGitCheckpointCommand } from '../lib/hook-input.mjs';
import { runHook, importHookModule } from '../lib/hook-runner.mjs';
import { DIAGNOSTIC_SOURCES } from '../lib/telemetry-codes.mjs';

const input = readHookInput();
if (!input) process.exit(0);
const command = input.tool_input == null ? undefined : input.tool_input.command;
if (!isGitCheckpointCommand(command == null ? '' : command)) process.exit(0);
// Imported inside the hook, not at the top: an implementation module that throws on import is
// recorded by a runtime that is still standing.
runHook(DIAGNOSTIC_SOURCES.CHECKPOINT, async () => {
  const mod = await importHookModule('./checkpoint.mjs');
  if (mod != null) await mod.runCheckpoint(input);
});
