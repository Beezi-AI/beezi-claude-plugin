import path from 'path';
import { fileURLToPath } from 'url';
import { spawnDetached } from './background-spawn.mjs';
import { pendingHistoryOf, historyDue } from './pending-history.mjs';

export const HISTORY_WORKER_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'history-worker.mjs');

const DEFER_FLAG = '--defer-upload';

// Tests that run scripts as child processes set this so no real worker starts.
function spawnDisabled() {
  return process.env.BEEZI_TEST_NO_SPAWN === '1';
}

// --defer-upload writes the rule but leaves the upload to the flow that runs next (sync, login, the setup wizard).
export function takeDeferFlag(argv) {
  return { deferUpload: argv.indexOf(DEFER_FLAG) !== -1, argv: argv.filter((arg) => arg !== DEFER_FLAG) };
}

async function linkedRows(deps) {
  const accounts = await import('./accounts.mjs');
  const listAccounts = deps.listAccounts == null ? accounts.listAccounts : deps.listAccounts;
  return (await listAccounts()).filter((a) => a.status === accounts.AccountStatus.LINKED);
}

// After a rule write: starts the worker when the account owes any workspace its history. Never throws.
export async function startHistoryWorker(key, deps = {}) {
  if (spawnDisabled()) return false;
  try {
    const row = (await linkedRows(deps)).find((a) => a.key === key);
    if (row == null || pendingHistoryOf(row).length === 0) return false;
    return spawnDetached(HISTORY_WORKER_SCRIPT, deps, ['--account', key]) === true;
  } catch {
    return false;
  }
}

// The retry path (SessionStart): one worker per account whose pending history is due. Never throws.
export async function maybeStartPendingHistory(deps = {}) {
  if (spawnDisabled()) return 0;
  const nowMs = deps.now == null ? Date.now() : deps.now();
  let started = 0;
  try {
    for (const row of await linkedRows(deps)) {
      if (historyDue(row, nowMs) && spawnDetached(HISTORY_WORKER_SCRIPT, deps, ['--account', row.key]) === true) started += 1;
    }
  } catch { /* best-effort: the next session start retries */ }
  return started;
}
