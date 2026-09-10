import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  recordPermissionMode,
  readRecordedPermissionMode,
  readPermissionModeRecord,
  resolveSessionId,
} from '../lib/permission-mode-store.mjs';

// Point stateDir() and claudeSessionsDir() at temp roots for the duration of one test.
function makeEnv(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-home-'));
  const claude = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-claude-'));
  const prev = { beezi: process.env.BEEZI_HOME, claude: process.env.CLAUDE_CONFIG_DIR };
  process.env.BEEZI_HOME = path.join(home, 'beezi');
  process.env.CLAUDE_CONFIG_DIR = claude;
  t.after(() => {
    if (prev.beezi === undefined) delete process.env.BEEZI_HOME;
    else process.env.BEEZI_HOME = prev.beezi;
    if (prev.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev.claude;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(claude, { recursive: true, force: true });
  });
  return { sessions: path.join(claude, 'sessions'), state: path.join(process.env.BEEZI_HOME, 'state') };
}

function writeSessionDescriptor(sessions, pid, record) {
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, `${pid}.json`), JSON.stringify(record), 'utf-8');
}

test('a recorded mode reads back for that session and no other', (t) => {
  makeEnv(t);
  assert.equal(recordPermissionMode('sess-1', 'plan'), true);
  assert.equal(readRecordedPermissionMode('sess-1'), 'plan');
  assert.equal(readRecordedPermissionMode('sess-2'), null);
});

// The whole point of the record: the mode the user switched to a second ago wins over anything
// written before it, with no transcript line needed to carry the change.
test('the newest recorded mode replaces the previous one', (t) => {
  makeEnv(t);
  recordPermissionMode('sess-1', 'plan');
  assert.equal(recordPermissionMode('sess-1', 'default'), true);
  assert.equal(readRecordedPermissionMode('sess-1'), 'default');
});

// PostToolUse fires for every tool call; re-recording the same mode must not cost a write.
test('recording an unchanged mode writes nothing', (t) => {
  const { state } = makeEnv(t);
  recordPermissionMode('sess-1', 'auto');
  const before = fs.statSync(path.join(state, 'sess-1.mode')).mtimeMs;
  assert.equal(recordPermissionMode('sess-1', 'auto'), false);
  assert.equal(fs.statSync(path.join(state, 'sess-1.mode')).mtimeMs, before);
});

// Hooks whose event carries no permission_mode field hand us undefined; that is not an answer,
// and it must never erase the answer an earlier hook gave.
test('a missing mode or session id records nothing and keeps what was recorded', (t) => {
  makeEnv(t);
  recordPermissionMode('sess-1', 'plan');
  for (const missing of [undefined, null, '', 42]) {
    assert.equal(recordPermissionMode('sess-1', missing), false, String(missing));
  }
  assert.equal(readRecordedPermissionMode('sess-1'), 'plan');
  assert.equal(recordPermissionMode(undefined, 'plan'), false);
  assert.equal(recordPermissionMode('', 'plan'), false);
});

test('an unwritable state dir is a silent no-op, not a thrown hook', (t) => {
  makeEnv(t);
  // A file where the state DIRECTORY belongs: the write fails the way a sandbox denial does.
  const blocked = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-blocked-'));
  t.after(() => fs.rmSync(blocked, { recursive: true, force: true }));
  const asFile = path.join(blocked, 'beezi');
  fs.writeFileSync(asFile, 'not a directory', 'utf-8');
  process.env.BEEZI_HOME = asFile;

  assert.equal(recordPermissionMode('sess-1', 'plan'), false);
  assert.equal(readRecordedPermissionMode('sess-1'), null);
});

test('a torn or unparseable record reads as no answer', (t) => {
  const { state } = makeEnv(t);
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'sess-1.mode'), '{"version":1,"mode":', 'utf-8');
  assert.equal(readRecordedPermissionMode('sess-1'), null);
  fs.writeFileSync(path.join(state, 'sess-2.mode'), '{"version":1}', 'utf-8');
  assert.equal(readRecordedPermissionMode('sess-2'), null);
});

// `at` is what lets a caller weigh this reading against the transcript's; a record that cannot be
// dated must still yield its mode, and must lose that comparison rather than win it silently.
test('the record carries when it was written, and survives an undatable one', (t) => {
  const { state } = makeEnv(t);
  const before = Date.now();
  recordPermissionMode('sess-1', 'plan');
  const record = readPermissionModeRecord('sess-1');
  assert.equal(record.mode, 'plan');
  assert.equal(typeof record.at, 'number');
  assert.ok(record.at >= before && record.at <= Date.now(), `at ${record.at} outside the write window`);

  fs.writeFileSync(path.join(state, 'sess-2.mode'), JSON.stringify({ mode: 'auto', at: 'not a date' }), 'utf-8');
  assert.deepEqual(readPermissionModeRecord('sess-2'), { mode: 'auto', at: null });
  assert.deepEqual(readPermissionModeRecord('sess-3'), { mode: null, at: null });
});

test('the session id comes from the environment when Claude Code exports it', (t) => {
  makeEnv(t);
  assert.equal(resolveSessionId({ env: { CLAUDE_CODE_SESSION_ID: 'sess-1' } }), 'sess-1');
});

// The desktop app and any other surface that does not export the session id still export the pid,
// and Claude Code writes a per-process descriptor naming the session it belongs to.
test('the session id falls back to the live per-process descriptor', (t) => {
  const { sessions } = makeEnv(t);
  writeSessionDescriptor(sessions, 4242, { pid: 4242, sessionId: 'sess-from-pid', entrypoint: 'cli' });
  assert.equal(resolveSessionId({ env: { CLAUDE_PID: '4242' } }), 'sess-from-pid');
  // The exported id still wins: it names the session directly, with no file to go stale.
  assert.equal(
    resolveSessionId({ env: { CLAUDE_CODE_SESSION_ID: 'sess-direct', CLAUDE_PID: '4242' } }),
    'sess-direct',
  );
});

test('no usable key reports no session rather than guessing one', (t) => {
  const { sessions } = makeEnv(t);
  writeSessionDescriptor(sessions, 4242, { pid: 4242, sessionId: 'sess-from-pid' });
  assert.equal(resolveSessionId({ env: {} }), null);
  assert.equal(resolveSessionId({ env: { CLAUDE_PID: '9999' } }), null);
  // A pid that is not a number must never be pasted into a path.
  assert.equal(resolveSessionId({ env: { CLAUDE_PID: '../../etc' } }), null);
  writeSessionDescriptor(sessions, 7, { pid: 7 });
  assert.equal(resolveSessionId({ env: { CLAUDE_PID: '7' } }), null);
});
