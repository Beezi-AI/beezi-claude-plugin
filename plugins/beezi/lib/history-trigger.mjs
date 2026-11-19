import path from 'path';
import { fileURLToPath } from 'url';
import { spawnDetached } from './background-spawn.mjs';
import { pendingHistoryOf, historyDue, HISTORY_RETRY_MS } from './pending-history.mjs';
import { readTrackingState, isTenantDark, isTrackingDisabled } from './tracking.mjs';
import { isMultiTenant, tenantsOf } from './workspace.mjs';
import { OfferGate, offerGate, offerStateOf, offerTenantKey, offerMode } from './offer-gate.mjs';

const SCRIPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
export const HISTORY_WORKER_SCRIPT = path.join(SCRIPTS_DIR, 'history-worker.mjs');
export const HISTORY_SCAN_SCRIPT = path.join(SCRIPTS_DIR, 'history-scan.mjs');

const DEFER_FLAG = '--defer-scan';

// Tests that run scripts as child processes set this so no real worker starts.
function spawnDisabled() {
  return process.env.BEEZI_TEST_NO_SPAWN === '1';
}

// --defer-scan writes the rule but starts no history scan: the flow that runs next (sync, login, the setup wizard) counts past sessions itself.
export function takeDeferFlag(argv) {
  return { deferScan: argv.indexOf(DEFER_FLAG) !== -1, argv: argv.filter((arg) => arg !== DEFER_FLAG) };
}

async function linkedRows(deps) {
  const accounts = await import('./accounts.mjs');
  const listAccounts = deps.listAccounts == null ? accounts.listAccounts : deps.listAccounts;
  return (await listAccounts()).filter((a) => a.status === accounts.AccountStatus.LINKED);
}

function trackingOf(row, deps) {
  return (deps.readTrackingState == null ? readTrackingState : deps.readTrackingState)(row.key);
}

// One index read and one tracking read per account for every session-start gate; the index writers re-read under their own lock.
export function sharedReads(deps = {}) {
  let rows = null;
  const tracking = new Map();
  return {
    listAccounts: () => {
      if (rows == null) rows = deps.listAccounts == null ? import('./accounts.mjs').then((a) => a.listAccounts()) : deps.listAccounts();
      return rows;
    },
    readTrackingState: (key) => {
      if (!tracking.has(key)) tracking.set(key, trackingOf({ key }, deps));
      return tracking.get(key);
    },
  };
}

// Every workspace of the row by its real id; a row without a workspace list stands for its own tenantId.
export function offerTenantIds(row) {
  const tenants = tenantsOf(row);
  if (tenants != null && tenants.length > 0) return tenants.map((t) => t.id);
  return [row.tenantId == null ? null : row.tenantId];
}

// A multi-workspace account goes dark per workspace; any other is off only when its tracking is disabled.
export function offerTrackingOff(row, state, tenantId) {
  return isMultiTenant(row) ? isTenantDark(state, tenantId) : isTrackingDisabled(state);
}

// The row's workspaces whose offer gate is OfferGate[gateName], with each one's offer mode, read from the row and its
// cached tracking state only.
export async function workspacesAt(row, state, gateName) {
  return offerTenantIds(row)
    .filter((tenantId) => offerGate(row, tenantId, { trackingOff: offerTrackingOff(row, state, tenantId) }) === OfferGate[gateName])
    .map((tenantId) => ({ tenantId, tenantKey: offerTenantKey(row, tenantId), mode: offerMode(row, tenantId) }));
}

// A stored retry time decides alone; otherwise a workspace is due an hour after its last scan.
export function scanDue(state, nowMs) {
  const retryAt = Date.parse(state.retryAt);
  if (Number.isFinite(retryAt)) return nowMs >= retryAt;
  const last = Date.parse(state.scanAt);
  return !Number.isFinite(last) || last > nowMs || nowMs - last >= HISTORY_RETRY_MS;
}

// Notes the scan on every workspace at SCAN (only those scanDue when throttled), then spawns one scan worker.
async function startScan(row, deps, throttled) {
  const nowMs = deps.now == null ? Date.now() : deps.now();
  const keys = (await workspacesAt(row, trackingOf(row, deps), 'SCAN'))
    .filter((w) => !throttled || scanDue(offerStateOf(row, w.tenantId), nowMs))
    .map((w) => w.tenantKey);
  if (keys.length === 0) return false;
  const noteOfferScan = deps.noteOfferScan == null ? (await import('./accounts.mjs')).noteOfferScan : deps.noteOfferScan;
  await noteOfferScan(row.key, keys, new Date(nowMs).toISOString());
  return spawnDetached(HISTORY_SCAN_SCRIPT, deps, ['--account', row.key]) === true;
}

// After an accepted upload: starts the history worker when any workspace of the account has an accepted upload pending. Never throws.
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

// After a rule write: scans the account's workspaces that wait for a scan, re-opened ones included. Never throws.
export async function startHistoryScan(key, deps = {}) {
  if (spawnDisabled()) return false;
  try {
    const row = (await linkedRows(deps)).find((a) => a.key === key);
    return row != null && await startScan(row, deps, false);
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

// SessionStart: one scan worker per account with a workspace at SCAN not scanned within the hour; local reads only. Never throws.
export async function maybeStartHistoryScans(deps = {}) {
  if (spawnDisabled()) return 0;
  let started = 0;
  try {
    for (const row of await linkedRows(deps)) {
      if (await startScan(row, deps, true)) started += 1;
    }
  } catch { /* best-effort: the next session start retries */ }
  return started;
}
