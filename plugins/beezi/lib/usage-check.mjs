import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { acquireLock, releaseLock } from './single-instance-lock.mjs';
import { spawnDetached as _spawnDetached } from './background-spawn.mjs';
import { statuslineInstalled as _statuslineInstalled } from './statusline-install.mjs';
import { readUsageUtilization as _readUsageUtilization } from './usage-utilization.mjs';
import { hasOauthTokenIdentity } from './oauth-identity.mjs';
import { oauthTokenEnv } from './claude-settings-env.mjs';
import { readBillingConfig } from './billing-config.mjs';
import { recordOwnsIdentity } from './identity-stamp.mjs';
import { statuslineUsageFile, usageCheckFile, usageCheckNoticeFile, usageCheckStateFile } from './paths.mjs';

// The opt-in plan-usage check: where the status line can't run, a background `claude -p` probe
// reads the live rate limits. This module is the cheap gate the prompt hook asks first.

export const USAGE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
export const USAGE_CHECK_BACKOFF_MS = 6 * 60 * 60 * 1000;
export const USAGE_CHECK_BACKOFF_AFTER = 3;
export const USAGE_CHECK_FRESH_MS = 30 * 60 * 1000;
export const USAGE_CHECK_NOTICE = "Beezi: the desktop app has no status line, so Beezi can't see your plan usage here. /beezi:settings usage-check on lets Beezi check it with one small request at most every 30 minutes.";

const DESKTOP_ENTRYPOINT = 'claude-desktop';
const CLI_ENTRYPOINT = 'cli';
const LOCK_NAME = 'usage-check';
const SUCCESS_OUTCOMES = ['recorded', 'unchanged'];
const PROBE_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'rate-limit-probe.mjs');

const stringOrNull = (value) => (typeof value === 'string' ? value : null);
const skip = (reason) => ({ started: false, reason });

export function usageCheckEnabled() {
  const raw = readJson(usageCheckFile());
  return raw != null && raw.enabled === true;
}

export function setUsageCheckEnabled(on) {
  writeJsonSecure(usageCheckFile(), { version: 1, enabled: on === true });
}

export function readUsageCheckState() {
  const raw = readJson(usageCheckStateFile());
  const state = raw == null || typeof raw !== 'object' ? {} : raw;
  return {
    lastAttemptAt: stringOrNull(state.lastAttemptAt),
    consecutiveFailures: Number.isInteger(state.consecutiveFailures) ? state.consecutiveFailures : 0,
    lastOutcome: stringOrNull(state.lastOutcome),
    lastEntrypoint: stringOrNull(state.lastEntrypoint),
    lastBinaryKind: stringOrNull(state.lastBinaryKind),
  };
}

function writeUsageCheckState(state) {
  writeJsonSecure(usageCheckStateFile(), { version: 1, ...state });
}

export function recordUsageCheckOutcome(outcome, extras = {}) {
  const state = readUsageCheckState();
  writeUsageCheckState({
    ...state,
    consecutiveFailures: SUCCESS_OUTCOMES.includes(outcome) ? 0 : state.consecutiveFailures + 1,
    lastOutcome: outcome,
    lastEntrypoint: stringOrNull(extras.lastEntrypoint),
    lastBinaryKind: stringOrNull(extras.lastBinaryKind),
  });
}

function throttled(state, nowMs) {
  const wait = state.consecutiveFailures >= USAGE_CHECK_BACKOFF_AFTER ? USAGE_CHECK_BACKOFF_MS : USAGE_CHECK_INTERVAL_MS;
  return nowMs - Date.parse(state.lastAttemptAt) < wait;
}

// The desktop app never runs a status line; the plain CLI only lacks one when Beezi's isn't installed.
export function sessionCanProbe(env, isStatuslineInstalled) {
  const entrypoint = env.CLAUDE_CODE_ENTRYPOINT;
  if (entrypoint === DESKTOP_ENTRYPOINT) return true;
  if (entrypoint == null || entrypoint === CLI_ENTRYPOINT) return !isStatuslineInstalled();
  return false;
}

// Under the lock so concurrent sessions submitting at once start one probe between them.
export function claimUsageCheck(deps = {}) {
  const now = deps.now == null ? () => new Date() : deps.now;
  if (!acquireLock(LOCK_NAME)) return false;
  try {
    const state = readUsageCheckState();
    const at = now();
    if (throttled(state, at.getTime())) return false;
    writeUsageCheckState({ ...state, lastAttemptAt: at.toISOString() });
    return true;
  } catch {
    return false;
  } finally {
    releaseLock(LOCK_NAME);
  }
}

// A setup token in the env, or a key-scoped billing record the drain also treats as a key in force.
export function setupTokenInForce(env) {
  if (hasOauthTokenIdentity(env)) return true;
  try {
    return recordOwnsIdentity(readBillingConfig());
  } catch {
    return false;
  }
}

// The status line's own reading first: ~/.claude.json is large, so its cache is read only when needed.
function hasFreshReading(nowMs, readUsageUtilization) {
  const isFresh = (ms) => nowMs - ms < USAGE_CHECK_FRESH_MS;
  const statusline = readJson(statuslineUsageFile());
  if (statusline != null && isFresh(Date.parse(statusline.lastRecordedAt))) return true;
  const cache = readUsageUtilization();
  return cache != null && isFresh(cache.fetchedAtMs);
}

export async function maybeStartUsageCheck(deps = {}) {
  if (!usageCheckEnabled()) return skip('disabled');
  const env = deps.env == null ? process.env : deps.env;
  const now = deps.now == null ? () => new Date() : deps.now;
  const statuslineInstalled = deps.statuslineInstalled == null ? _statuslineInstalled : deps.statuslineInstalled;
  const readUsageUtilization = deps.readUsageUtilization == null ? _readUsageUtilization : deps.readUsageUtilization;
  const spawnDetached = deps.spawnDetached == null ? _spawnDetached : deps.spawnDetached;

  if (!sessionCanProbe(env, statuslineInstalled)) return skip('session');
  if (setupTokenInForce(oauthTokenEnv(env))) return skip('setup-token');
  // Imported here: the account store stays off the prompt path until every cheaper check passed.
  const accounts = await import('./accounts.mjs');
  const listAccounts = deps.listAccounts == null ? accounts.listAccounts : deps.listAccounts;
  const rows = await listAccounts().catch(() => []);
  if (!rows.some((a) => a.status === accounts.AccountStatus.LINKED)) return skip('not-linked');
  if (throttled(readUsageCheckState(), now().getTime())) return skip('throttled');
  // Claimed before the freshness read, so a fresh skip also uses up the slot.
  if (!claimUsageCheck({ now })) return skip('throttled');
  if (hasFreshReading(now().getTime(), readUsageUtilization)) return skip('fresh');
  return spawnDetached(PROBE_SCRIPT) ? { started: true, reason: 'started' } : skip('spawn-failed');
}

export function takeDesktopUsageCheckNotice(deps = {}) {
  const env = deps.env == null ? process.env : deps.env;
  const now = deps.now == null ? () => new Date() : deps.now;
  if (env.CLAUDE_CODE_ENTRYPOINT !== DESKTOP_ENTRYPOINT || usageCheckEnabled()) return null;
  if (fs.existsSync(usageCheckNoticeFile()) || setupTokenInForce(oauthTokenEnv(env))) return null;
  writeJsonSecure(usageCheckNoticeFile(), { version: 1, shownAt: now().toISOString() });
  return USAGE_CHECK_NOTICE;
}
