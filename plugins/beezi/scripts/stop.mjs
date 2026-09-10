import { readHookInput } from '../lib/hook-input.mjs';
import { runHook, importHookModule } from '../lib/hook-runner.mjs';
import { maybeSpawnCostStateSync } from '../lib/cost-state-trigger.mjs';
import { DIAGNOSTIC_SOURCES } from '../lib/telemetry-codes.mjs';

const input = readHookInput();
if (!input) process.exit(0);
// Turn-end: emit the whole-session activity timeline alongside the segment checkpoint.
runHook(DIAGNOSTIC_SOURCES.STOP, async () => {
  const mod = await importHookModule('./checkpoint.mjs');
  if (mod != null) await mod.runCheckpoint(input, {}, { emitTimeline: true });
  // Last, and deliberately not awaited beyond the spawn call itself: the child is detached and
  // this hook never learns what it did. Chosen over the statusline collector (not every user
  // installs it) and over SessionStart (already the heaviest hook we have).
  maybeSpawnCostStateSync();
});
