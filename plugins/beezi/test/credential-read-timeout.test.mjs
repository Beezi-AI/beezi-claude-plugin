import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readCredentials, commitCredentials, CREDENTIAL_STATUS, UNAVAILABLE_REASONS,
} from '../lib/credentials.mjs';
import { acquireCredentialLock, releaseCredentialLock } from '../lib/credential-lock.mjs';
import { backendByName } from '../lib/credential-backends.mjs';
import { credentialService } from '../lib/paths.mjs';
import { getAuthentication, INTERACTIVE_REFRESH_WAIT_MS } from '../lib/token.mjs';
import { AUTH_STATES, AUTH_REASONS } from '../lib/auth-state.mjs';

// A Windows read costs a PowerShell spawn (~1.1s of startup before it runs anything), and two
// Beezi processes reading at once already take ~4.2s against the 5s spawn cap. Every tool call
// fires this plugin's hooks — twice over when a second Beezi variant is installed — so losing
// that race is ordinary. These tests pin the rule it broke: a read that was KILLED for being
// slow must never be reported as a credential that is GONE.

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'credread-'));
  const prev = process.env.BEEZI_HOME;
  process.env.BEEZI_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_HOME;
    else process.env.BEEZI_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const creds = (accessToken) => ({
  client_id: 'cid',
  redirect_uri: 'http://127.0.0.1:49152/callback',
  token_endpoint: 'https://clerk.example.com/oauth/token',
  access_token: accessToken,
  refresh_token: 'rt',
  expires_at: Date.now() + 3600_000,
});

// An in-memory stand-in for the Windows Credential Manager, driven through the same PowerShell
// scripts the real backend emits — `plan` says how many consecutive reads get killed first.
function winRun(store, plan) {
  return (file, args, input) => {
    const script = args[args.length - 1];
    const write = /\$c\.TargetName='([^']+)'/.exec(script);
    if (write) { store.set(write[1], input); return { ok: true, stdout: 'OK' }; }
    const read = /CredRead\('([^']+)'/.exec(script);
    if (read) {
      if (plan.timeouts > 0) { plan.timeouts -= 1; return { ok: false, stdout: '', timedOut: true }; }
      plan.reads += 1;
      const value = store.get(read[1]);
      return value == null ? { ok: false, stdout: '' } : { ok: true, stdout: value };
    }
    const del = /CredDelete\('([^']+)'/.exec(script);
    if (del) { store.delete(del[1]); return { ok: true, stdout: '' }; }
    return { ok: false, stdout: '' };
  };
}

function winDeps(store, plan) {
  return { platform: 'win32', run: winRun(store, plan) };
}

async function seed(deps, accessToken) {
  const lock = await acquireCredentialLock({ waitMs: 1000 }, deps);
  assert.ok(lock, 'expected to take the credential lock');
  try {
    const r = await commitCredentials(creds(accessToken), { lock, force: true }, deps);
    assert.equal(r.status, 'committed');
    assert.equal(r.backend, 'credential-manager');
  } finally {
    releaseCredentialLock(lock);
  }
}

test('an interactive caller retries a killed read instead of reporting it missing', async (t) => {
  tmpHome(t);
  const store = new Map();
  const plan = { timeouts: 0, reads: 0 };
  const deps = { ...winDeps(store, plan), sleepImpl: async () => {} };
  await seed(deps, 'tok-retry');

  plan.timeouts = 1; // the first attempt loses the race, the retry wins
  const r = await readCredentials(deps, { interactive: true });

  assert.equal(r.status, CREDENTIAL_STATUS.READY);
  assert.equal(r.credentials.access_token, 'tok-retry');
});

test('a hook does NOT retry — a second attempt would spend its whole 10s budget', async (t) => {
  tmpHome(t);
  const store = new Map();
  const plan = { timeouts: 0, reads: 0 };
  const deps = winDeps(store, plan);
  await seed(deps, 'tok-noretry');

  plan.timeouts = 1; // a retry would have succeeded; the default must not take it
  const r = await readCredentials(deps);

  assert.equal(r.status, CREDENTIAL_STATUS.UNAVAILABLE);
  assert.equal(r.reason, UNAVAILABLE_REASONS.BACKEND_TIMEOUT);
  assert.equal(plan.timeouts, 0, 'exactly one attempt was made');
});

test('the retry waits a jittered moment so readers killed together do not pile up again', async (t) => {
  tmpHome(t);
  const store = new Map();
  const plan = { timeouts: 0, reads: 0 };
  const waits = [];
  const deps = {
    ...winDeps(store, plan),
    sleepImpl: async (ms) => { waits.push(ms); },
    randomImpl: () => 0.5,
  };
  await seed(deps, 'tok-jitter');

  plan.timeouts = 1;
  await readCredentials(deps, { interactive: true });

  assert.equal(waits.length, 1);
  assert.ok(waits[0] >= 150 && waits[0] <= 750, `unexpected pause ${waits[0]}ms`);
});

test('a read that keeps timing out reports a timeout, never "no credentials"', async (t) => {
  tmpHome(t);
  const store = new Map();
  const plan = { timeouts: 0, reads: 0 };
  const deps = winDeps(store, plan);
  await seed(deps, 'tok-timeout');

  plan.timeouts = 99;
  const r = await readCredentials(deps);

  assert.equal(r.status, CREDENTIAL_STATUS.UNAVAILABLE);
  assert.equal(r.reason, UNAVAILABLE_REASONS.BACKEND_TIMEOUT);
  assert.notEqual(r.status, CREDENTIAL_STATUS.NONE);
});

test('an entry the store really does not hold still reads as unreadable, not as a timeout', async (t) => {
  tmpHome(t);
  const store = new Map();
  const plan = { timeouts: 0, reads: 0 };
  const deps = winDeps(store, plan);
  await seed(deps, 'tok-gone');

  store.clear(); // the entry is genuinely absent — an answered "no", not a killed read
  const r = await readCredentials(deps);

  assert.equal(r.status, CREDENTIAL_STATUS.UNAVAILABLE);
  assert.equal(r.reason, UNAVAILABLE_REASONS.BACKEND_UNREADABLE);
});

test('an answered read is never retried — the retry is only for a killed one', async (t) => {
  tmpHome(t);
  const store = new Map();
  const plan = { timeouts: 0, reads: 0 };
  const deps = winDeps(store, plan);
  await seed(deps, 'tok-once');

  plan.reads = 0;
  await readCredentials(deps);

  assert.equal(plan.reads, 1);
});

test('getAuthentication reports a slow store as unavailable, never as unlinked', async (t) => {
  tmpHome(t);
  const store = new Map();
  const plan = { timeouts: 0, reads: 0 };
  const deps = winDeps(store, plan);
  await seed(deps, 'tok-auth');

  plan.timeouts = 99;
  const auth = await getAuthentication(deps);

  assert.equal(auth.authState, AUTH_STATES.UNAVAILABLE);
  assert.equal(auth.reason, AUTH_REASONS.STORAGE_TIMEOUT);
  assert.notEqual(auth.authState, AUTH_STATES.UNLINKED);
});

test('an interactive waitMs buys the store read its retry; the hook default does not', async (t) => {
  tmpHome(t);
  const store = new Map();
  const plan = { timeouts: 0, reads: 0 };
  const deps = { ...winDeps(store, plan), sleepImpl: async () => {} };
  await seed(deps, 'tok-budget');

  plan.timeouts = 1;
  const hook = await getAuthentication(deps);
  assert.equal(hook.authState, AUTH_STATES.UNAVAILABLE, 'hook fails fast on the first kill');

  plan.timeouts = 1;
  const interactive = await getAuthentication(deps, { waitMs: INTERACTIVE_REFRESH_WAIT_MS });
  assert.equal(interactive.authState, AUTH_STATES.READY, 'interactive caller retries and wins');
});

test('the derived get() reaches the same entry read() does — the legacy path uses it', async (t) => {
  tmpHome(t);
  const store = new Map();
  const plan = { timeouts: 0, reads: 0 };
  const deps = winDeps(store, plan);
  await seed(deps, 'tok-get');

  const b = backendByName('credential-manager', deps);
  const entry = {
    service: credentialService(),
    account: 'gen-1',
    target: `${credentialService()}/gen-1`,
    file: 'unused',
  };
  const raw = b.get(entry);

  assert.equal(typeof raw, 'string');
  assert.equal(JSON.parse(raw).access_token, 'tok-get');
});

test('a hook read gets the shorter cap; an interactive one gets the longer', async (t) => {
  tmpHome(t);
  const store = new Map();
  const plan = { timeouts: 0, reads: 0 };
  const caps = [];
  const base = winRun(store, plan);
  const deps = {
    platform: 'win32',
    sleepImpl: async () => {},
    run: (file, args, input, options) => {
      if (/CredRead\(/.test(args[args.length - 1])) caps.push(options == null ? null : options.timeoutMs);
      return base(file, args, input);
    },
  };
  await seed(deps, 'tok-caps');

  caps.length = 0;
  await readCredentials(deps);
  await readCredentials(deps, { interactive: true });

  assert.deepEqual(caps, [6000, 8000]);
});
