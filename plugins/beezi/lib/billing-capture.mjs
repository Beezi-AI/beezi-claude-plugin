import {
  BillingSource,
  detectBillingSource,
  resolveBillingSource,
  normalizePlan,
} from './billing.mjs';
import { UserError } from './friendly-error.mjs';

// The credential fields are short opaque labels. Anything token-shaped (an
// sk-ant secret, an over-long string, or embedded whitespace) is refused so a
// misdirected value can never be persisted.
const TOKEN_LIKE = /sk-ant|\s/;

function safeField(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.length > 64 || TOKEN_LIKE.test(s)) {
    throw new UserError('Refusing a suspicious value (looks token-like). Nothing written.');
  }
  return s;
}

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--subscription-type') out.subscriptionType = argv[++i];
    else if (flag === '--rate-limit-tier') out.rateLimitTier = argv[++i];
    else if (flag === '--expires-at') out.expiresAt = argv[++i];
    else if (flag === '--via') out.via = argv[++i];
    else if (flag === '--plan') out.plan = argv[++i];
    else if (flag === '--from-claude') out.fromClaude = true;
  }
  // The script's --from-claude branch rebuilds args from ~/.claude.json, which would
  // silently drop a user-supplied --plan; refuse the combination up front instead.
  if (out.fromClaude && out.plan != null) {
    throw new UserError('--plan and --from-claude are mutually exclusive.');
  }
  return out;
}

// Self-reported plans a user can pick in the /beezi:login fallback. `free` is
// absent: Claude Code cannot run on subscription billing with a free plan.
const SELF_REPORTED_PLANS = Object.freeze(['pro', 'max_5x', 'max_20x', 'team', 'enterprise']);

// Not plans — the ways a user declares they are NOT on a subscription. Without them the tier
// question is the only answer available, which pins a machine paying with an API key to a
// subscription plan it does not have and buckets its spend and errors under that plan.
// `gateway` covers the case no local signal can settle: Claude Code pointed at a custom endpoint,
// which may forward this machine's own subscription credential or bill the gateway's instead.
const SELF_REPORTED_API_KEY = 'api_key';
const SELF_REPORTED_GATEWAY = 'gateway';

// The declared source for each non-subscription answer.
function declaredNonSubscriptionSource(plan) {
  if (plan === SELF_REPORTED_API_KEY) return BillingSource.ANTHROPIC_API_KEY;
  if (plan === SELF_REPORTED_GATEWAY) return BillingSource.THIRD_PARTY;
  return null;
}

export function buildConfig(args, env = process.env, now = new Date(), account = null) {
  if (args.plan != null) {
    const plan = String(args.plan).trim().toLowerCase();
    const declaredSource = declaredNonSubscriptionSource(plan);
    if (declaredSource != null) {
      const envSource = detectBillingSource(env);
      const capturedVia = safeField(args.via);
      return {
        version: 1,
        // An env that positively names a provider still wins; otherwise take the user's word.
        source: envSource === BillingSource.UNKNOWN ? declaredSource : envSource,
        subscriptionType: null,
        rateLimitTier: null,
        plan: null,
        credentialsExpiresAt: null,
        capturedAt: now.toISOString(),
        capturedBy: capturedVia == null ? 'manual' : capturedVia,
        selfReported: true,
      };
    }
    if (!SELF_REPORTED_PLANS.includes(plan)) {
      throw new UserError(
        `Unknown plan '${args.plan}'. Valid: ${[...SELF_REPORTED_PLANS, SELF_REPORTED_API_KEY, SELF_REPORTED_GATEWAY].join(', ')}.`,
      );
    }
    // Naming a subscription tier IS the evidence: the user is telling us they bill a subscription,
    // which is exactly the fact no local signal could establish. It resolves UNKNOWN, but it never
    // overrides an env that positively says otherwise — an exported API key outranks the claim.
    const envSource = detectBillingSource(env);
    const source = envSource === BillingSource.UNKNOWN ? BillingSource.SUBSCRIPTION : envSource;
    const isSub = source === BillingSource.SUBSCRIPTION;
    const capturedVia = safeField(args.via);
    return {
      version: 1,
      source,
      // The plan label is the single source of the derived fields; the tier was
      // never observed, so rateLimitTier stays null rather than a synthesized value.
      subscriptionType: isSub ? (plan.startsWith('max_') ? 'max' : plan) : null,
      rateLimitTier: null,
      plan: isSub ? plan : null,
      credentialsExpiresAt: null,
      capturedAt: now.toISOString(),
      capturedBy: capturedVia == null ? 'manual' : capturedVia,
      selfReported: true,
    };
  }
  const subscriptionType = safeField(args.subscriptionType);
  const rateLimitTier = safeField(args.rateLimitTier);
  const via = safeField(args.via);
  // A readable oauthAccount is positive subscription evidence; without it (and without an env
  // signal) the source stays unknown rather than being assumed.
  const source = resolveBillingSource(env, account);
  const isSub = source === BillingSource.SUBSCRIPTION;
  // null/undefined/'' must stay null — Number(null) is 0, which would look like an
  // already-expired timestamp and force a permanent "stale" state.
  const expiresAt = args.expiresAt == null || args.expiresAt === '' ? NaN : Number(args.expiresAt);
  return {
    version: 1,
    source,
    subscriptionType: isSub ? subscriptionType : null,
    rateLimitTier: isSub ? rateLimitTier : null,
    plan: isSub ? normalizePlan(subscriptionType, rateLimitTier) : null,
    credentialsExpiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
    capturedAt: now.toISOString(),
    capturedBy: via == null ? 'manual' : via,
  };
}

// A self-reported plan must survive automatic re-capture: when the fresh account
// fields still normalize to 'unknown', overwriting would destroy the only good
// data and restart the refresh-nudge loop the selfReported exemption exists to end.
export function shouldKeepExisting(freshConfig, existingConfig) {
  if (existingConfig == null || existingConfig.selfReported !== true) return false;
  const declaredTier = Boolean(existingConfig.plan) && existingConfig.plan !== 'unknown';
  // A declared api-key or gateway machine carries no plan at all — the source IS the declaration.
  const declaredSource = existingConfig.source === BillingSource.ANTHROPIC_API_KEY
    || existingConfig.source === BillingSource.THIRD_PARTY;
  if (!declaredTier && !declaredSource) return false;
  // Overwrite only when the fresh capture actually learned something. An `unknown` source means it
  // did not, so the user's answer must survive — otherwise every /beezi:refresh on a machine whose
  // billing cannot be observed wipes the answer and restarts the nudge loop.
  return freshConfig.plan === 'unknown' || freshConfig.source === BillingSource.UNKNOWN;
}
