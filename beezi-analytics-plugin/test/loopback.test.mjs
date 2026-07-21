import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startLoopback } from '../lib/loopback.mjs';

test('resolves the code from a valid callback', async () => {
  const lb = await startLoopback({ expectedState: 's1', timeoutMs: 5000 });
  const res = await fetch(`${lb.redirectUri}?code=abc&state=s1`);
  assert.equal(res.status, 200);
  assert.equal(await lb.code, 'abc');
});

test('rejects on state mismatch', async () => {
  const lb = await startLoopback({ expectedState: 's1', timeoutMs: 5000 });
  // Attach the rejection handler BEFORE the callback fires, or Node reports
  // an unhandled rejection while the fetch is still being awaited.
  const rejection = assert.rejects(lb.code, /state/i);
  const res = await fetch(`${lb.redirectUri}?code=abc&state=WRONG`);
  assert.equal(res.status, 400);
  await rejection;
});

test('rejects when the provider returns an error param', async () => {
  const lb = await startLoopback({ expectedState: 's1', timeoutMs: 5000 });
  const rejection = assert.rejects(lb.code, /access_denied/);
  const res = await fetch(`${lb.redirectUri}?error=access_denied&state=s1`);
  assert.equal(res.status, 400);
  await rejection;
});

test('rejects after the timeout', async () => {
  const lb = await startLoopback({ expectedState: 's1', timeoutMs: 50 });
  await assert.rejects(lb.code, /timed out/i);
});

test('ignores non-callback paths, then still accepts the real callback', async () => {
  const lb = await startLoopback({ expectedState: 's1', timeoutMs: 5000 });
  const miss = await fetch(`${lb.redirectUri.replace('/callback', '/favicon.ico')}`);
  assert.equal(miss.status, 404);
  await fetch(`${lb.redirectUri}?code=ok&state=s1`);
  assert.equal(await lb.code, 'ok');
});

test('binds the requested port when free; errors when busy', async () => {
  const lb1 = await startLoopback({ expectedState: 'a', timeoutMs: 5000 });
  await assert.rejects(
    startLoopback({ port: lb1.port, expectedState: 'b', timeoutMs: 5000 }),
    /EADDRINUSE|address already in use/i,
  );
  await fetch(`${lb1.redirectUri}?code=x&state=a`); // release lb1
  await lb1.code;
});
