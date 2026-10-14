import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';
import { resolveFetch } from './fetch-compat.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { usageSnapshotStateFile } from './paths.mjs';
import { readUsageUtilization as _readUsageUtilization } from './usage-utilization.mjs';
import { readClaudeAccount as _readClaudeAccount } from './claude-account.mjs';
import { readBillingConfig as _readBillingConfig } from './billing-config.mjs';
import { normalizePlan } from './billing.mjs';
import { buildIdentityStamp, recordOwnsIdentity } from './identity-stamp.mjs';
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
  // The organization qualifies the stamp's uuid, the live login. When the cache names a different
  // account, the live org belongs to none of these numbers, and pairing it with the cache's uuid
  // would describe an account that does not exist. The cache itself carries no org, so a same-uuid
  // cache is taken to be the live subscription's — the best this file can say.
  // An org next to no uuid at all qualifies nothing, so it stays off the wire too.
  const wireUuid = keyInForce ? null : utilization.accountUuid;
  const orgFromOtherAccount = wireUuid == null
    || accountsDiffer(utilization.accountUuid, stamp == null ? null : stamp.account_uuid);
  const { account_org_uuid, account_org_name, ...identity } = stamp == null ? {} : stamp;
  return {
    ...identity,
    ...(orgFromOtherAccount
      ? {}
      : {
          ...(account_org_uuid == null ? {} : { account_org_uuid }),
          ...(account_org_name == null ? {} : { account_org_name }),
        }),
    fetched_at: new Date(utilization.fetchedAtMs).toISOString(),
    account_uuid: wireUuid,
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

// The identity one drained row ships under. A row recorded its own account (statusline-usage.mjs)
// because it may be drained after a switch — of account, or of subscription within one login — and
// the identity in force at drain time would put its limits on the wrong one. Rows recorded before
// that field existed carry none and take the current identity, the best there is for them.
//
// A recorded identity replaces the current one wholesale, never field by field: the current email
// and org describe whoever is logged in NOW. And when the row names a different account or org than
// the plan does, the plan fields go null — the same guard buildSnapshotPayload applies, for the same
// reason: never one subscription's limits stamped with another's plan.
function rowIdentity(identity, recorded, keyInForce, planUuid, planOrg) {
  if (keyInForce || recorded == null) return identity;
  const recordedUuid = recorded.uuid == null ? null : recorded.uuid;
  const recordedOrg = recorded.organizationUuid == null ? null : recorded.organizationUuid;
  const out = { ...identity, account_uuid: recordedUuid };
  delete out.account_email;
  delete out.account_org_uuid;
  delete out.account_org_name;
  // The same account as now: the current email is billing.json's (the CLI's, fresher than the
  // oauthAccount copy the row holds), so it still answers first.
  const sameAccount = recordedUuid != null && recordedUuid === identity.account_uuid;
  const email = sameAccount && identity.account_email != null ? identity.account_email : recorded.email;
  if (email != null) out.account_email = email;
  if (recordedOrg != null) out.account_org_uuid = recordedOrg;
  if (recordedOrg != null && recorded.organizationName != null) out.account_org_name = recorded.organizationName;
  if (accountsDiffer(recordedUuid, planUuid) || accountsDiffer(recordedOrg, planOrg)) {
    out.subscription_type = null;
    out.rate_limit_tier = null;
    out.subscription_plan = null;
  }
  return out;
}

// Ships the rate-limit observations the status line recorded locally to EVERY linked account.
// Each row already carries its own fetched_at, so the server's (account, fetched_at) unique key
// dedupes replays for free. A row clears only once every account settled it, and rows are cleared
// only up to the last settled one, so a mid-drain failure retries the rest.
export async function drainStatuslineSnapshots(sessions, deps = {}) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  // The RESOLVED env when the caller has one (runCheckpoint does), so a token living in Claude
  // Code's settings file or the OS environment is visible here too. Falling back to process.env
  // keeps a caller that has none working, just blind to those two places.
  const env = deps.env == null ? process.env : deps.env;
  const readPending = deps.readPendingStatuslineUsage == null ? _readPendingStatuslineUsage : deps.readPendingStatuslineUsage;
  const clearPending = deps.clearPendingStatuslineUsage == null ? _clearPendingStatuslineUsage : deps.clearPendingStatuslineUsage;
  const readAccount = deps.readClaudeAccount == null ? _readClaudeAccount : deps.readClaudeAccount;
  // Only accounts holding both a token and a key can settle a row, so nothing else joins the fan-out.
  const recipients = (sessions || []).filter((s) => s && s.key);
  const live = recipients.filter((s) => s.token);
  const waitingForToken = live.length < recipients.length;
  if (live.length === 0) return { posted: 0, reason: 'no-token' };

  const pending = readPending();
  if (!pending.length) return { posted: 0, reason: 'empty' };

  const readBilling = deps.readBillingConfig == null ? _readBillingConfig : deps.readBillingConfig;
  let billing = null;
  try { billing = readBilling(); } catch { billing = null; }

  // The live login: the identity stamp's first source (see identity-stamp.mjs), and the plan's only
  // when no billing record exists yet — for the plan, billing.json answers, nulls included; see
  // resolvePlanFields.
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
    // account_uuid comes FROM the stamp, so it is the live login's uuid (billing.json's when the
    // login names none) and is suppressed entirely under a setup token. It is half the server's
    // dedupe key (tenant, user, account_uuid, fetched_at) and the analytics reads group by it: on a
    // setup-token machine, where ~/.claude.json names whoever logged in last, the honest answer is
    // no uuid at all rather than someone else's. Those machines move to the account_uuid = ''
    // series and are reached through their credential row. A row that recorded its own account
    // overrides this per row — see rowIdentity.
    account_uuid: stamp.account_uuid == null ? null : stamp.account_uuid,
    ...resolvePlanFields(billing, account),
  };

  // A setup token suppresses every recorded identity too: like the current one, it was read from the
  // ~/.claude.json that names whoever logged in interactively last. Both shapes count — a token the
  // env can see, and a record that belongs to a key the env cannot (the stamp's own guard).
  const keyInForce = stamp.oauth_key_prefix != null || recordOwnsIdentity(billing);
  const planUuid = billing != null
    ? billing.accountUuid
    : (account == null ? null : account.accountUuid);
  const planOrg = billing != null
    ? billing.organizationUuid
    : (account == null ? null : account.organizationUuid);

  let posted = 0;
  for (const pendingRow of pending) {
    const { account: recorded, ...row } = pendingRow;
    const body = { ...rowIdentity(identity, recorded, keyInForce, planUuid, planOrg), ...row, limits: null, raw: null };
    // Settled = stored (2xx) or refused for good (any 4xx, a dark or unauthorized tenant included);
    // only a 5xx or a transport failure is retryable, so one refusing account cannot pin the queue.
    const settled = await Promise.all(live.map(async (session) => {
      try {
        const res = await postJson(`${apiBase()}${ENDPOINTS.usageSnapshot}`, session, body, { fetchImpl });
        return (res.status >= 200 && res.status < 300) || (res.status >= 400 && res.status < 500);
      } catch {
        return false;
      }
    }));
    if (waitingForToken || settled.some((ok) => !ok)) break;
    posted += 1;
  }
  if (posted > 0) clearPending(posted);
  return { posted };
}

// Post the current snapshot unless this exact (accountUuid, fetchedAtMs) pair already went out.
// The marker advances only on a confirmed 2xx, so any failure (404 on an old API included)
// retries at the next turn-end. Concurrent sessions can race and double-post; the server drops
// duplicates on its unique key.
export async function maybePostUsageSnapshot(session, deps = {}) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  // See drainStatuslineSnapshots: the resolved env when the caller has one.
  const env = deps.env == null ? process.env : deps.env;
  const readUtilization = deps.readUsageUtilization == null ? _readUsageUtilization : deps.readUsageUtilization;
  const readAccount = deps.readClaudeAccount == null ? _readClaudeAccount : deps.readClaudeAccount;
  if (!session || !session.token || session.key == null) return { reported: false, reason: 'no-token' };

  let utilization = null;
  try { utilization = readUtilization(); } catch { utilization = null; }
  if (!utilization) return { reported: false, reason: 'no-utilization' };

  const stateFile = usageSnapshotStateFile(session.key);
  const storedState = readJson(stateFile);
  const state = storedState == null ? {} : storedState;
  // A workspace-scoped report keeps its own marker under lastSentByTenant.
  const tenantId = session.tenantId == null ? null : session.tenantId;
  const byTenant = state.lastSentByTenant == null ? {} : state.lastSentByTenant;
  const marker = tenantId == null ? state.lastSent : byTenant[tenantId];
  const sent = marker == null ? {} : marker;
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
    const res = await postJson(`${apiBase()}${ENDPOINTS.usageSnapshot}`, session, payload, { fetchImpl });
    if (res.status >= 200 && res.status < 300) {
      const lastSent = { accountUuid: utilization.accountUuid, fetchedAtMs: utilization.fetchedAtMs };
      const latest = readJson(stateFile);
      const current = latest == null ? {} : latest;
      const next = { version: 1 };
      if (tenantId == null) next.lastSent = lastSent;
      else if (current.lastSent != null) next.lastSent = current.lastSent;
      const tenants = { ...(current.lastSentByTenant == null ? {} : current.lastSentByTenant) };
      if (tenantId != null) tenants[tenantId] = lastSent;
      if (Object.keys(tenants).length > 0) next.lastSentByTenant = tenants;
      writeJsonSecure(stateFile, next);
      return { reported: true, status: res.status };
    }
    return { reported: false, status: res.status };
  } catch {
    return { reported: false, reason: 'network' };
  }
}
