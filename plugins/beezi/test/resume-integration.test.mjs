import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCheckpoint } from '../lib/checkpoint.mjs';
import { runSessionStart } from '../lib/session-start.mjs';

// ─── helpers ────────────────────────────────────────────────────────────────

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'int-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setHome(dir) {
  process.env.BEEZI_HOME = dir;
}

function assistantLine(branch, i, baseMs) {
  return JSON.stringify({
    type: 'assistant',
    gitBranch: branch,
    timestamp: new Date(baseMs + i * 1000).toISOString(),
    message: {
      model: 'm',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  });
}

function fakeGit(remote) {
  return (_args, _cwd) => remote;
}

function readState(homeDir, sessionId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(homeDir, 'state', `${sessionId}.json`), 'utf-8'));
  } catch {
    return null;
  }
}

function queueFiles(homeDir) {
  try {
    return fs.readdirSync(path.join(homeDir, 'queue'));
  } catch {
    return [];
  }
}

// ─── test 1: resume does NOT re-report already-counted work ─────────────────

test('1. resume does NOT re-report already-counted work (no double count)', async (t) => {
  const homeDir = makeTmpDir(t);
  setHome(homeDir);

  const session_id = 'sess-int';
  const baseMs = 1700000000000;
  const transcriptPath = path.join(homeDir, 'transcript.jsonl');

  const getAccessToken = async () => 'tok';
  const gitImpl = fakeGit('https://host/org/repo.git');

  // Build recording fetch: capture payloads for /sessions/report; return ok:false for /repos/status
  const payloads1 = [];
  const fetchImpl1 = async (url, opts) => {
    if (url.includes('/sessions/report')) {
      payloads1.push(JSON.parse(opts.body));
      return { status: 200 };
    }
    // /repos/status
    return { ok: false };
  };

  // Write 2 task-branch assistant lines
  fs.writeFileSync(
    transcriptPath,
    [assistantLine('feature/task-9', 0, baseMs), assistantLine('feature/task-9', 1, baseMs)].join('\n'),
    'utf-8',
  );

  // First checkpoint
  await runCheckpoint({ session_id, transcript_path: transcriptPath, cwd: 'x' }, { getAccessToken, gitImpl, fetchImpl: fetchImpl1 });

  // Verify: cursor=2, one segment from_line:1 to_line:2 reported
  const stateAfterFirst = readState(homeDir, session_id);
  assert.ok(stateAfterFirst, 'state file must exist after first checkpoint');
  assert.equal(stateAfterFirst.cursor, 2, 'cursor must be 2 after first checkpoint');

  assert.equal(payloads1.length, 1, 'exactly one segment reported in set 1');
  const seg1 = payloads1[0];
  assert.equal(seg1.from_line, 1, 'set-1 segment starts at line 1');
  assert.equal(seg1.to_line, 2, 'set-1 segment ends at line 2');
  // 2 lines × (10 input + 5 output) = 30
  assert.equal(seg1.token_total, 30, 'set-1 token_total == 30 (2 lines)');

  // Simulate RESUME: runSessionStart should NOT reset cursor
  const payloadsFlush = [];
  const fetchImplResume = async (url, opts) => {
    if (url.includes('/sessions/report')) {
      payloadsFlush.push(JSON.parse(opts.body));
      return { status: 200 };
    }
    return { ok: false };
  };

  await runSessionStart({ session_id, cwd: 'x' }, { getAccessToken, fetchImpl: fetchImplResume, gitImpl });

  // No segments should be flushed on resume (queue was already empty after first checkpoint's 200)
  assert.equal(payloadsFlush.length, 0, 'no segments flushed on resume (queue already empty)');

  // Cursor must still be 2 — initSessionState must not reset it
  const stateAfterResume = readState(homeDir, session_id);
  assert.equal(stateAfterResume.cursor, 2, 'cursor must remain 2 after resume (not reset to 0)');

  // Append 2 more lines
  fs.appendFileSync(
    transcriptPath,
    '\n' + [assistantLine('feature/task-9', 2, baseMs), assistantLine('feature/task-9', 3, baseMs)].join('\n'),
    'utf-8',
  );

  const payloads2 = [];
  const fetchImpl2 = async (url, opts) => {
    if (url.includes('/sessions/report')) {
      payloads2.push(JSON.parse(opts.body));
      return { status: 200 };
    }
    return { ok: false };
  };

  // Second checkpoint — should only count lines 3–4
  await runCheckpoint({ session_id, transcript_path: transcriptPath, cwd: 'x' }, { getAccessToken, gitImpl, fetchImpl: fetchImpl2 });

  assert.equal(payloads2.length, 1, 'exactly one segment reported in set 2');
  const seg2 = payloads2[0];

  // Key correctness: second segment must start AFTER first's to_line
  assert.ok(seg2.from_line > seg1.to_line, `set-2 from_line (${seg2.from_line}) must be > set-1 to_line (${seg1.to_line})`);
  assert.equal(seg2.from_line, 3, 'set-2 segment starts at line 3');
  assert.equal(seg2.to_line, 4, 'set-2 segment ends at line 4');

  // Lines 1–2 tokens must NOT appear in set 2
  assert.equal(seg2.token_total, 30, 'set-2 token_total == 30 (only lines 3–4, no double-count)');

  // Total across set1 + set2 == 4 lines counted exactly once
  const totalTokens = seg1.token_total + seg2.token_total;
  assert.equal(totalTokens, 60, 'total tokens across both sets == 60 (4 lines × 15, no overlap)');
});

// ─── test 2: offline segment flushed on next SessionStart ───────────────────

test('2. offline segment flushed on next SessionStart', async (t) => {
  const homeDir = makeTmpDir(t);
  setHome(homeDir);

  const session_id = 'sess-off';
  const baseMs = 1700000000000;
  const transcriptPath = path.join(homeDir, 'transcript-off.jsonl');

  const getAccessToken = async () => 'tok';
  const gitImpl = fakeGit('https://host/org/repo.git');

  // Write 2 task-branch lines
  fs.writeFileSync(
    transcriptPath,
    [assistantLine('feature/task-9', 0, baseMs), assistantLine('feature/task-9', 1, baseMs)].join('\n'),
    'utf-8',
  );

  // Fetch that returns 503 for /sessions/report → queue file stays
  const failFetch = async (url, _opts) => {
    if (url.includes('/sessions/report')) return { status: 503 };
    return { ok: false };
  };

  await runCheckpoint({ session_id, transcript_path: transcriptPath, cwd: 'x' }, { getAccessToken, gitImpl, fetchImpl: failFetch });

  // Exactly one queue file should remain
  const queueAfterCheckpoint = queueFiles(homeDir);
  assert.equal(queueAfterCheckpoint.length, 1, 'exactly one queue file after offline checkpoint');

  // Now SessionStart with a working fetch → should flush the queue
  const postedUrls = [];
  const okFetch = async (url, opts) => {
    if (url.includes('/sessions/report')) {
      postedUrls.push({ url, body: JSON.parse(opts.body) });
      return { status: 200 };
    }
    // /repos/status
    return { ok: false };
  };

  await runSessionStart({ session_id, cwd: 'x' }, { getAccessToken, fetchImpl: okFetch, gitImpl });

  // Queue file must have been POSTed to /sessions/report
  const reportPosts = postedUrls.filter(c => c.url.includes('/sessions/report'));
  assert.equal(reportPosts.length, 1, 'queue file must be POSTed to /sessions/report on next SessionStart');

  // Queue dir must now be empty (file removed after 200)
  const queueAfterFlush = queueFiles(homeDir);
  assert.equal(queueAfterFlush.length, 0, 'queue dir must be empty after successful flush on SessionStart');
});
