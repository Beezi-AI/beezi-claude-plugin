import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { beeziHome, accountsIndexFile } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { readTrackingState, isLiveTrackingAllowed } from './tracking.mjs';
import { getCoworkCacheFingerprint } from './cowork-cache.mjs';
import { runCoworkSync } from './cowork-sync.mjs';
import { spawnDetached } from './background-spawn.mjs';

const POLL_MS = 5000, SCAN_MS = 15000, PROCESS_MS = 30000;
export const liveStateFile = () => path.join(beeziHome(), 'cowork-live.json');
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'cowork-live.mjs');

// Only machine-local non-secret account metadata. A relink changes the signature even when
// Desktop's cache did not change, so the new eligible workspace gets an initial snapshot.
function eligibleRows(key = null) {
  const index = readJson(accountsIndexFile(), null);
  if (!index || !Array.isArray(index.accounts)) return [];
  const rows = index.accounts.filter((row) => row && row.status === 'linked' && /^[0-9a-f]{8}$/.test(row.key)
    && (key == null || key === row.key) && isLiveTrackingAllowed(readTrackingState(row.key)));
  return rows;
}
export function eligibleCoworkAccountKeys() { return eligibleRows().map((row) => row.key); }
export function eligibleCoworkAccounts(key = null) {
  const rows = eligibleRows(key);
  if (rows.length === 0) return '';
  return crypto.createHash('sha256').update(JSON.stringify(rows.map((row) => [row.key, row.clientId, row.linkedAt]).sort())).digest('hex');
}

export function desktopRunning(deps = {}) {
  const platform = deps.platform == null ? process.platform : deps.platform;
  const run = deps.execFileSync == null ? execFileSync : deps.execFileSync;
  const options = { encoding: 'utf8', windowsHide: true, timeout: 2000, maxBuffer: 256 * 1024, stdio: ['ignore', 'pipe', 'ignore'] };
  try {
    if (platform === 'win32') {
      // Code's cli is ALSO claude.exe. Only accept Desktop installation locations.
      const raw = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '@(Get-Process claude -ErrorAction SilentlyContinue | ForEach-Object { $_.Path }) | ConvertTo-Json -Compress'], options);
      const parsed = String(raw).trim() ? JSON.parse(raw) : [];
      const paths = Array.isArray(parsed) ? parsed : [parsed];
      const found = paths.some((p) => typeof p === 'string' && (
        /[\\/]WindowsApps[\\/]Claude_[^\\/]+[\\/]app[\\/]claude\.exe$/i.test(p)
        || /[\\/](?:AnthropicClaude|Claude)[\\/](?:app-[^\\/]+[\\/])?claude\.exe$/i.test(p)));
      return found ? true : (paths.some((p) => p == null || p === '') ? null : false);
    }
    if (platform === 'darwin') {
      const raw = run('/usr/bin/pgrep', ['-f', '/Claude.app/Contents/MacOS/Claude$'], options);
      return /^\d+/m.test(String(raw));
    }
    return false;
  } catch (error) {
    if (platform === 'darwin' && error.status === 1) return false;
    return null;
  }
}

export function maybeSpawnCoworkLive(deps = {}) {
  const eligible = deps.eligible == null ? eligibleCoworkAccounts : deps.eligible;
  const read = deps.readState == null ? () => readJson(liveStateFile(), null) : deps.readState;
  const write = deps.writeState == null ? (value) => writeJsonSecure(liveStateFile(), value) : deps.writeState;
  const spawn = deps.spawn == null ? spawnDetached : deps.spawn;
  const now = deps.now == null ? Date.now : deps.now;
  try {
    if (!eligible()) return false;
    const stamp = now(), prior = read() || {};
    if (prior.state === 'running' && stamp >= prior.heartbeatAt && stamp - prior.heartbeatAt < 30000) return false;
    if (typeof prior.attemptedAt === 'number' && stamp >= prior.attemptedAt && stamp - prior.attemptedAt < 60000) return false;
    write({ ...prior, attemptedAt: stamp });
    return spawn(SCRIPT) === true;
  } catch { return false; }
}

function succeeded(result) {
  if (!result || result.unavailable || (result.warnings && result.warnings.length)) return false;
  return (result.results || []).every((r) => r.ok && !r.halt && !r.costStatesFailed && !r.reportsFailed
    && !r.sessionsRejected && !r.unattributed && !r.permanentRejections);
}

// Managed by the worker process lease/watchdog. All timing seams permit deterministic tests.
export async function runCoworkLiveLoop(deps = {}) {
  const now = deps.now == null ? Date.now : deps.now;
  const sleep = deps.sleep == null ? (ms) => new Promise((resolve) => setTimeout(resolve, ms)) : deps.sleep;
  const eligible = deps.eligible == null ? eligibleCoworkAccounts : deps.eligible;
  const running = deps.desktopRunning == null ? desktopRunning : deps.desktopRunning;
  const fingerprint = deps.fingerprint == null ? getCoworkCacheFingerprint : deps.fingerprint;
  const sync = deps.sync == null ? () => runCoworkSync({}, { live: true }) : deps.sync;
  const status = deps.status == null ? () => {} : deps.status;
  let observed = null, accounts = null, pending = true, nextAttempt = 0, lastScan = -SCAN_MS;
  let nextProcess = 0, absentSince = null, unconfirmedSince = null, backoff = SCAN_MS, scans = 0;
  const finish = (reason) => { const result = { reason, scans }; status({ state: 'stopped', ...result }); return result; };
  for (;;) {
    const stamp = now(), currentAccounts = eligible();
    if (!currentAccounts) return finish('not-eligible');
    if (currentAccounts !== accounts) { accounts = currentAccounts; pending = true; nextAttempt = 0; }
    if (stamp >= nextProcess) {
      const alive = running(); nextProcess = stamp + PROCESS_MS;
      if (alive !== true && unconfirmedSince == null) unconfirmedSince = stamp;
      if (alive === false) { if (absentSince == null) absentSince = stamp; }
      else if (alive == null) { absentSince = null; }
      else { absentSince = null; unconfirmedSince = null; }
    }
    if (absentSince != null && stamp - absentSince >= 120000) return finish('desktop-closed');
    if (unconfirmedSince != null && stamp - unconfirmedSince >= 300000) return finish('liveness-unavailable');
    try {
      const value = fingerprint();
      if (value !== observed) { observed = value; pending = true; }
      if (value != null && pending && stamp >= nextAttempt && stamp - lastScan >= SCAN_MS) {
        lastScan = stamp; scans += 1;
        let result;
        try { result = await sync(); } catch { result = { unavailable: true }; }
        if (succeeded(result)) { pending = false; backoff = SCAN_MS; }
        else { nextAttempt = now() + backoff; backoff = Math.min(backoff * 2, 300000); }
      }
    } catch { pending = true; /* Retry a racing cache; never mark it observed successfully. */ }
    status({ state: 'running', scans, pending, nextAttempt });
    await sleep(POLL_MS);
  }
}
