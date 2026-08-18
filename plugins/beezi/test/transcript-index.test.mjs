import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listAllTranscripts, firstRecordedCwd } from '../lib/transcript-index.mjs';

// ─── helpers ────────────────────────────────────────────────────────────────

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tidx-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeTranscript(projectsDir, project, name, lines = [{ type: 'user' }]) {
  const dir = path.join(projectsDir, project);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf-8');
  return p;
}

// ─── listAllTranscripts ─────────────────────────────────────────────────────

test('1. finds every session transcript across project dirs', (t) => {
  const root = makeTmpDir(t);
  writeTranscript(root, '-c-work-app', 'aaa-111.jsonl');
  writeTranscript(root, '-c-work-other', 'bbb-222.jsonl');

  const found = listAllTranscripts({ projectsDir: root });

  assert.deepEqual(found.map((f) => f.sessionId).sort(), ['aaa-111', 'bbb-222']);
  assert.ok(found.every((f) => fs.existsSync(f.transcriptPath)));
});

// Subagent transcripts are one level deeper and are discovered by runCheckpoint from the main
// transcript. Surfacing them here would report each subagent as a session of its own.
test('2. ignores subagent transcripts nested under <sessionId>/subagents/', (t) => {
  const root = makeTmpDir(t);
  writeTranscript(root, '-c-work-app', 'aaa-111.jsonl');
  const subagents = path.join(root, '-c-work-app', 'aaa-111', 'subagents');
  fs.mkdirSync(subagents, { recursive: true });
  fs.writeFileSync(path.join(subagents, 'agent-xyz.jsonl'), '{}', 'utf-8');

  const found = listAllTranscripts({ projectsDir: root });

  assert.deepEqual(found.map((f) => f.sessionId), ['aaa-111']);
});

test('3. ignores non-.jsonl files', (t) => {
  const root = makeTmpDir(t);
  writeTranscript(root, '-c-work-app', 'aaa-111.jsonl');
  fs.writeFileSync(path.join(root, '-c-work-app', 'notes.txt'), 'hi', 'utf-8');
  fs.writeFileSync(path.join(root, '-c-work-app', 'aaa-111.json'), '{}', 'utf-8');

  const found = listAllTranscripts({ projectsDir: root });

  assert.deepEqual(found.map((f) => f.sessionId), ['aaa-111']);
});

test('4. ignores a directory named like a transcript', (t) => {
  const root = makeTmpDir(t);
  fs.mkdirSync(path.join(root, '-c-work-app', 'ddd-444.jsonl'), { recursive: true });

  assert.deepEqual(listAllTranscripts({ projectsDir: root }), []);
});

test('5. rejects a filename that is not a bare session id', (t) => {
  const root = makeTmpDir(t);
  writeTranscript(root, '-c-work-app', 'ok-1.jsonl');
  writeTranscript(root, '-c-work-app', 'has spaces.jsonl');
  writeTranscript(root, '-c-work-app', 'has.dots.jsonl');
  writeTranscript(root, '-c-work-app', 'under_score.jsonl');

  const found = listAllTranscripts({ projectsDir: root });

  assert.deepEqual(found.map((f) => f.sessionId), ['ok-1']);
});

test('6. returns [] when the projects root does not exist', (t) => {
  const root = makeTmpDir(t);
  assert.deepEqual(listAllTranscripts({ projectsDir: path.join(root, 'nope') }), []);
});

test('7. sorts oldest-first so a partial import advances chronologically', (t) => {
  const root = makeTmpDir(t);
  const older = writeTranscript(root, '-c-a', 'old-1.jsonl');
  const newer = writeTranscript(root, '-c-b', 'new-1.jsonl');
  fs.utimesSync(older, new Date(1_000_000), new Date(1_000_000));
  fs.utimesSync(newer, new Date(2_000_000), new Date(2_000_000));

  const found = listAllTranscripts({ projectsDir: root });

  assert.deepEqual(found.map((f) => f.sessionId), ['old-1', 'new-1']);
});

test('8. reports size, used by the caller to skip transcripts too large to parse', (t) => {
  const root = makeTmpDir(t);
  writeTranscript(root, '-c-a', 'aaa-1.jsonl', [{ type: 'user', text: 'x'.repeat(500) }]);

  const [entry] = listAllTranscripts({ projectsDir: root });

  assert.ok(entry.size > 500);
});

// ─── firstRecordedCwd ───────────────────────────────────────────────────────

// A past session has no live process cwd, and without one every segment resolves to a null
// remote and is silently dropped by runCheckpoint.
test('9. returns the cwd from the first record carrying one', (t) => {
  const root = makeTmpDir(t);
  const p = writeTranscript(root, '-c-a', 'aaa-1.jsonl', [
    { type: 'summary' },
    { type: 'user', cwd: 'C:/work/app' },
    { type: 'assistant', cwd: 'C:/work/other' },
  ]);

  assert.equal(firstRecordedCwd(p), 'C:/work/app');
});

test('10. returns null when no record carries a cwd', (t) => {
  const root = makeTmpDir(t);
  const p = writeTranscript(root, '-c-a', 'aaa-1.jsonl', [{ type: 'user' }, { type: 'assistant' }]);

  assert.equal(firstRecordedCwd(p), null);
});

test('11. returns null for a missing file rather than throwing', () => {
  assert.equal(firstRecordedCwd(path.join(os.tmpdir(), 'definitely-missing.jsonl')), null);
});

test('12. skips malformed lines before the cwd-bearing one', (t) => {
  const root = makeTmpDir(t);
  const dir = path.join(root, '-c-a');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'aaa-1.jsonl');
  fs.writeFileSync(p, `not json\n\n${JSON.stringify({ type: 'user', cwd: 'C:/work/app' })}\n`, 'utf-8');

  assert.equal(firstRecordedCwd(p), 'C:/work/app');
});
