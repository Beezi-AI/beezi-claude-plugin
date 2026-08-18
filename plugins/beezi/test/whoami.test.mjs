import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whoami } from '../lib/whoami.mjs';

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
