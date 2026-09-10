import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { markAsked } from '../lib/telemetry-consent.mjs';
import { runSessionStart as _runSessionStart } from '../lib/session-start.mjs';

// Same guard as checkpoint.test.mjs: runSessionStart's env resolution ends in an OS-environment
// probe that spawns and reads the developer's own machine. Default this suite to a machine with
// no setup token; a test that wants the probe injects `osEnvOauthToken` (or its own `env`).
function runSessionStart(input, deps = {}, ...rest) {
  const declared = Object.prototype.hasOwnProperty.call(deps, 'env')
    || Object.prototype.hasOwnProperty.call(deps, 'osEnvOauthToken');
  const base = declared ? deps : { env: {}, ...deps };
  // Same reasoning as the env guard above: the update check runs on EVERY path through
  // runSessionStart, including both early returns, and would otherwise hit GitHub from a unit
  // test. Default it to silence; test/session-start-update.test.mjs injects its own.
  return _runSessionStart(
    input,
    Object.prototype.hasOwnProperty.call(deps, 'checkForUpdate')
      ? base
      : { checkForUpdate: async () => null, ...base },
    ...rest,
  );
}

// ─── helpers ────────────────────────────────────────────────────────────────

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  return dir;
}

function setHome(dir) {
  process.env.BEEZI_HOME = dir;
  // These tests assert on the repo/link message, not the one-time consent ask — stamp it as
  // already asked so it can't bleed into their expected strings (covered on its own in
  // test/telemetry-consent-prompt.test.mjs).
  markAsked();
}

function stateFilePath(homeDir, sessionId) {
  return path.join(homeDir, 'state', `${sessionId}.json`);
}

function readStateFile(homeDir, sessionId) {
  try {
    return JSON.parse(fs.readFileSync(stateFilePath(homeDir, sessionId), 'utf-8'));
  } catch {
    return null;
  }
}

function fakeGit(remote) {
  return (_args, _cwd) => remote;
}

function fakeFetchOk(body) {
  return async () => ({ ok: true, json: async () => body });
}

function fakeFetchNotOk() {
  return async () => ({ ok: false });
}

function baseInput(overrides = {}) {
  return { session_id: 'test-session', cwd: '/some/path', ...overrides };
}

// Billing is resolved on every session start and appends its own nudge when it cannot tell how the
// machine bills. Tests that assert on the repo/link message pin it to a quiet, resolved state so
// that nudge can't bleed into their expected string.
const quietBilling = {
  resolveSource: () => 'subscription',
  // anchorCheckedAt sits safely in the past: a stamp minted after the reconcile's own `now`
  // would trip its future-stamp guard and read as heartbeat-due.
  readBillingConfig: () => ({ source: 'subscription', plan: 'pro', capturedAt: new Date().toISOString(), anchorCheckedAt: new Date(Date.now() - 60_000).toISOString() }),
  isStale: () => false,
  // The reconcile's re-capture layer must stay inert in unit tests: the real readers hit this
  // machine's ~/.claude.json and spawn the actual `claude` CLI.
  resolveClaudeSubscription: () => null,
  readClaudeAccountAnchor: () => null,
};

// ─── test 1: no token ────────────────────────────────────────────────────────

test('1. no token → returns login reminder, no state file created, fetch never called', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  let fetchCalled = false;
  const fetchImpl = async () => { fetchCalled = true; return { ok: true, json: async () => ({}) }; };

  const result = await runSessionStart(baseInput(), {
    getAccessToken: async () => null,
    fetchImpl,
    gitImpl: fakeGit('https://host/repo.git'),
  });

  assert.equal(result, '⚠ Beezi: this machine is not linked — analytics are NOT being tracked. Run /beezi:login to link it.');
  assert.equal(readStateFile(dir, 'test-session'), null, 'no state file');
  assert.equal(fetchCalled, false, 'fetch not called');
});

// ─── test 2: resume guard — init when absent ─────────────────────────────────

test('2. resume guard — creates cursor=0 when state file absent', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const result = await runSessionStart(baseInput({ session_id: 'sess-init' }), {
    getAccessToken: async () => 'tok',
    ...quietBilling,
    fetchImpl: fakeFetchOk({ connected: false }),
    gitImpl: fakeGit('https://host/repo.git'),
  });

  const state = readStateFile(dir, 'sess-init');
  assert.ok(state, 'state file must exist after run');
  assert.equal(state.cursor, 0, 'cursor must be 0 when initialized');
});

// ─── test 3: resume guard — do NOT reset when present ────────────────────────

test('3. resume guard — does NOT reset cursor when state file already exists', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  // Pre-create state file with cursor=42
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'sess-resume.json'), JSON.stringify({ cursor: 42 }), 'utf-8');

  await runSessionStart(baseInput({ session_id: 'sess-resume' }), {
    getAccessToken: async () => 'tok',
    ...quietBilling,
    fetchImpl: fakeFetchOk({ connected: false }),
    gitImpl: fakeGit('https://host/repo.git'),
  });

  const state = readStateFile(dir, 'sess-resume');
  assert.ok(state, 'state file must still exist');
  assert.equal(state.cursor, 42, 'cursor must NOT be reset to 0');
});

// ─── test 4: connected message ───────────────────────────────────────────────

test('4. connected message — returns "repo connected to ..." with projectName', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const result = await runSessionStart(baseInput({ session_id: 'sess-connected' }), {
    getAccessToken: async () => 'tok',
    ...quietBilling,
    fetchImpl: fakeFetchOk({ connected: true, projectName: 'Acme' }),
    gitImpl: fakeGit('https://host/repo.git'),
  });

  assert.equal(result, 'Beezi: repo connected to "Acme". Task-branch sessions will be tracked.');
});

// ─── test 5: not-connected message ───────────────────────────────────────────

test('5. not-connected message — returns "repo is not connected" when connected:false', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const result = await runSessionStart(baseInput({ session_id: 'sess-not-connected' }), {
    getAccessToken: async () => 'tok',
    ...quietBilling,
    fetchImpl: fakeFetchOk({ connected: false }),
    gitImpl: fakeGit('https://host/repo.git'),
  });

  assert.equal(result, 'Beezi: this repo is not connected to Beezi. No analytics tracked here.');
});

// ─── test 6: not a git repo → returns null ───────────────────────────────────

test('6. not a git repo — gitImpl throws → returns null silently', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const result = await runSessionStart(baseInput({ session_id: 'sess-nogit' }), {
    getAccessToken: async () => 'tok',
    ...quietBilling,
    fetchImpl: fakeFetchOk({ connected: true, projectName: 'X' }),
    gitImpl: () => { throw new Error('not a git repository'); },
  });

  assert.equal(result, null);
});

// ─── test 7: repo-status http failure → returns null ─────────────────────────

test('7. repo-status http failure (ok:false) → returns null', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const result = await runSessionStart(baseInput({ session_id: 'sess-http-fail' }), {
    getAccessToken: async () => 'tok',
    ...quietBilling,
    fetchImpl: fakeFetchNotOk(),
    gitImpl: fakeGit('https://host/repo.git'),
  });

  assert.equal(result, null);
});

// ─── test 8: offline (fetchImpl throws) → returns null, no throw escapes ─────

test('8. offline — fetchImpl throws → returns null, no error escapes', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const throwingFetch = async () => { throw new Error('ECONNREFUSED'); };

  let result;
  await assert.doesNotReject(async () => {
    result = await runSessionStart(baseInput({ session_id: 'sess-offline' }), {
      getAccessToken: async () => 'tok',
      ...quietBilling,
      fetchImpl: throwingFetch,
      gitImpl: fakeGit('https://host/repo.git'),
    });
  });

  assert.equal(result, null);
});

// ─── test 9: flushQueue invoked with token ────────────────────────────────────

test('9. flushQueue is invoked — seeds a queue file, verifies it is POSTed and removed', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  // Seed a queue file
  const queueDirPath = path.join(dir, 'queue');
  fs.mkdirSync(queueDirPath, { recursive: true });
  const queuePayload = { segmentId: 'sess-flush:1-1', sessionId: 'sess-flush', remote: 'https://host/repo.git', branch: 'feature/task-1', token_total: 50 };
  const queueFile = path.join(queueDirPath, 'sess-flush_1-1.json');
  fs.writeFileSync(queueFile, JSON.stringify(queuePayload), 'utf-8');

  const fetchCalls = [];
  const recordingFetch = async (url, opts) => {
    fetchCalls.push({ url, body: opts?.body ? JSON.parse(opts.body) : undefined });
    // Return ok:true for repo status too; distinguish by URL
    if (url.includes('/sessions/report')) {
      return { status: 200, ok: true };
    }
    // /repos/status
    return { ok: true, json: async () => ({ connected: false }) };
  };

  await runSessionStart(baseInput({ session_id: 'sess-flush' }), {
    getAccessToken: async () => 'my-token',
    ...quietBilling,
    fetchImpl: recordingFetch,
    gitImpl: fakeGit('https://host/repo.git'),
  });

  // The /sessions/report call must have been made
  const reportCalls = fetchCalls.filter(c => c.url.includes('/sessions/report'));
  assert.equal(reportCalls.length, 1, 'queue file must be POSTed to /sessions/report');
  assert.equal(reportCalls[0].body.segmentId, 'sess-flush:1-1', 'correct payload sent');

  // Queue file must be removed (status 200 → unlink)
  assert.equal(fs.existsSync(queueFile), false, 'queue file must be removed after successful flush');
});

// ─── test 10: the credential layer throwing is temporary, not "not linked" ───────────────

test('10. the credential layer throwing is a temporary failure, not a missing link (finding 6)', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  let fetchCalled = false;
  const fetchImpl = async () => { fetchCalled = true; return { ok: true, json: async () => ({}) }; };

  let result;
  await assert.doesNotReject(async () => {
    result = await runSessionStart(baseInput(), {
      getAccessToken: async () => { throw new Error('keytar not available'); },
      fetchImpl,
      gitImpl: fakeGit('https://host/repo.git'),
    });
  });

  // A store that could not be read is not evidence that nothing is stored, so the copy describes
  // retrying and never tells the user to run a login that would probe and delete a live session.
  assert.match(result, /retry on its own/);
  assert.doesNotMatch(result, /not linked/);
  assert.doesNotMatch(result, /beezi:login/);
  assert.equal(fetchCalled, false, 'fetch must not be called when the credentials cannot be read');
});

// ─── test 11: revoked token — whoami 401 → deletes token, warns ──────────────

test('11. rejected token — whoami 401 → warns but keeps the credentials', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  let deleted = false;
  const fetchImpl = async (url) => {
    if (url.includes('/me/claude-code/whoami')) return { status: 401, ok: false };
    return { ok: true, json: async () => ({ connected: false }) };
  };

  const result = await runSessionStart(baseInput({ session_id: 'sess-rejected' }), {
    getAccessToken: async () => 'tok',
    ...quietBilling,
    deleteCredentials: async () => { deleted = true; },
    fetchImpl,
    gitImpl: fakeGit('https://host/repo.git'),
  });

  assert.equal(result, '⚠ Beezi: this machine’s link was rejected — analytics are NOT being tracked. Run /beezi:login to authorize it again.');
  // A 401 here is equally an expired token, a permissions refusal, or a wrong-environment
  // call — too coarse to unlink on. Only the token endpoint naming the grant revoked, or an
  // explicit /beezi:login, may discard credentials.
  assert.equal(deleted, false, 'a rejected whoami must not delete the credentials');
  assert.equal(readStateFile(dir, 'sess-rejected'), null, 'no state file must be created for a rejected token');
});

// ─── stale-plan nudge helpers ────────────────────────────────────────────────

function fakeFetchWhoamiOkNoRepo() {
  return async (url) => {
    if (String(url).includes('/me/claude-code/whoami')) return { ok: true, status: 200, json: async () => ({}) };
    return { ok: true, json: async () => ({ connected: false }) };
  };
}

// ─── test 12: stale subscription plan → appends /beezi:refresh nudge ────────

test('12. stale subscription plan — appends /beezi:refresh nudge', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const result = await runSessionStart(baseInput({ session_id: 'sess-stale' }), {
    getAccessToken: async () => 'tok',
    ...quietBilling,
    fetchImpl: fakeFetchWhoamiOkNoRepo(),
    gitImpl: () => { throw new Error('not a git repo'); },
    resolveSource: () => 'subscription',
    readBillingConfig: () => ({ source: 'subscription', plan: 'pro', capturedAt: new Date().toISOString() }),
    isStale: () => true,
  });

  assert.match(result ?? '', /\/beezi:refresh/);
});

// ─── setup-token nudge: the case neither billing nudge can structurally reach ──

// billing.mjs forces SUBSCRIPTION for CLAUDE_CODE_OAUTH_TOKEN, so the UNKNOWN nudge can never fire
// here, and the stale nudge points at a local re-capture a setup-token machine cannot do. Without
// this check a CI runner reports unpriced usage in silence.
test('12b. portal says the setup token has no plan — nudges to /beezi:refresh', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const result = await runSessionStart(baseInput({ session_id: 'sess-key-unresolved' }), {
    getAccessToken: async () => 'tok',
    ...quietBilling,
    fetchImpl: fakeFetchWhoamiOkNoRepo(),
    gitImpl: () => { throw new Error('not a git repo'); },
    fetchOauthKeyStatus: async () => ({ known: true, needsAttention: true, subscriptionPlan: null }),
  });

  assert.match(result ?? '', /setup token/);
  // Routed at the command that actually performs this resolution, not at the portal UI.
  assert.match(result ?? '', /\/beezi:refresh/);
  assert.doesNotMatch(result ?? '', /Connections/);
});

test('12c. a resolved setup token is silent, and its plan is adopted locally', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const recorded = [];
  const result = await runSessionStart(baseInput({ session_id: 'sess-key-resolved' }), {
    getAccessToken: async () => 'tok',
    ...quietBilling,
    fetchImpl: fakeFetchWhoamiOkNoRepo(),
    gitImpl: () => { throw new Error('not a git repo'); },
    fetchOauthKeyStatus: async () => ({
      known: true,
      needsAttention: false,
      subscriptionPlan: 'max_20x',
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
      accountEmail: 'ci@example.com',
      accountAnchored: false,
      fingerprint: { prefix: 'sk-ant-oat01', last4: 'UQAA', length: 108 },
    }),
    recordResolvedKeyData: (status) => { recorded.push(status); return true; },
  });

  assert.doesNotMatch(result ?? '', /setup token/);
  // The whole point of the loop being closed: the server's answer reaches billing.json without the
  // user having to run /beezi:refresh first.
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].subscriptionPlan, 'max_20x');
  // The trimmings travel too. A setup-token machine cannot read any of these locally — the type and
  // the tier would otherwise stay whatever a previous interactive login left in billing.json.
  assert.equal(recorded[0].subscriptionType, 'max');
  assert.equal(recorded[0].rateLimitTier, 'default_claude_max_20x');
  assert.equal(recorded[0].accountEmail, 'ci@example.com');
  assert.deepEqual(recorded[0].fingerprint, { prefix: 'sk-ant-oat01', last4: 'UQAA', length: 108 });
});

// A key the server has flagged is exactly the key whose plan must NOT be adopted: needsAttention
// means the answer it has is not one to report.
test('12c-i. a flagged setup token is nudged, never adopted', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const recorded = [];
  await runSessionStart(baseInput({ session_id: 'sess-key-flagged' }), {
    getAccessToken: async () => 'tok',
    ...quietBilling,
    fetchImpl: fakeFetchWhoamiOkNoRepo(),
    gitImpl: () => { throw new Error('not a git repo'); },
    fetchOauthKeyStatus: async () => ({ known: true, needsAttention: true, subscriptionPlan: 'max_20x' }),
    recordResolvedKeyPlan: (plan) => { recorded.push(plan); return true; },
  });

  assert.deepEqual(recorded, []);
});

// known=false is the server saying it has no record of this key; a plan alongside it would be
// about something else.
test('12c-ii. an unknown key with a plan is not adopted', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const recorded = [];
  await runSessionStart(baseInput({ session_id: 'sess-key-unknown' }), {
    getAccessToken: async () => 'tok',
    ...quietBilling,
    fetchImpl: fakeFetchWhoamiOkNoRepo(),
    gitImpl: () => { throw new Error('not a git repo'); },
    fetchOauthKeyStatus: async () => ({ known: false, needsAttention: false, subscriptionPlan: 'pro' }),
    recordResolvedKeyPlan: (plan) => { recorded.push(plan); return true; },
  });

  assert.deepEqual(recorded, []);
});

// A write that blows up must not take session start with it.
test('12c-iii. a throwing write-back is swallowed', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const result = await runSessionStart(baseInput({ session_id: 'sess-key-writefail' }), {
    getAccessToken: async () => 'tok',
    ...quietBilling,
    fetchImpl: fakeFetchWhoamiOkNoRepo(),
    gitImpl: () => { throw new Error('not a git repo'); },
    fetchOauthKeyStatus: async () => ({ known: true, needsAttention: false, subscriptionPlan: 'pro' }),
    recordResolvedKeyPlan: () => { throw new Error('EACCES'); },
  });

  assert.doesNotMatch(result ?? '', /setup token/);
});

// "Could not ask" is not "unresolved" — an offline machine must not be told its billing is broken.
test('12d. an unanswerable probe says nothing', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const recorded = [];
  const result = await runSessionStart(baseInput({ session_id: 'sess-key-offline' }), {
    getAccessToken: async () => 'tok',
    ...quietBilling,
    fetchImpl: fakeFetchWhoamiOkNoRepo(),
    gitImpl: () => { throw new Error('not a git repo'); },
    fetchOauthKeyStatus: async () => null,
    recordResolvedKeyPlan: (plan) => { recorded.push(plan); return true; },
  });

  assert.doesNotMatch(result ?? '', /setup token/);
  assert.deepEqual(recorded, []);
});

// ─── test 13: fresh subscription plan → no nudge ─────────────────────────────

test('13. fresh subscription plan — no nudge appended', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const result = await runSessionStart(baseInput({ session_id: 'sess-fresh' }), {
    getAccessToken: async () => 'tok',
    ...quietBilling,
    fetchImpl: fakeFetchWhoamiOkNoRepo(),
    gitImpl: () => { throw new Error('not a git repo'); },
    resolveSource: () => 'subscription',
    readBillingConfig: () => ({ source: 'subscription', plan: 'pro', capturedAt: new Date().toISOString() }),
    isStale: () => false,
  });

  assert.equal(/\/beezi:refresh/.test(result ?? ''), false);
});

// ─── test 14: non-subscription source → no nudge, even if isStale() would say stale ──

test('14. non-subscription billing source — no nudge even when isStale() would say stale', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const result = await runSessionStart(baseInput({ session_id: 'sess-nonsub' }), {
    getAccessToken: async () => 'tok',
    ...quietBilling,
    fetchImpl: fakeFetchWhoamiOkNoRepo(),
    gitImpl: () => { throw new Error('not a git repo'); },
    resolveSource: () => 'anthropic_api_key',
    readBillingConfig: () => ({ source: 'anthropic_api_key' }),
    isStale: () => true,
  });

  assert.equal(/\/beezi:refresh/.test(result ?? ''), false);
});

// ─── billing-source drift sync ───────────────────────────────────────────────

test('14b. billing source changed since last session — billing.json is realigned to the env', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const stored = {
    source: 'subscription',
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_5x',
    plan: 'max_5x',
    selfReported: true,
    capturedAt: new Date().toISOString(),
    anchorCheckedAt: new Date(Date.now() - 60_000).toISOString(),
  };
  const writes = [];

  const result = await runSessionStart(baseInput({ session_id: 'sess-drift' }), {
    getAccessToken: async () => 'tok',
    ...quietBilling,
    fetchImpl: fakeFetchWhoamiOkNoRepo(),
    gitImpl: () => { throw new Error('not a git repo'); },
    resolveSource: () => 'anthropic_api_key',
    readBillingConfig: () => stored,
    writeBillingConfig: (cfg) => writes.push(cfg),
    isStale: () => false,
  });

  assert.equal(writes.length, 1, 'a changed billing source must rewrite billing.json');
  assert.equal(writes[0].source, 'anthropic_api_key');
  assert.equal(writes[0].plan, 'max_5x', 'the dormant plan must survive the switch');
  assert.equal(writes[0].selfReported, true);
  assert.equal(writes[0].capturedAt, stored.capturedAt, 'capturedAt belongs to the plan capture');
  // REVERSED, deliberately. This used to assert silence, on the reasoning that a source switch is
  // not something the user has to ACT on — which is still true, and is why the line names no
  // command. But "nothing to do" is not "nothing to know": the machine just changed what every
  // subsequent report is priced against, without asking, and the user is entitled to see that.
  // The line is a statement of fact; the nudges elsewhere own the calls to action.
  assert.match(result ?? '', /billing change detected/);
  assert.match(result ?? '', /billing source subscription → anthropic_api_key/);
  // Still no instruction attached — this switch is observed, not inferred, so there is nothing to
  // second-guess. Only the setup-token → login migration carries a correction hint.
  assert.equal(/\/beezi:refresh/.test(result ?? ''), false);
});

test('14c. billing source unchanged — billing.json is left alone', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const writes = [];
  await runSessionStart(baseInput({ session_id: 'sess-nodrift' }), {
    getAccessToken: async () => 'tok',
    ...quietBilling,
    fetchImpl: fakeFetchWhoamiOkNoRepo(),
    gitImpl: () => { throw new Error('not a git repo'); },
    resolveSource: () => 'subscription',
    readBillingConfig: () => ({ source: 'subscription', plan: 'pro', capturedAt: new Date().toISOString(), anchorCheckedAt: new Date(Date.now() - 60_000).toISOString() }),
    writeBillingConfig: (cfg) => writes.push(cfg),
    isStale: () => false,
  });

  assert.equal(writes.length, 0, 'a matching source must not rewrite the file');
});

test('14d. billing.json write failure does not break session start', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const result = await runSessionStart(baseInput({ session_id: 'sess-drift-fail' }), {
    getAccessToken: async () => 'tok',
    ...quietBilling,
    fetchImpl: fakeFetchWhoamiOkNoRepo(),
    gitImpl: () => { throw new Error('not a git repo'); },
    resolveSource: () => 'subscription',
    readBillingConfig: () => ({ source: 'anthropic_api_key' }),
    writeBillingConfig: () => { throw new Error('EACCES'); },
    isStale: () => false,
  });

  // The sync is best-effort: an unwritable billing.json must not take the hook down with it.
  assert.equal(result, null);
  assert.notEqual(readStateFile(dir, 'sess-drift-fail'), null, 'session state is still written');
});

// ─── test 15: session cwd + transcript recorded in state (cwd-change recovery) ──

test('15. records cwd + transcript_path in state; resume refreshes mapping without resetting cursor', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  await runSessionStart(
    baseInput({ session_id: 'sess-map', cwd: '/launch/dir', transcript_path: '/projects/enc/sess-map.jsonl' }),
    { getAccessToken: async () => 'tok', ...quietBilling, fetchImpl: fakeFetchOk({ connected: false }), gitImpl: fakeGit('https://host/repo.git') },
  );

  let state = readStateFile(dir, 'sess-map');
  assert.equal(state.cursor, 0, 'fresh session starts at cursor 0');
  assert.equal(state.cwd, '/launch/dir', 'launch cwd recorded');
  assert.equal(state.transcriptPath, '/projects/enc/sess-map.jsonl', 'transcript path recorded');
  assert.ok(state.updatedAt, 'updatedAt recorded');

  // Resume from another directory: cursor preserved, mapping refreshed.
  const stateDirPath = path.join(dir, 'state');
  fs.writeFileSync(path.join(stateDirPath, 'sess-map.json'), JSON.stringify({ ...state, cursor: 42 }), 'utf-8');
  await runSessionStart(
    baseInput({ session_id: 'sess-map', cwd: '/resume/dir', transcript_path: '/projects/enc/sess-map.jsonl' }),
    { getAccessToken: async () => 'tok', ...quietBilling, fetchImpl: fakeFetchOk({ connected: false }), gitImpl: fakeGit('https://host/repo.git') },
  );

  state = readStateFile(dir, 'sess-map');
  assert.equal(state.cursor, 42, 'cursor NOT reset on resume');
  assert.equal(state.cwd, '/resume/dir', 'mapping refreshed to the resume cwd');
});

// ─── unresolvable billing source → honest nudge ──────────────────────────────

test('14e. unknown billing source — nudges the user instead of silently guessing subscription', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const writes = [];
  const result = await runSessionStart(baseInput({ session_id: 'sess-unknown' }), {
    getAccessToken: async () => 'tok',
    fetchImpl: fakeFetchWhoamiOkNoRepo(),
    gitImpl: () => { throw new Error('not a git repo'); },
    resolveSource: () => 'unknown',
    readBillingConfig: () => ({ source: 'subscription', plan: 'max_20x', selfReported: true }),
    writeBillingConfig: (cfg) => writes.push(cfg),
    isStale: () => true,
    resolveClaudeSubscription: () => null,
    readClaudeAccountAnchor: () => null,
  });

  assert.match(result ?? '', /unknown/);
  assert.match(result ?? '', /\/beezi:login/);
  // The stale subscription nudge must NOT also fire — the plan is no longer the problem.
  assert.equal(/\/beezi:refresh/.test(result ?? ''), false);
  // And the file is realigned off the subscription claim it can no longer support. (The reconcile
  // may first stamp its heartbeat on the kept record; the realign write is the one that matters.)
  assert.ok(writes.length >= 1);
  const last = writes[writes.length - 1];
  assert.equal(last.source, 'unknown');
  assert.equal(last.plan, 'max_20x', 'the plan stays dormant for a switch back');
});

test('14f. a custom gateway names itself in the nudge — the user is asked what it bills', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);
  const prev = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = 'https://gw.corp.example';
  t.after(() => {
    if (prev === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = prev;
  });

  const result = await runSessionStart(baseInput({ session_id: 'sess-gateway' }), {
    getAccessToken: async () => 'tok',
    fetchImpl: fakeFetchWhoamiOkNoRepo(),
    gitImpl: () => { throw new Error('not a git repo'); },
    resolveSource: () => 'unknown',
    readBillingConfig: () => null,
    writeBillingConfig: () => {},
    resolveClaudeSubscription: () => null,
    readClaudeAccountAnchor: () => null,
  });

  // The generic "cannot determine" wording leaves the user with nothing to act on; naming the
  // gateway tells them why we cannot know and that only they can answer it.
  assert.match(result ?? '', /gateway|custom API endpoint/i);
  assert.match(result ?? '', /\/beezi:login/);
});

// ─── tenant tracking policy (whoami capture + gating + hints) ────────────────

import { readTrackingState, writeTrackingState, TrackingMode } from '../lib/tracking.mjs';

// Routes whoami and repos/status separately: whoami is a GET with no body, repos/status a POST.
function routedFetch({ who = {}, repo = { connected: false } } = {}) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (String(url).includes('/whoami')) return { ok: true, status: 200, json: async () => who };
    return { ok: true, status: 200, json: async () => repo };
  };
  return { impl, calls };
}

test('16. whoami tracking fields are persisted to tracking.json before the flush', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);
  const fetch = routedFetch({
    who: { email: 'dev@acme.com', tenantTier: 'audit', trackingMode: 'backfill_only', backfillCompleted: false },
  });

  await runSessionStart(baseInput({ session_id: 'sess-track' }), {
    getAccessToken: async () => 'tok',
    ...quietBilling,
    fetchImpl: fetch.impl,
    gitImpl: fakeGit('https://host/repo.git'),
  });

  const state = readTrackingState();
  assert.equal(state.trackingMode, 'backfill_only');
  assert.equal(state.tenantTier, 'audit');
  assert.equal(state.backfillCompleted, false);
});

test('17. audit mode: repo "will be tracked" line is replaced by the audit hint', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);
  const fetch = routedFetch({
    who: { tenantTier: 'audit', trackingMode: 'backfill_only', backfillCompleted: false },
    repo: { connected: true, projectName: 'Acme' },
  });

  const message = await runSessionStart(baseInput({ session_id: 'sess-audit-msg' }), {
    getAccessToken: async () => 'tok',
    ...quietBilling,
    fetchImpl: fetch.impl,
    gitImpl: fakeGit('https://host/repo.git'),
  });

  assert.ok(!String(message).includes('will be tracked'), 'the tracked promise must not appear');
  assert.match(String(message), /audit mode — new sessions are not tracked/);
  assert.match(String(message), /\/beezi:login/);
});

test('18. audit mode suppresses the billing nudges', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);
  const fetch = routedFetch({
    who: { tenantTier: 'audit', trackingMode: 'backfill_only', backfillCompleted: false },
  });

  const message = await runSessionStart(baseInput({ session_id: 'sess-nudge' }), {
    getAccessToken: async () => 'tok',
    resolveSource: () => 'subscription',
    readBillingConfig: () => ({ source: 'subscription', plan: 'pro', capturedAt: new Date().toISOString() }),
    isStale: () => true,
    fetchImpl: fetch.impl,
    gitImpl: fakeGit('https://host/repo.git'),
    resolveClaudeSubscription: () => null,
    readClaudeAccountAnchor: () => null,
  });

  assert.ok(!String(message).includes('/beezi:refresh'), 'stale-plan nudge is noise for a dark tenant');
});

test('19. a live tenant with an unfinished pull gets the one-line audit offer', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);
  const fetch = routedFetch({
    who: { tenantTier: 'pro', trackingMode: 'live', backfillCompleted: false },
    repo: { connected: true, projectName: 'Acme' },
  });

  const message = await runSessionStart(baseInput({ session_id: 'sess-live-hint' }), {
    getAccessToken: async () => 'tok',
    ...quietBilling,
    fetchImpl: fetch.impl,
    gitImpl: fakeGit('https://host/repo.git'),
  });

  assert.match(String(message), /repo connected to "Acme"/);
  assert.match(String(message), /run \/beezi:login once to include your past sessions/i);
});

test('20. old server (no policy fields) behaves exactly like today — no hints, tracking allowed', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);
  const fetch = routedFetch({
    who: { email: 'dev@acme.com', name: 'Dev' },
    repo: { connected: true, projectName: 'Acme' },
  });

  const message = await runSessionStart(baseInput({ session_id: 'sess-old-server' }), {
    getAccessToken: async () => 'tok',
    ...quietBilling,
    fetchImpl: fetch.impl,
    gitImpl: fakeGit('https://host/repo.git'),
  });

  assert.equal(message, 'Beezi: repo connected to "Acme". Task-branch sessions will be tracked.');
});

test('21. completed pull on a live tenant → no audit hint', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);
  const fetch = routedFetch({
    who: { tenantTier: 'pro', trackingMode: 'live', backfillCompleted: true },
    repo: { connected: true, projectName: 'Acme' },
  });

  const message = await runSessionStart(baseInput({ session_id: 'sess-done' }), {
    getAccessToken: async () => 'tok',
    ...quietBilling,
    fetchImpl: fetch.impl,
    gitImpl: fakeGit('https://host/repo.git'),
  });

  assert.equal(message, 'Beezi: repo connected to "Acme". Task-branch sessions will be tracked.');
});

// ─── status-line capture detachment ──────────────────────────────────────────

test('status line detached → session start says live capture is off', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const result = await runSessionStart(baseInput({ session_id: 'sess-sl-detached' }), {
    getAccessToken: async () => 'tok',
    ...quietBilling,
    fetchImpl: fakeFetchOk({ connected: true, projectName: 'Acme' }),
    gitImpl: fakeGit('https://host/repo.git'),
    statuslineCaptureDetached: () => true,
  });

  assert.equal(
    result,
    'Beezi: repo connected to "Acme". Task-branch sessions will be tracked.\n'
      + 'Beezi: your status line no longer runs Beezi’s wrapper, so live plan-usage capture is off. Run /beezi:login to wrap it again.',
  );
});

test('status line still wrapped → session start stays quiet about it', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const result = await runSessionStart(baseInput({ session_id: 'sess-sl-attached' }), {
    getAccessToken: async () => 'tok',
    ...quietBilling,
    fetchImpl: fakeFetchOk({ connected: true, projectName: 'Acme' }),
    gitImpl: fakeGit('https://host/repo.git'),
    statuslineCaptureDetached: () => false,
  });

  assert.equal(result, 'Beezi: repo connected to "Acme". Task-branch sessions will be tracked.');
});

test('status line check that throws never breaks session start', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const result = await runSessionStart(baseInput({ session_id: 'sess-sl-throws' }), {
    getAccessToken: async () => 'tok',
    ...quietBilling,
    fetchImpl: fakeFetchOk({ connected: true, projectName: 'Acme' }),
    gitImpl: fakeGit('https://host/repo.git'),
    statuslineCaptureDetached: () => { throw new Error('unreadable settings'); },
  });

  assert.equal(result, 'Beezi: repo connected to "Acme". Task-branch sessions will be tracked.');
});

// ─── account check-in trigger ────────────────────────────────────────────────

// A reconcile stub with a chosen outcome. runSessionStart destructures config/source/outcome from
// this ONE call — a second reconcile invocation would spawn the Claude CLI twice per session.
function reconcileWith(outcome, seen) {
  return () => {
    seen.calls += 1;
    return { config: { source: 'subscription', plan: 'pro' }, source: 'subscription', outcome };
  };
}

async function startWithOutcome(t, sessionId, outcome) {
  const dir = makeTmpDir(t);
  setHome(dir);
  const seen = { calls: 0 };
  const syncCalls = [];
  await runSessionStart(baseInput({ session_id: sessionId }), {
    getAccessToken: async () => 'tok',
    ...quietBilling,
    fetchImpl: fakeFetchOk({ connected: false }),
    gitImpl: fakeGit('https://host/repo.git'),
    reconcileBilling: reconcileWith(outcome, seen),
    syncAccount: async (token, options) => { syncCalls.push({ token, options }); return { synced: true }; },
  });
  return { seen, syncCalls };
}

test('account sync — a switched account forces the check-in', async (t) => {
  const { seen, syncCalls } = await startWithOutcome(t, 'sess-acct-switched', 'switched');
  assert.equal(seen.calls, 1, 'the reconcile must run exactly once per session start');
  assert.equal(syncCalls.length, 1);
  assert.equal(syncCalls[0].token, 'tok');
  assert.equal(syncCalls[0].options.force, true);
  assert.equal(syncCalls[0].options.via, 'session-start');
});

test('account sync — a fresh capture forces the check-in', async (t) => {
  const { syncCalls } = await startWithOutcome(t, 'sess-acct-captured', 'captured');
  assert.equal(syncCalls[0].options.force, true);
});

test('account sync — the steady state calls without force (the hash gate decides)', async (t) => {
  for (const outcome of ['none', 'kept', 'no-signal']) {
    const { syncCalls } = await startWithOutcome(t, `sess-acct-${outcome}`, outcome);
    assert.equal(syncCalls.length, 1, `${outcome} still checks in`);
    assert.equal(syncCalls[0].options.force, false, `${outcome} must not force a POST`);
  }
});

test('account sync — an unlinked machine never checks in', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);
  const syncCalls = [];
  await runSessionStart(baseInput({ session_id: 'sess-acct-notoken' }), {
    getAccessToken: async () => null,
    fetchImpl: fakeFetchOk({ connected: false }),
    gitImpl: fakeGit('https://host/repo.git'),
    syncAccount: async () => { syncCalls.push(1); return { synced: true }; },
  });
  assert.equal(syncCalls.length, 0);
});

test('account sync — a rejecting check-in never breaks session start', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);
  let result;
  await assert.doesNotReject(async () => {
    result = await runSessionStart(baseInput({ session_id: 'sess-acct-throws' }), {
      getAccessToken: async () => 'tok',
      ...quietBilling,
      fetchImpl: fakeFetchOk({ connected: true, projectName: 'Acme' }),
      gitImpl: fakeGit('https://host/repo.git'),
      syncAccount: async () => { throw new Error('offline'); },
    });
  });
  assert.equal(result, 'Beezi: repo connected to "Acme". Task-branch sessions will be tracked.');
});

// ─── end to end: the probed env reaches every consumer of the hook ───────────
// runSessionStart resolves the token ONCE and hands the same env to the billing reconcile, the
// account check-in and the key-status probe. If any of them fell back to its own default
// parameter it would re-resolve WITHOUT the OS-environment tier and could disagree with the
// others. The probe is injected, so nothing spawns and nothing reads this machine.

test('OS-env probe — one probed env reaches the reconcile, the check-in and the key status', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  // Hermetic first two tiers: no exported token, and an empty CLAUDE_CONFIG_DIR so the
  // developer's own settings file cannot answer before the probe does.
  const cfgDir = makeTmpDir(t);
  const prevCfg = process.env.CLAUDE_CONFIG_DIR;
  const prevToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CONFIG_DIR = cfgDir;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const { resetSettingsEnvCache } = await import('../lib/claude-settings-env.mjs');
  resetSettingsEnvCache();
  t.after(() => {
    if (prevCfg == null) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevCfg;
    if (prevToken != null) process.env.CLAUDE_CODE_OAUTH_TOKEN = prevToken;
    resetSettingsEnvCache();
  });

  const OS_TOKEN = `sk-ant-oat01-${'d'.repeat(60)}`;
  const seen = { reconcile: null, sync: null, keyStatus: null };
  let probes = 0;

  await runSessionStart(baseInput({ session_id: 'sess-osenv' }), {
    getAccessToken: async () => 'tok',
    fetchImpl: fakeFetchWhoamiOkNoRepo(),
    gitImpl: () => { throw new Error('not a git repo'); },
    osEnvOauthToken: () => { probes += 1; return OS_TOKEN; },
    // Deliberately NOT stubbing reconcileBilling: the real reconcile is what forwards the env on
    // to resolveSource, which is the only place the reconcile's own env is observable.
    resolveSource: (_config, env) => { seen.reconcile = env; return 'subscription'; },
    readBillingConfig: () => ({ source: 'subscription', plan: 'pro', capturedAt: new Date().toISOString(), anchorCheckedAt: new Date(Date.now() - 60_000).toISOString() }),
    isStale: () => false,
    writeBillingConfig: () => {},
    resolveClaudeSubscription: () => null,
    readClaudeAccountAnchor: () => null,
    syncAccount: async (_token, _options, d) => { seen.sync = d.env; return { synced: false }; },
    fetchOauthKeyStatus: async (_token, d) => { seen.keyStatus = d.env; return null; },
  });

  assert.equal(seen.reconcile == null ? null : seen.reconcile.CLAUDE_CODE_OAUTH_TOKEN, OS_TOKEN);
  assert.equal(seen.sync == null ? null : seen.sync.CLAUDE_CODE_OAUTH_TOKEN, OS_TOKEN);
  assert.equal(seen.keyStatus == null ? null : seen.keyStatus.CLAUDE_CODE_OAUTH_TOKEN, OS_TOKEN);
  // All three share ONE object, which is what makes disagreement impossible rather than unlikely.
  assert.equal(seen.sync, seen.keyStatus);
  assert.equal(seen.reconcile, seen.sync);
  // And the hook probed exactly once for all of them.
  assert.equal(probes, 1);
});

// ─── conversions of docs/oauth-session-investigation/reproduce.mjs, asserting the FIXED copy ──

const baseDeps = () => ({
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  gitImpl: () => { throw new Error('not a repo'); },
  checkForUpdate: async () => null,
  statuslineCaptureDetached: () => {},
  takeUpgradeNotice: () => false,
});

test('a transient refresh failure describes retrying, never "not linked"', async () => {
  const message = await runSessionStart({}, {
    ...baseDeps(),
    getAuthentication: async () => ({
      authState: 'unavailable', reason: 'refresh_network_error', accessToken: null,
    }),
  });
  assert.doesNotMatch(message, /not linked/);
  assert.match(message, /retry on its own/);
  assert.doesNotMatch(message, /beezi:login/);
});

test('a refresh already in flight says so instead of asking for a login', async () => {
  const message = await runSessionStart({}, {
    ...baseDeps(),
    getAuthentication: async () => ({
      authState: 'refreshing', reason: 'refresh_in_progress', accessToken: null,
    }),
  });
  assert.doesNotMatch(message, /not linked/);
  assert.match(message, /renewing/);
  assert.doesNotMatch(message, /beezi:login/);
});

test('a rejected grant asks for reauthorization and says the credentials are still there', async () => {
  const message = await runSessionStart({}, {
    ...baseDeps(),
    getAuthentication: async () => ({
      authState: 'reauth_required', reason: 'invalid_grant', accessToken: null,
    }),
  });
  assert.match(message, /\/beezi:login/);
  assert.doesNotMatch(message, /not linked/);
});

test('only a missing authorization is called "not linked"', async () => {
  const message = await runSessionStart({}, {
    ...baseDeps(),
    getAuthentication: async () => ({
      authState: 'unlinked', reason: 'no_credentials', accessToken: null,
    }),
  });
  assert.match(message, /not linked/);
});

// A 403 is a verdict on the account: refreshing cannot fix it and a login will not either.
test('a 403 describes missing permission and never spends a refresh', async () => {
  let refreshes = 0;
  const message = await runSessionStart({}, {
    ...baseDeps(),
    fetchImpl: async () => ({ ok: false, status: 403 }),
    getAuthentication: async (_d, options) => {
      if (options && options.forceRefresh) refreshes += 1;
      return { authState: 'ready', reason: 'ok', accessToken: 'tok' };
    },
  });
  assert.match(message, /administrator/);
  assert.doesNotMatch(message, /not linked/);
  assert.equal(refreshes, 0, 'a permission refusal is never a reason to refresh');
});

test('a 503 the server could not verify is silent, and never spends a refresh', async () => {
  let refreshes = 0;
  const message = await runSessionStart({}, {
    ...baseDeps(),
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ code: 'OAUTH_VERIFICATION_UNAVAILABLE' }) }),
    getAuthentication: async (_d, options) => {
      if (options && options.forceRefresh) refreshes += 1;
      return { authState: 'ready', reason: 'ok', accessToken: 'tok' };
    },
  });
  assert.equal(refreshes, 0);
  assert.ok(message == null || !/not linked|rejected/.test(message));
});

test('the store upgrade prints its restart notice once, then never again', async () => {
  let pending = true;
  const deps = {
    ...baseDeps(),
    takeUpgradeNotice: () => { const was = pending; pending = false; return was; },
    getAuthentication: async () => ({ authState: 'unlinked', reason: 'no_credentials', accessToken: null }),
  };
  assert.match(await runSessionStart({}, deps), /Restart Claude Code/);
  assert.doesNotMatch(await runSessionStart({}, deps), /Restart Claude Code/);
});

test('session start records a verification outage and a rate limit without changing what it says', async () => {
  for (const [status, body, reason] of [
    [503, { code: 'OAUTH_VERIFICATION_UNAVAILABLE' }, 'verification_unavailable'],
    [429, {}, 'rate_limited'],
  ]) {
    const recorded = [];
    const message = await runSessionStart({}, {
      ...baseDeps(),
      fetchImpl: async () => ({ ok: false, status, json: async () => body }),
      getAuthentication: async () => ({ authState: 'ready', reason: 'ok', accessToken: 'tok' }),
      recordAuthResult: (result, opts) => { recorded.push({ ...result, ...opts }); return true; },
    });
    assert.equal(recorded.length, 1, reason);
    assert.equal(recorded[0].reason, reason);
    assert.equal(recorded[0].source, 'session_start');
    assert.ok(message == null || !/not linked|rejected/.test(message), 'the hook stays quiet');
  }
});
