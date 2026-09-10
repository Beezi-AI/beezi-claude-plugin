import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectBillingSource,
  detectThirdPartyProvider,
  resolveBillingSource,
  isApiKeyBillingEvidence,
} from '../lib/billing.mjs';
import { normalizePlan } from '../lib/billing.mjs';
import { thirdPartyReportFields } from '../lib/billing-config.mjs';

test('detectBillingSource — a base URL alone is a route, not a payer', () => {
  // A proxy or gateway in front of the API does not change who is billed: Claude Code can keep
  // using the saved claude.ai login as the active credential through it. Without a credential var
  // naming a different payer, this is not evidence of anything — resolveBillingSource goes on to
  // look for the subscription account on disk.
  assert.equal(detectBillingSource({ ANTHROPIC_BASE_URL: 'https://proxy.example' }), 'unknown');
});

test('detectBillingSource — a gateway host plus an API key is third-party billing', () => {
  assert.equal(
    detectBillingSource({ ANTHROPIC_BASE_URL: 'https://gw.corp.example', ANTHROPIC_API_KEY: 'sk-x' }),
    'third_party',
  );
});

test('resolveBillingSource — a custom gateway leaves the payer unknown, account or not', () => {
  // The route may carry this machine's subscription credential or the gateway's own, and nothing
  // observable says which — so the local login stops being evidence and the user is asked instead.
  assert.equal(resolveBillingSource({ ANTHROPIC_BASE_URL: 'https://proxy.example' }, ACCOUNT), 'unknown');
  assert.equal(resolveBillingSource({ ANTHROPIC_BASE_URL: 'https://proxy.example' }, null), 'unknown');
});

test('detectBillingSource — third_party for Bedrock / Vertex', () => {
  assert.equal(detectBillingSource({ CLAUDE_CODE_USE_BEDROCK: '1' }), 'third_party');
  assert.equal(detectBillingSource({ CLAUDE_CODE_USE_VERTEX: '1' }), 'third_party');
});

test('detectBillingSource — third_party wins over ANTHROPIC_API_KEY', () => {
  assert.equal(
    detectBillingSource({ ANTHROPIC_BASE_URL: 'https://proxy.example', ANTHROPIC_API_KEY: 'x' }),
    'third_party',
  );
});

test('detectBillingSource — anthropic_api_key when only the key is present', () => {
  assert.equal(detectBillingSource({ ANTHROPIC_API_KEY: 'sk-x' }), 'anthropic_api_key');
});

test('detectBillingSource — unknown when nothing is set (never guesses subscription)', () => {
  // An API key configured inside Claude Code never reaches process.env, so "no signal" cannot be
  // read as "subscription" — that guess is what mis-attributed API-key usage to a stale plan.
  assert.equal(detectBillingSource({}), 'unknown');
});

test('detectBillingSource — third_party for Foundry', () => {
  assert.equal(detectBillingSource({ CLAUDE_CODE_USE_FOUNDRY: '1' }), 'third_party');
});

test('detectBillingSource — an auth token without a custom gateway is not a third-party signal', () => {
  // Same rule as the API key: a credential only names a different payer when it is being presented
  // somewhere other than Anthropic's own API. Against api.anthropic.com this is how a subscription
  // OAuth token is passed, so it must not be read as gateway billing.
  assert.equal(detectBillingSource({ ANTHROPIC_AUTH_TOKEN: 'tok' }), 'unknown');
  assert.equal(
    detectBillingSource({ ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }),
    'unknown',
  );
});

test('detectBillingSource — an auth token presented to a custom gateway is third-party', () => {
  assert.equal(
    detectBillingSource({ ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_BASE_URL: 'https://gw.corp.example' }),
    'third_party',
  );
});

test('detectBillingSource — subscription for CLAUDE_CODE_OAUTH_TOKEN', () => {
  assert.equal(detectBillingSource({ CLAUDE_CODE_OAUTH_TOKEN: 'oat' }), 'subscription');
});

test('normalizePlan — rateLimitTier wins for the multiplier', () => {
  assert.equal(normalizePlan('pro', 'default_claude_max_5x'), 'max_5x');
  assert.equal(normalizePlan('max', 'default_claude_max_20x'), 'max_20x');
});

test('normalizePlan — falls back to subscriptionType', () => {
  assert.equal(normalizePlan('pro', undefined), 'pro');
  assert.equal(normalizePlan('team', null), 'team');
  assert.equal(normalizePlan('enterprise', ''), 'enterprise');
  assert.equal(normalizePlan('max', 'weird_tier'), 'max');
  assert.equal(normalizePlan('free', undefined), 'free');
});

test('normalizePlan — a multiplier in the product field is matched too, not degraded to unknown', () => {
  // The tier arm matches by substring; the product arm used exact equality, so a source that put
  // the multiplier in subscriptionType missed every branch and returned 'unknown' — strictly
  // worse than the plain 'max' it should have beaten.
  assert.equal(normalizePlan('max_20x', null), 'max_20x');
  assert.equal(normalizePlan('max_5x', null), 'max_5x');
  assert.equal(normalizePlan('max', null), 'max', 'a bare max is still a bare max');
});

test('normalizePlan — unknown when nothing matches', () => {
  assert.equal(normalizePlan(undefined, undefined), 'unknown');
  assert.equal(normalizePlan('mystery', 'mystery'), 'unknown');
});

test('detectThirdPartyProvider — names each cloud provider from its env', () => {
  assert.equal(detectThirdPartyProvider({ CLAUDE_CODE_USE_BEDROCK: '1' }), 'aws_bedrock');
  assert.equal(detectThirdPartyProvider({ CLAUDE_CODE_USE_VERTEX: '1' }), 'google_vertex');
  assert.equal(detectThirdPartyProvider({ CLAUDE_CODE_USE_FOUNDRY: '1' }), 'azure_foundry');
});

test('detectThirdPartyProvider — gateway names the custom base URL as the route', () => {
  assert.equal(detectThirdPartyProvider({ ANTHROPIC_BASE_URL: 'https://proxy.example' }), 'gateway');
  // An auth token alone routes to Anthropic, so there is no third-party route to name.
  assert.equal(detectThirdPartyProvider({ ANTHROPIC_AUTH_TOKEN: 'tok' }), null);
});

test('detectThirdPartyProvider — cloud provider wins over gateway vars', () => {
  assert.equal(
    detectThirdPartyProvider({ CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_BASE_URL: 'https://proxy' }),
    'aws_bedrock',
  );
});

test('detectThirdPartyProvider — null when no provider env is set', () => {
  assert.equal(detectThirdPartyProvider({}), null);
  assert.equal(detectThirdPartyProvider({ ANTHROPIC_API_KEY: 'sk-x' }), null);
});

test('thirdPartyReportFields — provider key only for third-party billing', () => {
  assert.deepEqual(
    thirdPartyReportFields('third_party', { CLAUDE_CODE_USE_BEDROCK: '1' }),
    { third_party_provider: 'aws_bedrock' },
  );
  assert.deepEqual(thirdPartyReportFields('subscription', { CLAUDE_CODE_USE_BEDROCK: '1' }), {});
  // third-party billing with no identifiable provider env → omit the key rather than send unknown.
  assert.deepEqual(thirdPartyReportFields('third_party', {}), {});
});

// ─── resolveBillingSource: env → account → unknown ───────────────────────────

const ACCOUNT = Object.freeze({ subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' });

test('resolveBillingSource — a readable oauthAccount is the subscription evidence', () => {
  assert.equal(resolveBillingSource({}, ACCOUNT), 'subscription');
});

test('resolveBillingSource — no env signal and no account stays unknown', () => {
  assert.equal(resolveBillingSource({}, null), 'unknown');
});

test('resolveBillingSource — env outranks the account', () => {
  // The account lingers after a subscription login; an exported key is the current truth.
  assert.equal(resolveBillingSource({ ANTHROPIC_API_KEY: 'sk-x' }, ACCOUNT), 'anthropic_api_key');
  assert.equal(resolveBillingSource({ CLAUDE_CODE_USE_BEDROCK: '1' }, ACCOUNT), 'third_party');
});

// ─── isApiKeyBillingEvidence ────────────────────────────────────────────────

test('isApiKeyBillingEvidence — a credit-balance billing_error proves API-key billing', () => {
  assert.equal(isApiKeyBillingEvidence([
    { error: 'billing_error', text: 'Your credit balance is too low to access the Anthropic API.' },
  ]), true);
});

test('isApiKeyBillingEvidence — unrelated errors prove nothing', () => {
  assert.equal(isApiKeyBillingEvidence([]), false);
  assert.equal(isApiKeyBillingEvidence([{ error: 'rate_limit', text: 'usage limit reached' }]), false);
  // A subscription can hit a billing_error too; only the balance wording is API-key specific.
  assert.equal(isApiKeyBillingEvidence([{ error: 'billing_error', text: 'payment method declined' }]), false);
});

// ─── an API key configured inside Claude Code (never in process.env) ─────────

test('resolveBillingSource — a /login managed key resolves anthropic_api_key', () => {
  assert.equal(resolveBillingSource({}, null, { hasManagedApiKey: true }), 'anthropic_api_key');
});

test('resolveBillingSource — a configured apiKeyHelper resolves anthropic_api_key', () => {
  assert.equal(resolveBillingSource({}, null, { hasApiKeyHelper: true }), 'anthropic_api_key');
});

test('resolveBillingSource — an active subscription login outranks a configured key', () => {
  // Mirrors Claude Code's own resolution: it reports oauth whenever a subscription login is
  // active, even with an API key present.
  assert.equal(resolveBillingSource({}, ACCOUNT, { hasManagedApiKey: true }), 'subscription');
});

test('resolveBillingSource — no account and no key signals stays unknown', () => {
  assert.equal(resolveBillingSource({}, null, { hasManagedApiKey: false, hasApiKeyHelper: false }), 'unknown');
});

// ─── ANTHROPIC_BASE_URL is host-gated, not presence-gated ────────────────────
// Claude Desktop injects ANTHROPIC_BASE_URL into every session it spawns, set to its own
// endpoint (https://api.anthropic.com on a first-party subscription seat) and REPLACING whatever
// the user had exported. Treating its presence as proof of a gateway reported subscription users
// as third_party/gateway. Anthropic's own gating compares the host for exactly this reason.

test('detectBillingSource — the first-party API host is not third-party billing', () => {
  assert.equal(detectBillingSource({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }), 'unknown');
});

test('detectBillingSource — first-party host recognized regardless of case, port or path', () => {
  assert.equal(detectBillingSource({ ANTHROPIC_BASE_URL: 'HTTPS://API.Anthropic.COM' }), 'unknown');
  assert.equal(detectBillingSource({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com:443/v1' }), 'unknown');
  assert.equal(detectBillingSource({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com./' }), 'unknown');
  assert.equal(detectBillingSource({ ANTHROPIC_BASE_URL: '  https://api.anthropic.com  ' }), 'unknown');
});

test('detectThirdPartyProvider — any non-first-party host labels the route a gateway', () => {
  const key = { ANTHROPIC_API_KEY: 'sk-x' };
  assert.equal(detectThirdPartyProvider({ ...key, ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787' }), 'gateway');
  assert.equal(detectThirdPartyProvider({ ...key, ANTHROPIC_BASE_URL: 'https://gw.corp.example/anthropic' }), 'gateway');
  // Matching is on the exact hostname, so a longer host that merely starts with it is not first-party.
  assert.equal(detectThirdPartyProvider({ ...key, ANTHROPIC_BASE_URL: 'https://api.anthropic.com.evil.test' }), 'gateway');
});

test('detectThirdPartyProvider — an unparseable base URL is treated as a gateway', () => {
  // Set but not vouchable: no reason to credit it as the first-party endpoint.
  assert.equal(detectThirdPartyProvider({ ANTHROPIC_API_KEY: 'sk-x', ANTHROPIC_BASE_URL: 'api.anthropic.com' }), 'gateway');
  assert.equal(detectBillingSource({ ANTHROPIC_API_KEY: 'sk-x', ANTHROPIC_BASE_URL: 'not a url' }), 'third_party');
});

test('detectBillingSource — an API key alongside the first-party host is api-key billing', () => {
  assert.equal(
    detectBillingSource({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_API_KEY: 'sk-x' }),
    'anthropic_api_key',
  );
});



test('detectThirdPartyProvider — no gateway label for the first-party host', () => {
  assert.equal(detectThirdPartyProvider({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }), null);
  assert.equal(detectThirdPartyProvider({ ANTHROPIC_BASE_URL: 'https://gw.corp.example' }), 'gateway');
});

test('detectThirdPartyProvider — cloud providers still outrank the injected first-party host', () => {
  assert.equal(
    detectThirdPartyProvider({ CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }),
    'aws_bedrock',
  );
  assert.equal(
    detectBillingSource({ CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }),
    'third_party',
  );
});

test('resolveBillingSource — a desktop-shaped env keeps a subscription machine on subscription', () => {
  // The reported bug end to end: Claude Desktop's injected base URL used to outrank the
  // oauthAccount and relabel a Team/Max seat as gateway billing.
  assert.equal(
    resolveBillingSource({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }, ACCOUNT),
    'subscription',
  );
});
