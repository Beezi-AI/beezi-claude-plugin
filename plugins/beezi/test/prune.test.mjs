import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pruneStale } from '../lib/prune.mjs';

// ─── helpers ────────────────────────────────────────────────────────────────

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setHome(dir) {
  process.env.BEEZI_HOME = dir;
}

function stateDir(homeDir) {
  return path.join(homeDir, 'state');
}

function queueDir(homeDir) {
  return path.join(homeDir, 'queue');
}

function writeFile(dir, name, content = '{}') {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

function ageFile(p, ageMs, now = Date.now()) {
  // utimesSync takes seconds
  const timeSec = (now - ageMs) / 1000;
  fs.utimesSync(p, timeSec, timeSec);
}

// ─── test 1: prunes old state file ──────────────────────────────────────────

test('1. prunes old state file (mtime 15 days ago)', (t) => {
  const homeDir = makeTmpDir(t);
  setHome(homeDir);

  const now = Date.now();
  const fifteenDaysMs = 15 * 24 * 60 * 60 * 1000;

  const p = writeFile(stateDir(homeDir), 'old.json');
  ageFile(p, fifteenDaysMs, now);

  pruneStale(now);

  assert.equal(fs.existsSync(p), false, 'old state file must be pruned');
});

// ─── test 2: keeps recent state file ────────────────────────────────────────

test('2. keeps recent state file (mtime now)', (t) => {
  const homeDir = makeTmpDir(t);
  setHome(homeDir);

  const now = Date.now();

  const p = writeFile(stateDir(homeDir), 'fresh.json');
  ageFile(p, 0, now); // mtime = now

  pruneStale(now);

  assert.equal(fs.existsSync(p), true, 'recent state file must be kept');
});

// ─── test 3: prunes old queue file, keeps recent queue file ─────────────────

test('3. prunes old queue file, keeps recent queue file', (t) => {
  const homeDir = makeTmpDir(t);
  setHome(homeDir);

  const now = Date.now();
  const fifteenDaysMs = 15 * 24 * 60 * 60 * 1000;

  const qd = queueDir(homeDir);
  const oldFile = writeFile(qd, 'old-seg.json');
  const recentFile = writeFile(qd, 'recent-seg.json');

  ageFile(oldFile, fifteenDaysMs, now);
  ageFile(recentFile, 0, now);

  pruneStale(now);

  assert.equal(fs.existsSync(oldFile), false, 'old queue file must be pruned');
  assert.equal(fs.existsSync(recentFile), true, 'recent queue file must be kept');
});

// ─── test 4: missing dirs → no throw ────────────────────────────────────────

test('4. missing dirs → no throw', (t) => {
  const homeDir = makeTmpDir(t);
  setHome(homeDir);
  // Neither state/ nor queue/ exist in homeDir

  assert.doesNotThrow(() => pruneStale(Date.now()));
});

// ─── test 5: custom maxAgeMs boundary ────────────────────────────────────────

test('5. custom maxAgeMs boundary — 2-day-old file pruned at 1d, kept at 3d', (t) => {
  const now = Date.now();
  const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
  const oneDayMs = 1 * 24 * 60 * 60 * 1000;
  const threeDaysMs = 3 * 24 * 60 * 60 * 1000;

  // ── scenario A: maxAgeMs = 1 day → file aged 2 days should be pruned ──
  const homeDirA = makeTmpDir(t);
  process.env.BEEZI_HOME = homeDirA;

  const pA = writeFile(stateDir(homeDirA), 'file-a.json');
  ageFile(pA, twoDaysMs, now);

  pruneStale(now, oneDayMs);
  assert.equal(fs.existsSync(pA), false, '2-day-old file pruned with maxAgeMs=1day');

  // ── scenario B: maxAgeMs = 3 days → file aged 2 days should be kept ──
  const homeDirB = makeTmpDir(t);
  process.env.BEEZI_HOME = homeDirB;

  const pB = writeFile(stateDir(homeDirB), 'file-b.json');
  ageFile(pB, twoDaysMs, now);

  pruneStale(now, threeDaysMs);
  assert.equal(fs.existsSync(pB), true, '2-day-old file kept with maxAgeMs=3days');
});
