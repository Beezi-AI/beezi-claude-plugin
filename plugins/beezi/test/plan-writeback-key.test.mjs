import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recordResolvedKeyData,
  resolvedKeyDataFrom,
  safeEmail,
} from '../lib/plan-writeback.mjs';

// The full adoption: everything the portal knows about one key, written into the file the session
// reports read. Pure dependency injection throughout — no test here touches a real ~/.beezi.

function spyStore(existing = null) {
  const store = { existing, written: [] };
  store.deps = {
    readBillingConfig: () => store.existing,
    writeBillingConfig: (obj) => { store.written.push(obj); store.existing = obj; },
    now: new Date('2026-08-31T10:00:00.000Z'),
  };
  return store;
}

const FINGERPRINT = Object.freeze({ prefix: 'sk-ant-oat01', last4: 'UQAA', length: 108 });

const FULL_ANSWER = Object.freeze({
  subscriptionPlan: 'max_20x',
  subscriptionType: 'max',
  rateLimitTier: 'default_claude_max_20x',
  accountEmail: 'ci@example.com',
  fingerprint: FINGERPRINT,
});

test('the whole answer is adopted, scoped to the key it was resolved for', () => {
  // A record the transition reset moments earlier: it knows which key it belongs to and nothing else.
  const store = spyStore({ version: 4, source: 'subscription', plan: null, planSource: 'unresolved' });
  assert.equal(recordResolvedKeyData(FULL_ANSWER, store.deps), true);

  const written = store.written[0];
  assert.equal(written.plan, 'max_20x');
  // The three fields a setup-token machine cannot read locally at all — without them the record
  // stays half-filled with whatever a previous interactive login left behind.
  assert.equal(written.subscriptionType, 'max');
  assert.equal(written.rateLimitTier, 'default_claude_max_20x');
  assert.equal(written.accountEmail, 'ci@example.com');
  // The scope. A rotation must not inherit this answer.
  assert.deepEqual(written.keyFingerprint, FINGERPRINT);
  assert.equal(written.planSource, 'key_resolution');
  assert.equal(written.planResolvedAt, '2026-08-31T10:00:00.000Z');
  assert.equal(written.capturedAt, '2026-08-31T10:00:00.000Z');
});

test('an older API that names only the plan still adopts, and nulls nothing it did not mention', () => {
  // Forward compatibility runs both ways: a new plugin against a server that has not shipped the
  // extra fields must not wipe the record down to the one field it heard about. This is an
  // adoption, not a reset — the reset already happened, in billing-capture.
  const store = spyStore({
    version: 4,
    plan: 'team',
    subscriptionType: 'team',
    rateLimitTier: 'default_raven',
    accountEmail: 'kept@example.com',
    keyFingerprint: FINGERPRINT,
  });
  assert.equal(recordResolvedKeyData({ subscriptionPlan: 'max_20x' }, store.deps), true);

  const written = store.written[0];
  assert.equal(written.plan, 'max_20x');
  assert.equal(written.subscriptionType, 'team');
  assert.equal(written.rateLimitTier, 'default_raven');
  assert.equal(written.accountEmail, 'kept@example.com');
  assert.deepEqual(written.keyFingerprint, FINGERPRINT);
});

test('no plan means no write at all — the trimmings alone are not an answer', () => {
  // Restamping capturedAt on a record nothing improved would reset the staleness clock and hide a
  // record that genuinely needs re-reading.
  const store = spyStore({ version: 4, plan: 'team' });
  assert.equal(recordResolvedKeyData({ subscriptionType: 'max', accountEmail: 'a@b.co' }, store.deps), false);
  assert.equal(store.written.length, 0);
});

test('a key-resolution payload is adopted from its `key` field', () => {
  // fetchKeyResolution names the fingerprint `key`; fetchOauthKeyStatus names it `fingerprint`.
  // Both shapes reach this function, and both must scope the plan.
  const store = spyStore(null);
  recordResolvedKeyData({ subscriptionPlan: 'pro', key: FINGERPRINT }, store.deps);
  assert.deepEqual(store.written[0].keyFingerprint, FINGERPRINT);
});

test('a malformed fingerprint reads as "not stated" rather than being written through', () => {
  const store = spyStore(null);
  recordResolvedKeyData({ subscriptionPlan: 'pro', fingerprint: { prefix: 'sk-ant-oat01' } }, store.deps);
  assert.equal(store.written[0].keyFingerprint, undefined);
});

test('safeEmail accepts a real-length address but still refuses anything token-shaped', () => {
  // safePlan's 64-char cap would throw away a legitimate address — real ones run to 254.
  const long = `${'a'.repeat(240)}@example.com`;
  assert.equal(safeEmail(long), long);
  assert.equal(safeEmail('sk-ant-oat01-secret'), null, 'nothing credential-looking reaches billing.json');
  assert.equal(safeEmail('has space@example.com'), null);
  assert.equal(safeEmail(`${'a'.repeat(400)}@example.com`), null);
  assert.equal(safeEmail(null), null);
});

test('the email sanitizer guards the adoption path too', () => {
  const store = spyStore(null);
  recordResolvedKeyData({ subscriptionPlan: 'pro', accountEmail: 'sk-ant-oat01-leak' }, store.deps);
  assert.equal(store.written[0].accountEmail, undefined);
});

test('resolvedKeyDataFrom gates on `resolved`, exactly like the plan-only reader', () => {
  const payload = { status: 'resolved', subscriptionPlan: 'team' };
  assert.equal(resolvedKeyDataFrom(payload), payload);
  // 'unlinked' and 'unknown_key' are the server saying it has no answer — not an answer to adopt.
  assert.equal(resolvedKeyDataFrom({ status: 'unlinked', subscriptionPlan: 'team' }), null);
  assert.equal(resolvedKeyDataFrom({ status: 'unknown_key' }), null);
  assert.equal(resolvedKeyDataFrom(null), null);
});

test('an unwritable store is reported, never thrown — the caller is a hook', () => {
  const deps = {
    readBillingConfig: () => { throw new Error('unreadable'); },
    writeBillingConfig: () => { throw new Error('read-only home'); },
    now: new Date('2026-08-31T10:00:00.000Z'),
  };
  assert.equal(recordResolvedKeyData(FULL_ANSWER, deps), false);
});
