// The billing-source vocabulary shared with the Beezi API. Defined once so a stray
// literal typo in a comparison can't silently misclassify.
export const BillingSource = Object.freeze({
  THIRD_PARTY: 'third_party',
  ANTHROPIC_API_KEY: 'anthropic_api_key',
  SUBSCRIPTION: 'subscription',
});

// Detect how Claude Code is authenticated, from the environment.
// Precedence mirrors Claude Code: cloud providers → gateway/auth token → API key → subscription.
export function detectBillingSource(env = process.env) {
  if (env.CLAUDE_CODE_USE_BEDROCK || env.CLAUDE_CODE_USE_VERTEX || env.CLAUDE_CODE_USE_FOUNDRY) {
    return BillingSource.THIRD_PARTY;
  }
  if (env.ANTHROPIC_BASE_URL || env.ANTHROPIC_AUTH_TOKEN) return BillingSource.THIRD_PARTY;
  if (env.ANTHROPIC_API_KEY) return BillingSource.ANTHROPIC_API_KEY;
  // CLAUDE_CODE_OAUTH_TOKEN (CI) and the default interactive login both bill the subscription.
  return BillingSource.SUBSCRIPTION;
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
