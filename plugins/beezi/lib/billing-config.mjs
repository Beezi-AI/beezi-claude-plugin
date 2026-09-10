import { billingConfigFile, statuslineUsageFile } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import {
  BillingSource,
  detectBillingSource as detectBillingSourceFromEnv,
  resolveBillingSource,
  detectThirdPartyProvider,
  hasCustomGateway,
} from './billing.mjs';
import { readClaudeAccount, readClaudeAuthSignals } from './claude-account.mjs';
import { oauthTokenEnv } from './claude-settings-env.mjs';

// v2 adds detectedVia (provenance of the plan tuple) and accountAnchor (identity for
// account-switch detection). v3 adds accountEmail (the vendor email stored alongside accountUuid
// so a check-in can present both). Readers stay tolerant across all of it: readBillingConfig has
// no version gate and the reconcile's kept path restamps the version — the same mechanism that
// grandfathered v1 → v2. v4 adds keyFingerprint: WHICH setup token this record describes, so a plan
// the server resolved for one key is never served under another, and a local capture that could not
// see a key cannot overwrite a record that belongs to one.
export const BILLING_CONFIG_VERSION = 4;

const STALE_MS = 7 * 24 * 60 * 60 * 1000; // refresh plan info at least weekly

export function readBillingConfig() {
  return readJson(billingConfigFile());
}

export function writeBillingConfig(obj) {
  writeJsonSecure(billingConfigFile(), obj);
}

// A plan the capture positively determined it cannot resolve locally: the credential in force is a
// CLAUDE_CODE_OAUTH_TOKEN, so `claude auth status` names no account and no product, and everything
// ~/.claude.json says belongs to whichever login last touched the disk. See claude-auth-status.mjs.
//
// Exported because "unresolvable" is a different state from "missing" and callers must be able to
// branch on it: re-reading it changes nothing, so the /beezi:refresh nudge has nothing to offer —
// only the server, from the key row, knows what that credential is entitled to.
export function isPlanUnresolvable(config) {
  return config != null && config.planSource === 'unresolved';
}

// Stale only matters for subscription billing: env-based sources carry no plan.
export function isStale(config, now = Date.now(), staleMs = STALE_MS) {
  if (!config || config.source !== BillingSource.SUBSCRIPTION) return false;
  // BEFORE the missing-plan check, which a cleared record would otherwise trip on `plan: null`.
  // Not stale — unresolvable. Staleness means "this answer has aged out, go read it again", and
  // re-reading is exactly what cannot help here; a true verdict would spawn the CLI on every
  // session start and raise a refresh nudge the user has no way to satisfy. The reconcile's weekly
  // anchor heartbeat still re-verifies it, and a token rotation invalidates it immediately.
  if (isPlanUnresolvable(config)) return false;
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
//
// An unresolvable plan OMITS all three rather than sending explicit nulls, the same way
// thirdPartyReportFields omits its key: the three fields are how this client asserts a plan, and a
// setup-token machine has nothing to assert. Omission also matters because billing.mjs forces
// SUBSCRIPTION on a truthy CLAUDE_CODE_OAUTH_TOKEN, so `billing_source` still says subscription and
// this gate is the only thing standing between a plan we know is someone else's and the wire.
// The server prices these sessions from the credential row instead — a null here would be this
// client overwriting that answer with a guess it just decided it could not make.
export function subscriptionReportFields(billingSource, config) {
  if (billingSource !== BillingSource.SUBSCRIPTION || !config) return {};
  if (isPlanUnresolvable(config)) return {};
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
  return { version: BILLING_CONFIG_VERSION, ...(config == null ? {} : config), apiKeyEvidenceAt: now.toISOString() };
}

// A CLI-observed capture (claude auth status) is dated machine evidence, not user testimony. It
// counts as subscription proof while fresh — the reconcile re-verifies it weekly — which is the
// one scoped exception to "billing.json's own source is never an input": the file here carries a
// dated OBSERVATION, and the freshness window keeps a switch from asserting itself forever.
//
// A plan the Beezi server resolved for this machine's key (planSource 'key_resolution', written by
// plan-writeback.mjs) counts too, and has to be checked separately: that writer SPREADS the
// existing config, so a `detectedVia` left over from a previous interactive login survives next to
// it. Reading provenance from detectedVia alone would then either mislabel a server answer as a
// CLI capture, or — if the writer nulled detectedVia to stay honest — switch off the usage-snapshot
// drain's plan donation and lose correct data. Accepting both fields keeps the two consistent.
export function isFreshCliCapture(config, now = Date.now(), freshMs = STALE_MS) {
  if (config == null || config.selfReported === true) return false;
  const keyResolved = config.planSource === 'key_resolution';
  if (!keyResolved && config.detectedVia !== 'cli_status' && config.detectedVia !== 'merged') return false;
  if (!config.plan || config.plan === 'unknown') return false;
  const capturedAt = Date.parse(config.capturedAt == null ? '' : config.capturedAt);
  if (Number.isNaN(capturedAt)) return false;
  return now - capturedAt <= freshMs && capturedAt <= now;
}

// Official statusline docs: the `rate_limits` payload "appears only for Claude.ai subscribers
// (Pro/Max)" — so a recent observation recorded by the status-line wrapper is positive
// subscription-source evidence (source only, never a plan).
export function hasRecentStatuslineObservation(now = Date.now(), deps = {}) {
  const read = deps.readJson == null ? readJson : deps.readJson;
  let state = null;
  try { state = read(statuslineUsageFile()); } catch { state = null; }
  const at = Date.parse(state == null || state.lastRecordedAt == null ? '' : state.lastRecordedAt);
  if (Number.isNaN(at)) return false;
  return now - at <= STALE_MS && at <= now;
}

// The single source-of-truth resolution, shared by the session-start hook and every checkpoint so
// the two can never disagree about what this machine is billing.
export function resolveSource(config, env = oauthTokenEnv(process.env), deps = {}) {
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
  // Cheap file evidence for the surfaces that never write oauthAccount (VS Code extension GUI
  // login, desktop SSO, setup-token): a fresh CLI-observed capture, then a recent status-line
  // rate-limit observation. Both stay file-read-only — this runs on the checkpoint hot path.
  // A custom gateway still resolves UNKNOWN: what the route bills stays the user's question, and
  // this evidence must not answer it for them.
  if (!hasCustomGateway(env)) {
    if (isFreshCliCapture(config, now)) return BillingSource.SUBSCRIPTION;
    const hasObservation = deps.hasStatuslineObservation == null
      ? hasRecentStatuslineObservation
      : deps.hasStatuslineObservation;
    try { if (hasObservation(now)) return BillingSource.SUBSCRIPTION; } catch { /* best-effort */ }
  }
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

export function resolveBilling(config, env = oauthTokenEnv(process.env), deps = {}) {
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
