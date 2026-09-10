import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { markAsked } from '../lib/telemetry-consent.mjs';
import { runSessionStart } from '../lib/session-start.mjs';

// The update nudge is appended at all three of runSessionStart's return points. These tests drive
// that wiring through `deps.checkForUpdate` only — lib/update-check.mjs itself is covered by
// test/update-check.test.mjs.
//
// Every call below passes `env: {}` explicitly: runSessionStart's env resolution otherwise ends in
// an OS-environment probe that spawns and reads the developer's own machine. There is no local
// wrapper in this file to do it for us.

const NUDGE = 'Beezi: a newer beezi is published — 0.19.0 → 0.20.0. Run: claude plugin marketplace '
  + 'update beezi, then claude plugin update beezi@beezi — then restart Claude Code to apply it.';

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-update-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setHome(dir) {
  process.env.BEEZI_HOME = dir;
  // These tests assert on exact message strings, and the one-time consent ask would bleed into
  // them. Stamp it as already asked — except in the test that deliberately checks ordering
  // against it, which uses a fresh home and does not call this.
  markAsked();
}

function fakeGit(remote) {
  return () => remote;
}

function baseInput(overrides = {}) {
  return { session_id: 'test-session', cwd: '/some/path', ...overrides };
}

function routedFetch({ who = {}, repo = { connected: false } } = {}) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (String(url).includes('/whoami')) return { ok: true, status: 200, json: async () => who };
    return { ok: true, status: 200, json: async () => repo };
  };
  return { impl, calls };
}

// Billing resolves on every session start and appends its own nudge when it cannot tell how the
// machine bills. Pin it quiet so it can't bleed into the expected strings.
const quietBilling = {
  resolveSource: () => 'subscription',
  readBillingConfig: () => ({
    source: 'subscription',
    plan: 'pro',
    capturedAt: new Date().toISOString(),
    anchorCheckedAt: new Date(Date.now() - 60_000).toISOString(),
  }),
  isStale: () => false,
  resolveClaudeSubscription: () => null,
  readClaudeAccountAnchor: () => null,
};

// ─── the three return points ─────────────────────────────────────────────────

test('1. nudge is appended after the "not linked" early return', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const result = await runSessionStart(baseInput({ session_id: 'sess-u-notoken' }), {
    env: {},
    getAccessToken: async () => null,
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
    gitImpl: fakeGit('https://host/repo.git'),
    checkForUpdate: async () => NUDGE,
  });

  assert.equal(
    result,
    '⚠ Beezi: this machine is not linked — analytics are NOT being tracked. Run /beezi:login to link it.'
      + '\n' + NUDGE,
  );
});

test('2. nudge is appended after the rejected-token early return', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const fetchImpl = async (url) => {
    if (String(url).includes('/me/claude-code/whoami')) return { status: 401, ok: false };
    return { ok: true, json: async () => ({ connected: false }) };
  };

  const result = await runSessionStart(baseInput({ session_id: 'sess-u-rejected' }), {
    env: {},
    getAccessToken: async () => 'tok',
    ...quietBilling,
    deleteCredentials: async () => {},
    fetchImpl,
    gitImpl: fakeGit('https://host/repo.git'),
    checkForUpdate: async () => NUDGE,
  });

  assert.equal(
    result,
    '⚠ Beezi: this machine’s link was rejected — analytics are NOT being tracked. Run /beezi:login to authorize it again.'
      + '\n' + NUDGE,
  );
});

test('3. nudge is appended last on the normal path, after the repo line', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);
  const fetch = routedFetch({
    who: { email: 'dev@acme.com', name: 'Dev' },
    repo: { connected: true, projectName: 'Acme' },
  });

  const result = await runSessionStart(baseInput({ session_id: 'sess-u-normal' }), {
    env: {},
    getAccessToken: async () => 'tok',
    ...quietBilling,
    fetchImpl: fetch.impl,
    gitImpl: fakeGit('https://host/repo.git'),
    checkForUpdate: async () => NUDGE,
  });

  assert.equal(
    result,
    'Beezi: repo connected to "Acme". Task-branch sessions will be tracked.\n' + NUDGE,
  );
});

test('4. nudge lands after the one-time consent ask, not before it', async (t) => {
  const dir = makeTmpDir(t);
  // Deliberately NOT setHome() — a fresh BEEZI_HOME means consent has not been asked yet, so the
  // ask fires and the nudge must still come last.
  process.env.BEEZI_HOME = dir;
  const fetch = routedFetch({
    who: { email: 'dev@acme.com', name: 'Dev' },
    repo: { connected: true, projectName: 'Acme' },
  });

  const result = await runSessionStart(baseInput({ session_id: 'sess-u-consent' }), {
    env: {},
    getAccessToken: async () => 'tok',
    ...quietBilling,
    fetchImpl: fetch.impl,
    gitImpl: fakeGit('https://host/repo.git'),
    checkForUpdate: async () => NUDGE,
  });

  const lines = String(result).split('\n');
  assert.equal(lines[lines.length - 1], NUDGE, 'the nudge must be the final line');
  assert.ok(
    lines.some(l => l.includes('/beezi:telemetry on')),
    'the consent ask must still be present, above the nudge',
  );
});

// ─── silence and failure ─────────────────────────────────────────────────────

test('5. returning null leaves every message byte-identical', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);
  const fetch = routedFetch({
    who: { email: 'dev@acme.com', name: 'Dev' },
    repo: { connected: true, projectName: 'Acme' },
  });

  const result = await runSessionStart(baseInput({ session_id: 'sess-u-null' }), {
    env: {},
    getAccessToken: async () => 'tok',
    ...quietBilling,
    fetchImpl: fetch.impl,
    gitImpl: fakeGit('https://host/repo.git'),
    checkForUpdate: async () => null,
  });

  assert.equal(result, 'Beezi: repo connected to "Acme". Task-branch sessions will be tracked.');
});

test('6. a throwing check does not break session start and never surfaces as an unhandledRejection', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const unhandled = [];
  const onUnhandled = (reason) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.removeListener('unhandledRejection', onUnhandled));

  const fetch = routedFetch({
    who: { email: 'dev@acme.com', name: 'Dev' },
    repo: { connected: true, projectName: 'Acme' },
  });

  const result = await runSessionStart(baseInput({ session_id: 'sess-u-throw' }), {
    env: {},
    getAccessToken: async () => 'tok',
    ...quietBilling,
    fetchImpl: fetch.impl,
    gitImpl: fakeGit('https://host/repo.git'),
    checkForUpdate: async () => { throw new Error('boom'); },
  });

  assert.equal(result, 'Beezi: repo connected to "Acme". Task-branch sessions will be tracked.');

  // The .catch() is attached where the promise is created, so the rejection is settled long before
  // the await. Give the loop a turn to prove nothing escaped.
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(unhandled, [], 'a throwing update check must not produce an unhandledRejection');
});

test('7. a synchronously throwing check is caught too', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const result = await runSessionStart(baseInput({ session_id: 'sess-u-syncthrow' }), {
    env: {},
    getAccessToken: async () => null,
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
    gitImpl: fakeGit('https://host/repo.git'),
    checkForUpdate: () => { throw new Error('sync boom'); },
  });

  assert.equal(
    result,
    '⚠ Beezi: this machine is not linked — analytics are NOT being tracked. Run /beezi:login to link it.',
  );
});

// ─── it is not behind any gate ───────────────────────────────────────────────

test('8. called exactly once per session start', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);
  const fetch = routedFetch({
    who: { email: 'dev@acme.com', name: 'Dev' },
    repo: { connected: true, projectName: 'Acme' },
  });

  let calls = 0;
  await runSessionStart(baseInput({ session_id: 'sess-u-once' }), {
    env: {},
    getAccessToken: async () => 'tok',
    ...quietBilling,
    fetchImpl: fetch.impl,
    gitImpl: fakeGit('https://host/repo.git'),
    checkForUpdate: async () => { calls += 1; return null; },
  });

  assert.equal(calls, 1, 'the check must run exactly once, not once per return point');
});

test('9. still called with tracking disabled — the check is not behind the liveAllowed gate', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);
  const fetch = routedFetch({
    who: { tenantTier: 'pro', trackingMode: 'disabled' },
    repo: { connected: true, projectName: 'Acme' },
  });

  let calls = 0;
  const result = await runSessionStart(baseInput({ session_id: 'sess-u-disabled' }), {
    env: {},
    getAccessToken: async () => 'tok',
    ...quietBilling,
    fetchImpl: fetch.impl,
    gitImpl: fakeGit('https://host/repo.git'),
    checkForUpdate: async () => { calls += 1; return NUDGE; },
  });

  assert.equal(calls, 1, 'a workspace with analytics off must still learn its plugin is stale');
  assert.equal(String(result).split('\n').pop(), NUDGE);
});

test('10. still called on the no-token path — not behind the credential check', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  let calls = 0;
  await runSessionStart(baseInput({ session_id: 'sess-u-notoken-count' }), {
    env: {},
    getAccessToken: async () => null,
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
    gitImpl: fakeGit('https://host/repo.git'),
    checkForUpdate: async () => { calls += 1; return null; },
  });

  assert.equal(calls, 1, 'an unlinked machine is exactly the one that may need the newer build');
});

// ─── the security guarantee ──────────────────────────────────────────────────

test('11. the check is not handed runSessionStart\'s authenticated fetchImpl', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);
  const fetch = routedFetch({
    who: { email: 'dev@acme.com', name: 'Dev' },
    repo: { connected: true, projectName: 'Acme' },
  });

  let receivedArgs = null;
  await runSessionStart(baseInput({ session_id: 'sess-u-nofetch' }), {
    env: {},
    getAccessToken: async () => 'tok',
    ...quietBilling,
    fetchImpl: fetch.impl,
    gitImpl: fakeGit('https://host/repo.git'),
    checkForUpdate: async (...args) => { receivedArgs = args; return null; },
  });

  // Called with no arguments at all: the Beezi bearer token can never reach github.com because
  // there is nothing to leak it through. update-check resolves its own unauthenticated fetch.
  assert.deepEqual(receivedArgs, [], 'checkForUpdate must be invoked with no deps of ours');
});
