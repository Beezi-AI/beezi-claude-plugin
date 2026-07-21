import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportSessionError, readErrorContext } from '../lib/stop-failure.mjs';

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
    { session_id: 's1', error_type: 'rate_limit', transcript_path: '/t.jsonl' },
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

test('bails without a token (no fetch)', async () => {
  const { calls, fetchImpl } = captureFetch();
  const res = await reportSessionError(
    { session_id: 's1', error_type: 'rate_limit' },
    deps({ fetchImpl, getAccessToken: async () => null }),
  );
  assert.equal(res.reported, false);
  assert.equal(res.reason, 'no-token');
  assert.equal(calls.length, 0);
});

test('bails on missing session_id / error_type (no fetch)', async () => {
  const { calls, fetchImpl } = captureFetch();
  const res = await reportSessionError({ error_type: 'rate_limit' }, deps({ fetchImpl }));
  assert.equal(res.reported, false);
  assert.equal(calls.length, 0);
});

test('readErrorContext returns nulls when transcript is missing/unreadable', () => {
  assert.deepEqual(readErrorContext(null), { lastAssistantMessage: null, errorDetails: null });
  assert.deepEqual(
    readErrorContext('/nope.jsonl', {
      readFile: () => {
        throw new Error('enoent');
      },
    }),
    { lastAssistantMessage: null, errorDetails: null },
  );
});
