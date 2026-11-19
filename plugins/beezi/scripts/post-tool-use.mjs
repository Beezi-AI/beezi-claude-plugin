import { readHookInput, isGitCheckpointCommand } from '../lib/hook-input.mjs';
import { runHook, importHookModule } from '../lib/hook-runner.mjs';
import { DIAGNOSTIC_SOURCES } from '../lib/telemetry-codes.mjs';

const input = readHookInput();
if (!input) process.exit(0);
// One process per tool call: a git checkpoint for a HEAD-moving Bash command, the pulse for
// everything else. The source is decided here, before the import, so a module that fails to
// load is still recorded against the right hook.
const command = input.tool_input == null ? undefined : input.tool_input.command;
const isCheckpoint = input.tool_name === 'Bash' && isGitCheckpointCommand(typeof command === 'string' ? command : '');
// Imported inside the hook, not at the top: an implementation module that throws on import is
// recorded by a runtime that is still standing.
runHook(isCheckpoint ? DIAGNOSTIC_SOURCES.CHECKPOINT : DIAGNOSTIC_SOURCES.PULSE, async () => {
  const mod = await importHookModule('./post-tool-use.mjs');
  if (mod != null) await mod.dispatchPostToolUse(input);
});
