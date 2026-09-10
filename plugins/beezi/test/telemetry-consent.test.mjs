import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

function withHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-consent-'));
  const prev = process.env.BEEZI_HOME;
  process.env.BEEZI_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_HOME; else process.env.BEEZI_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('consent is off until explicitly granted', async (t) => {
  withHome(t);
  const { isTelemetryGranted, hasBeenAsked } = await import('../lib/telemetry-consent.mjs?1');
  assert.equal(isTelemetryGranted(), false, 'default is off');
  assert.equal(hasBeenAsked(), false);
});

test('granting then denying flips the gate and records the decision', async (t) => {
  withHome(t);
  const m = await import('../lib/telemetry-consent.mjs?2');
  m.grantConsent();
  assert.equal(m.isTelemetryGranted(), true);
  assert.ok(m.readConsent().decidedAt, 'decision is timestamped');
  m.denyConsent();
  assert.equal(m.isTelemetryGranted(), false);
});

test('markAsked records the ask without granting anything', async (t) => {
  withHome(t);
  const m = await import('../lib/telemetry-consent.mjs?3');
  m.markAsked();
  assert.equal(m.hasBeenAsked(), true, 'so the prompt never fires twice');
  assert.equal(m.isTelemetryGranted(), false, 'being asked is not consenting');
});

test('an existing anonymous grant keeps working and does not imply correlation', async (t) => {
  withHome(t);
  const m = await import('../lib/telemetry-consent.mjs?4');
  m.grantConsent();
  assert.equal(m.isTelemetryGranted(), true);
  assert.equal(m.isCorrelationGranted(), false, 'correlation is a separate, later opt-in');
  assert.equal(m.hasCorrelationBeenAsked(), false);
});

test('correlation can be granted and withdrawn without touching basic diagnostics', async (t) => {
  withHome(t);
  const m = await import('../lib/telemetry-consent.mjs?5');
  m.grantCorrelation();
  assert.equal(m.isTelemetryGranted(), true);
  assert.equal(m.isCorrelationGranted(), true);
  m.denyCorrelation();
  assert.equal(m.isCorrelationGranted(), false);
  assert.equal(m.isTelemetryGranted(), true, 'anonymous reporting continues');
});

test('a complete opt-out takes correlation with it, and re-enabling does not restore it', async (t) => {
  withHome(t);
  const m = await import('../lib/telemetry-consent.mjs?6');
  m.grantCorrelation();
  m.denyConsent();
  assert.equal(m.isTelemetryGranted(), false);
  m.grantConsent();
  assert.equal(m.isCorrelationGranted(), false, 'correlation must be re-given explicitly');
});

test('the correlation offer is made once, and only to a machine already sending diagnostics', async (t) => {
  withHome(t);
  const m = await import('../lib/telemetry-consent.mjs?7');
  assert.equal(m.correlationPrompt(), null, 'nothing to offer before diagnostics are on');
  m.grantConsent();
  const offer = m.correlationPrompt();
  assert.match(offer, /correlate/);
  assert.equal(m.correlationPrompt(), null, 'offered exactly once');
  assert.equal(m.isTelemetryGranted(), true, 'the offer never blocks anonymous reporting');
  assert.equal(m.isCorrelationGranted(), false, 'being asked is not consenting');
});
