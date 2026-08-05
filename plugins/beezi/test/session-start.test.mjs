import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSessionStart } from '../lib/session-start.mjs';

// ─── helpers ────────────────────────────────────────────────────────────────

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  return dir;
}

function setHome(dir) {
  process.env.BEEZI_HOME = dir;
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
  readBillingConfig: () => ({ source: 'subscription', plan: 'pro', capturedAt: new Date().toISOString() }),
  isStale: () => false,
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

// ─── test 10: getAccessToken throws → returns login reminder, no throw escapes (FIX 2) ─

test('10. getAccessToken throws → resolves to login reminder, no error escapes (FIX 2 regression)', async (t) => {
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

  assert.equal(result, '⚠ Beezi: this machine is not linked — analytics are NOT being tracked. Run /beezi:login to link it.', 'must return login reminder when getAccessToken throws');
  assert.equal(fetchCalled, false, 'fetch must not be called when getAccessToken throws');
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

  assert.equal(result, '⚠ Beezi: this machine’s link was rejected — analytics are NOT being tracked. Run /beezi:login to re-link.');
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
  // Silent: the switch itself is not something the user has to act on.
  assert.equal(/billing/i.test(result ?? ''), false);
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
    readBillingConfig: () => ({ source: 'subscription', plan: 'pro', capturedAt: new Date().toISOString() }),
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
    { getAccessToken: async () => 'tok', fetchImpl: fakeFetchOk({ connected: false }), gitImpl: fakeGit('https://host/repo.git') },
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
    { getAccessToken: async () => 'tok', fetchImpl: fakeFetchOk({ connected: false }), gitImpl: fakeGit('https://host/repo.git') },
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
  });

  assert.match(result ?? '', /unknown/);
  assert.match(result ?? '', /\/beezi:login/);
  // The stale subscription nudge must NOT also fire — the plan is no longer the problem.
  assert.equal(/\/beezi:refresh/.test(result ?? ''), false);
  // And the file is realigned off the subscription claim it can no longer support.
  assert.equal(writes.length, 1);
  assert.equal(writes[0].source, 'unknown');
  assert.equal(writes[0].plan, 'max_20x', 'the plan stays dormant for a switch back');
});
