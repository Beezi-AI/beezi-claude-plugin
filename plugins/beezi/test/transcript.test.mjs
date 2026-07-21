import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findTranscriptBySessionId, resolveSessionTranscript } from '../lib/transcript.mjs';

// Point claudeProjectsDir() at a temp root for the duration of one test.
function makeClaudeRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-test-'));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  t.after(() => {
    process.env.CLAUDE_CONFIG_DIR = prev;
    fs.rmSync(dir, { recursive: true });
  });
  return path.join(dir, 'projects');
}

function writeSessionTranscript(projectsRoot, projectDir, sessionId) {
  const dir = path.join(projectsRoot, projectDir);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(p, JSON.stringify({ type: 'user', cwd: '/launch/dir' }), 'utf-8');
  return p;
}

test('findTranscriptBySessionId finds the transcript regardless of cwd encoding', (t) => {
  const projects = makeClaudeRoot(t);
  writeSessionTranscript(projects, 'C--other-project', 'sess-other');
  const expected = writeSessionTranscript(projects, 'C--Users-x-Desktop-proj', 'sess-mine');

  const found = findTranscriptBySessionId('sess-mine');
  assert.ok(found, 'transcript located by session id');
  assert.equal(found.sessionId, 'sess-mine');
  assert.equal(found.transcriptPath, expected);
});

test('findTranscriptBySessionId → null when the session has no transcript', (t) => {
  makeClaudeRoot(t);
  assert.equal(findTranscriptBySessionId('sess-missing'), null);
});

test('findTranscriptBySessionId → null on unsafe session id (no path traversal)', (t) => {
  const projects = makeClaudeRoot(t);
  writeSessionTranscript(projects, 'C--proj', 'sess-1');
  assert.equal(findTranscriptBySessionId('../../etc/passwd'), null);
  assert.equal(findTranscriptBySessionId(''), null);
  assert.equal(findTranscriptBySessionId(null), null);
});

// ─── resolveSessionTranscript: env id → stored session state → legacy cwd scan ─

function makeBeeziHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-home-'));
  const prev = process.env.BEEZI_HOME;
  process.env.BEEZI_HOME = dir;
  t.after(() => {
    process.env.BEEZI_HOME = prev;
    fs.rmSync(dir, { recursive: true });
  });
  return dir;
}

function writeSessionState(homeDir, sessionId, state) {
  const dir = path.join(homeDir, 'state');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify(state), 'utf-8');
}

test('resolveSessionTranscript prefers CLAUDE_CODE_SESSION_ID even when cwd is wrong', (t) => {
  const projects = makeClaudeRoot(t);
  makeBeeziHome(t);
  const expected = writeSessionTranscript(projects, 'C--launch-dir', 'sess-env');

  const found = resolveSessionTranscript('/some/unrelated/cwd', { env: { CLAUDE_CODE_SESSION_ID: 'sess-env' } });
  assert.ok(found, 'resolved via env session id');
  assert.equal(found.sessionId, 'sess-env');
  assert.equal(found.transcriptPath, expected);
});

test('resolveSessionTranscript falls back to stored session state matching cwd', (t) => {
  const projects = makeClaudeRoot(t);
  const home = makeBeeziHome(t);
  const transcriptPath = writeSessionTranscript(projects, 'C--launch-dir', 'sess-state');
  writeSessionState(home, 'sess-state', {
    cursor: 5,
    cwd: '/launch/dir/.claude/worktrees/w1',
    transcriptPath,
    updatedAt: '2026-07-14T10:00:00.000Z',
  });

  const found = resolveSessionTranscript('/launch/dir/.claude/worktrees/w1', { env: {} });
  assert.ok(found, 'resolved via stored state');
  assert.equal(found.sessionId, 'sess-state');
  assert.equal(found.transcriptPath, transcriptPath);
});

test('resolveSessionTranscript picks the most recently updated state on a cwd tie', (t) => {
  const projects = makeClaudeRoot(t);
  const home = makeBeeziHome(t);
  const older = writeSessionTranscript(projects, 'C--dir-a', 'sess-old');
  const newer = writeSessionTranscript(projects, 'C--dir-b', 'sess-new');
  writeSessionState(home, 'sess-old', { cwd: '/shared/dir', transcriptPath: older, updatedAt: '2026-07-14T09:00:00.000Z' });
  writeSessionState(home, 'sess-new', { cwd: '/shared/dir', transcriptPath: newer, updatedAt: '2026-07-14T11:00:00.000Z' });

  const found = resolveSessionTranscript('/shared/dir', { env: {} });
  assert.equal(found.sessionId, 'sess-new', 'newest updatedAt wins');
});

test('resolveSessionTranscript ignores stored state whose transcript no longer exists', (t) => {
  makeClaudeRoot(t);
  const home = makeBeeziHome(t);
  writeSessionState(home, 'sess-gone', { cwd: '/gone/dir', transcriptPath: '/nope/missing.jsonl', updatedAt: '2026-07-14T10:00:00.000Z' });

  assert.equal(resolveSessionTranscript('/gone/dir', { env: {} }), null);
});

test('resolveSessionTranscript falls back to the legacy cwd project-dir scan', (t) => {
  const projects = makeClaudeRoot(t);
  makeBeeziHome(t);
  // encodeCwd('launchdir') === 'launchdir' — primary lookup hits this project dir.
  const expected = writeSessionTranscript(projects, 'launchdir', 'sess-legacy');

  const found = resolveSessionTranscript('launchdir', { env: {} });
  assert.ok(found, 'legacy scan still works');
  assert.equal(found.sessionId, 'sess-legacy');
  assert.equal(found.transcriptPath, expected);
});
