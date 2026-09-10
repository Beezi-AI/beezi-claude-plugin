import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probeStateWritable, preflightLogin } from '../lib/login-preflight.mjs';

// Point beeziHome() and claudeProjectsDir() at temp roots for the duration of one test.
function makeEnv(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-home-'));
  const claude = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-claude-'));
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
  return { beeziHome: process.env.BEEZI_HOME, projects: path.join(claude, 'projects') };
}

function writeSessionTranscript(projects, sessionId, mode) {
  const dir = path.join(projects, 'C--some-project');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    JSON.stringify({ type: 'permission-mode', permissionMode: mode }),
    'utf-8',
  );
}

test('the probe creates the state dir when it is missing and leaves no probe file behind', (t) => {
  const { beeziHome } = makeEnv(t);
  assert.equal(fs.existsSync(beeziHome), false);
  const probe = probeStateWritable();
  assert.equal(probe.ok, true);
  assert.equal(probe.code, null);
  assert.equal(fs.existsSync(beeziHome), true);
  assert.deepEqual(fs.readdirSync(beeziHome), []);
});

test('the probe reports the errno when the state dir cannot be written', (t) => {
  makeEnv(t);
  // A file where the state DIRECTORY belongs: mkdirSync fails the same way a sandbox denial does,
  // without needing platform-specific permission bits.
  const blocked = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-blocked-'));
  const asFile = path.join(blocked, 'beezi');
  fs.writeFileSync(asFile, 'not a directory', 'utf-8');
  process.env.BEEZI_HOME = asFile;
  t.after(() => fs.rmSync(blocked, { recursive: true, force: true }));

  const probe = probeStateWritable();
  assert.equal(probe.ok, false);
  assert.equal(probe.dir, asFile);
  assert.equal(typeof probe.code, 'string');
  assert.notEqual(probe.code, 'unknown');
});

// The sandbox case, which is the one this probe exists for: ~/.beezi already exists (this machine
// logged in before), so the recursive mkdir is a no-op and the denial lands on the WRITE. chmod
// does not deny writes on Windows, so the failure is injected instead of staged on disk.
test('a denied write inside an existing state dir is reported with its errno', (t) => {
  const { beeziHome } = makeEnv(t);
  fs.mkdirSync(beeziHome, { recursive: true });
  t.mock.method(fs, 'writeFileSync', () => {
    const error = new Error('operation not permitted');
    error.code = 'EPERM';
    throw error;
  });
  const probe = probeStateWritable();
  assert.deepEqual(probe, { ok: false, dir: beeziHome, code: 'EPERM' });
});

test('a thrown value with no errno still reports a blocked probe', (t) => {
  const { beeziHome } = makeEnv(t);
  fs.mkdirSync(beeziHome, { recursive: true });
  t.mock.method(fs, 'writeFileSync', () => { throw new Error('no code on this one'); });
  assert.deepEqual(probeStateWritable(), { ok: false, dir: beeziHome, code: 'unknown' });
});

// Observed on a real machine: auto mode's classifier allowed the sign-in and then denied
// billing-capture.mjs, leaving it linked with no plan captured. Blocking before Step 1 is the
// only way to avoid that half-linked state.
test('auto mode blocks before the probe runs, so it never creates the state dir', (t) => {
  const { projects, beeziHome } = makeEnv(t);
  writeSessionTranscript(projects, 'sess-auto', 'auto');
  const result = preflightLogin({ env: { CLAUDE_CODE_SESSION_ID: 'sess-auto' } });
  assert.deepEqual(result, { ok: false, reason: 'auto_mode', mode: 'auto', dir: null, code: null });
  assert.equal(fs.existsSync(beeziHome), false);
});

test('a mode that blocks nothing reaches the probe and passes', (t) => {
  const { projects, beeziHome } = makeEnv(t);
  writeSessionTranscript(projects, 'sess-ok', 'dontAsk');
  assert.deepEqual(preflightLogin({ env: { CLAUDE_CODE_SESSION_ID: 'sess-ok' } }), {
    ok: true,
    reason: null,
    mode: 'dontAsk',
    dir: beeziHome,
    code: null,
  });
});

test('plan mode blocks before the probe runs, so it never creates the state dir', (t) => {
  const { projects, beeziHome } = makeEnv(t);
  writeSessionTranscript(projects, 'sess-plan', 'plan');
  const result = preflightLogin({ env: { CLAUDE_CODE_SESSION_ID: 'sess-plan' } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'plan_mode');
  assert.equal(result.mode, 'plan');
  assert.equal(fs.existsSync(beeziHome), false);
});

test('an unwritable state dir blocks a mode that is otherwise fine', (t) => {
  const { projects } = makeEnv(t);
  writeSessionTranscript(projects, 'sess-ok', 'acceptEdits');
  const blocked = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-blocked-'));
  const asFile = path.join(blocked, 'beezi');
  fs.writeFileSync(asFile, 'not a directory', 'utf-8');
  process.env.BEEZI_HOME = asFile;
  t.after(() => fs.rmSync(blocked, { recursive: true, force: true }));

  const result = preflightLogin({ env: { CLAUDE_CODE_SESSION_ID: 'sess-ok' } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'state_unwritable');
  assert.equal(result.dir, asFile);
});

test('an undetectable permission mode still passes when the state dir is writable', (t) => {
  makeEnv(t);
  const result = preflightLogin({ env: {} });
  assert.equal(result.ok, true);
  assert.equal(result.mode, null);
});
