import { readHookInput } from '../lib/hook-input.mjs';
import { maybeRunPulse } from '../lib/pulse.mjs';
import { exitClean } from '../lib/shutdown.mjs';

const input = readHookInput();
if (!input) process.exit(0);
maybeRunPulse(input).catch(() => {}).finally(() => exitClean(0));
