import { readHookInput } from '../lib/hook-input.mjs';
import { runCheckpoint } from '../lib/checkpoint.mjs';
import { exitClean } from '../lib/shutdown.mjs';

const input = readHookInput();
if (!input) process.exit(0);
// Turn-end: emit the whole-session activity timeline alongside the segment checkpoint.
runCheckpoint(input, {}, { emitTimeline: true }).catch(() => {}).finally(() => exitClean(0));
