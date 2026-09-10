import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

test('quarantining a corrupt queue file records a diagnostic', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-callsite-'));
  const prev = process.env.BEEZI_HOME;
  process.env.BEEZI_HOME = home;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_HOME; else process.env.BEEZI_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const { grantConsent } = await import('../lib/telemetry-consent.mjs?q');
  grantConsent();
  const qdir = path.join(home, 'queue');
  fs.mkdirSync(qdir, { recursive: true });
  fs.writeFileSync(path.join(qdir, 'seg.json'), 'not json at all');

  const { flushQueue } = await import('../lib/checkpoint.mjs?q');
  const result = await flushQueue('tok', { fetchImpl: async () => ({ status: 200 }) });

  assert.equal(result.quarantined, 1);
  const events = fs.readdirSync(path.join(home, 'telemetry'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(home, 'telemetry', f), 'utf8')));
  assert.equal(events.length, 1);
  assert.equal(events[0].code, 'queue_file_quarantined');
  assert.equal(events[0].source, 'checkpoint');
});
