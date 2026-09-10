import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whoami, probeIdentity, PROBE_OUTCOMES } from '../lib/whoami.mjs';

const deps = (fetchImpl) => ({ fetchImpl, base: 'https://api.test' });

test('whoami — 200 with body → valid with fields', async () => {
  const res = await whoami('tok', deps(async () => ({
    ok: true,
    json: async () => ({
      email: 'dev@acme.com',
      name: 'Dev Eloper',
      tenantTier: 'audit',
      trackingMode: 'backfill_only',
      backfillCompleted: false,
    }),
  })));
  assert.deepEqual(res, {
    valid: true,
    email: 'dev@acme.com',
    name: 'Dev Eloper',
    tenantTier: 'audit',
    trackingMode: 'backfill_only',
    backfillCompleted: false,
  });
});

test('whoami — 401 → { valid: false }', async () => {
  const res = await whoami('tok', deps(async () => ({ status: 401, ok: false })));
  assert.deepEqual(res, { valid: false });
});

test('whoami — 403 → { valid: false }', async () => {
  const res = await whoami('tok', deps(async () => ({ status: 403, ok: false })));
  assert.deepEqual(res, { valid: false });
});

test('whoami — other non-ok (500) → null', async () => {
  const res = await whoami('tok', deps(async () => ({ status: 500, ok: false })));
  assert.equal(res, null);
});

test('whoami — fetch throws (offline) → null', async () => {
  const res = await whoami('tok', deps(async () => { throw new Error('ECONNREFUSED'); }));
  assert.equal(res, null);
});

// A pre-audit server omits the policy fields — nulls mean "allow" everywhere downstream.
test('whoami — 200 but body missing fields → nulls', async () => {
  const res = await whoami('tok', deps(async () => ({ ok: true, json: async () => ({}) })));
  assert.deepEqual(res, {
    valid: true,
    email: null,
    name: null,
    tenantTier: null,
    trackingMode: null,
    backfillCompleted: false,
  });
});

test('whoami — sends bearer token to the whoami URL', async () => {
  let seen;
  await whoami('my-token', deps(async (url, opts) => {
    seen = { url, auth: opts?.headers?.Authorization };
    return { ok: true, json: async () => ({}) };
  }));
  assert.equal(seen.url, 'https://api.test/me/claude-code/whoami');
  assert.equal(seen.auth, 'Bearer my-token');
});

// Findings 1 and 2: collapsing 401, 403 and "could not verify" into one verdict is what let a
// permissions refusal and a verification outage look like a dead credential.
test('probeIdentity — 401 is unauthorized, 403 is forbidden, and both keep their status', async () => {
  const unauthorized = await probeIdentity('tok', deps(async () => ({ status: 401, ok: false })));
  assert.equal(unauthorized.outcome, PROBE_OUTCOMES.UNAUTHORIZED);
  assert.equal(unauthorized.httpStatus, 401);
  const forbidden = await probeIdentity('tok', deps(async () => ({ status: 403, ok: false })));
  assert.equal(forbidden.outcome, PROBE_OUTCOMES.FORBIDDEN);
  assert.equal(forbidden.httpStatus, 403);
});

test('probeIdentity — 503 OAUTH_VERIFICATION_UNAVAILABLE is unavailable, never invalid', async () => {
  const res = await probeIdentity('tok', deps(async () => ({
    status: 503, ok: false, json: async () => ({ code: 'OAUTH_VERIFICATION_UNAVAILABLE' }),
  })));
  assert.equal(res.outcome, PROBE_OUTCOMES.UNAVAILABLE);
  assert.equal(res.httpStatus, 503);
  assert.equal(res.verificationUnavailable, true);
});

test('probeIdentity — a transport failure is unavailable with no status', async () => {
  const res = await probeIdentity('tok', deps(async () => { throw new Error('ECONNREFUSED'); }));
  assert.equal(res.outcome, PROBE_OUTCOMES.UNAVAILABLE);
  assert.equal(res.httpStatus, null);
});

test('probeIdentity — 429 is unavailable and keeps its status', async () => {
  const res = await probeIdentity('tok', deps(async () => ({ status: 429, ok: false })));
  assert.equal(res.outcome, PROBE_OUTCOMES.UNAVAILABLE);
  assert.equal(res.httpStatus, 429);
  assert.notEqual(res.verificationUnavailable, true);
});

test('probeIdentity — 200 carries the identity fields', async () => {
  const res = await probeIdentity('tok', deps(async () => ({
    ok: true, status: 200, json: async () => ({ email: 'dev@acme.com', tenantTier: 'pro' }),
  })));
  assert.equal(res.outcome, PROBE_OUTCOMES.AUTHENTICATED);
  assert.equal(res.identity.email, 'dev@acme.com');
  assert.equal(res.identity.tenantTier, 'pro');
});

test('probeIdentity — a transport failure names probe_unreachable', async () => {
  const res = await probeIdentity('tok', deps(async () => { throw new Error('ECONNREFUSED'); }));
  assert.equal(res.outcome, PROBE_OUTCOMES.UNAVAILABLE);
  assert.equal(res.httpStatus, null);
  assert.equal(res.reason, 'probe_unreachable');
});

test('probeIdentity — an HTTP failure carries a status, so it carries no probe_unreachable', async () => {
  const res = await probeIdentity('tok', deps(async () => ({ status: 500, ok: false })));
  assert.equal(res.httpStatus, 500);
  assert.notEqual(res.reason, 'probe_unreachable');
});

// The reasons the evidence trail needs: a verification outage, a rate limit and an ordinary 5xx
// are indistinguishable afterwards if the probe throws the distinction away.
test('probeIdentity — 503 OAUTH_VERIFICATION_UNAVAILABLE carries verification_unavailable', async () => {
  const res = await probeIdentity('tok', deps(async () => ({
    status: 503, ok: false, json: async () => ({ code: 'OAUTH_VERIFICATION_UNAVAILABLE' }),
  })));
  assert.equal(res.reason, 'verification_unavailable');
});

test('probeIdentity — 429 carries rate_limited', async () => {
  const res = await probeIdentity('tok', deps(async () => ({ status: 429, ok: false })));
  assert.equal(res.reason, 'rate_limited');
});

test('probeIdentity — an ordinary 5xx carries no reason of its own', async () => {
  const res = await probeIdentity('tok', deps(async () => ({ status: 502, ok: false })));
  assert.equal(res.reason, null);
});

test('probeIdentity — 401 and 403 name their own verdicts', async () => {
  assert.equal((await probeIdentity('t', deps(async () => ({ status: 401, ok: false })))).reason, 'unauthorized');
  assert.equal((await probeIdentity('t', deps(async () => ({ status: 403, ok: false })))).reason, 'forbidden');
});
