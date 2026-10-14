import { lastLine, outputLines, report } from './setup-routing.mjs';

export const NO_INFO = 'no Claude subscription info found';
export const PLAN_SKIPPED = 'No plan was saved. Your Beezi link itself already succeeded.';
export const LEFT_UNRESOLVED = "The setup token was left unresolved, so this machine's usage is still reported without a plan.";
export const UNKNOWN_KEY = "Beezi could not register this machine's Claude setup token with the server yet. Try /beezi:settings refresh in Claude Code later.";
export const UNREADABLE = "Beezi could not understand the server's answer, so this setup token's subscription cannot be resolved right now. Try /beezi:settings refresh in Claude Code later.";
const TIER_QUESTION = 'How does this machine pay for Claude?';
const TIERS = [
  { label: 'Pro', value: 'pro' },
  { label: 'Max', follow: { question: 'Which Max plan?', options: [{ label: 'Max 5x', value: 'max_5x' }, { label: 'Max 20x', value: 'max_20x' }] } },
  { label: 'Team or Enterprise', follow: { question: 'Team or Enterprise?', options: [{ label: 'Team', value: 'team' }, { label: 'Enterprise', value: 'enterprise' }] } },
  { label: 'API key (no subscription)', value: 'api_key' },
];
const GATEWAY_QUESTION = 'This machine sends Claude Code through a custom API endpoint. What pays for that usage?';
const GATEWAY = [
  { label: 'My Claude subscription (the endpoint just forwards it)', follow: { question: TIER_QUESTION, options: TIERS.slice(0, 3) } },
  { label: "The gateway or provider's own billing", value: 'gateway' },
  { label: 'An Anthropic API key', value: 'api_key' },
];
const RESOLVE_QUESTION = "Beezi does not know which subscription this machine's Claude setup token bills. How do you want to resolve it?";
const USE_SUBSCRIPTION = 'Use one of my subscriptions';
const NAME_PLAN = 'Name the plan';
const ENTER_TARGET = 'Enter an email or account id';
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

export function resolvedLine(plan) {
  const named = typeof plan === 'string' && plan !== '' ? `: ${plan}` : '';
  return `✓ Beezi knows the subscription for this machine's Claude setup token${named}. It is now what Beezi reports for this machine.`;
}

// The picked option's value, after its follow-up question; null when a question is dismissed.
async function pickValue(ctx, question, options) {
  const i = await ctx.ask.choose(question, options);
  if (i === null) return null;
  const follow = options[i].follow;
  return follow ? pickValue(ctx, follow.question, follow.options) : options[i].value;
}

async function askPayment(ctx, key, captureText) {
  const need = paymentQuestion(captureText);
  if (need === 'none') return;
  const value = need === 'gateway'
    ? await pickValue(ctx, GATEWAY_QUESTION, GATEWAY)
    : await pickValue(ctx, TIER_QUESTION, TIERS);
  if (value === null) {
    ctx.print(PLAN_SKIPPED);
    return;
  }
  report(ctx, await ctx.run('billing-capture.mjs', ['--plan', value, '--via', 'login-user', '--account', key]));
}

// The index of the picked entry by label; null when dismissed or when there is nothing to pick.
function pickEntry(ctx, question, entries) {
  if (entries.length === 0) return Promise.resolve(null);
  return ctx.ask.choose(question, entries.map((entry) => ({ label: entry.label })));
}

// The key-resolve argv for the user's answer; null when it is left unresolved.
async function resolveArgv(ctx, status) {
  const subscriptions = Array.isArray(status.subscriptions) ? status.subscriptions : [];
  const plans = Array.isArray(status.selectablePlans) ? status.selectablePlans : [];
  const ways = (subscriptions.length ? [USE_SUBSCRIPTION] : []).concat([NAME_PLAN, ENTER_TARGET]);
  const way = await ctx.ask.choose(RESOLVE_QUESTION, ways.map((label) => ({ label })));
  if (way === null) return null;
  if (ways[way] === USE_SUBSCRIPTION) {
    const i = await pickEntry(ctx, 'Which subscription does this machine bill?', subscriptions);
    return i === null ? null : ['--target', subscriptions[i].target];
  }
  if (ways[way] === NAME_PLAN) {
    const i = await pickEntry(ctx, 'Which plan is this subscription on?', plans);
    return i === null ? null : ['--plan', plans[i].plan];
  }
  const typed = await ctx.ask.text('Email or account id:');
  return typed === null ? null : ['--target', typed];
}

async function resolveUnlinked(ctx, key, status) {
  const argv = await resolveArgv(ctx, status);
  if (argv === null) {
    ctx.print(LEFT_UNRESOLVED);
    return;
  }
  const result = await ctx.run('key-resolve.mjs', argv.concat(['--account', key]));
  outputLines(`${result.stdout}\n${result.stderr}`).filter((line) => line.trim() !== '').forEach((line) => ctx.print(line));
}

async function settleSetupToken(ctx, key, status) {
  const s = status.status;
  if (s === 'unlinked') {
    await resolveUnlinked(ctx, key, status);
    return;
  }
  if (s === 'resolved') ctx.print(resolvedLine(status.subscriptionPlan));
  else if (s === 'unknown_key') ctx.print(UNKNOWN_KEY);
  else if (s === 'unavailable' || s === 'auth_unavailable') ctx.print(status.message);
  else ctx.print(UNREADABLE);
}

// login.md Steps 2–3: capture, setup-token check, then the gateway/tier questions where they apply.
export async function capturePlan(ctx, key) {
  const capture = await ctx.run('billing-capture.mjs', ['--from-claude', '--via', 'login', '--account', key]);
  report(ctx, capture);
  const listing = await ctx.run('key-resolve.mjs', ['status', '--account', key]);
  if (listing.code !== 0) {
    report(ctx, listing);
    return;
  }
  const status = parseKeyStatus(listing.stdout);
  if (status === null) return;
  if (status.status === 'not_linked') ctx.print(status.message);
  if (status.status === 'no_key' || status.status === 'not_linked') {
    await askPayment(ctx, key, capture.stdout);
    return;
  }
  await settleSetupToken(ctx, key, status);
}
