import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

function withHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-authrec-'));
  const prev = process.env.BEEZI_HOME;
  process.env.BEEZI_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_HOME; else process.env.BEEZI_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

let tag = 0;
async function load(grant = true) {
  const suffix = `?a${tag++}`;
  const consent = await import(`../lib/telemetry-consent.mjs${suffix}`);
  if (grant) consent.grantConsent();
  return {
    auth: await import(`../lib/telemetry-auth.mjs${suffix}`),
    states: await import(`../lib/auth-state.mjs${suffix}`),
    // No query string: this must be the SAME module instance telemetry-auth records through.
    telemetry: await import('../lib/telemetry.mjs'),
  };
}

const events = (home) => {
  const dir = path.join(home, 'telemetry');
  try {
    return fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  } catch { return []; }
};

test('a non-ready result is recorded with its state and its fixed reason', async (t) => {
  const home = withHome(t);
  const { auth, states } = await load();
  auth.recordAuthResult({ authState: states.AUTH_STATES.UNAVAILABLE, reason: states.AUTH_REASONS.REFRESH_TIMEOUT });
  const [event] = events(home);
  assert.equal(event.code, 'auth_state_changed');
  assert.equal(event.authState, 'unavailable');
  assert.equal(event.reason, 'refresh_timeout');
});

test('repeated missing-credential notices fold into one event', async (t) => {
  const home = withHome(t);
  const { auth, states } = await load();
  const unlinked = { authState: states.AUTH_STATES.UNLINKED, reason: states.AUTH_REASONS.NO_CREDENTIALS };
  for (let i = 0; i < 6; i++) auth.recordAuthResult(unlinked);
  const recorded = events(home);
  assert.equal(recorded.length, 1, 'every prompt must not produce another event');
  assert.equal(recorded[0].count, 6);
});

// The bug this prevents: `auth_state_changed` was recorded on every read, and the pending-file
// fold only spans the window between drains — so a permanently unlinked machine emitted a fresh
// event every minute, forever, through the route's shared rate-limit bucket.
test('a state that has not actually changed is not recorded again after the queue drains', async (t) => {
  const home = withHome(t);
  const { auth, states } = await load();
  const { recordLastAuthState } = await import('../lib/auth-markers.mjs?gate');
  const unlinked = { authState: states.AUTH_STATES.UNLINKED, reason: states.AUTH_REASONS.NO_CREDENTIALS };

  auth.recordAuthResult(unlinked);
  recordLastAuthState(unlinked.authState, unlinked.reason);   // what settle() does next
  fs.rmSync(path.join(home, 'telemetry'), { recursive: true, force: true }); // the drain
  auth.recordAuthResult(unlinked);

  assert.deepEqual(events(home), [], 'nothing changed, so there is nothing to report');

  // A genuine transition still reports.
  auth.recordAuthResult({ authState: states.AUTH_STATES.UNAVAILABLE, reason: states.AUTH_REASONS.LOCK_TIMEOUT });
  assert.equal(events(home).length, 1);
});

test('the normal ready result is silent, and the first ready after a failure is a recovery', async (t) => {
  const home = withHome(t);
  const { auth, states } = await load();
  auth.recordAuthResult({ authState: states.AUTH_STATES.READY, reason: states.AUTH_REASONS.OK });
  assert.deepEqual(events(home), [], 'normal traffic is not a diagnostic');
  auth.recordAuthResult({ authState: states.AUTH_STATES.READY, reason: states.AUTH_REASONS.RECOVERED });
  const [event] = events(home);
  assert.equal(event.code, 'auth_recovered');
  assert.equal(event.authState, 'ready');
  assert.equal(event.reason, 'recovered');
});

test('a migration conflict and an interrupted refresh get their own codes', async (t) => {
  const home = withHome(t);
  const { auth, states } = await load();
  auth.recordAuthResult({ authState: states.AUTH_STATES.UNAVAILABLE, reason: states.AUTH_REASONS.STORAGE_CONFLICT });
  auth.recordAuthResult({ authState: states.AUTH_STATES.UNAVAILABLE, reason: states.AUTH_REASONS.REFRESH_INTERRUPTED });
  const codes = events(home).map((e) => e.code).sort();
  assert.deepEqual(codes, ['credential_migration_conflict', 'refresh_interrupted']);
});

test('logout is the only emitter of logged_out, and names an unconfirmed unlink', async (t) => {
  const home = withHome(t);
  const { auth } = await load();
  auth.recordLogout();
  auth.recordLogoutUnconfirmed(403);
  const recorded = events(home);
  const out = recorded.find((e) => e.code === 'auth_state_changed');
  assert.equal(out.reason, 'logged_out');
  assert.equal(out.source, 'logout');
  const unconfirmed = recorded.find((e) => e.code === 'logout_unlink_unconfirmed');
  assert.equal(unconfirmed.httpStatus, 403);
  assert.equal(unconfirmed.reason, 'forbidden');
});

test('an interactive login failure carries its login reason', async (t) => {
  const home = withHome(t);
  const { auth, states } = await load();
  auth.recordLoginFailure(states.AUTH_REASONS.EXCHANGE_FAILED);
  const [event] = events(home);
  assert.equal(event.code, 'login_failed');
  assert.equal(event.source, 'login');
  assert.equal(event.reason, 'exchange_failed');
});

test('nothing is collected at all without consent', async (t) => {
  const home = withHome(t);
  const { auth, states } = await load(false);
  auth.recordAuthResult({ authState: states.AUTH_STATES.UNLINKED, reason: states.AUTH_REASONS.NO_CREDENTIALS });
  auth.recordLogout();
  auth.recordLoginFailure(states.AUTH_REASONS.LOGIN_CANCELLED);
  assert.deepEqual(events(home), []);
});

// Recursion protection: the diagnostics worker suppresses recording for its whole lifetime, so a
// failure while delivering diagnostics can never enqueue another diagnostic about it.
test('a failure inside the diagnostics path generates no further telemetry', async (t) => {
  const home = withHome(t);
  const { auth, states, telemetry } = await load();
  telemetry.suppressRecording(true);
  try {
    auth.recordAuthResult({ authState: states.AUTH_STATES.UNAVAILABLE, reason: states.AUTH_REASONS.REFRESH_TIMEOUT });
    auth.recordMcpStartupFailure(new Error('x'), null);
    assert.deepEqual(events(home), []);
  } finally {
    telemetry.suppressRecording(false);
  }
});

// A reason the API's enum does not know would be individually rejected and deleted, so it is
// dropped here instead of costing a round trip.
test('an unknown state or reason is dropped rather than sent', async (t) => {
  const home = withHome(t);
  const { auth } = await load();
  auth.recordAuthResult({ authState: 'made_up', reason: 'also_made_up' });
  const [event] = events(home);
  assert.equal(event.authState, null);
  assert.equal(event.reason, null);
});
