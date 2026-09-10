import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';
import { resolveFetch } from './fetch-compat.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { usageSnapshotStateFile } from './paths.mjs';
import { readUsageUtilization as _readUsageUtilization } from './usage-utilization.mjs';
import { readClaudeAccount as _readClaudeAccount } from './claude-account.mjs';
import { readBillingConfig as _readBillingConfig } from './billing-config.mjs';
import { normalizePlan } from './billing.mjs';
import { buildIdentityStamp } from './identity-stamp.mjs';
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

// The plan this machine bills, billing.json first.
//
// `~/.beezi/billing.json` is the reconciled record and the only source that can carry a plan the
// Beezi server resolved for a setup key (planSource 'key_resolution'), a merged CLI capture, or the
// user's own answer. `plan` is already normalized on disk, so it is taken as written rather than
// re-derived from the tuple.
//
// ~/.claude.json's oauthAccount answers ONLY when no billing record exists at all — the same rule
// the identity stamp follows, and for the same reason: a null in billing.json is a statement, and
// falling through it would reach for the file that is wrong on exactly the machines it is wrong on.
function resolvePlanFields(billing, account) {
  if (billing != null) {
    return {
      subscription_type: billing.subscriptionType == null ? null : billing.subscriptionType,
      rate_limit_tier: billing.rateLimitTier == null ? null : billing.rateLimitTier,
      subscription_plan: billing.plan == null ? null : billing.plan,
    };
  }
  if (account == null) {
    return { subscription_type: null, rate_limit_tier: null, subscription_plan: null };
  }
  return {
    subscription_type: account.subscriptionType == null ? null : account.subscriptionType,
    rate_limit_tier: account.rateLimitTier == null ? null : account.rateLimitTier,
    subscription_plan: normalizePlan(account.subscriptionType, account.rateLimitTier),
  };
}

// A POSITIVE mismatch only: both sides known and naming different accounts. A null on either side
// is "not stated", never "different" — the rule sameIdentityValue follows in billing-capture.mjs.
// Widening it to "cannot compare means mismatch" would drop the plan on every machine whose login
// surface never writes a uuid, which is the population billing.json exists to serve.
function accountsDiffer(a, b) {
  if (a == null || b == null) return false;
  return a !== b;
}

// Wire payload from the promoted cache. Plan fields ride unless the cache demonstrably belongs to
// a different account than the plan does — never account A's limits stamped with account B's plan.
//
// `stamp` is the shared identity stamp (lib/identity-stamp.mjs) and carries the email and the
// setup-token fingerprint the server needs to reach an account row. It is spread FIRST so its own
// account_uuid cannot displace the decision made below.
//
// account_uuid is the CACHE's own account — a label on the measurement, naming whose numbers these
// are rather than who this machine is, and half the server's dedupe key. The one exception is a
// setup token in force: that uuid is then read out of the same ~/.claude.json that names whoever
// logged in interactively last, and the server matches a uuid BEFORE a fingerprint, so leaving it
// on the wire would win the resolution and attribute this machine's limits to someone else. Such a
// machine moves to the account_uuid = '' series — what an account switch has always looked like
// here — and is reached through its credential row instead.
export function buildSnapshotPayload(utilization, account, stamp = {}, billing = null) {
  const keyInForce = stamp != null && stamp.oauth_key_prefix != null;
  // Under a key the guard has nothing to compare: both the cache uuid and any stored uuid describe
  // a previous interactive login, while the plan and the limits both belong to the key.
  const planUuid = billing != null
    ? billing.accountUuid
    : (account == null ? null : account.accountUuid);
  const mismatched = !keyInForce && accountsDiffer(utilization.accountUuid, planUuid);
  return {
    ...stamp,
    fetched_at: new Date(utilization.fetchedAtMs).toISOString(),
    account_uuid: keyInForce ? null : utilization.accountUuid,
    ...(mismatched
      ? { subscription_type: null, rate_limit_tier: null, subscription_plan: null }
      : resolvePlanFields(billing, account)),
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
  // The RESOLVED env when the caller has one (runCheckpoint does), so a token living in Claude
  // Code's settings file or the OS environment is visible here too. Falling back to process.env
  // keeps a caller that has none working, just blind to those two places.
  const env = deps.env == null ? process.env : deps.env;
  const readPending = deps.readPendingStatuslineUsage == null ? _readPendingStatuslineUsage : deps.readPendingStatuslineUsage;
  const clearPending = deps.clearPendingStatuslineUsage == null ? _clearPendingStatuslineUsage : deps.clearPendingStatuslineUsage;
  const readAccount = deps.readClaudeAccount == null ? _readClaudeAccount : deps.readClaudeAccount;
  if (!token) return { posted: 0, reason: 'no-token' };

  const pending = readPending();
  if (!pending.length) return { posted: 0, reason: 'empty' };

  const readBilling = deps.readBillingConfig == null ? _readBillingConfig : deps.readBillingConfig;
  let billing = null;
  try { billing = readBilling(); } catch { billing = null; }

  // Read for the no-billing-record case ONLY — a first session before the reconcile has ever
  // written one. Everywhere else billing.json answers, nulls included; see resolvePlanFields.
  let account = null;
  try { account = readAccount(); } catch { account = null; }

  // The identity the SERVER resolves an account from, identical to the one this machine's session
  // reports and its account check-in carry — same builder, same sources, same order.
  const stamp = buildIdentityStamp(account, billing, env);
  const identity = {
    ...stamp,
    // Explicit nulls, not omissions — this payload has always stated its plan fields either way,
    // and the spread above only ever ADDS keys the stamp knows about.
    //
    // account_uuid now comes FROM the stamp, so it is billing.json's uuid and is suppressed
    // entirely under a setup token. It is half the server's dedupe key
    // (tenant, user, account_uuid, fetched_at) and the analytics reads group by it, so the move is
    // deliberate: billing.json's uuid is a copy of the same vendor uuid on every machine that has
    // one, and on the machines where it is not — a setup token, where ~/.claude.json names whoever
    // logged in last — the honest answer is no uuid at all rather than someone else's. Those
    // machines move to the account_uuid = '' series and are reached through their credential row.
    account_uuid: stamp.account_uuid == null ? null : stamp.account_uuid,
    ...resolvePlanFields(billing, account),
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
  // See drainStatuslineSnapshots: the resolved env when the caller has one.
  const env = deps.env == null ? process.env : deps.env;
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
  const readBilling = deps.readBillingConfig == null ? _readBillingConfig : deps.readBillingConfig;
  let billing = null;
  try { billing = readBilling(); } catch { billing = null; }
  // What the stamp contributes here is the email and the fingerprint. Its uuid is overwritten by
  // the cache's inside buildSnapshotPayload — deliberately: the cache's account names whose numbers
  // these are, and it is half the server's dedupe key. billing.json rides along so the plan fields
  // and the mismatch guard read from the same record every other path uses.
  const stamp = buildIdentityStamp(account, billing, env);
  const payload = buildSnapshotPayload(utilization, account, stamp, billing);
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
