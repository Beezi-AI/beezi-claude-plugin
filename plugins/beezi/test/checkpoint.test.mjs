import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCheckpoint, flushQueue } from '../lib/checkpoint.mjs';

// ─── helpers ────────────────────────────────────────────────────────────────

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  return dir;
}

function setHome(dir) {
  process.env.BEEZI_HOME = dir;
}

function assistantLine(branch, model, usage, timestamp, cwd, effort) {
  return {
    type: 'assistant',
    gitBranch: branch,
    ...(cwd === undefined ? {} : { cwd }),
    timestamp,
    message: { model, usage },
    ...(effort === undefined ? {} : { effort }),
  };
}

function writeTranscript(dir, lines) {
  const p = path.join(dir, `t-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n'), 'utf-8');
  return p;
}

// Retained for tests 1, 7, 12, 13 (specified as untouched): those never reach a
// resolver call that cares about subcommand routing (no-token / zero-work / thrown
// getAccessToken / missing-transcript all short-circuit before or around git resolution),
// so the old blanket-remote fake is still adequate for them.
function fakeGit(remote) {
  return (_args, _cwd) => remote;
}

// Single-repo router: repo root is identity (the cwd passed to rev-parse), no reflog
// events (empty), current HEAD = `branch`, origin = `remote`.
function fakeGitRepo(branch, remote, reflog = '') {
  return (args, cwd) => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return cwd;
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return branch;
    if (args[0] === 'reflog') return reflog;
    if (args[0] === 'remote') return remote;
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

// Multi-repo router: `spec` maps a repo root → { branch, remote, reflog? }.
// rev-parse --show-toplevel is identity (dir passed IS the root); other calls look up by root.
function fakeGitByRoot(spec) {
  return (args, cwd) => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return cwd;
    const entry = spec[cwd];
    if (!entry) throw new Error(`no repo for ${cwd}`);
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return entry.branch;
    if (args[0] === 'reflog') return entry.reflog ?? '';
    if (args[0] === 'remote') {
      if (entry.remote == null) throw new Error(`no origin for ${cwd}`);
      return entry.remote;
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

// Build an assistant line whose tool_use touches a file in `repoDir` (the repo-signal source).
function repoAssistantLine(repoDir, branchIgnored, model, usage, timestamp) {
  return {
    type: 'assistant',
    gitBranch: branchIgnored,
    timestamp,
    message: { model, usage, content: [{ type: 'tool_use', name: 'Edit', input: { file_path: `${repoDir}/f.ts` } }] },
  };
}

function fakeFetch(status) {
  return async (_url, _opts) => ({ status });
}

function readQueue(homeDir) {
  const qdir = path.join(homeDir, 'queue');
  try {
    return fs.readdirSync(qdir).map(f => ({
      name: f,
      payload: JSON.parse(fs.readFileSync(path.join(qdir, f), 'utf-8')),
    }));
  } catch {
    return [];
  }
}

function readState(homeDir, sessionId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(homeDir, 'state', `${sessionId}.json`), 'utf-8'));
  } catch {
    return null;
  }
}

// ─── test 1: no token → nothing enqueued ────────────────────────────────────

test('1. no token → enqueues nothing, writes no state, fetch never called', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  let fetchCalled = false;
  const fetchImpl = async () => { fetchCalled = true; return { status: 200 }; };

  const transcript = writeTranscript(dir, [
    assistantLine('feature/task-1', 'model-a', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:00:00.000Z'),
  ]);

  await runCheckpoint(
    { session_id: 'sess-1', transcript_path: transcript, cwd: dir },
    { getAccessToken: async () => null, gitImpl: fakeGit('https://host/org/repo.git'), fetchImpl },
  );

  assert.equal(readQueue(dir).length, 0, 'no queue files');
  assert.equal(readState(dir, 'sess-1'), null, 'no state file');
  assert.equal(fetchCalled, false, 'fetch must not be called');
});

// ─── test 2: git failure → segment skipped, cursor still advances ────────────

test('2. git failure per-cwd → segment still tracked under a local: remote', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  let fetchCalled = false;
  // 503 keeps the queue file on disk so the payload can be inspected after the flush.
  const fetchImpl = async () => { fetchCalled = true; return { status: 503 }; };

  const transcript = writeTranscript(dir, [
    assistantLine('feature/task-1', 'model-a', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:00:00.000Z'),
  ]);

  await runCheckpoint(
    { session_id: 'sess-2', transcript_path: transcript, cwd: dir },
    {
      getAccessToken: async () => 'tok',
      gitImpl: () => { throw new Error('git not available'); },
      fetchImpl,
    },
  );

  // Git being unavailable no longer loses the usage: the segment falls back to the cwd's
  // folder name so the spend is still reported, and the cursor advances past the line.
  const queued = readQueue(dir);
  assert.equal(queued.length, 1, 'one queue file (git failure falls back to a local: remote)');
  assert.equal(queued[0].payload.remote, `local:${path.basename(dir)}`);
  assert.equal(fetchCalled, true, 'the fallback segment is flushed');
  const state = readState(dir, 'sess-2');
  assert.ok(state, 'state file must exist');
  assert.equal(state.cursor, 1, 'cursor advances even when the remote cannot be resolved');
});

// ─── test 3: task-branch segment enqueued with correct payload ───────────────

test('3. task-branch segment enqueued with correct segmentId, remote, branch, lines, token_total, models', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const transcript = writeTranscript(dir, [
    assistantLine('feature/task-1', 'model-a', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:00:00.000Z'),
  ]);

  await runCheckpoint(
    { session_id: 'sess-3', transcript_path: transcript, cwd: dir },
    {
      getAccessToken: async () => 'tok',
      gitImpl: fakeGitRepo('feature/task-1', 'https://host/org/repo.git'),
      fetchImpl: fakeFetch(200),
    },
  );

  // Queue was flushed (200 → unlinked), so check state instead
  const state = readState(dir, 'sess-3');
  assert.ok(state, 'state file must exist');
  assert.equal(state.cursor, 1);

  // Re-run with a non-flushing fetch to catch queue file before deletion
  const dir2 = makeTmpDir(t);
  setHome(dir2);

  const transcript2 = writeTranscript(dir2, [
    assistantLine('feature/task-1', 'model-a', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:00:00.000Z', undefined, 'high'),
  ]);

  await runCheckpoint(
    { session_id: 'sess-3b', transcript_path: transcript2, cwd: dir2 },
    {
      getAccessToken: async () => 'tok',
      gitImpl: fakeGitRepo('feature/task-1', 'https://host/org/repo.git'),
      fetchImpl: fakeFetch(503), // keep file
    },
  );

  const items = readQueue(dir2);
  assert.equal(items.length, 1, 'exactly one queue file');

  const { payload } = items[0];
  assert.equal(payload.segmentId, 'sess-3b:1-1');
  assert.equal(payload.sessionId, 'sess-3b');
  assert.equal(payload.remote, 'https://host/org/repo.git');
  assert.equal(payload.branch, 'feature/task-1');
  assert.equal(payload.from_line, 1);
  assert.equal(payload.to_line, 1);
  assert.equal(payload.token_total, 150); // 100 + 50
  assert.ok(payload.models && payload.models['model-a'], 'models.model-a must exist');
  assert.deepEqual(
    payload.models['model-a'].by_effort,
    { high: { token_input: 100, token_output: 50, token_cache_read: 0, token_cache_creation: 0, requests: 1 } },
    'by_effort rides the wire inside the models entry',
  );
});

// ─── test 4: non-task branch now enqueued (all-branches), cursor advances ────

test('4. non-task branch is enqueued (all branches reported), cursor advances', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const transcript = writeTranscript(dir, [
    assistantLine('main', 'model-a', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:00:00.000Z'),
  ]);

  await runCheckpoint(
    { session_id: 'sess-4', transcript_path: transcript, cwd: dir },
    {
      getAccessToken: async () => 'tok',
      gitImpl: fakeGitRepo('main', 'https://host/org/repo.git'),
      fetchImpl: fakeFetch(503), // keep file so we can inspect the enqueued segment
    },
  );

  const items = readQueue(dir);
  assert.equal(items.length, 1, 'non-task branch segment is enqueued');
  assert.equal(items[0].payload.branch, 'main', 'branch preserved on the enqueued segment');
  assert.equal(items[0].payload.token_total, 150, '100 + 50');

  const state = readState(dir, 'sess-4');
  assert.ok(state, 'state must exist');
  assert.equal(state.cursor, 1, 'cursor advanced to 1');
});

// ─── test 5: cursor advances / second run processes only new lines ───────────

test('5. second run only processes new lines (cursor advances disjointly)', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const filePath = path.join(dir, 'transcript.jsonl');
  const line1 = assistantLine('feature/task-1', 'model-a', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:00:00.000Z');
  fs.writeFileSync(filePath, JSON.stringify(line1), 'utf-8');

  const capturedPayloads = [];
  const fetchImpl = async (_url, opts) => {
    capturedPayloads.push(JSON.parse(opts.body));
    return { status: 200 };
  };

  const deps = {
    getAccessToken: async () => 'tok',
    gitImpl: fakeGitRepo('feature/task-1', 'https://host/org/repo.git'),
    fetchImpl,
  };

  // First run
  await runCheckpoint({ session_id: 'sess-5', transcript_path: filePath, cwd: dir }, deps);
  assert.equal(capturedPayloads.length, 1, 'first run enqueues one segment');
  const first = capturedPayloads[0];
  assert.equal(first.from_line, 1);
  assert.equal(first.to_line, 1);

  // Append a second line
  const line2 = assistantLine('feature/task-1', 'model-a', { input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:01:00.000Z');
  fs.appendFileSync(filePath, '\n' + JSON.stringify(line2), 'utf-8');

  // Second run
  await runCheckpoint({ session_id: 'sess-5', transcript_path: filePath, cwd: dir }, deps);
  assert.equal(capturedPayloads.length, 2, 'second run enqueues one more segment');
  const second = capturedPayloads[1];
  assert.ok(second.from_line > first.to_line, 'second segment starts after first ended');
  assert.equal(second.token_total, 30, 'second run only counts line 2 tokens (20+10)');
});

// ─── test 6: nothing new → no new queue files, state unchanged ──────────────

test('6. nothing new → early return, no queue files, state unchanged', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const transcript = writeTranscript(dir, [
    assistantLine('feature/task-1', 'model-a', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:00:00.000Z'),
  ]);

  const deps = {
    getAccessToken: async () => 'tok',
    gitImpl: fakeGitRepo('feature/task-1', 'https://host/org/repo.git'),
    fetchImpl: fakeFetch(200),
  };

  // First run to advance cursor
  await runCheckpoint({ session_id: 'sess-6', transcript_path: transcript, cwd: dir }, deps);
  const stateAfterFirst = readState(dir, 'sess-6');

  // Second run with same transcript (cursor == EOF)
  let fetchCalled = false;
  const fetchImpl2 = async () => { fetchCalled = true; return { status: 200 }; };
  await runCheckpoint({ session_id: 'sess-6', transcript_path: transcript, cwd: dir }, { ...deps, fetchImpl: fetchImpl2 });

  const stateAfterSecond = readState(dir, 'sess-6');
  assert.deepEqual(stateAfterSecond, stateAfterFirst, 'state unchanged on second run');
  assert.equal(fetchCalled, false, 'fetch not called when nothing new');
});

// ─── test 7: zero-work segment skipped ──────────────────────────────────────

test('7. zero-work task-branch segment not enqueued', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  // Non-assistant line on a task branch (no tokens, no duration)
  const line = { type: 'mode', mode: 'auto', sessionId: 'x', gitBranch: 'feature/task-1' };
  const filePath = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(filePath, JSON.stringify(line), 'utf-8');

  let fetchCalled = false;
  const fetchImpl = async () => { fetchCalled = true; return { status: 200 }; };

  await runCheckpoint(
    { session_id: 'sess-7', transcript_path: filePath, cwd: dir },
    {
      getAccessToken: async () => 'tok',
      gitImpl: fakeGit('https://host/org/repo.git'),
      fetchImpl,
    },
  );

  // Queue should be empty (segment dropped for zero work)
  // Note: flushQueue is still called but with an empty queue → no fetch
  assert.equal(fetchCalled, false, 'fetch not called for zero-work segment');
  // State cursor must still advance
  const state = readState(dir, 'sess-7');
  assert.ok(state, 'state file must exist');
  assert.equal(state.cursor, 1, 'cursor advanced past zero-work line');
});

// ─── test 8: remote sanitized ───────────────────────────────────────────────

test('8. remote sanitized — user:pass@ stripped from payload', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const capturedPayloads = [];
  const fetchImpl = async (_url, opts) => {
    capturedPayloads.push(JSON.parse(opts.body));
    return { status: 503 }; // keep in queue so we can inspect
  };

  const transcript = writeTranscript(dir, [
    assistantLine('feature/task-1', 'model-a', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:00:00.000Z'),
  ]);

  await runCheckpoint(
    { session_id: 'sess-8', transcript_path: transcript, cwd: dir },
    {
      getAccessToken: async () => 'tok',
      gitImpl: fakeGitRepo('feature/task-1', 'https://user:pw@host/org/repo.git'),
      fetchImpl,
    },
  );

  assert.equal(capturedPayloads.length, 1);
  assert.equal(capturedPayloads[0].remote, 'https://host/org/repo.git', 'credentials stripped from remote');
  assert.ok(!capturedPayloads[0].remote.includes('user:pw@'), 'no user:pw@ in remote');
});

// ─── test 9: flushQueue delivers + unlinks on 2xx ───────────────────────────

test('9. flushQueue delivers and unlinks on 2xx', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  // Seed a queue file directly
  const qdir = path.join(dir, 'queue');
  fs.mkdirSync(qdir, { recursive: true });
  const payload = { segmentId: 'sess-9:1-1', sessionId: 'sess-9', remote: 'https://host/repo.git', branch: 'feature/task-1', token_total: 100 };
  const filePath = path.join(qdir, 'sess-9_1-1.json');
  fs.writeFileSync(filePath, JSON.stringify(payload), 'utf-8');

  const fetchCalls = [];
  const fetchImpl = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return { status: 200 };
  };

  await flushQueue('my-token', { fetchImpl });

  // File must be unlinked
  assert.equal(fs.existsSync(filePath), false, 'queue file must be removed on 2xx');
  assert.equal(fetchCalls.length, 1, 'fetch called once');
  assert.ok(fetchCalls[0].url.includes('/sessions/report'), 'correct endpoint');
  assert.equal(fetchCalls[0].opts.headers['Authorization'], 'Bearer my-token', 'Bearer token sent');
});

// ─── test 10: flushQueue keeps on 5xx and on throw ──────────────────────────

test('10. flushQueue keeps file on 5xx and on throw', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const qdir = path.join(dir, 'queue');
  fs.mkdirSync(qdir, { recursive: true });

  // File 1: 5xx response
  const p1 = path.join(qdir, 'seg-503.json');
  fs.writeFileSync(p1, JSON.stringify({ segmentId: 'sess-10a:1-1' }), 'utf-8');

  // File 2: throwing fetch
  const p2 = path.join(qdir, 'seg-throw.json');
  fs.writeFileSync(p2, JSON.stringify({ segmentId: 'sess-10b:1-1' }), 'utf-8');

  let callCount = 0;
  const fetchImpl = async (_url, opts) => {
    callCount++;
    const body = JSON.parse(opts.body);
    if (body.segmentId === 'sess-10a:1-1') return { status: 503 };
    throw new Error('network error');
  };

  await flushQueue('tok', { fetchImpl });

  assert.equal(fs.existsSync(p1), true, 'file kept on 503');
  assert.equal(fs.existsSync(p2), true, 'file kept on throw');
  assert.equal(callCount, 2, 'fetch called for both files');
});

// ─── test 11: flushQueue drops on 4xx ───────────────────────────────────────

test('11. flushQueue drops on 4xx (terminal reject)', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const qdir = path.join(dir, 'queue');
  fs.mkdirSync(qdir, { recursive: true });

  const p = path.join(qdir, 'seg-422.json');
  fs.writeFileSync(p, JSON.stringify({ segmentId: 'sess-11:1-1' }), 'utf-8');

  await flushQueue('tok', { fetchImpl: fakeFetch(422) });

  assert.equal(fs.existsSync(p), false, 'file removed on 422');
});

// ─── test 12: getAccessToken throws → resolves without throw, nothing enqueued (FIX 2) ─

test('12. getAccessToken throws → resolves without throw, nothing enqueued (FIX 2 regression)', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  let fetchCalled = false;
  const fetchImpl = async () => { fetchCalled = true; return { status: 200 }; };

  const transcript = writeTranscript(dir, [
    assistantLine('feature/task-1', 'model-a', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:00:00.000Z'),
  ]);

  await assert.doesNotReject(async () => {
    await runCheckpoint(
      { session_id: 'sess-12', transcript_path: transcript, cwd: dir },
      {
        getAccessToken: async () => { throw new Error('keytar not available'); },
        gitImpl: fakeGit('https://host/org/repo.git'),
        fetchImpl,
      },
    );
  });

  assert.equal(readQueue(dir).length, 0, 'no queue files when getAccessToken throws');
  assert.equal(readState(dir, 'sess-12'), null, 'no state file when getAccessToken throws');
  assert.equal(fetchCalled, false, 'fetch must not be called when getAccessToken throws');
});

// ─── test 13: missing transcript → resolves without throw, nothing enqueued (FIX 3) ─

test('13. missing transcript → resolves without throw, nothing enqueued (FIX 3 regression)', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  let fetchCalled = false;
  const fetchImpl = async () => { fetchCalled = true; return { status: 200 }; };

  const nonExistentPath = path.join(dir, 'does-not-exist.jsonl');

  await assert.doesNotReject(async () => {
    await runCheckpoint(
      { session_id: 'sess-13', transcript_path: nonExistentPath, cwd: dir },
      {
        getAccessToken: async () => 'tok',
        gitImpl: fakeGit('https://host/org/repo.git'),
        fetchImpl,
      },
    );
  });

  assert.equal(readQueue(dir).length, 0, 'no queue files for missing transcript');
  assert.equal(fetchCalled, false, 'fetch must not be called for missing transcript');
});

// ─── test 14: empty transcript → cursor stays 0; then first line IS reported (FIX 5 end-to-end) ─

test('14. empty transcript → cursor stays 0; first real line IS reported on next run (FIX 5 end-to-end)', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const filePath = path.join(dir, 'transcript-e2e.jsonl');
  // Start with an empty transcript
  fs.writeFileSync(filePath, '', 'utf-8');

  const deps = {
    getAccessToken: async () => 'tok',
    gitImpl: fakeGitRepo('feature/task-14', 'https://host/org/repo.git'),
    fetchImpl: fakeFetch(200),
  };

  // First checkpoint on empty file → nothing enqueued, cursor must remain 0
  await runCheckpoint({ session_id: 'sess-14', transcript_path: filePath, cwd: dir }, deps);

  const stateAfterEmpty = readState(dir, 'sess-14');
  assert.equal(stateAfterEmpty, null, 'no state file written for empty transcript (cursor stays at default 0)');
  assert.equal(readQueue(dir).length, 0, 'no queue files for empty transcript');

  // Append one task-branch assistant line
  const line = assistantLine('feature/task-14', 'model-a', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:00:00.000Z');
  fs.writeFileSync(filePath, JSON.stringify(line), 'utf-8');

  const capturedPayloads = [];
  const recordingDeps = {
    getAccessToken: async () => 'tok',
    gitImpl: fakeGitRepo('feature/task-14', 'https://host/org/repo.git'),
    fetchImpl: async (_url, opts) => {
      capturedPayloads.push(JSON.parse(opts.body));
      return { status: 200 };
    },
  };

  // Second checkpoint — should report the first (and only) line
  await runCheckpoint({ session_id: 'sess-14', transcript_path: filePath, cwd: dir }, recordingDeps);

  assert.equal(capturedPayloads.length, 1, 'exactly one segment reported after first real line');
  const seg = capturedPayloads[0];
  assert.equal(seg.from_line, 1, 'segment starts at line 1 (not 2 — FIX 1 was applied)');
  assert.equal(seg.to_line, 1, 'segment ends at line 1');
  assert.equal(seg.token_total, 15, 'correct token total for first line (10+5)');
});

// ─── test 15: two repos by tool-path signal → each segment gets its own remote ──

test('15. two repos touched in one session → each segment resolves its own repo remote', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const u = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const transcript = writeTranscript(dir, [
    repoAssistantLine('/repo/alpha', 'frozen', 'model-a', u, '2024-01-01T10:00:00.000Z'),
    repoAssistantLine('/repo/beta', 'frozen', 'model-a', { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:01:00.000Z'),
  ]);

  const captured = [];
  await runCheckpoint(
    { session_id: 'sess-15', transcript_path: transcript, cwd: '/repo/alpha' },
    {
      getAccessToken: async () => 'tok',
      gitImpl: fakeGitByRoot({
        '/repo/alpha': { branch: 'feature/task-a', remote: 'https://host/org/alpha.git' },
        '/repo/beta': { branch: 'feature/task-b', remote: 'https://host/org/beta.git' },
      }),
      fetchImpl: async (_url, opts) => { captured.push(JSON.parse(opts.body)); return { status: 503 }; },
    },
  );

  assert.equal(captured.length, 2, 'one segment per repo');
  const alpha = captured.find((p) => p.remote === 'https://host/org/alpha.git');
  const beta = captured.find((p) => p.remote === 'https://host/org/beta.git');
  assert.ok(alpha, 'alpha segment resolved its own remote');
  assert.ok(beta, 'beta segment resolved its own remote');
  assert.equal(alpha.branch, 'feature/task-a');
  assert.equal(beta.branch, 'feature/task-b');
  assert.equal(alpha.token_total, 150);
  assert.equal(beta.token_total, 220);
});

// ─── test 16: reflog interleave within ONE repo → branch by timestamp ───────────

test('16. reflog interleave within a repo → branch attributed by line timestamp', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const CP_REFLOG = [
    'e3 HEAD@{2026-07-03T10:04:00+00:00}: checkout: moving from main to feature/task-A',
    'e2 HEAD@{2026-07-03T10:02:00+00:00}: checkout: moving from feature/task-A to main',
    'e1 HEAD@{2026-07-03T10:00:00+00:00}: checkout: moving from main to feature/task-A',
  ].join('\n');

  const u = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const transcript = writeTranscript(dir, [
    repoAssistantLine('/repo/x', 'frozen', 'model-a', u, '2026-07-03T10:00:30.000Z'), // → feature/task-A
    repoAssistantLine('/repo/x', 'frozen', 'model-a', u, '2026-07-03T10:02:30.000Z'), // → main
    repoAssistantLine('/repo/x', 'frozen', 'model-a', u, '2026-07-03T10:04:30.000Z'), // → feature/task-A
  ]);

  const captured = [];
  await runCheckpoint(
    { session_id: 'sess-16', transcript_path: transcript, cwd: '/repo/x' },
    {
      getAccessToken: async () => 'tok',
      gitImpl: fakeGitByRoot({ '/repo/x': { branch: 'IGNORED-HEAD', remote: 'https://host/org/x.git', reflog: CP_REFLOG } }),
      fetchImpl: async (_url, opts) => { captured.push(JSON.parse(opts.body)); return { status: 503 }; },
    },
  );

  const branches = captured.map((p) => p.branch);
  assert.deepEqual(branches, ['feature/task-A', 'main', 'feature/task-A'], 'reflog timestamps drive branch, not HEAD');
  // Disjoint ranges across the three runs.
  const ranges = captured.map((p) => [p.from_line, p.to_line]);
  assert.deepEqual(ranges, [[1, 1], [2, 2], [3, 3]]);
});

// ─── test 17: repo with no origin → its segment is skipped ──────────────────────

test('17. repo without an origin remote → tracked under a local: remote', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const u = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const transcript = writeTranscript(dir, [
    repoAssistantLine('/repo/noorigin', 'frozen', 'model-a', u, '2024-01-01T10:00:00.000Z'),
  ]);

  let fetchCalled = false;
  await runCheckpoint(
    { session_id: 'sess-17', transcript_path: transcript, cwd: '/repo/noorigin' },
    {
      getAccessToken: async () => 'tok',
      gitImpl: fakeGitByRoot({ '/repo/noorigin': { branch: 'feature/task-a', remote: null } }),
      // 503 keeps the queue file on disk so the payload can be inspected after the flush.
      fetchImpl: async () => { fetchCalled = true; return { status: 503 }; },
    },
  );

  // A repo with no origin is named by its own folder, not dropped.
  const queued = readQueue(dir);
  assert.equal(queued.length, 1, 'one queue file when origin cannot be resolved');
  assert.equal(queued[0].payload.remote, 'local:noorigin');
  assert.equal(fetchCalled, true, 'fetch called');
  const state = readState(dir, 'sess-17');
  assert.ok(state, 'state file exists');
  assert.equal(state.cursor, 1, 'cursor advanced past the segment');
});

// Realistic assistant message = 3 block-lines (thinking/text/tool_use) sharing id + usage.
function multiLineMsg(id, repoDir, usage, ts) {
  const m = (content) => ({ type: 'assistant', gitBranch: 'frozen', timestamp: ts, message: { id, model: 'model-a', usage, content } });
  return [
    m([{ type: 'thinking', thinking: 'x' }]),
    m([{ type: 'text', text: 'y' }]),
    m([{ type: 'tool_use', name: 'Edit', input: { file_path: `${repoDir}/f.ts` } }]),
  ];
}

test('18. realistic multi-line messages across two windows attribute per repo (C1/C2 end-to-end)', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const u = { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const filePath = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(filePath, multiLineMsg('m1', '/repo/alpha', u, '2024-01-01T10:00:00.000Z').map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');

  const captured = [];
  const deps = {
    getAccessToken: async () => 'tok',
    gitImpl: fakeGitByRoot({
      '/repo/alpha': { branch: 'feature/task-a', remote: 'https://host/org/alpha.git' },
      '/repo/beta': { branch: 'feature/task-b', remote: 'https://host/org/beta.git' },
    }),
    fetchImpl: async (_url, opts) => { captured.push(JSON.parse(opts.body)); return { status: 200 }; },
  };

  await runCheckpoint({ session_id: 'sess-18', transcript_path: filePath, cwd: '/repo/alpha' }, deps);
  assert.equal(captured.length, 1, 'window 1: one segment');
  assert.equal(captured[0].remote, 'https://host/org/alpha.git');
  assert.equal(captured[0].token_total, 100, 'message counted once');

  fs.appendFileSync(filePath, '\n' + multiLineMsg('m2', '/repo/beta', u, '2024-01-01T10:01:00.000Z').map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
  await runCheckpoint({ session_id: 'sess-18', transcript_path: filePath, cwd: '/repo/alpha' }, deps);

  assert.equal(captured.length, 2, 'window 2: appended message processed (not skipped), one new segment');
  assert.equal(captured[1].remote, 'https://host/org/beta.git', 'window-2 message attributed to repo beta despite launch cwd alpha');
  assert.equal(captured[1].token_total, 100);
  assert.notEqual(captured[0].segmentId, captured[1].segmentId, 'disjoint segmentIds across windows');
});

test('reports api-error events to /sessions/errors', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);
  const file = writeTranscript(dir, [
    assistantLine('main', 'claude-opus-4-8', { input_tokens: 1, output_tokens: 1 }, '2026-07-08T10:00:00.000Z', '/some/path'),
  ]);

  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return { status: 200 }; };
  const computeDelta = () => ({
    nextCursor: 1,
    segments: [],
    apiErrorEvents: [
      { error: 'rate_limit', text: "You've hit your session limit · resets 4:30pm (Europe/Kiev)", occurredAt: '2026-07-08T10:00:00.000Z', lineNo: 1 },
    ],
  });

  await runCheckpoint(
    { session_id: 's1', transcript_path: file, cwd: '/some/path' },
    { getAccessToken: async () => 'tok', gitImpl: fakeGitRepo('main', 'git@github.com:acme/app.git'), computeDelta, fetchImpl },
  );

  const errorCalls = calls.filter((c) => /\/sessions\/errors$/.test(c.url));
  assert.equal(errorCalls.length, 1);
  const body = JSON.parse(errorCalls[0].opts.body);
  assert.equal(body.sessionId, 's1');
  assert.equal(body.error, 'rate_limit');
  assert.match(body.lastAssistantMessage, /resets 4:30pm/);
  assert.equal(body.occurredAt, '2026-07-08T10:00:00.000Z');
});

// ─── operations: per-category breakdown survives to the wire ─────────────────

test('per-category operations reach the enqueued payload', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const transcript = writeTranscript(dir, [
    {
      type: 'assistant',
      gitBranch: 'main',
      timestamp: '2026-07-08T10:00:00.000Z',
      message: {
        model: 'model-a',
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x/a.ts' } },
          { type: 'tool_use', id: 't2', name: 'Grep', input: { pattern: 'x' } },
        ],
      },
    },
    {
      type: 'user',
      gitBranch: 'main',
      timestamp: '2026-07-08T10:00:01.000Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'y'.repeat(80) }] },
    },
  ]);

  await runCheckpoint(
    { session_id: 'sess-ops', transcript_path: transcript, cwd: dir },
    { getAccessToken: async () => 'tok', gitImpl: fakeGitRepo('main', 'https://host/org/repo.git'), fetchImpl: fakeFetch(503) },
  );

  const items = readQueue(dir);
  assert.equal(items.length, 1);
  const { operations } = items[0].payload;
  assert.ok(operations, 'operations present on payload');
  assert.equal(operations.file.count, 1);
  assert.equal(operations.file.est_tokens, 20); // 80 bytes / 4
  assert.equal(operations.search.count, 1);
  assert.equal(operations.other.count, 0);
});

// ─── timezone: the machine's IANA zone rides every enqueued payload ──────────

test('payload carries the machine IANA timezone', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const transcript = writeTranscript(dir, [
    {
      type: 'assistant',
      gitBranch: 'main',
      timestamp: '2026-07-08T10:00:00.000Z',
      message: {
        model: 'model-a',
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [{ type: 'text', text: 'hi' }],
      },
    },
  ]);

  await runCheckpoint(
    { session_id: 'sess-tz', transcript_path: transcript, cwd: dir },
    { getAccessToken: async () => 'tok', gitImpl: fakeGitRepo('main', 'https://host/org/repo.git'), fetchImpl: fakeFetch(503) },
  );

  const items = readQueue(dir);
  assert.equal(items.length, 1);
  assert.equal(items[0].payload.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
});

// ─── session rename after first prompt is re-sent via the anchor segment ──────

function userLine(branch, text, timestamp) {
  return { type: 'user', gitBranch: branch, timestamp, message: { content: text } };
}

test('19. rename (summary) with no new segment re-sends the anchor with the corrected name', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const filePath = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(
    filePath,
    [
      userLine('feature/task-1', 'fix login bug', '2024-01-01T10:00:00.000Z'),
      assistantLine('feature/task-1', 'model-a', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:00:01.000Z'),
    ].map((l) => JSON.stringify(l)).join('\n'),
    'utf-8',
  );

  const captured = [];
  const deps = {
    getAccessToken: async () => 'tok',
    gitImpl: fakeGitRepo('feature/task-1', 'https://host/org/repo.git'),
    fetchImpl: async (_url, opts) => { captured.push(JSON.parse(opts.body)); return { status: 200 }; },
  };

  // First checkpoint: no summary yet → name falls back to the first user prompt.
  await runCheckpoint({ session_id: 'sess-19', transcript_path: filePath, cwd: dir }, deps);
  assert.equal(captured.length, 1, 'first checkpoint enqueues the segment');
  assert.equal(captured[0].session_name, 'fix login bug', 'segment carries the first-prompt name');
  const anchorSegmentId = captured[0].segmentId;

  const stateAfterFirst = readState(dir, 'sess-19');
  assert.equal(stateAfterFirst.sentSessionName, 'fix login bug', 'sent name recorded');
  assert.ok(stateAfterFirst.anchor, 'anchor payload stored');

  // Claude Code writes the generated title; no further billable activity.
  fs.appendFileSync(filePath, '\n' + JSON.stringify({ type: 'summary', summary: 'Fix login bug' }), 'utf-8');

  // Second checkpoint: no new segment, but the name changed → replay the anchor.
  await runCheckpoint({ session_id: 'sess-19', transcript_path: filePath, cwd: dir }, deps);
  assert.equal(captured.length, 2, 'rename triggers exactly one re-send');
  assert.equal(captured[1].segmentId, anchorSegmentId, 're-send reuses the anchor segmentId (idempotent)');
  assert.equal(captured[1].session_name, 'Fix login bug', 're-send carries the corrected title');
  assert.equal(captured[1].token_total, captured[0].token_total, 'same tokens — no double count');
  assert.equal(readState(dir, 'sess-19').sentSessionName, 'Fix login bug', 'sent name updated');

  // Third checkpoint: name unchanged → no further re-send (no spam).
  await runCheckpoint({ session_id: 'sess-19', transcript_path: filePath, cwd: dir }, deps);
  assert.equal(captured.length, 2, 'no extra re-send when the name is unchanged');
});

// ─── subagent transcripts: usage in <sessionId>/subagents/agent-*.jsonl ──────

// Claude Code writes each subagent's turns to <transcriptDir>/<sessionId>/subagents/
// agent-<id>.jsonl — NOT to the main session transcript. These helpers build that layout.
function writeSubagentTranscript(transcriptDir, sessionId, agentId, lines) {
  const dir = path.join(transcriptDir, sessionId, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${agentId}.jsonl`);
  fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n'), 'utf-8');
  return p;
}

test('20. subagent transcript usage is enqueued as its own segment', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const transcript = writeTranscript(dir, [
    assistantLine('main', 'claude-fable-5', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:00:00.000Z'),
  ]);
  writeSubagentTranscript(dir, 'sess-20', 'agent-abc123', [
    assistantLine('main', 'claude-sonnet-5', { input_tokens: 200, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:00:30.000Z', undefined, 'xhigh'),
  ]);
  fs.writeFileSync(
    path.join(dir, 'sess-20', 'subagents', 'agent-abc123.meta.json'),
    JSON.stringify({ agentType: 'Explore', spawnDepth: 1, toolUseId: 'toolu_x' }),
    'utf-8',
  );

  await runCheckpoint(
    { session_id: 'sess-20', transcript_path: transcript, cwd: dir },
    {
      getAccessToken: async () => 'tok',
      gitImpl: fakeGitRepo('main', 'https://host/org/repo.git'),
      fetchImpl: fakeFetch(503), // keep queue files so we can inspect them
    },
  );

  const items = readQueue(dir);
  assert.equal(items.length, 2, 'main segment + subagent segment');

  const main = items.find(i => i.payload.segmentId === 'sess-20:1-1');
  assert.ok(main, 'main segment keeps its segmentId shape');
  assert.ok(main.payload.models['claude-fable-5'], 'main segment carries the main model');
  assert.equal(main.payload.is_subagent, undefined, 'main segment is not flagged as a subagent');

  const agent = items.find(i => i.payload.segmentId === 'sess-20:agent-abc123:1-1');
  assert.ok(agent, 'subagent segment gets a distinct segmentId scoped by agent id');
  assert.equal(agent.payload.sessionId, 'sess-20', 'subagent work bills to the parent session');
  assert.equal(agent.payload.token_total, 280, 'subagent tokens counted (200+80)');
  assert.ok(agent.payload.models['claude-sonnet-5'], 'subagent model reported');
  assert.equal(
    agent.payload.models['claude-sonnet-5'].by_effort.xhigh.requests, 1,
    'subagent enqueue path carries by_effort',
  );
  assert.equal(agent.payload.branch, 'main');
  assert.equal(agent.payload.remote, 'https://host/org/repo.git');
  assert.equal(agent.payload.is_subagent, true, 'subagent segment is flagged');
  assert.equal(agent.payload.agent_id, 'agent-abc123', 'subagent id carried on the payload');
  assert.equal(agent.payload.agent_type, 'Explore', 'agent_type read from meta.json');
  assert.equal(agent.payload.spawn_depth, 1, 'spawn_depth read from meta.json');
  assert.equal(agent.payload.agent_name, null, 'agent_name null when the main transcript has no matching Task block');
});

test('20b. subagent agent_name resolves from the spawning Task block description', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const transcript = writeTranscript(dir, [
    {
      type: 'assistant',
      gitBranch: 'main',
      timestamp: '2024-01-01T10:00:00.000Z',
      message: {
        content: [
          { type: 'tool_use', name: 'Task', id: 'toolu_named', input: { description: 'Explore analytics plugin', subagent_type: 'Explore' } },
        ],
      },
    },
    assistantLine('main', 'claude-fable-5', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:00:01.000Z'),
  ]);
  writeSubagentTranscript(dir, 'sess-20b', 'agent-named', [
    assistantLine('main', 'claude-sonnet-5', { input_tokens: 200, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:00:30.000Z'),
  ]);
  fs.writeFileSync(
    path.join(dir, 'sess-20b', 'subagents', 'agent-named.meta.json'),
    JSON.stringify({ agentType: 'Explore', spawnDepth: 1, toolUseId: 'toolu_named' }),
    'utf-8',
  );

  await runCheckpoint(
    { session_id: 'sess-20b', transcript_path: transcript, cwd: dir },
    {
      getAccessToken: async () => 'tok',
      gitImpl: fakeGitRepo('main', 'https://host/org/repo.git'),
      fetchImpl: fakeFetch(503),
    },
  );

  const agent = readQueue(dir).find(i => i.payload.is_subagent);
  assert.ok(agent, 'subagent segment enqueued');
  assert.equal(agent.payload.agent_type, 'Explore');
  assert.equal(agent.payload.agent_name, 'Explore analytics plugin', 'agent_name = spawning Task block description');
});

test('21. per-agent cursor — second run only processes new subagent lines', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const transcript = writeTranscript(dir, [
    assistantLine('main', 'claude-fable-5', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:00:00.000Z'),
  ]);
  const agentPath = writeSubagentTranscript(dir, 'sess-21', 'agent-abc123', [
    assistantLine('main', 'claude-sonnet-5', { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:00:30.000Z'),
  ]);

  const captured = [];
  const deps = {
    getAccessToken: async () => 'tok',
    gitImpl: fakeGitRepo('main', 'https://host/org/repo.git'),
    fetchImpl: async (_url, opts) => { captured.push(JSON.parse(opts.body)); return { status: 200 }; },
  };

  await runCheckpoint({ session_id: 'sess-21', transcript_path: transcript, cwd: dir }, deps);
  assert.equal(captured.length, 2, 'first run: main + subagent segments');
  assert.equal(readState(dir, 'sess-21').agentCursors['agent-abc123'], 1, 'agent cursor persisted');

  // Only the subagent produces new lines before the next checkpoint.
  const line2 = assistantLine('main', 'claude-sonnet-5', { input_tokens: 30, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:01:00.000Z');
  fs.appendFileSync(agentPath, '\n' + JSON.stringify(line2), 'utf-8');

  await runCheckpoint({ session_id: 'sess-21', transcript_path: transcript, cwd: dir }, deps);
  assert.equal(captured.length, 3, 'second run: exactly one new segment (agent-only activity)');
  const second = captured[2];
  assert.equal(second.segmentId, 'sess-21:agent-abc123:2-2', 'new segment covers only the appended line');
  assert.equal(second.token_total, 37, 'only the new line counted (30+7)');
  assert.equal(readState(dir, 'sess-21').agentCursors['agent-abc123'], 2, 'agent cursor advanced');
});

// ─── parallel subagents: reported time is the union, not the sum ─────────────

test('25. parallel subagents overlapping the main thread bill only uncovered wall clock', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  // Main thread is anchored across the whole 10:00:00 → 10:04:00 window (240s of active time).
  const transcript = writeTranscript(dir, [
    assistantLine('main', 'claude-fable-5', usage, '2024-01-01T10:00:00.000Z'),
    assistantLine('main', 'claude-fable-5', usage, '2024-01-01T10:02:00.000Z'),
    assistantLine('main', 'claude-fable-5', usage, '2024-01-01T10:04:00.000Z'),
  ]);
  // Two agents run concurrently inside that window: 10:00:30–10:03:30 and 10:01:00–10:02:00.
  writeSubagentTranscript(dir, 'sess-22', 'agent-aaa', [
    assistantLine('main', 'claude-sonnet-5', usage, '2024-01-01T10:00:30.000Z'),
    assistantLine('main', 'claude-sonnet-5', usage, '2024-01-01T10:03:30.000Z'),
  ]);
  writeSubagentTranscript(dir, 'sess-22', 'agent-bbb', [
    assistantLine('main', 'claude-sonnet-5', usage, '2024-01-01T10:01:00.000Z'),
    assistantLine('main', 'claude-sonnet-5', usage, '2024-01-01T10:02:00.000Z'),
  ]);

  await runCheckpoint(
    { session_id: 'sess-22', transcript_path: transcript, cwd: dir },
    {
      getAccessToken: async () => 'tok',
      gitImpl: fakeGitRepo('main', 'https://host/org/repo.git'),
      fetchImpl: fakeFetch(503), // keep queue files so we can inspect them
    },
  );

  const items = readQueue(dir);
  assert.equal(items.length, 3, 'main segment + two subagent segments');

  const main = items.find(i => i.payload.segmentId === 'sess-22:1-3');
  assert.equal(main.payload.duration_sec, 240, 'main thread keeps its full span');

  const aaa = items.find(i => i.payload.agent_id === 'agent-aaa');
  const bbb = items.find(i => i.payload.agent_id === 'agent-bbb');
  assert.equal(aaa.payload.duration_sec, 0, 'agent-aaa runs entirely inside the main span');
  assert.equal(bbb.payload.duration_sec, 0, 'agent-bbb runs entirely inside the main span');
  assert.ok(aaa.payload.token_total > 0, 'subagent tokens are still reported in full');
  assert.ok(bbb.payload.token_total > 0);

  const billed = items.reduce((acc, i) => acc + i.payload.duration_sec, 0);
  assert.equal(billed, 240, 'SUM(duration_sec) equals wall clock, not 240+180+60=480');

  const state = readState(dir, 'sess-22');
  assert.deepEqual(
    state.coveredIntervals,
    [[Date.parse('2024-01-01T10:00:00.000Z'), Date.parse('2024-01-01T10:04:00.000Z')]],
    'coverage persisted as one merged interval',
  );
});

test('26. a subagent outliving the main span bills the uncovered tail', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  // Main is only anchored for its first 60s; the agent keeps working past that.
  const transcript = writeTranscript(dir, [
    assistantLine('main', 'claude-fable-5', usage, '2024-01-01T10:00:00.000Z'),
    assistantLine('main', 'claude-fable-5', usage, '2024-01-01T10:01:00.000Z'),
  ]);
  writeSubagentTranscript(dir, 'sess-23', 'agent-long', [
    assistantLine('main', 'claude-sonnet-5', usage, '2024-01-01T10:00:30.000Z'),
    assistantLine('main', 'claude-sonnet-5', usage, '2024-01-01T10:03:00.000Z'),
  ]);

  await runCheckpoint(
    { session_id: 'sess-23', transcript_path: transcript, cwd: dir },
    {
      getAccessToken: async () => 'tok',
      gitImpl: fakeGitRepo('main', 'https://host/org/repo.git'),
      fetchImpl: fakeFetch(503),
    },
  );

  const items = readQueue(dir);
  const main = items.find(i => !i.payload.is_subagent);
  const agent = items.find(i => i.payload.is_subagent);
  assert.equal(main.payload.duration_sec, 60);
  assert.equal(agent.payload.duration_sec, 120, 'only 10:01:00 → 10:03:00 is uncovered');
  assert.equal(
    items.reduce((acc, i) => acc + i.payload.duration_sec, 0),
    180,
    'union spans 10:00:00 → 10:03:00',
  );
});

test('27. coverage persists across checkpoints — a late subagent window is not re-billed', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const transcript = writeTranscript(dir, [
    assistantLine('main', 'claude-fable-5', usage, '2024-01-01T10:00:00.000Z'),
    assistantLine('main', 'claude-fable-5', usage, '2024-01-01T10:02:00.000Z'),
  ]);

  const captured = [];
  const deps = {
    getAccessToken: async () => 'tok',
    gitImpl: fakeGitRepo('main', 'https://host/org/repo.git'),
    fetchImpl: async (_url, opts) => { captured.push(JSON.parse(opts.body)); return { status: 200 }; },
  };

  // Checkpoint 1: main only — the agent transcript does not exist on disk yet.
  await runCheckpoint({ session_id: 'sess-24', transcript_path: transcript, cwd: dir }, deps);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].duration_sec, 120);

  // Checkpoint 2: the agent's transcript lands, covering minutes already billed by the main thread.
  writeSubagentTranscript(dir, 'sess-24', 'agent-late', [
    assistantLine('main', 'claude-sonnet-5', usage, '2024-01-01T10:00:30.000Z'),
    assistantLine('main', 'claude-sonnet-5', usage, '2024-01-01T10:01:30.000Z'),
  ]);
  await runCheckpoint({ session_id: 'sess-24', transcript_path: transcript, cwd: dir }, deps);

  assert.equal(captured.length, 2, 'the late subagent window is still reported');
  assert.equal(captured[1].is_subagent, true);
  assert.equal(captured[1].duration_sec, 0, 'its minutes were already claimed in the previous run');
  assert.ok(captured[1].token_total > 0, 'its tokens still count');
});

// ─── session cwd/transcript recorded in state (cwd-change recovery) ──────────

test('22. checkpoint records cwd + transcriptPath in session state, tracking cwd changes', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const filePath = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(filePath, JSON.stringify(
    assistantLine('main', 'model-a', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:00:00.000Z'),
  ), 'utf-8');

  const deps = {
    getAccessToken: async () => 'tok',
    gitImpl: fakeGitRepo('main', 'https://host/org/repo.git'),
    fetchImpl: fakeFetch(200),
  };

  await runCheckpoint({ session_id: 'sess-22', transcript_path: filePath, cwd: '/launch/dir' }, deps);
  let state = readState(dir, 'sess-22');
  assert.equal(state.cwd, '/launch/dir', 'launch cwd recorded');
  assert.equal(state.transcriptPath, filePath, 'transcript path recorded');
  assert.ok(state.updatedAt, 'updatedAt recorded');

  // Session cd's elsewhere (worktree, subdir…) — next checkpoint carries the new cwd.
  fs.appendFileSync(filePath, '\n' + JSON.stringify(
    assistantLine('main', 'model-a', { input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:01:00.000Z'),
  ), 'utf-8');
  await runCheckpoint({ session_id: 'sess-22', transcript_path: filePath, cwd: '/launch/dir/.claude/worktrees/w1' }, deps);

  state = readState(dir, 'sess-22');
  assert.equal(state.cwd, '/launch/dir/.claude/worktrees/w1', 'cwd follows the session');
});

// ─── session name: fall back to the previously-sent name when unreadable ─────

test('unreadable session name falls back to the previously-sent name', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);
  // Isolate the live session store so sessionNameFromStore can't match a real session → null.
  const prevCfg = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'claude-empty');
  t.after(() => { process.env.CLAUDE_CONFIG_DIR = prevCfg; });

  // Seed prior state: we already sent a name on an earlier checkpoint.
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'state', 'sess-name.json'),
    JSON.stringify({ cursor: 0, sentSessionName: 'Fix login bug', anchor: null }),
    'utf-8',
  );

  // A billable segment whose transcript yields no name (no user/summary/ai-title line).
  const transcript = writeTranscript(dir, [
    assistantLine('main', 'model-a', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2026-07-13T10:00:00.000Z'),
  ]);

  await runCheckpoint(
    { session_id: 'sess-name', transcript_path: transcript, cwd: dir },
    { getAccessToken: async () => 'tok', gitImpl: fakeGitRepo('main', 'https://host/org/repo.git'), fetchImpl: fakeFetch(503) },
  );

  const items = readQueue(dir);
  assert.equal(items.length, 1);
  assert.equal(items[0].payload.session_name, 'Fix login bug', 'payload keeps the previous name');
  assert.equal(readState(dir, 'sess-name').sentSessionName, 'Fix login bug', 'state name not clobbered to null');
});

// ─── API-key billing evidence: a credit-balance error re-attributes the report ──

test('a credit-balance billing_error re-attributes the segment to anthropic_api_key and persists the proof', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  // The machine looks like a Max 20x subscriber on disk: this is exactly the state that used to
  // stamp `subscription` + `max_20x` onto a session actually paying with an API key.
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'billing.json'),
    JSON.stringify({
      version: 1,
      source: 'subscription',
      subscriptionType: 'max',
      plan: 'max_20x',
      selfReported: true,
      capturedAt: new Date().toISOString(),
    }),
    'utf-8',
  );

  const transcript = writeTranscript(dir, [
    assistantLine('feature/task-1', 'claude-opus-5', { input_tokens: 10, output_tokens: 5 }, '2026-08-05T10:00:00.000Z', dir),
    {
      type: 'assistant',
      gitBranch: 'feature/task-1',
      cwd: dir,
      timestamp: '2026-08-05T10:00:05.000Z',
      isApiErrorMessage: true,
      error: 'billing_error',
      apiErrorStatus: 400,
      message: {
        content: [{ type: 'text', text: 'Your credit balance is too low to access the Anthropic API.' }],
      },
    },
  ]);

  await runCheckpoint(
    { session_id: 'sess-evidence', transcript_path: transcript, cwd: dir },
    {
      getAccessToken: async () => 'tok',
      gitImpl: fakeGitRepo('feature/task-1', 'https://host/org/repo.git'),
      fetchImpl: fakeFetch(500), // keep the queue on disk so the payload can be inspected
    },
  );

  const queued = readQueue(dir);
  assert.equal(queued.length, 1, 'the usage segment is still reported');
  assert.equal(queued[0].payload.billing_source, 'anthropic_api_key');
  assert.equal(queued[0].payload.subscription_plan, undefined, 'no plan may ride an API-key report');
  assert.equal(queued[0].payload.subscription_type, undefined);

  const billing = JSON.parse(fs.readFileSync(path.join(dir, 'billing.json'), 'utf-8'));
  assert.ok(billing.apiKeyEvidenceAt, 'the proof is persisted for later sessions');
  assert.equal(billing.plan, 'max_20x', 'the dormant plan is kept, just not reported');
});

// ─── import seams (sink / skipFlush / collectSessionErrors / persistState) ───

// The bulk import (/beezi:import) drives runCheckpoint per past session and batches delivery
// itself, so each of its side effects has to be redirectable.

test('28. options.sink receives every payload and the disk queue stays empty', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const transcript = writeTranscript(dir, [
    assistantLine('main', 'model-a', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2026-07-13T10:00:00.000Z'),
  ]);

  const sunk = [];
  const { enqueued } = await runCheckpoint(
    { session_id: 'sess-sink', transcript_path: transcript, cwd: dir },
    { getAccessToken: async () => 'tok', gitImpl: fakeGitRepo('main', 'https://host/org/repo.git'), fetchImpl: fakeFetch(200) },
    { sink: (p) => sunk.push(p), skipFlush: true },
  );

  assert.equal(enqueued, 1);
  assert.equal(sunk.length, 1, 'payload reached the sink');
  assert.equal(sunk[0].sessionId, 'sess-sink');
  assert.equal(readQueue(dir).length, 0, 'nothing written to the disk queue');
});

test('29. options.skipFlush returns flush null and never calls fetch', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  let fetchCalled = false;
  const fetchImpl = async () => { fetchCalled = true; return { status: 200 }; };

  const transcript = writeTranscript(dir, [
    assistantLine('main', 'model-a', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2026-07-13T10:00:00.000Z'),
  ]);

  const { flush } = await runCheckpoint(
    { session_id: 'sess-noflush', transcript_path: transcript, cwd: dir },
    { getAccessToken: async () => 'tok', gitImpl: fakeGitRepo('main', 'https://host/org/repo.git'), fetchImpl },
    { sink: () => {}, skipFlush: true },
  );

  assert.equal(flush, null);
  assert.equal(fetchCalled, false, 'skipFlush must issue no HTTP at all');
});

test('30. options.collectSessionErrors buffers rate-limit reports instead of POSTing them', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const urls = [];
  const fetchImpl = async (url) => { urls.push(String(url)); return { status: 200 }; };

  const transcript = writeTranscript(dir, [
    assistantLine('main', 'model-a', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2026-07-13T10:00:00.000Z'),
    { type: 'assistant', isApiErrorMessage: true, error: 'rate_limit', timestamp: '2026-07-13T10:05:00.000Z', message: { content: [{ type: 'text', text: 'limit reached' }] } },
  ]);

  const { sessionErrors } = await runCheckpoint(
    { session_id: 'sess-rl', transcript_path: transcript, cwd: dir },
    { getAccessToken: async () => 'tok', gitImpl: fakeGitRepo('main', 'https://host/org/repo.git'), fetchImpl },
    { sink: () => {}, skipFlush: true, collectSessionErrors: true },
  );

  assert.equal(sessionErrors.length, 1, 'the rate-limit event was buffered');
  assert.equal(sessionErrors[0].sessionId, 'sess-rl');
  assert.equal(sessionErrors[0].error, 'rate_limit');
  assert.ok(!urls.some((u) => u.includes('/sessions/errors')), '/sessions/errors must not be called');
});

// The import builds payloads first and delivers them afterwards. Advancing the cursor here would
// consume the lines before the server accepted them, so a failed delivery would leave the session
// both unledgered and unreadable — the re-run would find nothing left to send.
test('31. options.persistState false leaves the cursor unadvanced', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const transcript = writeTranscript(dir, [
    assistantLine('main', 'model-a', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2026-07-13T10:00:00.000Z'),
  ]);

  const sunk = [];
  await runCheckpoint(
    { session_id: 'sess-nostate', transcript_path: transcript, cwd: dir },
    { getAccessToken: async () => 'tok', gitImpl: fakeGitRepo('main', 'https://host/org/repo.git'), fetchImpl: fakeFetch(200) },
    { sink: (p) => sunk.push(p), skipFlush: true, persistState: false },
  );

  assert.equal(sunk.length, 1, 'the segment was still produced');
  assert.equal(readState(dir, 'sess-nostate'), null, 'no state file written');
});

test('32. the default path is unchanged — queue written, state persisted, flush ran', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const transcript = writeTranscript(dir, [
    assistantLine('main', 'model-a', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2026-07-13T10:00:00.000Z'),
  ]);

  const { flush, sessionErrors } = await runCheckpoint(
    { session_id: 'sess-default', transcript_path: transcript, cwd: dir },
    { getAccessToken: async () => 'tok', gitImpl: fakeGitRepo('main', 'https://host/org/repo.git'), fetchImpl: fakeFetch(200) },
  );

  assert.equal(flush.flushed, 1, 'flush still runs by default');
  assert.deepEqual(sessionErrors, [], 'sessionErrors is always an array');
  assert.ok(readState(dir, 'sess-default'), 'state still persisted');
});

import { writeTrackingState, readTrackingState, TrackingMode } from '../lib/tracking.mjs';
import { QUEUE_HOLD_MS } from '../lib/checkpoint.mjs';

function fakeJsonFetch(replies) {
  let i = 0;
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    const reply = replies[Math.min(i, replies.length - 1)];
    i += 1;
    return { status: reply.status, json: async () => reply.body ?? {} };
  };
  return { impl, calls };
}

// ─── tenant tracking gate + 403 queue handling + payload clamps ─────────────

test('33. tracking disabled → runCheckpoint does zero work and reports gated', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);
  writeTrackingState({ trackingMode: TrackingMode.DISABLED });

  const transcript = writeTranscript(dir, [
    assistantLine('main', 'model-a', { input_tokens: 10, output_tokens: 5 }, '2026-07-13T10:00:00.000Z', dir),
  ]);
  let fetchCalled = false;

  const result = await runCheckpoint(
    { session_id: 'gated-1', transcript_path: transcript, cwd: dir },
    { getAccessToken: async () => 'tok', gitImpl: fakeGit('https://host/org/repo.git'), fetchImpl: async () => { fetchCalled = true; return { status: 200 }; } },
  );

  assert.equal(result.gated, true);
  assert.equal(result.enqueued, 0);
  assert.equal(fetchCalled, false);
  assert.deepEqual(readQueue(dir), []);
  assert.equal(readState(dir, 'gated-1'), null);
});

test('34. backfill_only blocks live hooks exactly like disabled', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);
  writeTrackingState({ trackingMode: TrackingMode.BACKFILL_ONLY });

  const transcript = writeTranscript(dir, [
    assistantLine('main', 'model-a', { input_tokens: 10, output_tokens: 5 }, '2026-07-13T10:00:00.000Z', dir),
  ]);

  const result = await runCheckpoint(
    { session_id: 'gated-2', transcript_path: transcript, cwd: dir },
    { getAccessToken: async () => 'tok', gitImpl: fakeGit('https://host/org/repo.git'), fetchImpl: fakeFetch(200) },
  );

  assert.equal(result.gated, true);
  assert.deepEqual(readQueue(dir), []);
});

test('35. skipLiveTrackingGate runs the full checkpoint even when disabled (the audit path)', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);
  writeTrackingState({ trackingMode: TrackingMode.BACKFILL_ONLY });

  const transcript = writeTranscript(dir, [
    assistantLine('main', 'model-a', { input_tokens: 10, output_tokens: 5 }, '2026-07-13T10:00:00.000Z', dir),
  ]);
  const sunk = [];

  const result = await runCheckpoint(
    { session_id: 'gated-3', transcript_path: transcript, cwd: dir },
    { getAccessToken: async () => 'tok', gitImpl: fakeGitRepo('main', 'https://host/org/repo.git') },
    { sink: (p) => sunk.push(p), skipFlush: true, persistState: false, skipLiveTrackingGate: true },
  );

  assert.equal(result.gated, undefined);
  assert.equal(sunk.length, 1);
});

test('36. flushQueue 403 TRACKING_DISABLED: holds the files, stops the loop, records the state', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);
  const qdir = path.join(dir, 'queue');
  fs.mkdirSync(qdir, { recursive: true });
  fs.writeFileSync(path.join(qdir, 'a.json'), JSON.stringify({ segmentId: 'a' }), 'utf-8');
  fs.writeFileSync(path.join(qdir, 'b.json'), JSON.stringify({ segmentId: 'b' }), 'utf-8');
  fs.writeFileSync(path.join(qdir, 'c.json'), JSON.stringify({ segmentId: 'c' }), 'utf-8');

  const fetch = fakeJsonFetch([
    { status: 403, body: { statusCode: 403, code: 'TRACKING_DISABLED', message: 'audit mode' } },
  ]);

  const result = await flushQueue('tok', { fetchImpl: fetch.impl });

  assert.equal(result.trackingDisabled, true);
  assert.equal(fetch.calls.length, 1, 'the storm stops after the first 403');
  assert.equal(readQueue(dir).length, 3, 'files are HELD for the 3-day window, not deleted');
  assert.equal(readTrackingState().trackingMode, TrackingMode.DISABLED);
});

test('37. the 3-day hold sweep expires only old files while tracking is off', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);
  writeTrackingState({ trackingMode: TrackingMode.DISABLED });
  const qdir = path.join(dir, 'queue');
  fs.mkdirSync(qdir, { recursive: true });
  fs.writeFileSync(path.join(qdir, 'fresh.json'), JSON.stringify({ segmentId: 'fresh' }), 'utf-8');
  fs.writeFileSync(path.join(qdir, 'old.json'), JSON.stringify({ segmentId: 'old' }), 'utf-8');
  const past = (Date.now() - QUEUE_HOLD_MS - 60_000) / 1000;
  fs.utimesSync(path.join(qdir, 'old.json'), past, past);
  let fetchCalled = false;

  const result = await flushQueue('tok', { fetchImpl: async () => { fetchCalled = true; return { status: 200 }; } });

  assert.equal(fetchCalled, false, 'a dark workspace posts nothing');
  assert.equal(result.trackingDisabled, true);
  assert.equal(result.expired, 1);
  assert.deepEqual(readQueue(dir).map((f) => f.name), ['fresh.json']);
});

test('38. a code-less 403 (seat revoked) keeps the file and counts as failed', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);
  const qdir = path.join(dir, 'queue');
  fs.mkdirSync(qdir, { recursive: true });
  fs.writeFileSync(path.join(qdir, 'a.json'), JSON.stringify({ segmentId: 'a' }), 'utf-8');

  const fetch = fakeJsonFetch([
    { status: 403, body: { statusCode: 403, message: 'Your seat was revoked', error: 'Forbidden' } },
  ]);

  const result = await flushQueue('tok', { fetchImpl: fetch.impl });

  assert.equal(result.failed, 1);
  assert.equal(result.trackingDisabled, false);
  assert.equal(readQueue(dir).length, 1, 'a reversible refusal must not destroy the report');
  assert.equal(readTrackingState(), null, 'no tracking flip on a code-less 403');
});

test('39. over-long branch, agent_name and agent_type are clamped to the server caps', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const longBranch = 'feature/' + 'b'.repeat(300);
  const longDescription = 'd'.repeat(300);
  const longType = 'x'.repeat(150);

  const transcript = writeTranscript(dir, [
    assistantLine(longBranch, 'model-a', { input_tokens: 10, output_tokens: 5 }, '2026-07-13T10:00:00.000Z', dir),
    {
      type: 'assistant',
      gitBranch: longBranch,
      cwd: dir,
      timestamp: '2026-07-13T10:00:01.000Z',
      message: {
        model: 'model-a',
        content: [{ type: 'tool_use', name: 'Task', id: 'toolu_1', input: { description: longDescription } }],
      },
    },
  ]);
  const subDir = path.join(path.dirname(transcript), 'clamp-1', 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(
    path.join(subDir, 'agent-a1.jsonl'),
    JSON.stringify(assistantLine(longBranch, 'model-a', { input_tokens: 7, output_tokens: 3 }, '2026-07-13T10:00:02.000Z', dir)),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(subDir, 'agent-a1.meta.json'),
    JSON.stringify({ agentType: longType, spawnDepth: 1, toolUseId: 'toolu_1' }),
    'utf-8',
  );

  const sunk = [];
  await runCheckpoint(
    { session_id: 'clamp-1', transcript_path: transcript, cwd: dir },
    { getAccessToken: async () => 'tok', gitImpl: fakeGitRepo(longBranch, 'https://host/org/repo.git') },
    { sink: (p) => sunk.push(p), skipFlush: true, persistState: false },
  );

  assert.ok(sunk.length >= 2, 'main and subagent segments were built');
  for (const payload of sunk) {
    assert.ok(payload.branch.length <= 255, 'branch of ' + payload.branch.length + ' exceeds the cap');
  }
  const agentPayload = sunk.find((p) => p.is_subagent);
  assert.ok(agentPayload, 'the subagent segment was built');
  assert.equal(agentPayload.agent_name.length, 200);
  assert.equal(agentPayload.agent_type.length, 100);
});

test('40. an audit run (persistState:false) never rewrites the billing config from old evidence', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);
  fs.writeFileSync(
    path.join(dir, 'billing.json'),
    JSON.stringify({
      version: 1,
      source: 'subscription',
      subscriptionType: 'max',
      plan: 'max_20x',
      selfReported: true,
      capturedAt: new Date().toISOString(),
    }),
    'utf-8',
  );

  const transcript = writeTranscript(dir, [
    assistantLine('main', 'model-a', { input_tokens: 10, output_tokens: 5 }, '2026-01-05T10:00:00.000Z', dir),
    {
      type: 'assistant',
      gitBranch: 'main',
      cwd: dir,
      timestamp: '2026-01-05T10:00:05.000Z',
      isApiErrorMessage: true,
      error: 'billing_error',
      apiErrorStatus: 400,
      message: {
        content: [{ type: 'text', text: 'Your credit balance is too low to access the Anthropic API.' }],
      },
    },
  ]);

  const sunk = [];
  await runCheckpoint(
    { session_id: 'audit-billing', transcript_path: transcript, cwd: dir },
    { getAccessToken: async () => 'tok', gitImpl: fakeGitRepo('main', 'https://host/org/repo.git') },
    { sink: (p) => sunk.push(p), skipFlush: true, collectSessionErrors: true, persistState: false, skipLiveTrackingGate: true },
  );

  const billing = JSON.parse(fs.readFileSync(path.join(dir, 'billing.json'), 'utf-8'));
  assert.equal(billing.apiKeyEvidenceAt, undefined, 'months-old evidence must not stamp the live config');
  assert.ok(sunk.length >= 1, 'the historical usage still reports');
});

// The whole value of the retrospective pull: payloads must carry the transcript's own span —
// the server dates a session at ingest wall-clock when these are absent, which would stamp
// months of history "today".
test('41. audit-built payloads carry the transcript-derived started_at/ended_at', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const transcript = writeTranscript(dir, [
    assistantLine('main', 'model-a', { input_tokens: 10, output_tokens: 5 }, '2025-11-02T09:00:00.000Z', dir),
    assistantLine('main', 'model-a', { input_tokens: 4, output_tokens: 2 }, '2025-11-02T10:30:00.000Z', dir),
  ]);

  const sunk = [];
  await runCheckpoint(
    { session_id: 'span-1', transcript_path: transcript, cwd: dir },
    { getAccessToken: async () => 'tok', gitImpl: fakeGitRepo('main', 'https://host/org/repo.git') },
    { sink: (p) => sunk.push(p), skipFlush: true, persistState: false, skipLiveTrackingGate: true },
  );

  assert.equal(sunk.length, 1);
  assert.equal(sunk[0].started_at, '2025-11-02T09:00:00.000Z');
  assert.equal(sunk[0].ended_at, '2025-11-02T10:30:00.000Z');
});

// …and that span stops at the last real turn. Claude Code appends an away_summary recap once the
// human walks off (the last timestamped record in 107 of 231 local transcripts), so a backfilled
// session used to be reported as ending tens of minutes deep into its own idle tail.
test('41b. the away recap does not push the payload ended_at into the idle tail', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const transcript = writeTranscript(dir, [
    assistantLine('main', 'model-a', { input_tokens: 10, output_tokens: 5 }, '2025-11-02T09:00:00.000Z', dir),
    assistantLine('main', 'model-a', { input_tokens: 4, output_tokens: 2 }, '2025-11-02T09:01:00.000Z', dir),
    { type: 'system', subtype: 'away_summary', content: 'recap', gitBranch: 'main', cwd: dir, timestamp: '2025-11-02T09:50:00.000Z' },
  ]);

  const sunk = [];
  await runCheckpoint(
    { session_id: 'span-away', transcript_path: transcript, cwd: dir },
    { getAccessToken: async () => 'tok', gitImpl: fakeGitRepo('main', 'https://host/org/repo.git') },
    { sink: (p) => sunk.push(p), skipFlush: true, persistState: false, skipLiveTrackingGate: true },
  );

  assert.equal(sunk.length, 1);
  assert.equal(sunk[0].started_at, '2025-11-02T09:00:00.000Z');
  assert.equal(sunk[0].ended_at, '2025-11-02T09:01:00.000Z', 'ends at the last turn, not the recap');
  // The billed clock is untouched by the span filter — still the full 60s of real work.
  assert.equal(sunk[0].duration_sec, 60);
});

// A window holding nothing BUT bookkeeping has no anchors at all, so it has no span to report.
// It must not reach the wire regardless: no tokens and no active clock means nothing to bill.
test('41c. a bookkeeping-only window emits no payload', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const transcript = writeTranscript(dir, [
    { type: 'system', subtype: 'away_summary', content: 'recap', gitBranch: 'main', cwd: dir, timestamp: '2025-11-02T09:50:00.000Z' },
    { type: 'queue-operation', operation: 'remove', timestamp: '2025-11-02T09:50:01.000Z' },
  ]);

  const sunk = [];
  await runCheckpoint(
    { session_id: 'span-bookkeeping', transcript_path: transcript, cwd: dir },
    { getAccessToken: async () => 'tok', gitImpl: fakeGitRepo('main', 'https://host/org/repo.git') },
    { sink: (p) => sunk.push(p), skipFlush: true, persistState: false, skipLiveTrackingGate: true },
  );

  assert.equal(sunk.length, 0, 'no tokens and no active clock — nothing to report');
});

// ─── usage stamp + context strip + snapshot post ─────────────────────────────

const UTIL_FIXTURE = {
  fetchedAtMs: 1785953089424,
  accountUuid: 'acc-1',
  fiveHourPct: 1,
  fiveHourResetsAt: '2026-08-05T22:19:59.360Z',
  sevenDayPct: 20,
  sevenDayResetsAt: '2026-08-10T12:00:00.360Z',
  limits: [{ kind: 'session', percent: 1 }],
  raw: {},
};
const ACCOUNT_FIXTURE = { accountUuid: 'acc-1', subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' };
const USAGE_FIXTURE = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const USAGE_STAMP_KEYS = ['account_uuid', 'usage_account_uuid', 'usage_five_hour_pct', 'usage_seven_day_pct', 'usage_fetched_at'];

function usageDeps(extra = {}) {
  return {
    getAccessToken: async () => 'tok',
    gitImpl: fakeGitRepo('main', 'https://host/org/repo.git'),
    fetchImpl: fakeFetch(503), // keeps queue files on disk for inspection
    readUsageUtilization: () => UTIL_FIXTURE,
    readClaudeAccount: () => ACCOUNT_FIXTURE,
    maybePostUsageSnapshot: async () => ({ reported: false, reason: 'test' }),
    ...extra,
  };
}

test('usage stamp — rides every payload when the caches are readable', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);
  const transcript = writeTranscript(dir, [
    assistantLine('main', 'model-a', USAGE_FIXTURE, '2024-01-01T10:00:00.000Z'),
  ]);
  await runCheckpoint({ session_id: 'sess-u1', transcript_path: transcript, cwd: dir }, usageDeps());
  const queue = readQueue(dir);
  assert.equal(queue.length, 1);
  const p = queue[0].payload;
  assert.equal(p.account_uuid, 'acc-1');
  assert.equal(p.usage_account_uuid, 'acc-1');
  assert.equal(p.usage_five_hour_pct, 1);
  assert.equal(p.usage_seven_day_pct, 20);
  assert.equal(p.usage_fetched_at, new Date(1785953089424).toISOString());
});

test('usage stamp — no stamp keys at all when both caches are unreadable', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);
  const transcript = writeTranscript(dir, [
    assistantLine('main', 'model-a', USAGE_FIXTURE, '2024-01-01T10:00:00.000Z'),
  ]);
  await runCheckpoint(
    { session_id: 'sess-u2', transcript_path: transcript, cwd: dir },
    usageDeps({
      readUsageUtilization: () => { throw new Error('boom'); },
      readClaudeAccount: () => { throw new Error('boom'); },
    }),
  );
  const p = readQueue(dir)[0].payload;
  for (const key of USAGE_STAMP_KEYS) {
    assert.equal(key in p, false, `${key} must be absent, not null`);
  }
});

test('usage stamp — context fields ride main segments, stripped from subagent segments', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);
  const transcript = writeTranscript(dir, [
    assistantLine('main', 'model-a', USAGE_FIXTURE, '2024-01-01T10:00:00.000Z'),
  ]);
  const subDir = path.join(path.dirname(transcript), 'sess-u3', 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(
    path.join(subDir, 'agent-a1.jsonl'),
    JSON.stringify(assistantLine('main', 'model-a', USAGE_FIXTURE, '2024-01-01T10:00:30.000Z')),
    'utf-8',
  );
  await runCheckpoint({ session_id: 'sess-u3', transcript_path: transcript, cwd: dir }, usageDeps());
  const queue = readQueue(dir).map((q) => q.payload);
  const main = queue.find((p) => !p.is_subagent);
  const sub = queue.find((p) => p.is_subagent === true);
  assert.ok(main, 'main payload exists');
  assert.ok(sub, 'subagent payload exists');
  assert.equal(main.context_peak_tokens, 100);
  assert.equal(main.context_final_tokens, 100);
  assert.equal(main.context_final_model, 'model-a');
  assert.equal('context_peak_tokens' in sub, false);
  assert.equal('context_final_tokens' in sub, false);
  assert.equal('context_final_model' in sub, false);
  assert.equal(sub.token_input, 100, 'subagent token fields stay intact');
});

test('usage stamp — snapshot post fires only with emitTimeline, via the deps seam', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);
  let calls = 0;
  const deps = usageDeps({ maybePostUsageSnapshot: async () => { calls += 1; return { reported: true }; } });
  const transcript = writeTranscript(dir, [
    assistantLine('main', 'model-a', USAGE_FIXTURE, '2024-01-01T10:00:00.000Z'),
  ]);
  await runCheckpoint({ session_id: 'sess-u4', transcript_path: transcript, cwd: dir }, deps);
  assert.equal(calls, 0, 'plain checkpoint must not post a snapshot');
  await runCheckpoint({ session_id: 'sess-u4', transcript_path: transcript, cwd: dir }, deps, { emitTimeline: true });
  assert.equal(calls, 1, 'turn-end checkpoint posts once');
});

// ─── CLAUDE.md size rides the report ────────────────────────────────────────

test('claude_md_lines — reported from the segment repo root, omitted when the repo has none', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Rules\n\nBe careful.\n', 'utf-8');

  const deps = {
    getAccessToken: async () => 'tok',
    gitImpl: fakeGitRepo('feature/task-1', 'https://host/org/repo.git'),
    fetchImpl: fakeFetch(503), // keep the queue file so the payload is readable
  };
  const transcript = writeTranscript(dir, [
    assistantLine('feature/task-1', 'model-a', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:00:00.000Z'),
  ]);
  await runCheckpoint({ session_id: 'sess-md', transcript_path: transcript, cwd: dir }, deps);

  const items = readQueue(dir);
  assert.equal(items.length, 1, 'exactly one queue file');
  assert.equal(items[0].payload.claude_md_lines, 3);

  // Same setup, no CLAUDE.md: the key must be absent rather than 0, which the server reads as
  // an empty-but-present file.
  const bare = makeTmpDir(t);
  setHome(bare);
  const transcript2 = writeTranscript(bare, [
    assistantLine('feature/task-1', 'model-a', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:00:00.000Z'),
  ]);
  await runCheckpoint({ session_id: 'sess-md2', transcript_path: transcript2, cwd: bare }, deps);

  const bareItems = readQueue(bare);
  assert.equal(bareItems.length, 1, 'exactly one queue file');
  assert.equal('claude_md_lines' in bareItems[0].payload, false);
});
