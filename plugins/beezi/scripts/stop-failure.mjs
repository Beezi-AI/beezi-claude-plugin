import { readHookInput } from '../lib/hook-input.mjs';
import { runHook, importHookModule } from '../lib/hook-runner.mjs';
import { DIAGNOSTIC_SOURCES } from '../lib/telemetry-codes.mjs';

const input = readHookInput();
if (!input) process.exit(0);
// StopFailure fires INSTEAD of Stop, so this hook owns both jobs for a turn that died on an API
// error: report the failure, and checkpoint the usage the turn spent before it died.
runHook(DIAGNOSTIC_SOURCES.STOP_FAILURE, async () => {
  const failure = await importHookModule('./stop-failure.mjs');
  const checkpoint = await importHookModule('./checkpoint.mjs');
  await Promise.allSettled([
    failure == null ? null : failure.reportSessionError(input),
    checkpoint == null ? null : checkpoint.runCheckpoint(input, {}, { emitTimeline: true }),
  ]);
});
