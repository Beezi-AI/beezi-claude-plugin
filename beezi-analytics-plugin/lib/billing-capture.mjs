import { BillingSource, detectBillingSource, normalizePlan } from './billing.mjs';
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

export function buildConfig(args, env = process.env, now = new Date()) {
  if (args.plan != null) {
    const plan = String(args.plan).trim().toLowerCase();
    if (!SELF_REPORTED_PLANS.includes(plan)) {
      throw new UserError(`Unknown plan '${args.plan}'. Valid: ${SELF_REPORTED_PLANS.join(', ')}.`);
    }
    const source = detectBillingSource(env);
    const isSub = source === BillingSource.SUBSCRIPTION;
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
      capturedBy: safeField(args.via) ?? 'manual',
      selfReported: true,
    };
  }
  const subscriptionType = safeField(args.subscriptionType);
  const rateLimitTier = safeField(args.rateLimitTier);
  const via = safeField(args.via) ?? 'manual';
  const source = detectBillingSource(env);
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
    capturedBy: via,
  };
}

// A self-reported plan must survive automatic re-capture: when the fresh account
// fields still normalize to 'unknown', overwriting would destroy the only good
// data and restart the refresh-nudge loop the selfReported exemption exists to end.
export function shouldKeepExisting(freshConfig, existingConfig) {
  return freshConfig.plan === 'unknown'
    && existingConfig?.selfReported === true
    && Boolean(existingConfig.plan)
    && existingConfig.plan !== 'unknown';
}
