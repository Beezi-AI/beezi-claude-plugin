import { readHookInput, isGitCheckpointCommand } from '../lib/hook-input.mjs';
import { runCheckpoint } from '../lib/checkpoint.mjs';
import { exitClean } from '../lib/shutdown.mjs';

const input = readHookInput();
if (!input) process.exit(0);
if (!isGitCheckpointCommand(input.tool_input?.command ?? '')) process.exit(0);
runCheckpoint(input).catch(() => {}).finally(() => exitClean(0));
