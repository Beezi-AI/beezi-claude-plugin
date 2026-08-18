import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reportSessionError, readErrorContext } from '../lib/stop-failure.mjs';

// Isolate from the developer's real ~/.beezi — a machine linked to an audit-mode workspace
// carries a tracking.json that would trip the live-tracking gate inside reportSessionError.
process.env.BEEZI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-failure-test-'));

function captureFetch(status = 200) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { status };
  };
  return { calls, fetchImpl };
}

const deps = (over = {}) => ({
  getAccessToken: async () => 'my-token',
  now: () => new Date('2026-07-08T10:00:00.000Z'),
  readFile: () => '',
  ...over,
});

test('POSTs to /sessions/errors with bearer auth and full payload', async () => {
  const { calls, fetchImpl } = captureFetch(200);
  const res = await reportSessionError(
    { session_id: 's1', error: 'rate_limit', transcript_path: '/t.jsonl' },
    deps({
      fetchImpl,
      readFile: () =>
        [
          JSON.stringify({ type: 'assistant', message: { content: 'API Error: Rate limit reached' } }),
          JSON.stringify({ is_error: true, error: { message: '429 Too Many Requests' } }),
        ].join('\n'),
    }),
  );

  assert.equal(res.reported, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/sessions\/errors$/);
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer my-token');
  const body = JSON.parse(calls[0].opts.body);
  assert.deepEqual(body, {
    sessionId: 's1',
    error: 'rate_limit',
    errorDetails: '429 Too Many Requests',
    lastAssistantMessage: 'API Error: Rate limit reached',
    occurredAt: '2026-07-08T10:00:00.000Z',
  });
});

test('reports a real StopFailure billing payload, stamped from the transcript line', async () => {
  const { calls, fetchImpl } = captureFetch(200);
  const res = await reportSessionError(
    {
      session_id: 's1',
      error: 'billing_error',
      error_details: 'Your credit balance is too low to access the Anthropic API.',
      last_assistant_message: 'Credit balance is too low',
      transcript_path: '/t.jsonl',
    },
    deps({
      fetchImpl,
      readFile: () =>
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-07-31T18:44:50.690Z',
          isApiErrorMessage: true,
          error: 'billing_error',
          apiErrorStatus: 400,
          message: { content: [{ type: 'text', text: 'Credit balance is too low' }] },
        }),
    }),
  );

  assert.equal(res.reported, true);
  assert.deepEqual(JSON.parse(calls[0].opts.body), {
    sessionId: 's1',
    error: 'billing_error',
    errorDetails: 'Your credit balance is too low to access the Anthropic API.',
    lastAssistantMessage: 'Credit balance is too low',
    occurredAt: '2026-07-31T18:44:50.690Z',
  });
});

test('bails without a token (no fetch)', async () => {
  const { calls, fetchImpl } = captureFetch();
  const res = await reportSessionError(
    { session_id: 's1', error: 'rate_limit' },
    deps({ fetchImpl, getAccessToken: async () => null }),
  );
  assert.equal(res.reported, false);
  assert.equal(res.reason, 'no-token');
  assert.equal(calls.length, 0);
});

test('bails on missing session_id / error (no fetch)', async () => {
  const { calls, fetchImpl } = captureFetch();
  const res = await reportSessionError({ error: 'rate_limit' }, deps({ fetchImpl }));
  assert.equal(res.reported, false);
  assert.equal(calls.length, 0);
});

test('readErrorContext returns nulls when transcript is missing/unreadable', () => {
  const empty = { lastAssistantMessage: null, errorDetails: null, occurredAt: null };
  assert.deepEqual(readErrorContext(null), empty);
  assert.deepEqual(
    readErrorContext('/nope.jsonl', {
      readFile: () => {
        throw new Error('enoent');
      },
    }),
    empty,
  );
});

// /sessions/errors carries the tracking gate server-side; this path posts outside runCheckpoint
// so it needs its own client gate — a dark tenant would otherwise 403 on every StopFailure.
test('reportSessionError no-ops when tracking is not live', async () => {
  let fetchCalled = false;
  const res = await reportSessionError(
    { session_id: 's1', error: 'rate_limit' },
    {
      isLiveTrackingAllowedImpl: () => false,
      getAccessToken: async () => 'tok',
      fetchImpl: async () => { fetchCalled = true; return { status: 200 }; },
    },
  );

  assert.deepEqual(res, { reported: false, reason: 'tracking-disabled' });
  assert.equal(fetchCalled, false);
});
