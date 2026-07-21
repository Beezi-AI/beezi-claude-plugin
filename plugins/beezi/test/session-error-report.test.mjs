import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postSessionError } from '../lib/session-error-report.mjs';

test('POSTs the payload to /sessions/errors with bearer auth', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return { status: 200 }; };
  const res = await postSessionError(
    { sessionId: 's1', error: 'rate_limit', errorDetails: null,
      lastAssistantMessage: 'resets 4:30pm (Europe/Kiev)', occurredAt: '2026-07-08T10:00:00.000Z' },
    'my-token',
    { fetchImpl },
  );
  assert.equal(res.reported, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/sessions\/errors$/);
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer my-token');
  assert.deepEqual(JSON.parse(calls[0].opts.body), {
    sessionId: 's1', error: 'rate_limit', errorDetails: null,
    lastAssistantMessage: 'resets 4:30pm (Europe/Kiev)', occurredAt: '2026-07-08T10:00:00.000Z',
  });
});

test('reports false without a token (no fetch)', async () => {
  const calls = [];
  const fetchImpl = async () => { calls.push(1); return { status: 200 }; };
  const res = await postSessionError({ sessionId: 's1', error: 'rate_limit' }, null, { fetchImpl });
  assert.equal(res.reported, false);
  assert.equal(res.reason, 'no-token');
  assert.equal(calls.length, 0);
});
