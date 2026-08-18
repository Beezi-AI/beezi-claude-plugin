import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';
import { resolveFetch } from './fetch-compat.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { usageSnapshotStateFile } from './paths.mjs';
import { readUsageUtilization as _readUsageUtilization } from './usage-utilization.mjs';
import { readClaudeAccount as _readClaudeAccount } from './claude-account.mjs';
import { normalizePlan } from './billing.mjs';
import {
  readPendingStatuslineUsage as _readPendingStatuslineUsage,
  clearPendingStatuslineUsage as _clearPendingStatuslineUsage,
} from './statusline-usage.mjs';

// The API deep-whitelists nested limit entries (forbidNonWhitelisted): an unknown upstream key
// inside limits[] would 400 the whole snapshot. Send exactly the known keys; JSON serialization
// drops the undefined ones.
function sanitizeLimit(l) {
  const limit = l == null ? {} : l;
  return {
    kind: limit.kind,
    group: limit.group,
    percent: limit.percent,
    severity: limit.severity,
    resets_at: limit.resets_at,
    is_active: limit.is_active,
    scope: limit.scope,
  };
}

// Wire payload from the promoted cache. Plan fields ride only when the cache demonstrably belongs
// to the logged-in account — never account A's limits stamped with account B's plan. account_uuid
// is always the CACHE's own account: after a switch it names the previous account until Claude
// Code refetches, which is the truth about whose numbers these are.
export function buildSnapshotPayload(utilization, account) {
  const sameAccount =
    utilization.accountUuid != null &&
    utilization.accountUuid === (account == null || account.accountUuid == null ? null : account.accountUuid);
  return {
    fetched_at: new Date(utilization.fetchedAtMs).toISOString(),
    account_uuid: utilization.accountUuid,
    subscription_type: sameAccount ? (account.subscriptionType == null ? null : account.subscriptionType) : null,
    rate_limit_tier: sameAccount ? (account.rateLimitTier == null ? null : account.rateLimitTier) : null,
    subscription_plan: sameAccount
      ? normalizePlan(account.subscriptionType, account.rateLimitTier)
      : null,
    five_hour_pct: utilization.fiveHourPct,
    five_hour_resets_at: utilization.fiveHourResetsAt,
    seven_day_pct: utilization.sevenDayPct,
    seven_day_resets_at: utilization.sevenDayResetsAt,
    limits: utilization.limits ? utilization.limits.map(sanitizeLimit) : null,
    raw: utilization.raw,
  };
}

// Ships the rate-limit observations the status line recorded locally. Each row already carries
// its own fetched_at, so the server's (account, fetched_at) unique key dedupes replays for free.
// Rows are cleared only up to the last confirmed store, so a mid-drain failure retries the rest.
export async function drainStatuslineSnapshots(token, deps = {}) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const readPending = deps.readPendingStatuslineUsage == null ? _readPendingStatuslineUsage : deps.readPendingStatuslineUsage;
  const clearPending = deps.clearPendingStatuslineUsage == null ? _clearPendingStatuslineUsage : deps.clearPendingStatuslineUsage;
  const readAccount = deps.readClaudeAccount == null ? _readClaudeAccount : deps.readClaudeAccount;
  if (!token) return { posted: 0, reason: 'no-token' };

  const pending = readPending();
  if (!pending.length) return { posted: 0, reason: 'empty' };

  let account = null;
  try { account = readAccount(); } catch { account = null; }
  const identity = {
    account_uuid: account == null || account.accountUuid == null ? null : account.accountUuid,
    subscription_type: account == null || account.subscriptionType == null ? null : account.subscriptionType,
    rate_limit_tier: account == null || account.rateLimitTier == null ? null : account.rateLimitTier,
    subscription_plan: account
      ? normalizePlan(account.subscriptionType, account.rateLimitTier)
      : null,
  };

  let posted = 0;
  for (const row of pending) {
    try {
      const res = await postJson(
        `${apiBase()}${ENDPOINTS.usageSnapshot}`,
        token,
        { ...identity, ...row, limits: null, raw: null },
        { fetchImpl },
      );
      if (res.status < 200 || res.status >= 300) break;
      posted += 1;
    } catch {
      break;
    }
  }
  if (posted > 0) clearPending(posted);
  return { posted };
}

// Post the current snapshot unless this exact (accountUuid, fetchedAtMs) pair already went out.
// The marker advances only on a confirmed 2xx, so any failure (404 on an old API included)
// retries at the next turn-end. Concurrent sessions can race and double-post; the server drops
// duplicates on its unique key.
export async function maybePostUsageSnapshot(token, deps = {}) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const readUtilization = deps.readUsageUtilization == null ? _readUsageUtilization : deps.readUsageUtilization;
  const readAccount = deps.readClaudeAccount == null ? _readClaudeAccount : deps.readClaudeAccount;
  if (!token) return { reported: false, reason: 'no-token' };

  let utilization = null;
  try { utilization = readUtilization(); } catch { utilization = null; }
  if (!utilization) return { reported: false, reason: 'no-utilization' };

  const stateFile = usageSnapshotStateFile();
  // The whole state is carried forward, not just lastSent: usage-ping.mjs keeps its config-mtime
  // gate in this same file, and replacing the object would blow that marker away on every post.
  const storedState = readJson(stateFile);
  const state = storedState == null ? {} : storedState;
  const sent = state.lastSent == null ? {} : state.lastSent;
  if (sent.accountUuid === utilization.accountUuid && sent.fetchedAtMs === utilization.fetchedAtMs) {
    return { reported: false, reason: 'already-sent' };
  }

  let account = null;
  try { account = readAccount(); } catch { account = null; }
  const payload = buildSnapshotPayload(utilization, account);
  try {
    const res = await postJson(`${apiBase()}${ENDPOINTS.usageSnapshot}`, token, payload, { fetchImpl });
    if (res.status >= 200 && res.status < 300) {
      writeJsonSecure(stateFile, {
        ...state,
        version: 1,
        lastSent: { accountUuid: utilization.accountUuid, fetchedAtMs: utilization.fetchedAtMs },
      });
      return { reported: true, status: res.status };
    }
    return { reported: false, status: res.status };
  } catch {
    return { reported: false, reason: 'network' };
  }
}
