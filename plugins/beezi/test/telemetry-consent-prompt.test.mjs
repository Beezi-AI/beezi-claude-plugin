import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

function withHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-prompt-'));
  const prev = process.env.BEEZI_HOME;
  process.env.BEEZI_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_HOME; else process.env.BEEZI_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('the consent ask appears once and never again', async (t) => {
  withHome(t);
  const { consentPrompt } = await import('../lib/session-start.mjs?p');
  const first = consentPrompt();
  assert.ok(first && first.includes('/beezi:telemetry'), 'names the command to answer with');
  assert.equal(consentPrompt(), null, 'asked exactly once per machine');
});

test('the ask offers all three answers and recommends correlate', async (t) => {
  withHome(t);
  const { consentPrompt } = await import('../lib/session-start.mjs?recommend');
  const ask = consentPrompt();
  for (const mode of ['correlate', 'on', 'off']) {
    assert.ok(ask.includes(`/beezi:telemetry ${mode}`), `offers ${mode}`);
  }
  assert.ok(/Recommended: \/beezi:telemetry correlate/.test(ask), 'correlate is the recommendation');
  assert.ok(
    ask.indexOf('/beezi:telemetry correlate') < ask.indexOf('/beezi:telemetry on'),
    'the recommended answer is offered first',
  );
});

test('showing the ask grants nothing on its own', async (t) => {
  withHome(t);
  const { consentPrompt } = await import('../lib/session-start.mjs?grants');
  consentPrompt();
  const { isTelemetryGranted, isCorrelationGranted } = await import('../lib/telemetry-consent.mjs?grants');
  assert.equal(isTelemetryGranted(), false, 'recommending is not consenting');
  assert.equal(isCorrelationGranted(), false, 'and never turns correlation on by itself');
});

test('the combined ask stands in for the standalone correlation offer', async (t) => {
  withHome(t);
  const { consentPrompt } = await import('../lib/session-start.mjs?once');
  consentPrompt();
  const { grantConsent, correlationPrompt } = await import('../lib/telemetry-consent.mjs?once');
  grantConsent();
  assert.equal(correlationPrompt(), null, 'correlation is not asked about twice');
});

test('a machine that consented before this change is still offered correlation', async (t) => {
  withHome(t);
  const { grantConsent, correlationPrompt } = await import('../lib/telemetry-consent.mjs?legacy');
  grantConsent();
  const offer = correlationPrompt();
  assert.ok(offer && offer.includes('/beezi:telemetry correlate'), 'the older grant still gets the offer');
});

test('turning telemetry off deletes anything still pending', async (t) => {
  const home = withHome(t);
  const { grantConsent, denyConsent } = await import('../lib/telemetry-consent.mjs?r');
  grantConsent();
  const dir = path.join(home, 'telemetry');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pending.json'), '{"eventId":"x"}');

  const { setTelemetry } = await import('../scripts/telemetry.mjs?r');
  setTelemetry('off');

  assert.equal(fs.existsSync(path.join(dir, 'pending.json')), false, 'nothing recorded before the change is sent after it');
});
