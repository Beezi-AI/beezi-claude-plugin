import { readHookInput } from '../lib/hook-input.mjs';
import { recordPermissionMode } from '../lib/permission-mode-store.mjs';
import { runHook, importHookModule } from '../lib/hook-runner.mjs';
import { DIAGNOSTIC_SOURCES } from '../lib/telemetry-codes.mjs';
import { maybeSpawnCostStateSync } from '../lib/cost-state-trigger.mjs';
import { maybeSpawnCoworkLive } from '../lib/cowork-live.mjs';

const input = readHookInput();
if (!input) process.exit(0);
// The launch mode, before the user has typed anything. Belt and braces: UserPromptSubmit fires
// for /beezi:login itself and records the mode before any of its commands run, so the login
// preflight does not depend on this one. Claude Code documents permission_mode as absent from
// some events, and a payload without it records nothing rather than clearing what is there.
recordPermissionMode(input.session_id, input.permission_mode);
runHook(DIAGNOSTIC_SOURCES.SESSION_START, async () => {
  const mod = await importHookModule('./session-start.mjs');
  const result = mod == null ? null : await mod.runSessionStart(input);
  maybeSpawnCostStateSync();
  maybeSpawnCoworkLive();
  return result;
}, {
  onResult: (msg) => { if (msg) process.stdout.write(JSON.stringify({ systemMessage: msg })); },
});
