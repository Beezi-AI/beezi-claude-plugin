import {
  BILLING_CONFIG_VERSION,
  readBillingConfig as _readBillingConfig,
  writeBillingConfig as _writeBillingConfig,
} from './billing-config.mjs';

// The one bridge between the two plan stores.
//
// Until this module existed there were two answers to "what does this machine bill" that never
// spoke to each other: billing.json, which feeds subscription_plan / subscription_type /
// rate_limit_tier on every /sessions/report, the account check-in and the usage snapshot; and the
// server's key resolution (lib/key-resolution.mjs, lib/oauth-key-status.mjs), which knows what a
// CLAUDE_CODE_OAUTH_TOKEN's fingerprint has been attached to in the portal. A user could resolve
// their key through /beezi:refresh and every session report afterwards would still ship the stale
// plan a previous interactive login left on disk, or none at all. This writes the server's answer
// into the file the reports actually read.
//
// Deliberately the ONLY thing here. billing-capture.mjs owns the local capture and its
// reconcile; adding a second writer there would have put two unrelated decisions in one place.
// This module reads and writes through billing-config.mjs's exports and touches nothing else.

// provenance stamped on a plan this module wrote. The vocabulary is shared with the local capture
// path: 'unresolved' (a setup token whose plan is not knowable locally), 'claude_login'
// (claude auth status / oauthAccount), 'self_reported' (what the user told /beezi:login), and this
// one — the Beezi server's answer for this key's fingerprint.
export const KEY_RESOLUTION_PLAN_SOURCE = 'key_resolution';

// Same discipline as billing-capture.mjs's safeField: the plan is a short opaque label, so anything
// token-shaped (an sk-ant secret, embedded whitespace) or over-long is refused rather than written.
// A server that answered with something surprising must never get a credential-looking string into
// billing.json, which is read back and reported on every session.
//
// Unlike safeField this RETURNS null instead of throwing: every caller here is best-effort, and a
// throw on the /beezi:refresh success path would turn a resolved key into a visible error.
const TOKEN_LIKE = /sk-ant|\s/;
const MAX_PLAN_LENGTH = 64;

export function safePlan(plan) {
  if (plan == null) return null;
  const s = String(plan).trim();
  if (!s) return null;
  if (s.length > MAX_PLAN_LENGTH || TOKEN_LIKE.test(s)) return null;
  return s;
}

// Same discipline for the account email, with the one difference that matters: real addresses run
// to 254 characters, so safePlan's 64-char cap would silently throw away a legitimate one. The
// token-shaped refusal is identical — nothing credential-looking reaches billing.json.
const MAX_EMAIL_LENGTH = 320;

export function safeEmail(email) {
  if (email == null) return null;
  const s = String(email).trim();
  if (!s) return null;
  if (s.length > MAX_EMAIL_LENGTH || TOKEN_LIKE.test(s)) return null;
  return s;
}

// The fingerprint the server's answer is scoped to, or null. Shape-checked rather than trusted:
// this lands in billing.json and is later compared against the live key to decide whether a stored
// plan still applies, so a malformed triple must read as "not stated" rather than as a mismatch.
function safeFingerprint(fingerprint) {
  if (fingerprint == null || typeof fingerprint !== 'object') return null;
  const prefix = typeof fingerprint.prefix === 'string' ? fingerprint.prefix : null;
  const last4 = typeof fingerprint.last4 === 'string' ? fingerprint.last4 : null;
  const length = typeof fingerprint.length === 'number' && Number.isFinite(fingerprint.length)
    ? fingerprint.length
    : null;
  if (prefix == null || last4 == null || length == null) return null;
  return { prefix, last4, length };
}

// The plan named by a fetchKeyResolution payload, or null. Only 'resolved' counts: 'unlinked' and
// 'unknown_key' are the server saying it has no answer, and a null status is the normalization of a
// status this client does not recognize — none of the three is an authoritative plan.
export function resolvedPlanFrom(payload) {
  if (payload == null || payload.status !== 'resolved') return null;
  return safePlan(payload.subscriptionPlan);
}

// The whole payload when it is an authoritative answer, for recordResolvedKeyData. Same gate as
// resolvedPlanFrom — only 'resolved' counts — but it keeps the trimmings the plan-only reader
// throws away: the subscription type, the tier, the account email and the key it all belongs to.
export function resolvedKeyDataFrom(payload) {
  if (payload == null || payload.status !== 'resolved') return null;
  return payload;
}

// The plan named by a submitKeyPlan / submitKeyLink result, or null. A refusal names nothing, and a
// link that succeeded without the server naming a plan names nothing either — attaching a key to a
// subscription does not tell this side which plan that subscription is on, and guessing one would
// put a fabricated tier into every report.
export function submittedPlanFrom(result) {
  if (result == null || result.ok !== true) return null;
  return safePlan(result.subscriptionPlan);
}

// Record a plan the Beezi server resolved for this machine's setup token. Returns true when
// billing.json was written, false when there was nothing trustworthy to write or the write failed.
//
// Never throws, by contract: the callers are a SessionStart hook and the success path of
// /beezi:refresh, and neither may turn a failed write into a broken session or a red line under a
// resolution that actually landed.
//
// capturedAt is stamped alongside planResolvedAt on purpose. isStale() reads capturedAt, and
// leaving a previous login's date there would make the very next session start print "subscription
// plan info is missing or stale — run /beezi:refresh" one line after /beezi:refresh resolved it.
// A capture genuinely did just happen; planResolvedAt is the provenance-specific stamp on top.
//
// subscriptionType and rateLimitTier are deliberately NOT synthesized from the plan. The server
// named a plan, not a tier, and buildConfig already sets the precedent: an unobserved tier stays
// null rather than becoming a value nothing measured.
export function recordResolvedKeyPlan(plan, deps = {}) {
  return recordResolvedKeyData({ subscriptionPlan: plan }, deps);
}

// The full adoption: everything the portal knows about THIS key, written into the file the session
// reports read. Supersedes the plan-only write above, which is now a thin wrapper so the older call
// sites keep working unchanged.
//
// Why more than the plan: on a setup-token machine the local capture cannot name the subscription
// type, the rate-limit tier or the account at all — every one of those reads a previous interactive
// login's leftovers. The server's answer for the key's fingerprint is the only trustworthy source
// for them, so a plan adopted without them leaves the record half-filled with someone else's data.
//
// Each field is written only when the server actually named it. A field the server omitted (an
// older API, or an account that genuinely has none) leaves whatever is on disk alone rather than
// nulling it — this is an adoption, not a reset. The reset is billing-capture's job and has already
// run by the time this is called.
//
// `status` is a fetchOauthKeyStatus result or a fetchKeyResolution payload; both shapes carry the
// same field names. Returns true when billing.json was written.
export function recordResolvedKeyData(status, deps = {}) {
  const readConfig = deps.readBillingConfig == null ? _readBillingConfig : deps.readBillingConfig;
  const writeConfig = deps.writeBillingConfig == null ? _writeBillingConfig : deps.writeBillingConfig;
  const now = deps.now == null ? new Date() : deps.now;
  if (status == null || typeof status !== 'object') return false;
  const safe = safePlan(status.subscriptionPlan);
  // The plan is the one required field: without it there is no answer to adopt, and writing the
  // trimmings alone would restamp capturedAt on a record nothing improved.
  if (safe == null) return false;
  try {
    let existing = null;
    try { existing = readConfig(); } catch { existing = null; }
    const base = existing == null || typeof existing !== 'object' ? {} : existing;
    const stamped = now.toISOString();
    const next = {
      version: BILLING_CONFIG_VERSION,
      ...base,
      plan: safe,
      planSource: KEY_RESOLUTION_PLAN_SOURCE,
      planResolvedAt: stamped,
      capturedAt: stamped,
    };
    const subscriptionType = safePlan(status.subscriptionType);
    if (subscriptionType != null) next.subscriptionType = subscriptionType;
    const rateLimitTier = safePlan(status.rateLimitTier);
    if (rateLimitTier != null) next.rateLimitTier = rateLimitTier;
    const accountEmail = safeEmail(status.accountEmail);
    if (accountEmail != null) next.accountEmail = accountEmail;
    // Scopes the plan to the key it was resolved for. Without it a rotation would keep serving the
    // previous key's answer under the new fingerprint — an answer about a different credential.
    const fingerprint = safeFingerprint(status.fingerprint == null ? status.key : status.fingerprint);
    if (fingerprint != null) next.keyFingerprint = fingerprint;
    writeConfig(next);
    return true;
  } catch {
    // Best-effort: an unwritable ~/.beezi must not break the caller. The next session start asks
    // the portal again and gets another chance to record it.
    return false;
  }
}
