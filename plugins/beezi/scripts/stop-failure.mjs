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
  const runCheckpoint = checkpoint == null ? null : checkpoint.runCheckpoint;
  if (failure != null) {
    await failure.runStopFailure(input, { runCheckpoint });
    return;
  }
  // The report module failed to load: the turn's usage is still checkpointed.
  if (runCheckpoint != null) await runCheckpoint(input, {}, { emitTimeline: true, backgroundFlush: true, localOnly: true, lockWaitMs: checkpoint.CHECKPOINT_LOCK_WAIT_MS });
});
