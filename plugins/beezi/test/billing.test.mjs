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

test('detectBillingSource — third_party when ANTHROPIC_BASE_URL is set', () => {
  assert.equal(detectBillingSource({ ANTHROPIC_BASE_URL: 'https://proxy.example' }), 'third_party');
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

test('detectBillingSource — third_party for ANTHROPIC_AUTH_TOKEN (gateway)', () => {
  assert.equal(detectBillingSource({ ANTHROPIC_AUTH_TOKEN: 'tok' }), 'third_party');
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

test('normalizePlan — unknown when nothing matches', () => {
  assert.equal(normalizePlan(undefined, undefined), 'unknown');
  assert.equal(normalizePlan('mystery', 'mystery'), 'unknown');
});

test('detectThirdPartyProvider — names each cloud provider from its env', () => {
  assert.equal(detectThirdPartyProvider({ CLAUDE_CODE_USE_BEDROCK: '1' }), 'aws_bedrock');
  assert.equal(detectThirdPartyProvider({ CLAUDE_CODE_USE_VERTEX: '1' }), 'google_vertex');
  assert.equal(detectThirdPartyProvider({ CLAUDE_CODE_USE_FOUNDRY: '1' }), 'azure_foundry');
});

test('detectThirdPartyProvider — gateway for base-url / auth-token', () => {
  assert.equal(detectThirdPartyProvider({ ANTHROPIC_BASE_URL: 'https://proxy.example' }), 'gateway');
  assert.equal(detectThirdPartyProvider({ ANTHROPIC_AUTH_TOKEN: 'tok' }), 'gateway');
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
