// The credential lock reclaims a lock when the pid is alive but started at a different time, so a
// mis-parsed number here strips a live holder. A null is always safe: the caller reads it as alive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processStartTime, ownStartTime } from '../lib/process-start-time.mjs';

const NOW = Math.round(Date.now() / 1000);
const psRun = (out) => () => out;

test('ps elapsed time is turned into an epoch start, in every field width', () => {
  const at = (etime) => processStartTime(123, { platform: 'darwin', run: psRun(`${etime}\n`) });
  assert.ok(Math.abs(at('00:30') - (NOW - 30)) <= 1, 'mm:ss');
  assert.ok(Math.abs(at('02:03') - (NOW - 123)) <= 1, 'mm:ss');
  assert.ok(Math.abs(at('01:02:03') - (NOW - 3723)) <= 1, 'hh:mm:ss');
  assert.ok(Math.abs(at('1-02:03:04') - (NOW - 93784)) <= 1, 'dd-hh:mm:ss');
});

test('unparseable or failed ps output is null, never a guess', () => {
  const at = (out) => processStartTime(123, { platform: 'darwin', run: psRun(out) });
  assert.equal(at('nonsense\n'), null);
  assert.equal(at(''), null);
  assert.equal(at(null), null, 'the spawn failed or timed out');
});

test('a Windows FILETIME becomes epoch seconds', () => {
  // 2023-11-14T22:13:20Z = epoch 1700000000.
  const filetime = (1700000000 + 11644473600) * 1e7;
  const started = processStartTime(123, { platform: 'win32', run: psRun(`${filetime}\r\n`) });
  assert.equal(started, 1700000000);
  assert.equal(processStartTime(123, { platform: 'win32', run: psRun(null) }), null);
});

test('a pid that is not a positive integer never spawns anything', () => {
  const run = () => { throw new Error('must not spawn'); };
  for (const pid of [0, -1, 1.5, null, undefined, '123']) {
    assert.equal(processStartTime(pid, { platform: 'darwin', run }), null);
  }
});

test('ownStartTime is this process, in the same units the probe returns', () => {
  const own = ownStartTime();
  assert.ok(Number.isInteger(own));
  assert.ok(own <= NOW && own > NOW - 86400 * 365, 'a plausible epoch second');
});
