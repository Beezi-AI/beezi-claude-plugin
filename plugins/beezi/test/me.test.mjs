import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMe } from '../lib/me.mjs';
import { PROBE_OUTCOMES } from '../lib/whoami.mjs';

const auth = (authState, reason, accessToken = null) => async () => ({ authState, reason, accessToken });
const probe = (outcome, extra = {}) => async () => ({ outcome, httpStatus: null, identity: null, ...extra });

test('me — a linked machine prints its account', async () => {
  const lines = await runMe({
    getAuthentication: auth('ready', 'ok', 'tok'),
    probeIdentity: probe(PROBE_OUTCOMES.AUTHENTICATED, {
      identity: { name: 'Dev', email: 'dev@acme.com', tenantTier: 'pro', trackingMode: 'live', backfillCompleted: true },
    }),
  });
  assert.match(lines[0], /this machine is linked/);
  assert.match(lines.join('\n'), /dev@acme\.com/);
});

// finding 6: only a missing authorization is "not linked".
test('me — a temporary failure never says not linked', async () => {
  const lines = await runMe({
    getAuthentication: auth('unavailable', 'refresh_network_error'),
    probeIdentity: probe(PROBE_OUTCOMES.AUTHENTICATED),
  });
  const text = lines.join('\n');
  assert.doesNotMatch(text, /not linked/);
  assert.match(text, /still linked/);
  assert.match(text, /nothing was removed/);
});

test('me — a refresh in flight says to try again in a moment', async () => {
  const lines = await runMe({ getAuthentication: auth('refreshing', 'refresh_in_progress') });
  assert.match(lines.join('\n'), /being renewed/);
  assert.doesNotMatch(lines.join('\n'), /not linked/);
});

test('me — only a missing authorization is not linked', async () => {
  const lines = await runMe({ getAuthentication: auth('unlinked', 'no_credentials') });
  assert.match(lines[0], /not linked/);
});

test('me — a rejected grant asks for reauthorization and says nothing was removed', async () => {
  const lines = await runMe({ getAuthentication: auth('reauth_required', 'invalid_grant') });
  const text = lines.join('\n');
  assert.match(text, /\/beezi:login/);
  assert.match(text, /still on this machine/);
});

// findings 1, 2: a permission refusal and a verification outage are not dead credentials, and
// neither is a reason to spend a refresh grant.
test('me — 403 describes missing permission and never refreshes', async () => {
  let refreshes = 0;
  const lines = await runMe({
    getAuthentication: async (_d, options) => {
      if (options && options.forceRefresh) refreshes += 1;
      return { authState: 'ready', reason: 'ok', accessToken: 'tok' };
    },
    probeIdentity: probe(PROBE_OUTCOMES.FORBIDDEN, { httpStatus: 403 }),
  });
  assert.match(lines.join('\n'), /administrator/);
  assert.doesNotMatch(lines.join('\n'), /not linked/);
  assert.equal(refreshes, 0);
});

test('me — 503 OAUTH_VERIFICATION_UNAVAILABLE is a check we could not run', async () => {
  let refreshes = 0;
  const lines = await runMe({
    getAuthentication: async (_d, options) => {
      if (options && options.forceRefresh) refreshes += 1;
      return { authState: 'ready', reason: 'ok', accessToken: 'tok' };
    },
    probeIdentity: probe(PROBE_OUTCOMES.UNAVAILABLE, { httpStatus: 503, verificationUnavailable: true }),
  });
  assert.match(lines.join('\n'), /could not check/);
  assert.match(lines.join('\n'), /Nothing is wrong/);
  assert.equal(refreshes, 0);
});

test('me — a 401 is retried exactly once behind a forced refresh', async () => {
  let refreshes = 0;
  const outcomes = [PROBE_OUTCOMES.UNAUTHORIZED, PROBE_OUTCOMES.AUTHENTICATED];
  const lines = await runMe({
    getAuthentication: async (_d, options) => {
      if (options && options.forceRefresh) refreshes += 1;
      return { authState: 'ready', reason: 'ok', accessToken: 'tok' };
    },
    probeIdentity: async () => ({
      outcome: outcomes.shift(), httpStatus: null, identity: { name: null, email: null },
    }),
  });
  assert.equal(refreshes, 1);
  assert.match(lines[0], /this machine is linked/);
});

// The three reasons that existed in the vocabulary but never travelled.
test('me — a verification outage and a rate limit reach the evidence trail', async () => {
  for (const [reason, extra] of [
    ['verification_unavailable', { httpStatus: 503, verificationUnavailable: true }],
    ['rate_limited', { httpStatus: 429 }],
  ]) {
    const recorded = [];
    await runMe({
      getAuthentication: auth('ready', 'ok', 'tok'),
      probeIdentity: probe(PROBE_OUTCOMES.UNAVAILABLE, { reason, ...extra }),
      recordAuthResult: (result, opts) => { recorded.push({ ...result, ...opts }); return true; },
    });
    assert.equal(recorded.length, 1, reason);
    assert.equal(recorded[0].authState, 'unavailable');
    assert.equal(recorded[0].reason, reason);
    assert.equal(recorded[0].source, 'me');
  }
});

test('me — a 403 records forbidden', async () => {
  const recorded = [];
  await runMe({
    getAuthentication: auth('ready', 'ok', 'tok'),
    probeIdentity: probe(PROBE_OUTCOMES.FORBIDDEN, { httpStatus: 403, reason: 'forbidden' }),
    recordAuthResult: (result) => { recorded.push(result); return true; },
  });
  assert.equal(recorded[0].reason, 'forbidden');
});
