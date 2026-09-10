import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function withHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-install-'));
  const prev = process.env.BEEZI_HOME;
  process.env.BEEZI_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_HOME; else process.env.BEEZI_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

let tag = 0;
async function load(mode) {
  const suffix = `?i${tag++}`;
  const consent = await import(`../lib/telemetry-consent.mjs${suffix}`);
  if (mode === 'anonymous') consent.grantConsent();
  if (mode === 'correlate') consent.grantCorrelation();
  return {
    consent,
    id: await import(`../lib/installation-id.mjs${suffix}`),
    binding: await import(`../lib/installation-binding.mjs${suffix}`),
  };
}

test('no id exists until correlation is granted, separately from diagnostics', async (t) => {
  const home = withHome(t);
  const { id } = await load('anonymous');
  assert.equal(id.ensureInstallationId(), null, 'an anonymous grant mints nothing');
  assert.equal(id.needsBinding(), false);
  assert.equal(fs.existsSync(path.join(home, 'installation.json')), false);
});

test('correlation consent mints a uuid v4 outside the credential store', async (t) => {
  const home = withHome(t);
  const { id } = await load('correlate');
  const value = id.ensureInstallationId();
  assert.match(value, UUID_V4);
  assert.equal(id.ensureInstallationId(), value, 'minted once, then reused');
  assert.equal(fs.existsSync(path.join(home, 'installation.json')), true);
  assert.equal(fs.existsSync(path.join(home, 'credentials', 'installation.json')), false);
});

test('an unbound installation stays anonymous until authentication succeeds', async (t) => {
  withHome(t);
  const { id, binding } = await load('correlate');
  id.ensureInstallationId();
  assert.equal(id.currentInstallationId(), null, 'never bound — events carry nothing');

  await binding.bindInstallationIfNeeded('tok', {
    postJsonImpl: async () => ({ status: 200 }),
    recordIssue: () => true,
  });
  assert.equal(id.currentInstallationId(), id.readInstallationRecord().id);
});

test('the binding request carries exactly the two keys the route accepts', async (t) => {
  withHome(t);
  const { binding } = await load('correlate');
  const calls = [];
  await binding.bindInstallationIfNeeded('tok', {
    postJsonImpl: async (url, token, body) => { calls.push({ url, token, body }); return { status: 200 }; },
    recordIssue: () => true,
  });
  assert.ok(calls[0].url.endsWith('/cli-agent/plugin-diagnostics/installation'));
  assert.deepEqual(Object.keys(calls[0].body).sort(), ['consentVersion', 'installationId']);
  assert.equal(calls[0].body.consentVersion, 2);
});

test('a failed binding is retried later rather than abandoned', async (t) => {
  withHome(t);
  const { id, binding } = await load('correlate');
  const first = await binding.bindInstallationIfNeeded('tok', {
    postJsonImpl: async () => ({ status: 503 }), recordIssue: () => true,
  });
  assert.equal(first.status, 'failed');
  const minted = id.readInstallationRecord().id;
  assert.equal(id.needsBinding(), true, 'still unbound, so the next authenticated activity tries again');

  await binding.bindInstallationIfNeeded('tok', {
    postJsonImpl: async () => ({ status: 200 }), recordIssue: () => true,
  });
  assert.equal(id.readInstallationRecord().id, minted, 'a transport failure never rotates the id');
  assert.equal(id.needsBinding(), false);
});

test('a 409 conflict generates a NEW id and never reassigns the old one', async (t) => {
  withHome(t);
  const { id, binding } = await load('correlate');
  const original = id.ensureInstallationId();
  const recorded = [];
  const result = await binding.bindInstallationIfNeeded('tok', {
    postJsonImpl: async () => ({ status: 409 }),
    recordIssue: (event) => { recorded.push(event); return true; },
  });

  assert.equal(result.status, 'conflict');
  assert.equal(id.readInstallationRecord(), null, 'the conflicting id is discarded');
  assert.equal(recorded[0].code, 'installation_binding_failed');
  assert.equal(recorded[0].reason, 'binding_conflict');
  assert.notEqual(id.ensureInstallationId(), original, 'the next need mints a fresh one');
});

test('a bound installation is re-asserted once the server binding goes stale', async (t) => {
  withHome(t);
  const { id, binding } = await load('correlate');
  await binding.bindInstallationIfNeeded('tok', {
    postJsonImpl: async () => ({ status: 200 }), recordIssue: () => true, now: () => 0,
  });
  const week = 7 * 24 * 60 * 60 * 1000;
  assert.equal(id.needsBinding(week - 1), false);
  assert.equal(id.needsBinding(week + 1), true, 'well inside the server 90-day expiry');
});

test('a queued event keeps the installation id it was queued under', async (t) => {
  const home = withHome(t);
  const suffix = '?queued';
  const consent = await import(`../lib/telemetry-consent.mjs${suffix}`);
  consent.grantCorrelation();
  const id = await import(`../lib/installation-id.mjs${suffix}`);
  const binding = await import(`../lib/installation-binding.mjs${suffix}`);
  const { recordIssue } = await import(`../lib/telemetry.mjs${suffix}`);
  const { DIAGNOSTIC_CODES, DIAGNOSTIC_SOURCES } = await import(`../lib/telemetry-codes.mjs${suffix}`);

  await binding.bindInstallationIfNeeded('tok', { postJsonImpl: async () => ({ status: 200 }), recordIssue: () => true });
  const bound = id.readInstallationRecord().id;
  recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH, source: DIAGNOSTIC_SOURCES.STOP, error: new Error('x') });

  // Logout rotates the identity; the already-queued event must not be re-attributed.
  id.rotateInstallationId();
  recordIssue({ code: DIAGNOSTIC_CODES.MCP_STARTUP_FAILED, source: DIAGNOSTIC_SOURCES.MCP_BRIDGE });

  const dir = path.join(home, 'telemetry');
  const events = fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  const crash = events.find((e) => e.code === 'hook_crash');
  const after = events.find((e) => e.code === 'mcp_startup_failed');
  assert.equal(crash.installationId, bound);
  assert.equal(after.installationId, null, 'events recorded after the rotation are anonymous again');
});

// Binding runs on whichever authenticated hook called it (today: the checkpoint). Stamping
// diagnostics_worker said it happened somewhere it never does; leaving the source off lets
// recordIssue inherit the hook that is actually running.
test('binding failures do not claim to come from the diagnostics worker', async (t) => {
  withHome(t);
  const { binding } = await load('correlate');
  const events = [];
  const record = (event) => { events.push(event); return true; };

  await binding.bindInstallationIfNeeded('tok', {
    postJsonImpl: async () => { throw new Error('offline'); }, recordIssue: record,
  });
  await binding.bindInstallationIfNeeded('tok', {
    postJsonImpl: async () => ({ status: 409 }), recordIssue: record,
  });
  await binding.bindInstallationIfNeeded('tok', {
    postJsonImpl: async () => ({ status: 500 }), recordIssue: record,
  });

  assert.equal(events.length, 3);
  for (const event of events) {
    assert.equal(event.code, 'installation_binding_failed');
    assert.equal(event.source, undefined, 'no explicit source — it inherits the running hook');
  }
});
