import { billingConfigFile } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import {
  BillingSource,
  detectBillingSource as detectBillingSourceFromEnv,
  resolveBillingSource,
  detectThirdPartyProvider,
} from './billing.mjs';
import { readClaudeAccount, readClaudeAuthSignals } from './claude-account.mjs';

const STALE_MS = 7 * 24 * 60 * 60 * 1000; // refresh plan info at least weekly

export function readBillingConfig() {
  return readJson(billingConfigFile());
}

export function writeBillingConfig(obj) {
  writeJsonSecure(billingConfigFile(), obj);
}

// Stale only matters for subscription billing: env-based sources carry no plan.
export function isStale(config, now = Date.now(), staleMs = STALE_MS) {
  if (!config || config.source !== BillingSource.SUBSCRIPTION) return false;
  if (!config.plan || config.plan === 'unknown') return true;
  // A self-reported plan can never be re-resolved automatically, so age must not
  // invalidate it; the user re-runs /beezi:login when their tier changes.
  if (config.selfReported) return false;
  if (typeof config.credentialsExpiresAt === 'number' && config.credentialsExpiresAt <= now) return true;
  const capturedAt = Date.parse(config.capturedAt == null ? '' : config.capturedAt);
  if (Number.isNaN(capturedAt)) return true;
  return now - capturedAt > staleMs;
}

// The report payload keys for the subscription plan, or {} when not applicable.
export function subscriptionReportFields(billingSource, config) {
  if (billingSource !== BillingSource.SUBSCRIPTION || !config) return {};
  return {
    subscription_type: config.subscriptionType == null ? null : config.subscriptionType,
    rate_limit_tier: config.rateLimitTier == null ? null : config.rateLimitTier,
    subscription_plan: config.plan == null ? null : config.plan,
  };
}

// The report payload key naming the third-party provider, or {} when billing is not third-party
// (or the provider can't be identified from the env). Env-based — no persisted config needed.
export function thirdPartyReportFields(billingSource, env = process.env) {
  if (billingSource !== BillingSource.THIRD_PARTY) return {};
  const provider = detectThirdPartyProvider(env);
  return provider ? { third_party_provider: provider } : {};
}

// The one place the precedence is stated: environment first, then the on-disk Claude account as
// positive subscription evidence, then `unknown`. billing.json's own `source` is never consulted
// for resolution — it is a record of the last resolution, not an input to the next one, so a
// switch the user made outside our sight cannot keep asserting itself. The file contributes plan
// detail only, and only once the source resolves to subscription.
//
// Recorded API-key proof outranks the on-disk account: an oauthAccount can linger from a previous
// subscription login, but a credit-balance error cannot happen unless a key is actually paying.
// Short window on purpose — it must lapse quickly once the user switches back, and a session still
// on a key re-earns it the next time the error fires.
const API_KEY_EVIDENCE_MS = 24 * 60 * 60 * 1000;

export function hasFreshApiKeyEvidence(config, now = Date.now()) {
  const at = Date.parse(config == null || config.apiKeyEvidenceAt == null ? '' : config.apiKeyEvidenceAt);
  if (Number.isNaN(at)) return false;
  return now - at <= API_KEY_EVIDENCE_MS && at <= now;
}

// Stamp proof that this machine bills an API key. Returns the updated config, or null when the
// existing stamp is still fresh (nothing to write). Creates a minimal config when none exists —
// the evidence has to survive even on a machine that never ran /beezi:login.
export function recordApiKeyEvidence(config, now = new Date()) {
  if (hasFreshApiKeyEvidence(config, now.getTime())) return null;
  return { version: 1, ...(config == null ? {} : config), apiKeyEvidenceAt: now.toISOString() };
}

// The single source-of-truth resolution, shared by the session-start hook and every checkpoint so
// the two can never disagree about what this machine is billing.
export function resolveSource(config, env = process.env, deps = {}) {
  const readAccount = deps.readClaudeAccount == null ? readClaudeAccount : deps.readClaudeAccount;
  const readSignals = deps.readClaudeAuthSignals == null ? readClaudeAuthSignals : deps.readClaudeAuthSignals;
  const now = deps.now == null ? Date.now() : deps.now;
  const fromEnv = detectBillingSourceFromEnv(env);
  if (fromEnv !== BillingSource.UNKNOWN) return fromEnv;
  if (hasFreshApiKeyEvidence(config, now)) return BillingSource.ANTHROPIC_API_KEY;
  let account = null;
  let signals = null;
  // Best-effort: an unreadable ~/.claude.json must degrade to `unknown`, not throw on the
  // checkpoint hot path.
  try { account = readAccount(); } catch { account = null; }
  try { signals = readSignals(); } catch { signals = null; }
  const fromDisk = resolveBillingSource(env, account, signals);
  if (fromDisk !== BillingSource.UNKNOWN) return fromDisk;
  // Weakest evidence, deliberately last: what the user told /beezi:login. It is the only thing
  // that works on a machine exposing no observable signal at all, which is why the nudge points
  // there — but it is unverifiable testimony, so anything above overrules it, and an API-key
  // balance error (checked above) revokes it outright.
  const declared = config != null && config.selfReported === true ? config.source : null;
  if (
    declared === BillingSource.SUBSCRIPTION
    || declared === BillingSource.ANTHROPIC_API_KEY
    || declared === BillingSource.THIRD_PARTY
  ) {
    return declared;
  }
  return BillingSource.UNKNOWN;
}

export function resolveBilling(config, env = process.env, deps = {}) {
  const source = resolveSource(config, env, deps);
  return {
    billing_source: source,
    ...subscriptionReportFields(source, config),
    ...thirdPartyReportFields(source, env),
  };
}

// A stored source drifts whenever the user switches auth method between sessions (exporting
// ANTHROPIC_API_KEY over a subscription login, pointing at a gateway, and back). Env is
// authoritative, so realign the file to it. Returns the updated config, or null when there is
// nothing to change — the caller writes only on a non-null result.
//
// The plan fields (subscriptionType/rateLimitTier/plan/selfReported) are deliberately preserved
// rather than nulled: they are already env-gated out of every report by subscriptionReportFields,
// so carrying them dormant costs nothing and a switch back to subscription resumes intact. That
// matters most for a selfReported plan, which no automatic capture can ever reconstruct.
//
// capturedAt is NOT bumped. It timestamps the plan capture and isStale() reads it; refreshing it
// here would make a plan that was never re-read look freshly captured and suppress the refresh
// nudge. The source flip gets its own field instead.
export function syncBillingSource(config, source, now = new Date()) {
  if (!config || config.source === source) return null;
  return { ...config, source, sourceUpdatedAt: now.toISOString() };
}
