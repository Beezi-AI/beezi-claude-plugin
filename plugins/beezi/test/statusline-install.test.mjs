import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  installStatusline,
  uninstallStatusline,
  statuslineShimFile,
  statuslineCaptureDetached,
} from '../lib/statusline-install.mjs';

function useTmpDirs(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-install-test-'));
  const beezi = path.join(root, 'beezi-home');
  const claude = path.join(root, 'claude-home');
  fs.mkdirSync(claude, { recursive: true });
  process.env.BEEZI_HOME = beezi;
  process.env.CLAUDE_CONFIG_DIR = claude;
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.CLAUDE_CONFIG_DIR;
  });
  return { beezi, claude, settings: path.join(claude, 'settings.json') };
}

// A believable cache path, so the shim's version glob resolves against sibling dirs.
// Pin the platform: these exercise the POSIX shim, and an unpinned process.platform made every
// one of them assert Linux behaviour against whatever host ran them. The win32 cases below pin
// theirs the same way.
const deps = { selfPath: '/cache/mp/beezi/1.0.0/lib/statusline-install.mjs', platform: 'linux' };

const readSettings = (p) => JSON.parse(fs.readFileSync(p, 'utf-8'));

test('installStatusline — machine with no status line gets the shim and keeps a null original', (t) => {
  const { settings } = useTmpDirs(t);
  const r = installStatusline(deps);
  assert.equal(r.ok, true);

  const written = readSettings(settings);
  assert.deepEqual(written.statusLine, { type: 'command', command: statuslineShimFile('linux') });

  const shim = fs.readFileSync(statuslineShimFile('linux'), 'utf-8');
  assert.match(shim, /statusline\.mjs/);
  assert.ok(!shim.includes('BEEZI_STATUSLINE_CHAIN'), 'nothing to chain');
  // Keyed to the HOST, not the injected platform: NTFS has no POSIX execute bit, so chmod(0o755)
  // is a no-op on Windows and the mode always reads back without it. The bit still matters on a
  // real POSIX machine — Claude Code execs the shim directly — so the check runs wherever it can.
  if (process.platform !== 'win32') {
    assert.ok(fs.statSync(statuslineShimFile('linux')).mode & 0o100, 'shim is executable');
  }
});

test('installStatusline — wraps an existing status line and preserves it for uninstall', (t) => {
  const { settings } = useTmpDirs(t);
  const prior = { type: 'command', command: "~/bin/my-line.sh --style 'fancy'", padding: 1 };
  fs.writeFileSync(settings, JSON.stringify({ statusLine: prior, model: 'opus' }));

  const r = installStatusline(deps);
  assert.equal(r.ok, true);

  const written = readSettings(settings);
  assert.equal(written.statusLine.command, statuslineShimFile('linux'));
  assert.equal(written.statusLine.padding, 1, 'padding survives the wrap');
  assert.equal(written.model, 'opus', 'unrelated settings survive');

  const shim = fs.readFileSync(statuslineShimFile('linux'), 'utf-8');
  assert.ok(shim.includes("BEEZI_STATUSLINE_CHAIN='~/bin/my-line.sh --style '\\''fancy'\\'''"),
    'chain embedded with single quotes escaped');
});

test('installStatusline — re-running never chains the shim onto itself', (t) => {
  const { settings } = useTmpDirs(t);
  const prior = { type: 'command', command: '~/bin/my-line.sh' };
  fs.writeFileSync(settings, JSON.stringify({ statusLine: prior }));

  installStatusline(deps);
  const r = installStatusline(deps);
  assert.equal(r.ok, true);
  assert.match(r.message, /already/);

  const shim = fs.readFileSync(statuslineShimFile('linux'), 'utf-8');
  assert.ok(shim.includes("BEEZI_STATUSLINE_CHAIN='~/bin/my-line.sh'"), 'chain is still the ORIGINAL command');
  assert.ok(!shim.includes('statusline.sh'), 'shim never chains a beezi shim');
});

test('installStatusline — unparseable settings.json is left untouched', (t) => {
  const { settings } = useTmpDirs(t);
  fs.writeFileSync(settings, '{ not json');
  const r = installStatusline(deps);
  assert.equal(r.ok, false);
  assert.equal(fs.readFileSync(settings, 'utf-8'), '{ not json');
});

test('installStatusline — Windows gets a PowerShell shim behind a pinned powershell.exe', (t) => {
  const { settings } = useTmpDirs(t);
  const prior = { type: 'command', command: 'C:\\tools\\my-line.cmd', padding: 0 };
  fs.writeFileSync(settings, JSON.stringify({ statusLine: prior }));

  const winDeps = { ...deps, platform: 'win32', env: { SystemRoot: 'C:\\Windows' } };
  const r = installStatusline(winDeps);
  assert.equal(r.ok, true);

  const shimPath = statuslineShimFile('win32');
  assert.match(shimPath, /statusline\.ps1$/);
  const written = readSettings(settings);
  assert.match(written.statusLine.command, /^"C:\\Windows[/\\]System32[/\\]WindowsPowerShell[/\\]v1\.0[/\\]powershell\.exe" -NoProfile -ExecutionPolicy Bypass -File "/,
    'powershell path is pinned, never bare');
  assert.ok(written.statusLine.command.includes(`"${shimPath}"`));
  assert.equal(written.statusLine.padding, 0, 'padding survives the wrap');

  const shim = fs.readFileSync(shimPath, 'utf-8');
  assert.ok(shim.includes("$chain = 'C:\\tools\\my-line.cmd'"), 'chain embedded for node and fallback paths');
  assert.match(shim, /statusline\.mjs/);
});

test('installStatusline — Windows re-run is idempotent and keeps the original chain', (t) => {
  const { settings } = useTmpDirs(t);
  const prior = { type: 'command', command: 'C:\\tools\\my-line.cmd' };
  fs.writeFileSync(settings, JSON.stringify({ statusLine: prior }));

  const winDeps = { ...deps, platform: 'win32', env: { SystemRoot: 'C:\\Windows' } };
  installStatusline(winDeps);
  const r = installStatusline(winDeps);
  assert.equal(r.ok, true);
  assert.match(r.message, /already/);

  const shim = fs.readFileSync(statuslineShimFile('win32'), 'utf-8');
  assert.ok(shim.includes("$chain = 'C:\\tools\\my-line.cmd'"), 'chain is still the ORIGINAL command');
});

test('uninstallStatusline — restores the wrapped status line on Windows', (t) => {
  const { settings } = useTmpDirs(t);
  const prior = { type: 'command', command: 'C:\\tools\\my-line.cmd' };
  fs.writeFileSync(settings, JSON.stringify({ statusLine: prior }));

  const winDeps = { ...deps, platform: 'win32', env: { SystemRoot: 'C:\\Windows' } };
  installStatusline(winDeps);
  const r = uninstallStatusline({ platform: 'win32' });
  assert.equal(r.ok, true);
  assert.deepEqual(readSettings(settings).statusLine, prior);
  assert.equal(fs.existsSync(statuslineShimFile('win32')), false);
});

test('uninstallStatusline — restores the wrapped status line', (t) => {
  const { settings } = useTmpDirs(t);
  const prior = { type: 'command', command: '~/bin/my-line.sh' };
  fs.writeFileSync(settings, JSON.stringify({ statusLine: prior }));
  installStatusline(deps);

  const r = uninstallStatusline({ platform: 'linux' });
  assert.equal(r.ok, true);
  assert.deepEqual(readSettings(settings).statusLine, prior);
  assert.equal(fs.existsSync(statuslineShimFile('linux')), false);
});

test('uninstallStatusline — a machine that had no status line ends with none', (t) => {
  const { settings } = useTmpDirs(t);
  installStatusline(deps);
  uninstallStatusline({ platform: 'linux' });
  assert.equal(readSettings(settings).statusLine, undefined);
});

test('uninstallStatusline — a status line the user changed since is not touched', (t) => {
  const { settings } = useTmpDirs(t);
  installStatusline(deps);
  const theirs = { type: 'command', command: '~/bin/new-line.sh' };
  fs.writeFileSync(settings, JSON.stringify({ statusLine: theirs }));

  const r = uninstallStatusline({ platform: 'linux' });
  assert.equal(r.ok, true);
  assert.deepEqual(readSettings(settings).statusLine, theirs);
  assert.equal(fs.existsSync(statuslineShimFile('linux')), false, 'shim still cleaned up');
});

// Dev machines run several Beezi variants (~/.beezi, ~/.beezi-staging, ~/.beezi-local). Each keeps
// its own statusline-original.json, so a variant installing over another variant's shim has to
// inherit that record instead of reading the shim as "nothing to wrap".
function variant(root, name, statusLine) {
  const home = path.join(root, name);
  fs.mkdirSync(home, { recursive: true });
  const shim = path.join(home, 'statusline.sh');
  fs.writeFileSync(shim, '#!/bin/sh\n');
  if (statusLine !== undefined) {
    fs.writeFileSync(path.join(home, 'statusline-original.json'), JSON.stringify({ statusLine }));
  }
  return shim;
}

test("installStatusline — inherits the original from another variant's shim", (t) => {
  const { beezi, settings } = useTmpDirs(t);
  const theirs = { type: 'command', command: '~/.claude/statusline.sh', padding: 1 };
  const stagingShim = variant(path.dirname(beezi), '.beezi-staging', theirs);
  fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: stagingShim, padding: 1 } }));

  const r = installStatusline(deps);
  assert.equal(r.ok, true);
  assert.match(r.message, /wrapped/);

  const shim = fs.readFileSync(statuslineShimFile('linux'), 'utf-8');
  assert.ok(shim.includes("BEEZI_STATUSLINE_CHAIN='~/.claude/statusline.sh'"),
    'chain inherited from the sibling variant');
  const stored = JSON.parse(fs.readFileSync(path.join(beezi, 'statusline-original.json'), 'utf-8'));
  assert.deepEqual(stored.statusLine, theirs, 'uninstall would restore the real line, not a shim');
});

test('installStatusline — recovers an original a previous install dropped', (t) => {
  const { beezi } = useTmpDirs(t);
  const theirs = { type: 'command', command: '~/.claude/statusline.sh', padding: 1 };
  variant(path.dirname(beezi), '.beezi-staging', theirs);
  installStatusline(deps);
  fs.rmSync(path.join(beezi, 'statusline-original.json'));

  const r = installStatusline(deps);
  assert.equal(r.ok, true);

  const shim = fs.readFileSync(statuslineShimFile('linux'), 'utf-8');
  assert.ok(shim.includes("BEEZI_STATUSLINE_CHAIN='~/.claude/statusline.sh'"),
    'chain recovered from the sibling record');
  const stored = JSON.parse(fs.readFileSync(path.join(beezi, 'statusline-original.json'), 'utf-8'));
  assert.deepEqual(stored.statusLine, theirs);
});

test('installStatusline — variants pointing at each other never loop', (t) => {
  const { beezi, settings } = useTmpDirs(t);
  const root = path.dirname(beezi);
  const aShim = path.join(root, '.beezi-a', 'statusline.sh');
  const bShim = variant(root, '.beezi-b', { type: 'command', command: aShim });
  variant(root, '.beezi-a', { type: 'command', command: bShim });
  fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: aShim } }));

  const r = installStatusline(deps);
  assert.equal(r.ok, true);
  const shim = fs.readFileSync(statuslineShimFile('linux'), 'utf-8');
  assert.ok(!shim.includes('BEEZI_STATUSLINE_CHAIN'), 'a cycle of shims resolves to nothing to wrap');
});

// statuslineCaptureDetached — the wrapper is a settings.json entry that /statusline, the
// statusline-setup agent or a hand-edit can replace at any time, taking live capture with it.

test('statuslineCaptureDetached — a machine that never installed is not nagged', (t) => {
  const { settings } = useTmpDirs(t);
  fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: '~/my-line.sh' } }));
  assert.equal(statuslineCaptureDetached({ platform: 'linux' }), false);
});

test('statuslineCaptureDetached — settings still pointing at our shim reads as attached', (t) => {
  useTmpDirs(t);
  installStatusline(deps);
  assert.equal(statuslineCaptureDetached({ platform: 'linux' }), false);
});

test('statuslineCaptureDetached — a status line set after install reads as detached', (t) => {
  const { settings } = useTmpDirs(t);
  installStatusline(deps);
  // What /statusline writes: the shim is gone from settings, our original record is not.
  fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: '~/.claude/my-new-line.sh' } }));
  assert.equal(statuslineCaptureDetached({ platform: 'linux' }), true);
});

test('statuslineCaptureDetached — a status line REMOVED after install reads as detached', (t) => {
  const { settings } = useTmpDirs(t);
  installStatusline(deps);
  fs.writeFileSync(settings, JSON.stringify({ model: 'opus' }));
  assert.equal(statuslineCaptureDetached({ platform: 'linux' }), true);
});

test('statuslineCaptureDetached — another variant taking over is still capture, not detachment', (t) => {
  const { beezi, settings } = useTmpDirs(t);
  installStatusline(deps);
  // A second Beezi variant installs over us: its shim runs the capture, so ours must stay quiet.
  const sibling = variant(path.dirname(beezi), '.beezi-staging', { type: 'command', command: statuslineShimFile('linux') });
  fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: sibling } }));
  assert.equal(statuslineCaptureDetached({ platform: 'linux' }), false);
});

test('statuslineCaptureDetached — an unreadable settings.json is never reported as detached', (t) => {
  const { settings } = useTmpDirs(t);
  installStatusline(deps);
  fs.writeFileSync(settings, '{ not json');
  assert.equal(statuslineCaptureDetached({ platform: 'linux' }), false);
});

// Dev machines run several Beezi variants (~/.beezi, ~/.beezi-staging, ~/.beezi-local). Each keeps
// its own statusline-original.json, so a variant installing over another variant's shim has to
// inherit that record instead of reading the shim as "nothing to wrap".
function variant(root, name, statusLine) {
  const home = path.join(root, name);
  fs.mkdirSync(home, { recursive: true });
  const shim = path.join(home, 'statusline.sh');
  fs.writeFileSync(shim, '#!/bin/sh\n');
  if (statusLine !== undefined) {
    fs.writeFileSync(path.join(home, 'statusline-original.json'), JSON.stringify({ statusLine }));
  }
  return shim;
}

test("installStatusline — inherits the original from another variant's shim", (t) => {
  const { beezi, settings } = useTmpDirs(t);
  const theirs = { type: 'command', command: '~/.claude/statusline.sh', padding: 1 };
  const stagingShim = variant(path.dirname(beezi), '.beezi-staging', theirs);
  fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: stagingShim, padding: 1 } }));

  const r = installStatusline(deps);
  assert.equal(r.ok, true);
  assert.match(r.message, /wrapped/);

  const shim = fs.readFileSync(statuslineShimFile(), 'utf-8');
  assert.ok(shim.includes("BEEZI_STATUSLINE_CHAIN='~/.claude/statusline.sh'"),
    'chain inherited from the sibling variant');
  const stored = JSON.parse(fs.readFileSync(path.join(beezi, 'statusline-original.json'), 'utf-8'));
  assert.deepEqual(stored.statusLine, theirs, 'uninstall would restore the real line, not a shim');
});

test('installStatusline — recovers an original a previous install dropped', (t) => {
  const { beezi } = useTmpDirs(t);
  const theirs = { type: 'command', command: '~/.claude/statusline.sh', padding: 1 };
  variant(path.dirname(beezi), '.beezi-staging', theirs);
  installStatusline(deps);
  fs.rmSync(path.join(beezi, 'statusline-original.json'));

  const r = installStatusline(deps);
  assert.equal(r.ok, true);

  const shim = fs.readFileSync(statuslineShimFile(), 'utf-8');
  assert.ok(shim.includes("BEEZI_STATUSLINE_CHAIN='~/.claude/statusline.sh'"),
    'chain recovered from the sibling record');
  const stored = JSON.parse(fs.readFileSync(path.join(beezi, 'statusline-original.json'), 'utf-8'));
  assert.deepEqual(stored.statusLine, theirs);
});

test('installStatusline — variants pointing at each other never loop', (t) => {
  const { beezi, settings } = useTmpDirs(t);
  const root = path.dirname(beezi);
  const aShim = path.join(root, '.beezi-a', 'statusline.sh');
  const bShim = variant(root, '.beezi-b', { type: 'command', command: aShim });
  variant(root, '.beezi-a', { type: 'command', command: bShim });
  fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: aShim } }));

  const r = installStatusline(deps);
  assert.equal(r.ok, true);
  const shim = fs.readFileSync(statuslineShimFile(), 'utf-8');
  assert.ok(!shim.includes('BEEZI_STATUSLINE_CHAIN'), 'a cycle of shims resolves to nothing to wrap');
});
