import { readHookInput } from '../lib/hook-input.mjs';
import { runHook, importHookModule } from '../lib/hook-runner.mjs';
import { DIAGNOSTIC_SOURCES } from '../lib/telemetry-codes.mjs';

const input = readHookInput();
if (!input) process.exit(0);
runHook(DIAGNOSTIC_SOURCES.REPORT, async () => {
  const mod = await importHookModule('./checkpoint.mjs');
  if (mod != null) await mod.runCheckpoint(input, {}, { emitTimeline: true });
});
