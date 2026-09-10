import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recordResolvedKeyPlan,
  resolvedPlanFrom,
  submittedPlanFrom,
  safePlan,
} from '../lib/plan-writeback.mjs';

// Everything here is pure dependency injection: readBillingConfig/writeBillingConfig are always
// supplied, so no test ever touches the developer's real ~/.beezi/billing.json.
function spyStore(existing = null) {
  const store = { existing, written: [] };
  store.deps = {
    readBillingConfig: () => store.existing,
    writeBillingConfig: (obj) => { store.written.push(obj); store.existing = obj; },
    now: new Date('2026-08-31T10:00:00.000Z'),
  };
  return store;
}

test('a resolved plan is written with its provenance and leaves the rest of the config alone', () => {
  const store = spyStore({
    version: 3,
    source: 'subscription',
    plan: 'max_20x',
    subscriptionType: 'max',
    rateLimitTier: 'default',
    selfReported: true,
    accountEmail: 'someone@example.com',
    capturedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(recordResolvedKeyPlan('pro', store.deps), true);
  assert.equal(store.written.length, 1);
  const wrote = store.written[0];
  assert.equal(wrote.plan, 'pro');
  assert.equal(wrote.planSource, 'key_resolution');
  assert.equal(wrote.planResolvedAt, '2026-08-31T10:00:00.000Z');
  // capturedAt is restamped on purpose: isStale() reads it, and a leftover date would make the very
  // next session start nudge for a refresh that just happened.
  assert.equal(wrote.capturedAt, '2026-08-31T10:00:00.000Z');
  // Untouched: the tier was never observed here, and identity is nobody's business but the
  // capture's.
  assert.equal(wrote.subscriptionType, 'max');
  assert.equal(wrote.rateLimitTier, 'default');
  assert.equal(wrote.selfReported, true);
  assert.equal(wrote.accountEmail, 'someone@example.com');
  assert.equal(wrote.source, 'subscription');
});

test('a machine with no billing.json at all still records the plan', () => {
  const store = spyStore(null);
  assert.equal(recordResolvedKeyPlan('team', store.deps), true);
  assert.equal(store.written[0].plan, 'team');
  assert.equal(store.written[0].planSource, 'key_resolution');
  assert.equal(typeof store.written[0].version, 'number');
});

test('nothing to record means nothing written', () => {
  for (const value of [null, undefined, '', '   ']) {
    const store = spyStore(null);
    assert.equal(recordResolvedKeyPlan(value, store.deps), false);
    assert.equal(store.written.length, 0);
  }
});

test('a token-shaped or over-long plan is refused, never persisted', () => {
  for (const value of [`sk-ant-oat01-${'y'.repeat(40)}`, 'max 20x', 'x'.repeat(65)]) {
    const store = spyStore(null);
    assert.equal(recordResolvedKeyPlan(value, store.deps), false);
    assert.equal(store.written.length, 0);
  }
  assert.equal(safePlan('pro'), 'pro');
  assert.equal(safePlan('  max_5x  '), 'max_5x');
});

test('a failing write never throws — the caller is a hook and a success line', () => {
  const deps = {
    readBillingConfig: () => ({ plan: 'pro' }),
    writeBillingConfig: () => { throw new Error('EACCES'); },
  };
  assert.equal(recordResolvedKeyPlan('max_5x', deps), false);
});

test('an unreadable config degrades to writing a fresh one rather than throwing', () => {
  const written = [];
  const deps = {
    readBillingConfig: () => { throw new Error('EACCES'); },
    writeBillingConfig: (obj) => written.push(obj),
  };
  assert.equal(recordResolvedKeyPlan('pro', deps), true);
  assert.equal(written[0].plan, 'pro');
});

test('only a resolved payload names a plan', () => {
  assert.equal(resolvedPlanFrom({ status: 'resolved', subscriptionPlan: 'max_20x' }), 'max_20x');
  assert.equal(resolvedPlanFrom({ status: 'resolved', subscriptionPlan: null }), null);
  assert.equal(resolvedPlanFrom({ status: 'unlinked', subscriptionPlan: 'pro' }), null);
  assert.equal(resolvedPlanFrom({ status: 'unknown_key', subscriptionPlan: 'pro' }), null);
  // The normalization fetchKeyResolution applies to a status this client does not recognize.
  assert.equal(resolvedPlanFrom({ status: null, subscriptionPlan: 'pro' }), null);
  assert.equal(resolvedPlanFrom(null), null);
});

test('only a successful submit names a plan, and a link without one names nothing', () => {
  // --plan success.
  assert.equal(submittedPlanFrom({ ok: true, subscriptionPlan: 'max_5x' }), 'max_5x');
  // --target success WITH a plan named by the server.
  assert.equal(
    submittedPlanFrom({ ok: true, outcome: 'linked', targetAccountId: 'acc_1', subscriptionPlan: 'team' }),
    'team',
  );
  // --target success WITHOUT one: a link is not a plan, and guessing would ship a fabricated tier.
  assert.equal(
    submittedPlanFrom({ ok: true, outcome: 'claimed', targetAccountId: null, subscriptionPlan: null }),
    null,
  );
  // Every refusal.
  assert.equal(submittedPlanFrom({ ok: false, message: 'nope', subscriptionPlan: 'pro' }), null);
  assert.equal(submittedPlanFrom(null), null);
});

test('the two selectors compose with the writer the way the entrypoint uses them', () => {
  const store = spyStore(null);
  recordResolvedKeyPlan(resolvedPlanFrom({ status: 'resolved', subscriptionPlan: 'max_20x' }), store.deps);
  recordResolvedKeyPlan(submittedPlanFrom({ ok: false, message: 'refused' }), store.deps);
  recordResolvedKeyPlan(submittedPlanFrom({ ok: true, outcome: 'linked', subscriptionPlan: null }), store.deps);
  assert.equal(store.written.length, 1);
  assert.equal(store.written[0].plan, 'max_20x');
});
