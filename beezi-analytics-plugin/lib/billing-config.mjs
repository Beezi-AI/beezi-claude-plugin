import { billingConfigFile } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { BillingSource, detectThirdPartyProvider } from './billing.mjs';

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
  const capturedAt = Date.parse(config.capturedAt ?? '');
  if (Number.isNaN(capturedAt)) return true;
  return now - capturedAt > staleMs;
}

// The report payload keys for the subscription plan, or {} when not applicable.
export function subscriptionReportFields(billingSource, config) {
  if (billingSource !== BillingSource.SUBSCRIPTION || !config) return {};
  return {
    subscription_type: config.subscriptionType ?? null,
    rate_limit_tier: config.rateLimitTier ?? null,
    subscription_plan: config.plan ?? null,
  };
}

// The report payload key naming the third-party provider, or {} when billing is not third-party
// (or the provider can't be identified from the env). Env-based — no persisted config needed.
export function thirdPartyReportFields(billingSource, env = process.env) {
  if (billingSource !== BillingSource.THIRD_PARTY) return {};
  const provider = detectThirdPartyProvider(env);
  return provider ? { third_party_provider: provider } : {};
}
