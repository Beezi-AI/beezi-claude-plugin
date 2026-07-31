import { readHookInput } from '../lib/hook-input.mjs';
import { reportSessionError } from '../lib/stop-failure.mjs';
import { runCheckpoint } from '../lib/checkpoint.mjs';
import { exitClean } from '../lib/shutdown.mjs';

const input = readHookInput();
if (!input) process.exit(0);
// StopFailure fires INSTEAD of Stop, so this hook owns both jobs for a turn that died on an API
// error: report the failure, and checkpoint the usage the turn spent before it died.
Promise.allSettled([
  reportSessionError(input),
  runCheckpoint(input, {}, { emitTimeline: true }),
]).finally(() => exitClean(0));
