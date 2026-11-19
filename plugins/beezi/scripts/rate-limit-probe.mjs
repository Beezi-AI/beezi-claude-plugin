import { runHook, importHookModule } from '../lib/hook-runner.mjs';
import { DIAGNOSTIC_SOURCES } from '../lib/telemetry-codes.mjs';

// Spawned detached by the prompt hook's usage-check gate: one headless probe that records live
// plan usage into the status line's queue. Prints nothing and always exits 0.
runHook(DIAGNOSTIC_SOURCES.USAGE_PING, async () => {
  const mod = await importHookModule('./rate-limit-probe.mjs');
  if (mod != null) await mod.runRateLimitProbe();
});
