import { readHookInput } from '../lib/hook-input.mjs';
import { runHook, importHookModule } from '../lib/hook-runner.mjs';
import { DIAGNOSTIC_SOURCES } from '../lib/telemetry-codes.mjs';

// Captures Claude Code's subscription-limit cache at moments runCheckpoint does not cover:
// every prompt, before a compaction, and when a subagent finishes. Turn end and session end
// already post from inside runCheckpoint, so this fills the mid-turn and between-turn gaps.
//
// Silent by design: it prints nothing and always exits 0, so it can never annotate a turn or
// block one. The common case is a single stat() of ~/.claude.json and an immediate exit.
readHookInput();
runHook(DIAGNOSTIC_SOURCES.USAGE_PING, async () => {
  const mod = await importHookModule('./usage-ping.mjs');
  if (mod != null) await mod.pingUsageSnapshot();
});
