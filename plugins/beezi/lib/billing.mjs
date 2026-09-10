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

// Whether ANTHROPIC_BASE_URL points somewhere other than Anthropic's own API. This answers a
// ROUTING question, never a billing one — see detectBillingSource for why the two are separate.
// Claude Code gates the same way (Remote Control is disabled only when the base URL points at a
// host other than api.anthropic.com).
const FIRST_PARTY_API_HOST = 'api.anthropic.com';

function isGatewayBaseUrl(value) {
  if (value == null) return false;
  const raw = String(value).trim();
  if (!raw) return false;
  let host;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    // Set but unparseable: nothing to vouch for it, so keep the conservative answer.
    return true;
  }
  // A trailing dot is the same host in absolute-FQDN form.
  return host.replace(/\.$/, '') !== FIRST_PARTY_API_HOST;
}

// Whether this machine routes Claude Code somewhere other than Anthropic's own API. Exported so
// the session-start nudge and the login flow can ask the user what the gateway bills, which is the
// only way to settle it — see resolveBillingSource.
export function hasCustomGateway(env = process.env) {
  return isGatewayBaseUrl(env.ANTHROPIC_BASE_URL);
}

// Detect how Claude Code is authenticated, from the environment ALONE. Pure — no disk reads.
// Precedence: cloud providers → gateway auth token → API key (labelled third-party when it is
// presented to a gateway host) → OAuth token.
// Absence of every signal yields UNKNOWN, never a guess; resolveBillingSource is what goes on to
// look for positive subscription evidence off-env.
export function detectBillingSource(env = process.env) {
  if (env.CLAUDE_CODE_USE_BEDROCK || env.CLAUDE_CODE_USE_VERTEX || env.CLAUDE_CODE_USE_FOUNDRY) {
    return BillingSource.THIRD_PARTY;
  }
  // A proxy or gateway in front of the API does not change who pays: Claude Code can keep the
  // saved claude.ai login as the active credential through one, and Anthropic then bills that
  // subscription. What proves a different payer is a CREDENTIAL, not a route — so ANTHROPIC_BASE_URL
  // alone is not a billing signal, and only labels the route once something else names the payer.
  // (Claude Desktop makes this concrete: it injects ANTHROPIC_BASE_URL into every session it
  // spawns, replacing whatever the user exported, while still billing the OAuth subscription.)
  // The same holds for a credential on its own: against api.anthropic.com an auth token is how a
  // subscription OAuth credential is passed, and an API key is plain api-key billing. It is the
  // COMBINATION — a credential presented to a host that is not Anthropic's — that names a payer
  // outside this machine's Claude login.
  if (isGatewayBaseUrl(env.ANTHROPIC_BASE_URL) && (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN)) {
    return BillingSource.THIRD_PARTY;
  }
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
  // A custom gateway with no credential in the env is the one case the machine cannot settle: the
  // route may carry this machine's own subscription credential or one the gateway holds, and
  // nothing observable distinguishes them. The local login stops counting as evidence, and the
  // question goes to the user (/beezi:login) exactly as an unresolvable tier does.
  if (hasCustomGateway(env)) return BillingSource.UNKNOWN;
  if (account) return BillingSource.SUBSCRIPTION;
  if (signals != null && (signals.hasManagedApiKey || signals.hasApiKeyHelper)) return BillingSource.ANTHROPIC_API_KEY;
  return BillingSource.UNKNOWN;
}

// An API error that proves the session is billing an API key rather than a subscription: only a
// pay-as-you-go key has a credit balance to run out of. A subscription that runs out reports a
// usage/rate limit instead. This is the one signal that survives a switch we cannot otherwise
// observe, so it outranks everything else when it appears.
const API_KEY_BALANCE_TEXT = /credit balance is too low|low api[- ]key balance/i;

export function isApiKeyBillingEvidence(apiErrorEvents = []) {
  return apiErrorEvents.some(
    (e) => e != null && e.error === 'billing_error' && API_KEY_BALANCE_TEXT.test(String(e.text == null ? '' : e.text)),
  );
}

// The specific third-party provider vocabulary shared with the Beezi API.
export const ThirdPartyProvider = Object.freeze({
  AWS_BEDROCK: 'aws_bedrock',
  GOOGLE_VERTEX: 'google_vertex',
  AZURE_FOUNDRY: 'azure_foundry',
  GATEWAY: 'gateway',
});

// Which third-party provider is in use, from the environment. Presence-only for the cloud
// providers — those values are never read; ANTHROPIC_BASE_URL is judged by its host alone (see
// isGatewayBaseUrl), never by its credentials or path. Precedence matches detectBillingSource:
// cloud providers before gateway vars. This is the ROUTE label, not a billing signal: callers must
// establish third-party billing first (resolveBilling does, via thirdPartyReportFields).
// Returns null when no provider env is set.
export function detectThirdPartyProvider(env = process.env) {
  if (env.CLAUDE_CODE_USE_BEDROCK) return ThirdPartyProvider.AWS_BEDROCK;
  if (env.CLAUDE_CODE_USE_VERTEX) return ThirdPartyProvider.GOOGLE_VERTEX;
  if (env.CLAUDE_CODE_USE_FOUNDRY) return ThirdPartyProvider.AZURE_FOUNDRY;
  if (isGatewayBaseUrl(env.ANTHROPIC_BASE_URL)) return ThirdPartyProvider.GATEWAY;
  return null;
}

// Normalize the local credential fields to a plan label. rateLimitTier wins for the
// Max multiplier; subscriptionType names the product. Substring match so new
// default_claude_max_* tiers degrade gracefully. Raw fields remain the source of truth.
export function normalizePlan(subscriptionType, rateLimitTier) {
  const tier = String(rateLimitTier == null ? '' : rateLimitTier).toLowerCase();
  if (tier.includes('max_20x')) return 'max_20x';
  if (tier.includes('max_5x')) return 'max_5x';
  const type = String(subscriptionType == null ? '' : subscriptionType).toLowerCase();
  // Symmetric with the tier arm above: a source that puts the multiplier in the product field
  // would otherwise miss every exact-equality branch below and degrade to 'unknown'.
  if (type.includes('max_20x')) return 'max_20x';
  if (type.includes('max_5x')) return 'max_5x';
  if (type === 'enterprise') return 'enterprise';
  if (type === 'team') return 'team';
  if (type === 'max') return 'max';
  if (type === 'pro') return 'pro';
  if (type === 'free') return 'free';
  return 'unknown';
}
