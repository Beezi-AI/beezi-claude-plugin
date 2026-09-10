import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

function withHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-trigger-'));
  const prev = process.env.BEEZI_HOME;
  process.env.BEEZI_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_HOME; else process.env.BEEZI_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

let tag = 0;
async function load(grant, pending) {
  const suffix = `?t${tag++}`;
  const consent = await import(`../lib/telemetry-consent.mjs${suffix}`);
  if (grant) consent.grantConsent();
  if (pending) {
    const dir = path.join(process.env.BEEZI_HOME, 'telemetry');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.json'), '{}');
  }
  return import(`../lib/diagnostics-trigger.mjs${suffix}`);
}

test('nothing is spawned without consent, however much is queued', async (t) => {
  withHome(t);
  const { maybeSpawnDiagnostics } = await load(false, true);
  let spawned = 0;
  assert.equal(maybeSpawnDiagnostics({ spawnImpl: () => { spawned += 1; return { unref() {} }; } }), false);
  assert.equal(spawned, 0);
});

test('nothing is spawned when there is nothing to deliver', async (t) => {
  withHome(t);
  const { maybeSpawnDiagnostics } = await load(true, false);
  let spawned = 0;
  assert.equal(maybeSpawnDiagnostics({ spawnImpl: () => { spawned += 1; return { unref() {} }; } }), false);
  assert.equal(spawned, 0);
});

test('a consented machine with pending reports spawns the worker, needing no token', async (t) => {
  withHome(t);
  const { maybeSpawnDiagnostics } = await load(true, true);
  const calls = [];
  assert.equal(maybeSpawnDiagnostics({
    spawnImpl: (bin, args) => { calls.push({ bin, args }); return { unref() {} }; },
    now: () => 1000,
  }), true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].args[0], /scripts[/\\]diagnostics-worker\.mjs$/);
  assert.deepEqual(calls[0].args.slice(1), [], 'argv carries nothing at all');
});

test('the second hook of the same turn does not spawn a second worker', async (t) => {
  withHome(t);
  const { maybeSpawnDiagnostics } = await load(true, true);
  let spawned = 0;
  const deps = { spawnImpl: () => { spawned += 1; return { unref() {} }; }, now: () => 1000 };
  maybeSpawnDiagnostics(deps);
  maybeSpawnDiagnostics(deps);
  maybeSpawnDiagnostics({ ...deps, now: () => 1000 + 59999 });
  assert.equal(spawned, 1, 'the window is claimed before the spawn');
  maybeSpawnDiagnostics({ ...deps, now: () => 1000 + 60000 });
  assert.equal(spawned, 2, 'and released a minute later');
});
