import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLock, releaseLock, LOCK_STALE_MS } from '../lib/single-instance-lock.mjs';

// Own BEEZI_HOME per test, restored afterwards, so no case can touch the developer's real ~/.beezi
// or leave the variable set for the rest of the file.
function makeHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-test-'));
  const prev = process.env.BEEZI_HOME;
  process.env.BEEZI_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_HOME;
    else process.env.BEEZI_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('first caller wins, second is refused', (t) => {
  makeHome(t);
  assert.strictEqual(acquireLock('cost-state-sync'), true);
  assert.strictEqual(acquireLock('cost-state-sync'), false);
});

test('release lets the next caller in', (t) => {
  makeHome(t);
  acquireLock('cost-state-sync');
  releaseLock('cost-state-sync');
  assert.strictEqual(acquireLock('cost-state-sync'), true);
});

test('a stale lock is broken', (t) => {
  const dir = makeHome(t);
  const lock = path.join(dir, 'cost-state-sync.lock');
  fs.mkdirSync(lock);
  const old = new Date(Date.now() - LOCK_STALE_MS - 1000);
  fs.utimesSync(lock, old, old);
  assert.strictEqual(acquireLock('cost-state-sync'), true);
});

test('a fresh lock is not broken', (t) => {
  const dir = makeHome(t);
  fs.mkdirSync(path.join(dir, 'cost-state-sync.lock'));
  assert.strictEqual(acquireLock('cost-state-sync'), false);
});

test('releasing a lock that is not held never throws', (t) => {
  makeHome(t);
  assert.doesNotThrow(() => releaseLock('cost-state-sync'));
});

test('uses rmdirSync, never rmSync — rmSync is Node 14.14+ and the floor is 13.2', (t) => {
  const dir = makeHome(t);
  fs.mkdirSync(path.join(dir, 'cost-state-sync.lock'));
  let usedRmdir = false;
  releaseLock('cost-state-sync', { rmdirSync: () => { usedRmdir = true; } });
  assert.strictEqual(usedRmdir, true);
});

// The entrypoint's contract, modelled without spawning it: a REFUSED child must leave the holder's
// lock alone. Releasing unconditionally would delete the running holder's directory and let a third
// window start scanning alongside it — exactly what the lock exists to prevent.
test('a refused caller that honours `held` leaves the holder lock in place', (t) => {
  const dir = makeHome(t);
  const lock = path.join(dir, 'cost-state-sync.lock');

  const holderHeld = acquireLock('cost-state-sync');
  assert.strictEqual(holderHeld, true);

  // Second window's child: refused, so it takes the early return and never releases.
  const refusedHeld = acquireLock('cost-state-sync');
  assert.strictEqual(refusedHeld, false);
  if (refusedHeld) releaseLock('cost-state-sync');

  assert.strictEqual(fs.existsSync(lock), true, 'refused child must not delete the holder lock');
});

// scripts/cost-state-sync.mjs is detached and unobserved, so the two properties that keep it from
// becoming an orphan are pinned by reading it rather than by running it: every exit path funnels
// through finish(), and finish() is where the watchdog is cleared and the lock conditionally
// released. A try/finally in main() cannot do either — the lock-refused path returns before any
// try would be entered, and a ref'd timer left running there holds the process open for 5 minutes.
const ENTRYPOINT = fs.readFileSync(
  fileURLToPath(new URL('../scripts/cost-state-sync.mjs', import.meta.url)),
  'utf8',
);

test('the entrypoint releases the lock only when it is held', () => {
  const releases = ENTRYPOINT.match(/releaseLock\(/g);
  assert.deepStrictEqual(releases, ['releaseLock('], 'exactly one release call');
  assert.match(ENTRYPOINT, /if \(held\) releaseLock\(/);
});

function bodyOf(source, header) {
  const start = source.indexOf(header);
  assert.ok(start >= 0, header + ' exists');
  return source.slice(start, source.indexOf('\n}', start));
}

test('the entrypoint clears the watchdog inside finish(), not in main', () => {
  assert.match(bodyOf(ENTRYPOINT, 'function finish('), /clearTimeout\(watchdog\)/);
  // A try/finally in main() cannot clear it: the lock-refused path returns before the try is
  // entered, and the ref'd timer then holds the process open for its full five minutes.
  const main = bodyOf(ENTRYPOINT, 'async function main(');
  assert.ok(!/\bfinally\b/.test(main), 'main() must not own the teardown');
  assert.ok(!/clearTimeout/.test(main));
});

test('the entrypoint routes crashes through finish()', () => {
  assert.match(ENTRYPOINT, /uncaughtException[\s\S]{0,60}finish\(0\)/);
  assert.match(ENTRYPOINT, /unhandledRejection[\s\S]{0,60}finish\(0\)/);
  // Both settlement paths, so a rejected main() exits too.
  assert.match(ENTRYPOINT, /main\(\)[\s\S]{0,80}finish\(0\)[\s\S]{0,40}finish\(0\)/);
});

test('the entrypoint never uses fs.rmSync', () => {
  assert.ok(!/\brmSync\b/.test(ENTRYPOINT));
});
