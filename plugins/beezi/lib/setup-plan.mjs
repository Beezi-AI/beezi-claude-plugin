import { lastLine, report } from './setup-routing.mjs';
import { PLAN_LABELS } from './machine-settings.mjs';

export const NO_INFO = 'no Claude subscription info found';
const SOURCE_LABELS = { anthropic_api_key: 'API key', third_party: 'Third-party provider' };
const CAPTURED = /^✓ Beezi billing captured: source=(\S+) plan=([^\s.]+)/;
// key-resolve statuses for a machine with no setup token: the capture alone names the plan.
const NO_TOKEN = ['no_key', 'not_linked'];
const SETTLED_SOURCE = /\bsource=(?:anthropic_api_key|third_party)\b/;
const NEEDS_TIER = new RegExp(`${NO_INFO}|\\bplan=unknown\\b|keeping the self-reported plan`);

// The question a --from-claude capture line calls for: 'none', 'gateway' or 'tier'.
export function paymentQuestion(text) {
  if (SETTLED_SOURCE.test(text)) return 'none';
  if (/ gateway=custom\b/.test(text)) return 'gateway';
  return NEEDS_TIER.test(text) ? 'tier' : 'none';
}

// The one JSON object `key-resolve.mjs status` prints, or null.
export function parseKeyStatus(text) {
  const line = lastLine(text, /^\{/);
  if (line === null) return null;
  try {
    return JSON.parse(line);
  } catch (error) {
    return null;
  }
}

// The plan a --from-claude capture settled on, by its label; null when it settled on none.
function capturedPlan(text) {
  const line = lastLine(text, CAPTURED);
  if (line === null || paymentQuestion(text) !== 'none') return null;
  const found = CAPTURED.exec(line);
  if (SOURCE_LABELS[found[1]] !== undefined) return SOURCE_LABELS[found[1]];
  return PLAN_LABELS[found[2]] !== undefined ? PLAN_LABELS[found[2]] : null;
}

// The silent capture and setup-token check; the found plan's label, or null. Only failures print.
export async function capturePlan(ctx, key) {
  const capture = await ctx.run('billing-capture.mjs', ['--from-claude', '--via', 'login', '--account', key]);
  if (capture.code !== 0) report(ctx, capture);
  const listing = await ctx.run('key-resolve.mjs', ['status', '--account', key]);
  if (listing.code !== 0) {
    report(ctx, listing);
    return null;
  }
  const status = parseKeyStatus(listing.stdout);
  if (status === null) return null;
  if (status.status === 'resolved') {
    const plan = status.subscriptionPlan;
    return PLAN_LABELS[plan] !== undefined ? PLAN_LABELS[plan] : plan || null;
  }
  return NO_TOKEN.indexOf(status.status) !== -1 ? capturedPlan(capture.stdout) : null;
}
