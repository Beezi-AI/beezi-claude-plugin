import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  keyFingerprint,
  collectKeys,
  buildAccountSyncPayload,
  payloadHash,
  isEmptyPayload,
  syncAccountIfNeeded,
  CredentialKind,
} from '../lib/account-sync.mjs';

// Every test gets its own BEEZI_HOME so the sync marker can never touch the real ~/.beezi
// (nor leak between tests). The env passed to the library is always an explicit object — never
// process.env — so a developer machine with a real ANTHROPIC_API_KEY exported cannot be
// fingerprinted into a test.
async function withTempHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-acct-'));
  const prev = process.env.BEEZI_HOME;
  process.env.BEEZI_HOME = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.BEEZI_HOME; else process.env.BEEZI_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 44 chars: a realistic credential shape whose middle is unmistakable in any leak.
const SECRET = 'sk-ant-api03-MIDDLEMUSTNEVERAPPEARANYWHERE-9f3a';
const MIDDLE = SECRET.slice(12, -4);

const okFetch = (calls = [], status = 200) => async (url, opts) => {
  calls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
  return { status, json: async () => ({}) };
};

function config(overrides = {}) {
  return {
    version: 3,
    source: 'subscription',
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_20x',
    plan: 'max_20x',
    accountAnchor: { value: 'acc-uuid-1', source: 'account_uuid', updatedAt: '2026-08-01T00:00:00.000Z' },
    accountEmail: 'dev@example.com',
    ...overrides,
  };
}

// ─── keyFingerprint — the security guard ─────────────────────────────────────

test('keyFingerprint — anything under 20 chars yields null', () => {
  assert.equal(keyFingerprint('sk-ant-short'), null);
  assert.equal(keyFingerprint('a'.repeat(19)), null);
  assert.notEqual(keyFingerprint('a'.repeat(20)), null);
});

test('keyFingerprint — non-strings and blanks yield null, never throw', () => {
  for (const v of [null, undefined, 0, 12345678901234567890, {}, [], true, '', '   ']) {
    assert.equal(keyFingerprint(v), null, `${String(v)} must not fingerprint`);
  }
});

test('keyFingerprint — exposes only 12 leading + 4 trailing chars and the length', () => {
  const fp = keyFingerprint(SECRET);
  assert.deepEqual(fp, { prefix: SECRET.slice(0, 12), last4: SECRET.slice(-4), length: SECRET.length });
  assert.equal(fp.prefix.length, 12);
  assert.equal(fp.last4.length, 4);
  // The actual rule: nothing between char 12 and the last 4 may leave the machine.
  assert.equal(JSON.stringify(fp).includes(MIDDLE), false, 'the middle of the key must never appear');
});

test('keyFingerprint — length is derived from the SAME trimmed value as prefix/last4', () => {
  const fp = keyFingerprint(`  ${SECRET}\n`);
  assert.equal(fp.length, SECRET.length, 'a raw length would desync the server reconstruction check');
  assert.equal(fp.prefix, SECRET.slice(0, 12));
  assert.equal(fp.last4, SECRET.slice(-4));
  // At the 20-char floor the server keeps the entry: 12 + 4 < 20.
  assert.ok(fp.prefix.length + fp.last4.length < fp.length);
});

// ─── collectKeys — the env matrix ────────────────────────────────────────────

test('collectKeys — bare ANTHROPIC_API_KEY is an anthropic_api_key', () => {
  const keys = collectKeys({ ANTHROPIC_API_KEY: SECRET });
  assert.equal(keys.length, 1);
  assert.equal(keys[0].kind, CredentialKind.ANTHROPIC_API_KEY);
  assert.equal(keys[0].last4, SECRET.slice(-4));
});

test('collectKeys — a first-party base URL is NOT a gateway', () => {
  const keys = collectKeys({ ANTHROPIC_API_KEY: SECRET, ANTHROPIC_BASE_URL: 'https://api.anthropic.com' });
  assert.equal(keys[0].kind, CredentialKind.ANTHROPIC_API_KEY);
});

test('collectKeys — the gateway conjunction reclassifies the key as gateway_token', () => {
  const keys = collectKeys({ ANTHROPIC_API_KEY: SECRET, ANTHROPIC_BASE_URL: 'https://llm.corp.internal/v1' });
  assert.equal(keys.length, 1);
  assert.equal(keys[0].kind, CredentialKind.GATEWAY_TOKEN);
});

test('collectKeys — ANTHROPIC_AUTH_TOKEN counts ONLY under the gateway conjunction', () => {
  const token = `sk-auth-${'x'.repeat(30)}-abcd`;
  // Against Anthropic's own API this is a rotating subscription credential — never fingerprinted.
  assert.deepEqual(collectKeys({ ANTHROPIC_AUTH_TOKEN: token }), []);
  assert.deepEqual(collectKeys({ ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_BASE_URL: 'https://api.anthropic.com/' }), []);
  const viaGateway = collectKeys({ ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_BASE_URL: 'https://gw.example.com' });
  assert.equal(viaGateway.length, 1);
  assert.equal(viaGateway[0].kind, CredentialKind.GATEWAY_TOKEN);
});

test('collectKeys — CLAUDE_CODE_OAUTH_TOKEN is a claude_oauth_token', () => {
  const keys = collectKeys({ CLAUDE_CODE_OAUTH_TOKEN: `sk-ant-oat01-${'y'.repeat(40)}` });
  assert.equal(keys.length, 1);
  assert.equal(keys[0].kind, CredentialKind.CLAUDE_OAUTH_TOKEN);
});

test('collectKeys — AWS_ACCESS_KEY_ID counts only when Bedrock is on, and the secret never does', () => {
  const id = 'AKIAIOSFODNN7EXAMPLE1234';
  const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  assert.deepEqual(collectKeys({ AWS_ACCESS_KEY_ID: id, AWS_SECRET_ACCESS_KEY: secret }), []);
  const keys = collectKeys({ CLAUDE_CODE_USE_BEDROCK: '1', AWS_ACCESS_KEY_ID: id, AWS_SECRET_ACCESS_KEY: secret });
  assert.equal(keys.length, 1);
  assert.equal(keys[0].kind, CredentialKind.AWS_BEDROCK);
  assert.equal(JSON.stringify(keys).includes(secret.slice(12, -4)), false, 'the AWS secret must never be read');
});

test('collectKeys — Vertex and Foundry contribute nothing (no stable env credential)', () => {
  assert.deepEqual(collectKeys({ CLAUDE_CODE_USE_VERTEX: '1', GOOGLE_APPLICATION_CREDENTIALS: '/path/to/adc.json' }), []);
  assert.deepEqual(collectKeys({ CLAUDE_CODE_USE_FOUNDRY: '1' }), []);
});

test('collectKeys — short values are dropped, not sent truncated', () => {
  assert.deepEqual(collectKeys({ ANTHROPIC_API_KEY: 'sk-ant-tiny', CLAUDE_CODE_OAUTH_TOKEN: '' }), []);
});

test('collectKeys — several kinds come back in a stable, deduped order', () => {
  const env = {
    CLAUDE_CODE_USE_BEDROCK: '1',
    AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE1234',
    ANTHROPIC_API_KEY: SECRET,
    CLAUDE_CODE_OAUTH_TOKEN: `sk-ant-oat01-${'y'.repeat(40)}`,
  };
  const kinds = collectKeys(env).map((k) => k.kind);
  assert.deepEqual(kinds, [CredentialKind.ANTHROPIC_API_KEY, CredentialKind.AWS_BEDROCK, CredentialKind.CLAUDE_OAUTH_TOKEN]);
  // Same env, keys reinserted in another order → identical result (hash stability).
  const reordered = collectKeys({
    ANTHROPIC_API_KEY: SECRET,
    CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN,
    AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID,
    CLAUDE_CODE_USE_BEDROCK: '1',
  });
  assert.deepEqual(reordered, collectKeys(env));
});

test('collectKeys — the same value under two names is reported once per kind', () => {
  // A gateway machine exporting the identical string as key and auth token.
  const keys = collectKeys({
    ANTHROPIC_BASE_URL: 'https://gw.example.com',
    ANTHROPIC_API_KEY: SECRET,
    ANTHROPIC_AUTH_TOKEN: SECRET,
  });
  assert.equal(keys.length, 1);
  assert.equal(keys[0].kind, CredentialKind.GATEWAY_TOKEN);
});

// ─── buildAccountSyncPayload ─────────────────────────────────────────────────

test('payload — an account_uuid anchor fills accountUuid and the stored accountEmail rides along', () => {
  // The uuid-anchored machine is exactly the one the server-side merge was starving on: it knew
  // the email locally but never sent it alongside the uuid.
  const p = buildAccountSyncPayload({ config: config(), env: {} });
  assert.equal(p.accountUuid, 'acc-uuid-1');
  assert.equal(p.email, 'dev@example.com');
  assert.equal(p.subscriptionType, 'max');
  assert.equal(p.rateLimitTier, 'default_claude_max_20x');
});

test('payload — an email anchor fills email (on-disk v2 config with no stored accountEmail)', () => {
  const p = buildAccountSyncPayload({
    config: config({ accountAnchor: { value: 'dev@example.com', source: 'email' }, accountEmail: null }),
    env: {},
  });
  assert.equal(p.email, 'dev@example.com');
  assert.equal('accountUuid' in p, false);
});

const OAUTH_TOKEN = `sk-ant-oat01-${'y'.repeat(40)}`;

test('payload — a fingerprintable CLAUDE_CODE_OAUTH_TOKEN replaces the stored uuid/email', () => {
  // The server anchors an account row on the fingerprint itself (Case C). Sending the stored pair
  // alongside would let it win the resolution — it is matched BEFORE the fingerprint — and on a
  // token machine that pair is routinely a previous login's leftovers.
  const p = buildAccountSyncPayload({
    config: config({ accountUuid: 'acc-uuid-1' }),
    env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN },
  });
  assert.equal('accountUuid' in p, false);
  assert.equal('email' in p, false);
  assert.equal(p.subscriptionType, 'max', 'the plan axis is untouched');
  assert.equal(p.rateLimitTier, 'default_claude_max_20x');
  assert.equal(p.keys.length, 1);
  assert.equal(p.keys[0].kind, CredentialKind.CLAUDE_OAUTH_TOKEN);
});

test('payload — a token too short to fingerprint suppresses nothing', () => {
  // Truthy but unidentifiable: the server would drop the key entry, so suppressing here would
  // trade a usable identity for none at all.
  const p = buildAccountSyncPayload({
    config: config({ accountUuid: 'acc-uuid-1' }),
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01' },
  });
  assert.equal(p.accountUuid, 'acc-uuid-1');
  assert.equal(p.email, 'dev@example.com');
  assert.equal('keys' in p, false);
});

test('payload — unexporting the token brings the stored identity back (suppression is not erasure)', () => {
  const stored = config({ accountUuid: 'acc-uuid-1' });
  const withToken = buildAccountSyncPayload({ config: stored, env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN } });
  assert.equal('accountUuid' in withToken, false);
  assert.equal(buildAccountSyncPayload({ config: stored, env: {} }).accountUuid, 'acc-uuid-1');
});

test('payload — a user_id anchor identifies NOTHING (opaque local hash, not a vendor id)', () => {
  const p = buildAccountSyncPayload({
    config: config({ accountAnchor: { value: 'aabbccdd-local-hash', source: 'user_id' }, accountEmail: null }),
    env: {},
  });
  assert.equal('accountUuid' in p, false);
  assert.equal('email' in p, false);
  assert.equal(p.subscriptionType, 'max', 'the tier is still known and still reported');
});

test('payload — a stored accountEmail identifies even under a user_id anchor', () => {
  const p = buildAccountSyncPayload({
    config: config({ accountAnchor: { value: 'aabbccdd-local-hash', source: 'user_id' } }),
    env: {},
  });
  assert.equal(p.email, 'dev@example.com');
  assert.equal('accountUuid' in p, false);
});

test('payload — a stored accountUuid rides along with an email anchor: BOTH identity fields', () => {
  // The server's Case A merge (uuid row absorbs the email provisional row, repoints sessions)
  // is only reachable when one payload presents the uuid — an email-only check-in and
  // uuid-only session reports otherwise never meet.
  const p = buildAccountSyncPayload({
    config: config({
      accountUuid: 'acc-uuid-1',
      accountAnchor: { value: 'dev@example.com', source: 'email' },
    }),
    env: {},
  });
  assert.equal(p.accountUuid, 'acc-uuid-1');
  assert.equal(p.email, 'dev@example.com');
});

test('payload — a stored accountUuid identifies even under a user_id anchor', () => {
  const p = buildAccountSyncPayload({
    config: config({
      accountUuid: 'acc-uuid-1',
      accountAnchor: { value: 'aabbccdd-local-hash', source: 'user_id' },
      accountEmail: null,
    }),
    env: {},
  });
  assert.equal(p.accountUuid, 'acc-uuid-1');
  assert.equal('email' in p, false);
});

test('payload — both identity fields stay inside the contract keys', () => {
  const p = buildAccountSyncPayload({
    config: config({
      accountUuid: 'acc-uuid-1',
      accountAnchor: { value: 'dev@example.com', source: 'email' },
    }),
    env: {},
  });
  assert.deepEqual(
    Object.keys(p).sort(),
    ['accountUuid', 'email', 'rateLimitTier', 'subscriptionType'],
  );
});

test('payload — carries ONLY the contract keys (an unknown key would 400 the check-in)', () => {
  const p = buildAccountSyncPayload({ config: config(), env: { ANTHROPIC_API_KEY: SECRET } });
  assert.deepEqual(
    Object.keys(p).sort(),
    ['accountUuid', 'email', 'keys', 'rateLimitTier', 'subscriptionType'],
  );
  assert.deepEqual(Object.keys(p.keys[0]).sort(), ['kind', 'last4', 'length', 'prefix']);
  // The server derives the plan itself — sending it would be rejected.
  assert.equal('subscriptionPlan' in p, false);
  assert.equal('plan' in p, false);
  assert.equal('source' in p, false);
});

test('payload — unknown is first-class: missing fields are omitted, not nulled', () => {
  const p = buildAccountSyncPayload({
    config: { version: 2, source: 'unknown', subscriptionType: null, rateLimitTier: null, accountAnchor: null },
    env: {},
  });
  assert.deepEqual(p, {});
  assert.equal(isEmptyPayload(p), true);
});

test('payload — no billing config at all still builds from the env alone', () => {
  const p = buildAccountSyncPayload({ config: null, env: { ANTHROPIC_API_KEY: SECRET } });
  assert.deepEqual(Object.keys(p), ['keys']);
  assert.equal(p.keys[0].kind, CredentialKind.ANTHROPIC_API_KEY);
});

test('payload — the whole serialized body never contains the middle of a key', () => {
  const p = buildAccountSyncPayload({
    config: config(),
    env: { ANTHROPIC_API_KEY: SECRET, CLAUDE_CODE_OAUTH_TOKEN: SECRET },
  });
  assert.equal(JSON.stringify(p).includes(MIDDLE), false);
});

// ─── payloadHash ─────────────────────────────────────────────────────────────

test('hash — identical payloads hash identically regardless of key insertion order', () => {
  const a = { accountUuid: 'u', subscriptionType: 'max', keys: [{ kind: 'anthropic_api_key', prefix: 'p', last4: 'l', length: 40 }] };
  const b = { keys: [{ length: 40, last4: 'l', prefix: 'p', kind: 'anthropic_api_key' }], subscriptionType: 'max', accountUuid: 'u' };
  assert.equal(payloadHash(a), payloadHash(b));
});

test('hash — any real change moves the digest', () => {
  const base = buildAccountSyncPayload({ config: config(), env: {} });
  const switched = buildAccountSyncPayload({
    config: config({ accountAnchor: { value: 'acc-uuid-2', source: 'account_uuid' } }),
    env: {},
  });
  assert.notEqual(payloadHash(base), payloadHash(switched));
  const emailChanged = buildAccountSyncPayload({ config: config({ accountEmail: 'other@example.com' }), env: {} });
  assert.notEqual(payloadHash(base), payloadHash(emailChanged));
  const withKey = buildAccountSyncPayload({ config: config(), env: { ANTHROPIC_API_KEY: SECRET } });
  assert.notEqual(payloadHash(base), payloadHash(withKey));
});

// ─── syncAccountIfNeeded — the trigger matrix ────────────────────────────────

test('sync — first call POSTs, second identical call does not', async () => {
  await withTempHome(async () => {
    const calls = [];
    const deps = { fetchImpl: okFetch(calls), readBillingConfig: () => config(), env: {} };
    const first = await syncAccountIfNeeded('tok', {}, deps);
    assert.equal(first.synced, true);
    const second = await syncAccountIfNeeded('tok', {}, deps);
    assert.equal(second.synced, false);
    assert.equal(second.reason, 'unchanged');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith('/me/cli-agent/account'));
    assert.equal(calls[0].headers['X-Beezi-Agent'], 'claude-code');
    assert.ok(String(calls[0].headers.Authorization).startsWith('Bearer '));
  });
});

test('sync — `via` is provenance only and never reaches the wire body', async () => {
  await withTempHome(async () => {
    const calls = [];
    await syncAccountIfNeeded('tok', { via: 'session-start' }, {
      fetchImpl: okFetch(calls),
      readBillingConfig: () => config(),
      env: {},
    });
    assert.equal('via' in calls[0].body, false);
    assert.deepEqual(Object.keys(calls[0].body).sort(), ['accountUuid', 'email', 'rateLimitTier', 'subscriptionType']);
  });
});

test('sync — force re-POSTs an unchanged payload', async () => {
  await withTempHome(async () => {
    const calls = [];
    const deps = { fetchImpl: okFetch(calls), readBillingConfig: () => config(), env: {} };
    await syncAccountIfNeeded('tok', {}, deps);
    const forced = await syncAccountIfNeeded('tok', { force: true }, deps);
    assert.equal(forced.synced, true);
    assert.equal(calls.length, 2);
  });
});

test('sync — a changed account POSTs without force (the switch path)', async () => {
  await withTempHome(async () => {
    const calls = [];
    const fetchImpl = okFetch(calls);
    await syncAccountIfNeeded('tok', {}, { fetchImpl, readBillingConfig: () => config(), env: {} });
    const res = await syncAccountIfNeeded('tok', {}, {
      fetchImpl,
      readBillingConfig: () => config({ accountAnchor: { value: 'acc-uuid-2', source: 'account_uuid' } }),
      env: {},
    });
    assert.equal(res.synced, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.accountUuid, 'acc-uuid-2');
  });
});

test('sync — an unchanged payload re-POSTs once the 7-day TTL lapses', async () => {
  await withTempHome(async () => {
    const calls = [];
    const base = { fetchImpl: okFetch(calls), readBillingConfig: () => config(), env: {} };
    const t0 = new Date('2026-08-01T00:00:00.000Z');
    await syncAccountIfNeeded('tok', {}, { ...base, now: t0 });
    const sixDays = new Date(t0.getTime() + 6 * 24 * 60 * 60 * 1000);
    assert.equal((await syncAccountIfNeeded('tok', {}, { ...base, now: sixDays })).synced, false);
    const eightDays = new Date(t0.getTime() + 8 * 24 * 60 * 60 * 1000);
    assert.equal((await syncAccountIfNeeded('tok', {}, { ...base, now: eightDays })).synced, true);
    assert.equal(calls.length, 2);
  });
});

test('sync — nothing known → no request at all', async () => {
  await withTempHome(async () => {
    const calls = [];
    const res = await syncAccountIfNeeded('tok', { force: true }, {
      fetchImpl: okFetch(calls),
      readBillingConfig: () => null,
      env: {},
    });
    assert.equal(res.synced, false);
    assert.equal(res.reason, 'nothing-known');
    assert.equal(calls.length, 0);
  });
});

test('sync — no token → no request, no state written', async () => {
  await withTempHome(async (dir) => {
    const calls = [];
    const res = await syncAccountIfNeeded(null, { force: true }, {
      fetchImpl: okFetch(calls),
      readBillingConfig: () => config(),
      env: {},
    });
    assert.equal(res.reason, 'no-token');
    assert.equal(calls.length, 0);
    assert.equal(fs.existsSync(path.join(dir, 'account-sync.json')), false);
  });
});

test('sync — the marker lives at the beeziHome ROOT, outside the pruned state/ dir', async () => {
  await withTempHome(async (dir) => {
    await syncAccountIfNeeded('tok', {}, { fetchImpl: okFetch([]), readBillingConfig: () => config(), env: {} });
    const marker = path.join(dir, 'account-sync.json');
    assert.ok(fs.existsSync(marker), 'account-sync.json must sit beside billing.json');
    const state = JSON.parse(fs.readFileSync(marker, 'utf-8'));
    assert.equal(state.version, 1);
    assert.equal(typeof state.lastSyncedHash, 'string');
    assert.ok(!Number.isNaN(Date.parse(state.lastSyncedAt)));
    // Nothing key-shaped is ever persisted.
    assert.equal(fs.readFileSync(marker, 'utf-8').includes(MIDDLE), false);
  });
});

test('sync — a non-2xx leaves the marker untouched so the next trigger retries', async () => {
  await withTempHome(async (dir) => {
    const calls = [];
    let status = 404;
    const deps = {
      fetchImpl: async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { status }; },
      readBillingConfig: () => config(),
      env: {},
    };
    const first = await syncAccountIfNeeded('tok', {}, deps);
    assert.equal(first.synced, false);
    assert.equal(first.status, 404);
    assert.equal(fs.existsSync(path.join(dir, 'account-sync.json')), false, 'a 404 must not seal the marker');
    status = 200;
    assert.equal((await syncAccountIfNeeded('tok', {}, deps)).synced, true);
    assert.equal(calls.length, 2);
  });
});

test('sync — a network failure never throws', async () => {
  await withTempHome(async () => {
    await assert.doesNotReject(async () => {
      const res = await syncAccountIfNeeded('tok', { force: true }, {
        fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
        readBillingConfig: () => config(),
        env: {},
      });
      assert.equal(res.synced, false);
      assert.equal(res.reason, 'network');
    });
  });
});

test('sync — a throwing billing reader degrades to the env-only payload', async () => {
  await withTempHome(async () => {
    const calls = [];
    const res = await syncAccountIfNeeded('tok', {}, {
      fetchImpl: okFetch(calls),
      readBillingConfig: () => { throw new Error('unreadable billing.json'); },
      env: { ANTHROPIC_API_KEY: SECRET },
    });
    assert.equal(res.synced, true);
    assert.deepEqual(Object.keys(calls[0].body), ['keys']);
  });
});

test('sync — an unwritable marker still reports the successful POST', async () => {
  await withTempHome(async () => {
    const calls = [];
    const res = await syncAccountIfNeeded('tok', {}, {
      fetchImpl: okFetch(calls),
      readBillingConfig: () => config(),
      env: {},
      writeJsonImpl: () => { throw new Error('EROFS'); },
    });
    assert.equal(res.synced, true);
  });
});

// ─── the shared suppression predicate ────────────────────────────────────────

// The check-in and the identity stamp must withhold the uuid and the email on the SAME answer.
// A machine whose check-in still carried an identity while its session reports carried only a
// fingerprint would hand the server something to resolve, and a credential's account binding is
// filled once and never moved — so the divergence is irreversible, not merely wrong.
const STORED_FINGERPRINT = { prefix: 'sk-ant-oat01', last4: 'yyyy', length: 53 };

// billing.json answers for the uuid, the email and the plan — never for which key is in force. Its
// stored fingerprint is stamped from the same probed env this payload resolves, so it names no
// token the env cannot see, and a disagreement is a stale record with no way out:
// shouldKeepExisting's key guard blocks the rewrite on the forced path too, and authModeReverted
// excuses selfReported records from the one escape. See oauth-identity.mjs.
test('payload — a stored fingerprint alone suppresses nothing', () => {
  const p = buildAccountSyncPayload({
    config: config({ accountUuid: 'acc-uuid-1', keyFingerprint: STORED_FINGERPRINT }),
    env: {},
  });
  assert.equal(p.accountUuid, 'acc-uuid-1');
  assert.equal(p.email, 'dev@example.com');
  assert.equal('keys' in p, false, 'a record is not a credential in force');
});

// The env is where the key in force is read, and the fingerprint it produces is what travels.
test('payload — the live token is what suppresses and what travels', () => {
  const p = buildAccountSyncPayload({
    config: config({ accountUuid: 'acc-uuid-1', keyFingerprint: STORED_FINGERPRINT }),
    env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN },
  });
  assert.equal('accountUuid' in p, false);
  assert.equal('email' in p, false);
  assert.equal(p.keys.length, 1);
  assert.deepEqual(p.keys[0], { kind: CredentialKind.CLAUDE_OAUTH_TOKEN, ...keyFingerprint(OAUTH_TOKEN) });
});

// The divergence this predicate exists to make unrepresentable, pinned across both modules.
test('the check-in and the identity stamp suppress on the same answer', async () => {
  const { buildIdentityStamp } = await import('../lib/identity-stamp.mjs');
  const cases = [
    { config: config({ accountUuid: 'acc-uuid-1' }), env: {} },
    { config: config({ accountUuid: 'acc-uuid-1' }), env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN } },
    { config: config({ accountUuid: 'acc-uuid-1', keyFingerprint: STORED_FINGERPRINT }), env: {} },
    { config: null, env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN } },
    { config: null, env: {} },
  ];
  for (const c of cases) {
    const payload = buildAccountSyncPayload(c);
    const stamp = buildIdentityStamp(null, c.config, c.env);
    assert.equal(
      'accountUuid' in payload,
      'account_uuid' in stamp,
      `uuid suppression disagrees for ${JSON.stringify(c.env)}`,
    );
    assert.equal('email' in payload, 'account_email' in stamp);
  }
});
