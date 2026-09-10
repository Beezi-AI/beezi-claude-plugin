import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const EVENT = {
  eventId: '11111111-1111-4111-8111-111111111111',
  code: 'hook_crash', source: 'stop', site: null, errorName: 'TypeError', errorCode: null,
  httpStatus: null, pluginVersion: '0.16.2', claudeCodeVersion: '2.1.251', nodeVersion: 'v22.17.0',
  os: 'darwin', osRelease: '25.4.0', arch: 'arm64', count: 2,
  authState: 'unavailable', reason: 'refresh_timeout', installationId: null,
  firstSeenAt: '2026-08-28T10:00:00.000Z', lastSeenAt: '2026-08-28T10:05:00.000Z',
};

function withHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-flush-'));
  const prev = process.env.BEEZI_HOME;
  process.env.BEEZI_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_HOME; else process.env.BEEZI_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function seed(home, events) {
  const dir = path.join(home, 'telemetry');
  fs.mkdirSync(dir, { recursive: true });
  events.forEach((e, i) => fs.writeFileSync(path.join(dir, `e${i}.json`), JSON.stringify(e)));
  return dir;
}

const accepted = (body) => ({
  status: 200,
  retryAfterMs: null,
  body: { acceptedEventIds: JSON.parse(body).events.map((e) => e.eventId), rejected: [] },
});

let tag = 0;
async function load(grant = true) {
  const suffix = `?f${tag++}`;
  const consent = await import(`../lib/telemetry-consent.mjs${suffix}`);
  if (grant) consent.grantConsent();
  return { consent, flush: await import(`../lib/telemetry-flush.mjs${suffix}`) };
}

test('no grant means nothing is sent, and everything pending is purged', async (t) => {
  const home = withHome(t);
  const dir = seed(home, [EVENT]);
  const { flush } = await load(false);
  let called = false;
  const result = await flush.flushDiagnostics({ postDiagnosticsImpl: async () => { called = true; return accepted('{"events":[]}'); } });
  assert.equal(called, false, 'consent is rechecked immediately before transmission');
  assert.equal(result.purged, true);
  assert.deepEqual(fs.readdirSync(dir), [], 'a withdrawn grant clears the queue');
});

test('a granted machine delivers anonymously: no token, no authorization, no installation id', async (t) => {
  const home = withHome(t);
  const dir = seed(home, [EVENT, { ...EVENT, eventId: 'evt-two' }]);
  const { flush } = await load();

  const calls = [];
  const result = await flush.flushDiagnostics({
    postDiagnosticsImpl: async (url, body, deps) => { calls.push({ url, body, deps }); return accepted(body); },
  });

  assert.equal(calls.length, 1, 'one request, not one per event');
  assert.ok(calls[0].url.endsWith('/cli-agent/plugin-diagnostics/public'));
  const payload = JSON.parse(calls[0].body);
  assert.equal(payload.schemaVersion, 2);
  assert.equal(payload.events.length, 2);
  assert.equal(payload.installationId, undefined, 'no top-level id: each event carries its own');
  assert.equal(payload.events[0].installationId, undefined, 'anonymous events omit the field');
  assert.equal(payload.events[0].authState, 'unavailable');
  assert.equal(payload.events[0].reason, 'refresh_timeout');
  assert.equal(JSON.stringify(payload).toLowerCase().includes('authorization'), false);
  assert.equal(result.sent, 2);
  assert.deepEqual(fs.readdirSync(dir), [], 'acknowledged events are removed');
});

test('sealing freezes the queue so a new occurrence becomes a NEW event', async (t) => {
  const home = withHome(t);
  const dir = seed(home, [EVENT]);
  const { flush } = await load();

  assert.equal(flush.sealPending(), 1);
  const sealed = fs.readdirSync(dir);
  assert.deepEqual(sealed, [`evt-${EVENT.eventId}.json`], 'named for the event it froze');

  // A recorder that fires after the seal finds no pending file and starts a fresh one.
  fs.writeFileSync(path.join(dir, 'abc123.json'), JSON.stringify({ ...EVENT, eventId: 'later-event' }));
  const bodies = [];
  await flush.flushDiagnostics({
    postDiagnosticsImpl: async (_url, body) => { bodies.push(JSON.parse(body)); return accepted(body); },
  });
  const ids = bodies[0].events.map((e) => e.eventId).sort();
  assert.deepEqual(ids, ['11111111-1111-4111-8111-111111111111', 'later-event']);
});

test('only acknowledged and individually rejected events are removed', async (t) => {
  const home = withHome(t);
  const dir = seed(home, [
    { ...EVENT, eventId: 'a' }, { ...EVENT, eventId: 'b' }, { ...EVENT, eventId: 'c' },
  ]);
  const { flush } = await load();

  await flush.flushDiagnostics({
    postDiagnosticsImpl: async (_url, body) => {
      const events = JSON.parse(body).events;
      const bIndex = events.findIndex((e) => e.eventId === 'b');
      return {
        status: 200,
        retryAfterMs: null,
        body: { acceptedEventIds: ['a'], rejected: [{ index: bIndex, eventId: 'b', reason: 'unknown_code' }] },
      };
    },
  });

  assert.deepEqual(fs.readdirSync(dir), ['evt-c.json'], 'c was neither accepted nor rejected — kept');
});

test('a replayed delivery changes nothing: the same event id is acknowledged again', async (t) => {
  const home = withHome(t);
  const dir = seed(home, [EVENT]);
  const { flush } = await load();
  const bodies = [];
  const post = async (_url, body) => { bodies.push(JSON.parse(body)); return accepted(body); };

  await flush.flushDiagnostics({ postDiagnosticsImpl: post });
  await flush.flushDiagnostics({ postDiagnosticsImpl: post });

  assert.equal(bodies.length, 1, 'nothing is left to resend after the acknowledgement');
  assert.deepEqual(fs.readdirSync(dir), []);
});

for (const status of [0, 401, 403, 404, 405, 408, 429, 500, 503]) {
  test(`status ${status} preserves the report for a later attempt`, async (t) => {
    const home = withHome(t);
    const dir = seed(home, [EVENT]);
    const { flush } = await load();
    const result = await flush.flushDiagnostics({
      postDiagnosticsImpl: async () => (status === 0
        ? Promise.reject(new Error('network'))
        : { status, retryAfterMs: null, body: null }),
      now: () => 1000,
    });
    assert.equal(result.kept, 1);
    assert.deepEqual(fs.readdirSync(dir), [`evt-${EVENT.eventId}.json`]);
    assert.equal(flush.readSendState().nextAttemptAt, 1000 + flush.SEND_BACKOFF_MS[0]);
  });
}

test('a permanent refusal drops the batch rather than retrying it forever', async (t) => {
  const home = withHome(t);
  const dir = seed(home, [EVENT]);
  const { flush } = await load();
  await flush.flushDiagnostics({ postDiagnosticsImpl: async () => ({ status: 400, retryAfterMs: null, body: null }) });
  assert.deepEqual(fs.readdirSync(dir), [], '400 means these bytes will never be accepted');
});

test('Retry-After wins over the backoff ladder', async (t) => {
  const home = withHome(t);
  seed(home, [EVENT]);
  const { flush } = await load();
  await flush.flushDiagnostics({
    postDiagnosticsImpl: async () => ({ status: 429, retryAfterMs: 900000, body: null }),
    now: () => 5000,
  });
  assert.equal(flush.readSendState().nextAttemptAt, 5000 + 900000);
});

test('the backoff ladder climbs from a minute to an hour', async (t) => {
  const home = withHome(t);
  seed(home, [EVENT]);
  const { flush } = await load();
  assert.equal(flush.SEND_BACKOFF_MS[0], 60000);
  assert.equal(flush.SEND_BACKOFF_MS[flush.SEND_BACKOFF_MS.length - 1], 3600000);
  for (let attempt = 1; attempt <= flush.SEND_BACKOFF_MS.length + 1; attempt++) {
    await flush.flushDiagnostics({
      postDiagnosticsImpl: async () => ({ status: 503, retryAfterMs: null, body: null }),
      now: () => 0,
    });
    const expected = flush.SEND_BACKOFF_MS[Math.min(attempt - 1, flush.SEND_BACKOFF_MS.length - 1)];
    assert.equal(flush.readSendState().nextAttemptAt, expected, `attempt ${attempt}`);
  }
});

test('413 splits the batch instead of losing it', async (t) => {
  const home = withHome(t);
  const dir = seed(home, [
    { ...EVENT, eventId: 'a' }, { ...EVENT, eventId: 'b' },
    { ...EVENT, eventId: 'c' }, { ...EVENT, eventId: 'd' },
  ]);
  const { flush } = await load();
  const sizes = [];
  let first = true;
  await flush.flushDiagnostics({
    postDiagnosticsImpl: async (_url, body) => {
      const events = JSON.parse(body).events;
      sizes.push(events.length);
      if (first) { first = false; return { status: 413, retryAfterMs: null, body: null }; }
      return accepted(body);
    },
  });
  assert.deepEqual(sizes.slice(0, 2), [4, 2], 'the oversized batch is halved');
  assert.equal(fs.readdirSync(dir).length, 0, 'the remainder goes out in the same run');
});

test('a single event that alone is too large is dropped, not retried forever', async (t) => {
  const home = withHome(t);
  const dir = seed(home, [EVENT]);
  const { flush } = await load();
  await flush.flushDiagnostics({ postDiagnosticsImpl: async () => ({ status: 413, retryAfterMs: null, body: null }) });
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('an unreadable fragment is dropped without costing the batch a round trip', async (t) => {
  const home = withHome(t);
  const dir = seed(home, [EVENT]);
  fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ eventId: 'bad', code: 'hook_crash', source: 'stop' }));
  const { flush } = await load();
  const bodies = [];
  await flush.flushDiagnostics({
    postDiagnosticsImpl: async (_url, body) => { bodies.push(JSON.parse(body)); return accepted(body); },
  });
  assert.equal(bodies[0].events.length, 1);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('withdrawing correlation removes correlated reports and keeps the anonymous ones', async (t) => {
  const home = withHome(t);
  const dir = seed(home, [
    { ...EVENT, eventId: 'anon' },
    { ...EVENT, eventId: 'linked', installationId: '22222222-2222-4222-8222-222222222222' },
  ]);
  const { flush } = await load();
  assert.equal(flush.purgeCorrelatedDiagnostics(), 1);
  assert.deepEqual(fs.readdirSync(dir), ['e0.json'], 'the anonymous report is still deliverable');
});

// A 200 carrying something that is not the route's answer is far more often a proxy, a captive
// portal or a load balancer than the route. Deleting the batch on it destroys the evidence with
// no retry, and the server dedups on eventId, so preserving is free.
test('a 200 whose body is not the route’s shape preserves the batch and backs off', async (t) => {
  const home = withHome(t);
  const dir = seed(home, [EVENT, { ...EVENT, eventId: 'evt-two' }]);
  const { flush } = await load();
  const result = await flush.flushDiagnostics({
    postDiagnosticsImpl: async () => ({ status: 200, retryAfterMs: null, body: null }),
  });
  assert.equal(result.deleted, 0, 'nothing was destroyed');
  assert.equal(result.kept, 2);
  assert.equal(result.requests, 1, 'it backs off instead of hammering the same endpoint');
  assert.equal(fs.readdirSync(dir).length, 2, 'both reports survive for the next run');
});

test('a 200 with an html body preserves the batch too', async (t) => {
  const home = withHome(t);
  const dir = seed(home, [EVENT]);
  const { flush } = await load();
  await flush.flushDiagnostics({
    postDiagnosticsImpl: async () => ({ status: 200, retryAfterMs: null, body: { hello: 'captive portal' } }),
  });
  assert.equal(fs.readdirSync(dir).length, 1);
});

// The brief's "recheck consent immediately before transmission" — a run can make several
// requests (a 413 halves the batch and goes round again), and a user who types
// /beezi:telemetry off between two of them must not have the rest sent anyway.
test('consent withdrawn between requests stops the rest of the run', async (t) => {
  const home = withHome(t);
  const dir = seed(home, [
    EVENT,
    { ...EVENT, eventId: 'evt-two' },
    { ...EVENT, eventId: 'evt-three' },
    { ...EVENT, eventId: 'evt-four' },
  ]);
  const { consent, flush } = await load();
  let requests = 0;
  const result = await flush.flushDiagnostics({
    postDiagnosticsImpl: async (_url, body) => {
      requests += 1;
      if (requests === 1) {
        consent.denyConsent();
        return { status: 413, retryAfterMs: null, body: null };
      }
      return accepted(body);
    },
  });
  assert.equal(requests, 1, 'the second request is never made');
  assert.equal(result.purged, true);
  assert.deepEqual(fs.readdirSync(dir), [], 'the withdrawal purges what was left');
});
