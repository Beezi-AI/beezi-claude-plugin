import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { usageSnapshotStateFile } from './paths.mjs';
import { readUsageUtilization as _readUsageUtilization } from './usage-utilization.mjs';
import { readClaudeAccount as _readClaudeAccount } from './claude-account.mjs';
import { normalizePlan } from './billing.mjs';

// The API deep-whitelists nested limit entries (forbidNonWhitelisted): an unknown upstream key
// inside limits[] would 400 the whole snapshot. Send exactly the known keys; JSON serialization
// drops the undefined ones.
function sanitizeLimit(l) {
  return {
    kind: l?.kind,
    group: l?.group,
    percent: l?.percent,
    severity: l?.severity,
    resets_at: l?.resets_at,
    is_active: l?.is_active,
    scope: l?.scope,
  };
}

// Wire payload from the promoted cache. Plan fields ride only when the cache demonstrably belongs
// to the logged-in account — never account A's limits stamped with account B's plan. account_uuid
// is always the CACHE's own account: after a switch it names the previous account until Claude
// Code refetches, which is the truth about whose numbers these are.
export function buildSnapshotPayload(utilization, account) {
  const sameAccount =
    utilization.accountUuid != null && utilization.accountUuid === (account?.accountUuid ?? null);
  return {
    fetched_at: new Date(utilization.fetchedAtMs).toISOString(),
    account_uuid: utilization.accountUuid,
    subscription_type: sameAccount ? (account.subscriptionType ?? null) : null,
    rate_limit_tier: sameAccount ? (account.rateLimitTier ?? null) : null,
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

// Post the current snapshot unless this exact (accountUuid, fetchedAtMs) pair already went out.
// The marker advances only on a confirmed 2xx, so any failure (404 on an old API included)
// retries at the next turn-end. Concurrent sessions can race and double-post; the server drops
// duplicates on its unique key.
export async function maybePostUsageSnapshot(token, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const readUtilization = deps.readUsageUtilization ?? _readUsageUtilization;
  const readAccount = deps.readClaudeAccount ?? _readClaudeAccount;
  if (!token) return { reported: false, reason: 'no-token' };

  let utilization = null;
  try { utilization = readUtilization(); } catch { utilization = null; }
  if (!utilization) return { reported: false, reason: 'no-utilization' };

  const stateFile = usageSnapshotStateFile();
  const sent = readJson(stateFile)?.lastSent ?? {};
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
