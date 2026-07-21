import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sessionNameFrom, sessionNameFromStore, resolveSessionName } from '../lib/session-name.mjs';

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  return dir;
}

// A temp CLAUDE_CONFIG_DIR with a sessions/ store, restored after the test.
function makeClaudeHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-home-'));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function writeSession(home, pid, record) {
  const sdir = path.join(home, 'sessions');
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, `${pid}.json`), JSON.stringify(record), 'utf-8');
}

function writeTranscript(dir, lines) {
  const p = path.join(dir, `t-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf-8');
  return p;
}

test('sessionNameFrom — ai-title beats summary and first user prompt', (t) => {
  const dir = makeTmpDir(t);
  const p = writeTranscript(dir, [
    { type: 'user', message: { content: 'first prompt' } },
    { type: 'summary', summary: 'Summary title' },
    { type: 'ai-title', aiTitle: 'AI generated title' },
  ]);
  assert.equal(sessionNameFrom(p), 'AI generated title');
});

test('sessionNameFrom — last ai-title wins', (t) => {
  const dir = makeTmpDir(t);
  const p = writeTranscript(dir, [
    { type: 'ai-title', aiTitle: 'Old title' },
    { type: 'user', message: { content: 'a prompt' } },
    { type: 'ai-title', aiTitle: 'Current title' },
  ]);
  assert.equal(sessionNameFrom(p), 'Current title');
});

test('sessionNameFrom — custom-title (rename) beats ai-title regardless of position', (t) => {
  const dir = makeTmpDir(t);
  const customFirst = writeTranscript(dir, [
    { type: 'custom-title', customTitle: 'My renamed session' },
    { type: 'ai-title', aiTitle: 'AI title' },
  ]);
  const customLast = writeTranscript(dir, [
    { type: 'ai-title', aiTitle: 'AI title' },
    { type: 'custom-title', customTitle: 'My renamed session' },
  ]);
  assert.equal(sessionNameFrom(customFirst), 'My renamed session');
  assert.equal(sessionNameFrom(customLast), 'My renamed session');
});

test('sessionNameFrom — last custom-title wins', (t) => {
  const dir = makeTmpDir(t);
  const p = writeTranscript(dir, [
    { type: 'custom-title', customTitle: 'First rename' },
    { type: 'custom-title', customTitle: 'Second rename' },
  ]);
  assert.equal(sessionNameFrom(p), 'Second rename');
});

test('sessionNameFrom — finds ai-title in the tail of a >64KB transcript', (t) => {
  const dir = makeTmpDir(t);
  const filler = Array.from({ length: 150 }, () => (
    { type: 'assistant', message: { content: 'x'.repeat(1000) } }
  ));
  const p = writeTranscript(dir, [
    { type: 'user', message: { content: 'first prompt' } },
    ...filler,
    { type: 'ai-title', aiTitle: 'Title near the end' },
  ]);
  assert.equal(sessionNameFrom(p), 'Title near the end');
});

test('sessionNameFrom — finds custom-title in the head of a >64KB transcript', (t) => {
  const dir = makeTmpDir(t);
  const filler = Array.from({ length: 150 }, () => (
    { type: 'assistant', message: { content: 'x'.repeat(1000) } }
  ));
  const p = writeTranscript(dir, [
    { type: 'custom-title', customTitle: 'Named at start' },
    { type: 'user', message: { content: 'first prompt' } },
    ...filler,
  ]);
  assert.equal(sessionNameFrom(p), 'Named at start');
});

test('sessionNameFrom — empty summary line does not block the first-user fallback', (t) => {
  const dir = makeTmpDir(t);
  const p = writeTranscript(dir, [
    { type: 'summary', summary: '' },
    { type: 'user', message: { content: 'the actual prompt' } },
  ]);
  assert.equal(sessionNameFrom(p), 'the actual prompt');
});

test('sessionNameFrom — prefers the summary line', (t) => {
  const dir = makeTmpDir(t);
  const p = writeTranscript(dir, [
    { type: 'user', message: { content: 'first prompt text' } },
    { type: 'summary', summary: 'Fix the billing detection bug' },
  ]);
  assert.equal(sessionNameFrom(p), 'Fix the billing detection bug');
});

test('sessionNameFrom — falls back to first user prompt (string content)', (t) => {
  const dir = makeTmpDir(t);
  const p = writeTranscript(dir, [
    { type: 'assistant', message: { model: 'x', usage: {} } },
    { type: 'user', message: { content: 'implement session name extraction' } },
    { type: 'user', message: { content: 'a later prompt' } },
  ]);
  assert.equal(sessionNameFrom(p), 'implement session name extraction');
});

test('sessionNameFrom — first user prompt (array content blocks)', (t) => {
  const dir = makeTmpDir(t);
  const p = writeTranscript(dir, [
    { type: 'user', message: { content: [{ text: 'hello' }, { text: 'world' }] } },
  ]);
  assert.equal(sessionNameFrom(p), 'hello world');
});

test('sessionNameFrom — truncates to 200 chars', (t) => {
  const dir = makeTmpDir(t);
  const long = 'x'.repeat(500);
  const p = writeTranscript(dir, [{ type: 'summary', summary: long }]);
  assert.equal(sessionNameFrom(p).length, 200);
});

test('sessionNameFrom — null when no summary and no user text', (t) => {
  const dir = makeTmpDir(t);
  const p = writeTranscript(dir, [
    { type: 'assistant', message: { model: 'x', usage: {} } },
    { type: 'user', message: { content: '   ' } },
  ]);
  assert.equal(sessionNameFrom(p), null);
});

test('sessionNameFrom — null (read-safe) when the file does not exist', () => {
  assert.equal(sessionNameFrom(path.join(os.tmpdir(), 'does-not-exist-xyz.jsonl')), null);
});

test('sessionNameFrom — skips malformed JSON lines and blank lines', (t) => {
  const dir = makeTmpDir(t);
  const p = path.join(dir, 'mixed.jsonl');
  fs.writeFileSync(p, [
    'not json at all',
    '',
    JSON.stringify({ type: 'user', message: { content: 'good prompt' } }),
  ].join('\n'), 'utf-8');
  assert.equal(sessionNameFrom(p), 'good prompt');
});

test('sessionNameFromStore — returns the live session name matched by sessionId', (t) => {
  const home = makeClaudeHome(t);
  writeSession(home, 111, { sessionId: 'other', name: 'wrong' });
  writeSession(home, 222, { sessionId: 'abc-123', name: 'analytics-session-truncate-fix' });
  assert.equal(sessionNameFromStore('abc-123'), 'analytics-session-truncate-fix');
});

test('sessionNameFromStore — trims and truncates to 200 chars', (t) => {
  const home = makeClaudeHome(t);
  writeSession(home, 1, { sessionId: 's', name: `  ${'x'.repeat(500)}  ` });
  assert.equal(sessionNameFromStore('s').length, 200);
});

test('sessionNameFromStore — null when the matched record has no usable name', (t) => {
  const home = makeClaudeHome(t);
  writeSession(home, 1, { sessionId: 's', name: '   ' });
  writeSession(home, 2, { sessionId: 's2' });
  assert.equal(sessionNameFromStore('s'), null);
  assert.equal(sessionNameFromStore('s2'), null);
});

test('sessionNameFromStore — ignores placeholder names (nameSource "derived")', (t) => {
  const home = makeClaudeHome(t);
  writeSession(home, 1, { sessionId: 's', name: 'my-repo-64', nameSource: 'derived' });
  assert.equal(sessionNameFromStore('s'), null);
});

test('sessionNameFromStore — keeps real names (nameSource "user"/"ai"/absent)', (t) => {
  const home = makeClaudeHome(t);
  writeSession(home, 1, { sessionId: 'u', name: 'renamed by user', nameSource: 'user' });
  writeSession(home, 2, { sessionId: 'a', name: 'ai title', nameSource: 'ai' });
  writeSession(home, 3, { sessionId: 'n', name: 'no source field' });
  assert.equal(sessionNameFromStore('u'), 'renamed by user');
  assert.equal(sessionNameFromStore('a'), 'ai title');
  assert.equal(sessionNameFromStore('n'), 'no source field');
});

test('sessionNameFromStore — a stale derived record does not mask a real one for the same sessionId', (t) => {
  const home = makeClaudeHome(t);
  // readdirSync yields '1.json' before '2.json'; the derived record must be skipped,
  // not abort the scan.
  writeSession(home, 1, { sessionId: 's', name: 'my-repo-64', nameSource: 'derived' });
  writeSession(home, 2, { sessionId: 's', name: 'Real live name' });
  assert.equal(sessionNameFromStore('s'), 'Real live name');
});

test('sessionNameFromStore — null when no record matches / dir missing', (t) => {
  const home = makeClaudeHome(t);
  assert.equal(sessionNameFromStore('nope'), null, 'sessions dir absent → null');
  writeSession(home, 1, { sessionId: 's', name: 'x' });
  assert.equal(sessionNameFromStore('missing'), null, 'no matching sessionId → null');
  assert.equal(sessionNameFromStore(''), null, 'empty sessionId → null');
});

test('resolveSessionName — store name wins over the transcript summary', (t) => {
  const home = makeClaudeHome(t);
  writeSession(home, 1, { sessionId: 'sid', name: 'the-real-name' });
  const dir = makeTmpDir(t);
  const p = writeTranscript(dir, [{ type: 'summary', summary: 'Transcript summary' }]);
  assert.equal(resolveSessionName('sid', p), 'the-real-name');
});

test('resolveSessionName — derived store placeholder loses to the transcript ai-title', (t) => {
  const home = makeClaudeHome(t);
  writeSession(home, 1, { sessionId: 'sid', name: 'beezi-claude-code-46', nameSource: 'derived' });
  const dir = makeTmpDir(t);
  const p = writeTranscript(dir, [
    { type: 'user', message: { content: 'first prompt' } },
    { type: 'ai-title', aiTitle: 'Fix session name resolution' },
  ]);
  assert.equal(resolveSessionName('sid', p), 'Fix session name resolution');
});

test('resolveSessionName — derived store placeholder loses to the transcript custom-title', (t) => {
  const home = makeClaudeHome(t);
  writeSession(home, 1, { sessionId: 'sid', name: 'beezi-claude-code-46', nameSource: 'derived' });
  const dir = makeTmpDir(t);
  const p = writeTranscript(dir, [
    { type: 'ai-title', aiTitle: 'AI title' },
    { type: 'custom-title', customTitle: 'Renamed mid-session' },
  ]);
  assert.equal(resolveSessionName('sid', p), 'Renamed mid-session');
});

test('resolveSessionName — falls back to transcript when the store has no match', (t) => {
  makeClaudeHome(t); // empty store
  const dir = makeTmpDir(t);
  const p = writeTranscript(dir, [
    { type: 'user', message: { content: 'first prompt' } },
    { type: 'summary', summary: 'Summary title' },
  ]);
  assert.equal(resolveSessionName('sid', p), 'Summary title');
});
