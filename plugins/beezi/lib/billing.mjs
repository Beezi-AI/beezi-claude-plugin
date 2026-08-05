// The billing-source vocabulary shared with the Beezi API. Defined once so a stray
// literal typo in a comparison can't silently misclassify.
export const BillingSource = Object.freeze({
  THIRD_PARTY: 'third_party',
  ANTHROPIC_API_KEY: 'anthropic_api_key',
  SUBSCRIPTION: 'subscription',
  // No evidence either way. Distinct from SUBSCRIPTION on purpose: an API key configured inside
  // Claude Code (its own /login, or the OS keychain) never reaches process.env, so "no env signal"
  // is not the same as "billing a subscription". Guessing SUBSCRIPTION here is what let API-key
  // sessions report a stale subscription plan and bucket their errors under it.
  UNKNOWN: 'unknown',
});

// Detect how Claude Code is authenticated, from the environment ALONE. Pure — no disk reads.
// Precedence mirrors Claude Code: cloud providers → gateway/auth token → API key → OAuth token.
// Absence of every signal yields UNKNOWN, never a guess; resolveBillingSource is what goes on to
// look for positive subscription evidence off-env.
export function detectBillingSource(env = process.env) {
  if (env.CLAUDE_CODE_USE_BEDROCK || env.CLAUDE_CODE_USE_VERTEX || env.CLAUDE_CODE_USE_FOUNDRY) {
    return BillingSource.THIRD_PARTY;
  }
  if (env.ANTHROPIC_BASE_URL || env.ANTHROPIC_AUTH_TOKEN) return BillingSource.THIRD_PARTY;
  if (env.ANTHROPIC_API_KEY) return BillingSource.ANTHROPIC_API_KEY;
  // CLAUDE_CODE_OAUTH_TOKEN (CI) is a subscription credential — positive evidence, not a default.
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return BillingSource.SUBSCRIPTION;
  return BillingSource.UNKNOWN;
}

// The full precedence, and the only function callers should resolve a source with: environment
// first, then the on-disk Claude account, then unknown. Never guesses.
//
// `account` is the parsed ~/.claude.json oauthAccount (readClaudeAccount()) — proof of an
// interactive subscription login. `signals` is readClaudeAuthSignals() — presence-only flags for
// an API key configured inside Claude Code, which never reaches process.env. Both are passed in
// rather than read here so this stays pure and the caller controls the best-effort disk reads.
//
// Subscription outranks a configured key, matching Claude Code's own resolution: it returns
// "oauth" whenever a subscription login is active, even with an API key present.
export function resolveBillingSource(env = process.env, account = null, signals = null) {
  const fromEnv = detectBillingSource(env);
  if (fromEnv !== BillingSource.UNKNOWN) return fromEnv;
  if (account) return BillingSource.SUBSCRIPTION;
  if (signals?.hasManagedApiKey || signals?.hasApiKeyHelper) return BillingSource.ANTHROPIC_API_KEY;
  return BillingSource.UNKNOWN;
}

// An API error that proves the session is billing an API key rather than a subscription: only a
// pay-as-you-go key has a credit balance to run out of. A subscription that runs out reports a
// usage/rate limit instead. This is the one signal that survives a switch we cannot otherwise
// observe, so it outranks everything else when it appears.
const API_KEY_BALANCE_TEXT = /credit balance is too low|low api[- ]key balance/i;

export function isApiKeyBillingEvidence(apiErrorEvents = []) {
  return apiErrorEvents.some(
    (e) => e?.error === 'billing_error' && API_KEY_BALANCE_TEXT.test(String(e?.text ?? '')),
  );
}

// The specific third-party provider vocabulary shared with the Beezi API.
export const ThirdPartyProvider = Object.freeze({
  AWS_BEDROCK: 'aws_bedrock',
  GOOGLE_VERTEX: 'google_vertex',
  AZURE_FOUNDRY: 'azure_foundry',
  GATEWAY: 'gateway',
});

// Which third-party provider is in use, from the environment. Presence-only — the value of each
// var is never read. Precedence matches detectBillingSource: cloud providers before gateway vars.
// Returns null when billing is not third-party (no provider env is set).
export function detectThirdPartyProvider(env = process.env) {
  if (env.CLAUDE_CODE_USE_BEDROCK) return ThirdPartyProvider.AWS_BEDROCK;
  if (env.CLAUDE_CODE_USE_VERTEX) return ThirdPartyProvider.GOOGLE_VERTEX;
  if (env.CLAUDE_CODE_USE_FOUNDRY) return ThirdPartyProvider.AZURE_FOUNDRY;
  if (env.ANTHROPIC_BASE_URL || env.ANTHROPIC_AUTH_TOKEN) return ThirdPartyProvider.GATEWAY;
  return null;
}

// Normalize the local credential fields to a plan label. rateLimitTier wins for the
// Max multiplier; subscriptionType names the product. Substring match so new
// default_claude_max_* tiers degrade gracefully. Raw fields remain the source of truth.
export function normalizePlan(subscriptionType, rateLimitTier) {
  const tier = String(rateLimitTier ?? '').toLowerCase();
  if (tier.includes('max_20x')) return 'max_20x';
  if (tier.includes('max_5x')) return 'max_5x';
  const type = String(subscriptionType ?? '').toLowerCase();
  if (type === 'enterprise') return 'enterprise';
  if (type === 'team') return 'team';
  if (type === 'max') return 'max';
  if (type === 'pro') return 'pro';
  if (type === 'free') return 'free';
  return 'unknown';
}
