import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fork } from 'child_process';
import { fileURLToPath } from 'url';
import { readJson, readJsonSalvaged, writeJsonSecure } from '../lib/fs-store.mjs';

const STORE = fileURLToPath(new URL('../lib/fs-store.mjs', import.meta.url));

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-fs-store-'));
}

test('round-trips an object and keeps the file 0600', (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'nested', 'state.json');

  writeJsonSecure(file, { hello: 'world' });
  assert.deepEqual(readJson(file), { hello: 'world' });
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'payloads carry prompt text and refresh tokens');
  }
});

test('an overwrite stays 0600 and leaves no temp files behind', (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');

  writeJsonSecure(file, { long: 'x'.repeat(500) });
  writeJsonSecure(file, { short: 1 });
  assert.deepEqual(readJson(file), { short: 1 });
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  assert.deepEqual(fs.readdirSync(dir), ['state.json'], 'no stray temp file survives a write');
});

test('readJson returns the fallback rather than throwing on unreadable content', (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'broken.json');
  fs.writeFileSync(file, '{"a":1}trailing');
  assert.equal(readJson(file, 'fallback'), 'fallback');
  assert.equal(readJson(path.join(dir, 'missing.json'), null), null);
});

// The bug this file exists for: two hook processes enqueue the SAME queue/<segmentId>.json at
// once (seven hook events call runCheckpoint, and parallel SubagentStop hooks fire together).
// A plain writeFileSync opens with O_TRUNC and writes as two steps, so when both processes
// truncate before either writes, the shorter payload lands on top of the longer one and its
// tail survives past the closing brace. The file then never parses, flushQueue skips it
// forever, and that session's analytics are lost in silence.
test('concurrent writers never leave the target unparseable', { timeout: 60_000 }, async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const worker = path.join(dir, 'worker.mjs');
  fs.writeFileSync(worker, `
    import { writeJsonSecure } from ${JSON.stringify(STORE)};
    process.on('message', (msg) => {
      writeJsonSecure(msg.target, msg.payload);
      process.send('done');
    });
    process.send('ready');
  `);

  const start = (idx) => new Promise((resolve) => {
    const child = fork(worker, [], { env: { ...process.env, WORKER: String(idx) }, stdio: 'ignore' });
    child.once('message', () => resolve(child));
  });
  const workers = [await start(0), await start(1)];
  t.after(() => workers.forEach((w) => w.kill()));

  // Different lengths on purpose — the real collision is a payload that drops the context/stats
  // fields landing over one that carries them.
  const long = { segmentId: 's:1-2', stats: { filler: 'x'.repeat(400) }, context_final_model: 'claude-opus-5' };
  const short = { segmentId: 's:1-2', stats: { filler: 'x'.repeat(40) } };

  const ROUNDS = 150;
  const damaged = [];
  for (let round = 0; round < ROUNDS; round++) {
    const target = path.join(dir, `seg-${round}.json`);
    await Promise.all(workers.map((w, i) => new Promise((resolve) => {
      w.once('message', resolve);
      w.send({ target, payload: i === 0 ? long : short });
    })));
    const raw = fs.readFileSync(target, 'utf8');
    try {
      JSON.parse(raw);
    } catch (error) {
      damaged.push(`round ${round}: ${error.message} :: ${raw.slice(-60)}`);
    }
  }

  assert.deepEqual(damaged, [], `${damaged.length}/${ROUNDS} rounds produced a file that will not parse`);
});

test('readJsonSalvaged recovers the payload hiding under trailing wreckage', (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'seg.json');

  // A complete object followed by the tail of a longer previous write — the real corruption.
  const good = JSON.stringify({ segmentId: 's:1-2', note: 'brace } and "quote" inside' });
  fs.writeFileSync(file, good + '65070,"context_final_model":"claude-opus-5"}');

  const { value, salvaged } = readJsonSalvaged(file);
  assert.equal(salvaged, true);
  assert.equal(value.segmentId, 's:1-2');
  assert.equal(value.note, 'brace } and "quote" inside', 'braces inside strings do not end the scan');
});

// The bug: a write failure schedules a telemetry report via recordIssue, which itself writes
// through writeJsonSecure. If THAT write also fails (e.g. the telemetry dir is unwritable), the
// old code scheduled another report, which failed, which scheduled another — forever, spinning
// the microtask queue instead of ever letting a timer fire. Reproduced upstream as a 1s timer
// that never fired in 5s.
test('a write failure inside the telemetry directory reports once and never starves the event loop', {
  skip: process.platform === 'win32' ? 'chmod-based write denial is not meaningful on win32' : false,
}, async (t) => {
  const dir = tmpDir();
  t.after(() => {
    try { fs.chmodSync(path.join(dir, 'telemetry'), 0o700); } catch { /* best-effort */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const prevHome = process.env.BEEZI_HOME;
  process.env.BEEZI_HOME = dir;
  t.after(() => {
    if (prevHome === undefined) delete process.env.BEEZI_HOME; else process.env.BEEZI_HOME = prevHome;
  });

  const { grantConsent } = await import('../lib/telemetry-consent.mjs?recursion');
  grantConsent();

  const telemetryDirPath = path.join(dir, 'telemetry');
  fs.mkdirSync(telemetryDirPath, { recursive: true });
  fs.chmodSync(telemetryDirPath, 0o500); // read + execute only: no new file can be created inside

  const { writeJsonSecure } = await import('../lib/fs-store.mjs?recursion');

  let timerFired = false;
  const timer = setTimeout(() => { timerFired = true; }, 20);

  assert.throws(() => writeJsonSecure(path.join(telemetryDirPath, 'blocked.json'), { a: 1 }));

  await new Promise((resolve) => setTimeout(resolve, 300));
  clearTimeout(timer);
  assert.equal(timerFired, true, 'the event loop kept processing timers instead of spinning on retries');
});

test('readJsonSalvaged leaves clean files untouched and gives up on junk', (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const clean = path.join(dir, 'clean.json');
  writeJsonSecure(clean, { a: 1 });
  assert.deepEqual(readJsonSalvaged(clean), { value: { a: 1 }, salvaged: false });

  const junk = path.join(dir, 'junk.json');
  fs.writeFileSync(junk, 'not json at all');
  assert.deepEqual(readJsonSalvaged(junk), { value: null, salvaged: false });

  assert.deepEqual(readJsonSalvaged(path.join(dir, 'missing.json')), { value: null, salvaged: false });
});
