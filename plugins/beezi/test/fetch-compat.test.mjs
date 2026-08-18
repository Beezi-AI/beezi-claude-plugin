import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { resolveFetch, httpsFetch } from '../lib/fetch-compat.mjs';

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('resolveFetch returns the global fetch when it exists', () => {
  assert.equal(typeof globalThis.fetch, 'function');
  assert.strictEqual(resolveFetch(), globalThis.fetch);
});

test('resolveFetch falls back to httpsFetch when no global fetch exists', (t) => {
  const real = globalThis.fetch;
  globalThis.fetch = undefined;
  t.after(() => {
    globalThis.fetch = real;
  });
  assert.strictEqual(resolveFetch(), httpsFetch);
});

test('GET: status, ok, statusText, json(), text()', async (t) => {
  const { server, url } = await startServer((req, res) => {
    res.statusCode = 201;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ hello: 'world' }));
  });
  t.after(() => closeServer(server));

  const res = await httpsFetch(url);
  assert.equal(res.status, 201);
  assert.equal(res.ok, true);
  assert.equal(res.statusText, 'Created');
  assert.deepEqual(await res.json(), { hello: 'world' });
});

test('text() buffers the response body as a string', async (t) => {
  const { server, url } = await startServer((req, res) => {
    res.end('plain text body');
  });
  t.after(() => closeServer(server));

  const res = await httpsFetch(url);
  assert.equal(await res.text(), 'plain text body');
});

test('non-2xx status is reflected in ok/status, not thrown', async (t) => {
  const { server, url } = await startServer((req, res) => {
    res.statusCode = 404;
    res.end('not found');
  });
  t.after(() => closeServer(server));

  const res = await httpsFetch(url);
  assert.equal(res.ok, false);
  assert.equal(res.status, 404);
});

test('headers.get is case-insensitive and returns null when absent', async (t) => {
  const { server, url } = await startServer((req, res) => {
    res.setHeader('X-Custom-Header', 'abc123');
    res.end();
  });
  t.after(() => closeServer(server));

  const res = await httpsFetch(url);
  assert.equal(res.headers.get('x-custom-header'), 'abc123');
  assert.equal(res.headers.get('X-CUSTOM-HEADER'), 'abc123');
  assert.equal(res.headers.get('nonexistent'), null);
});

test('POST with a string body arrives verbatim with sent headers', async (t) => {
  const { server, url } = await startServer((req, res) => {
    let received = '';
    req.on('data', (chunk) => { received += chunk; });
    req.on('end', () => {
      res.end(JSON.stringify({
        method: req.method,
        body: received,
        contentType: req.headers['content-type'],
      }));
    });
  });
  t.after(() => closeServer(server));

  const res = await httpsFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: 'hello beezi',
  });
  const payload = await res.json();
  assert.equal(payload.method, 'POST');
  assert.equal(payload.body, 'hello beezi');
  assert.equal(payload.contentType, 'text/plain');
});

test('POST sets Content-Length to the byte length of the body (multibyte-safe)', async (t) => {
  const { server, url } = await startServer((req, res) => {
    res.end(String(req.headers['content-length']));
  });
  t.after(() => closeServer(server));

  const body = 'café'; // 4 chars, 5 UTF-8 bytes — .length would be wrong
  const res = await httpsFetch(url, { method: 'POST', body });
  assert.equal(await res.text(), String(Buffer.byteLength(body)));
});

test('POST with a URLSearchParams body is sent as its string form', async (t) => {
  const { server, url } = await startServer((req, res) => {
    let received = '';
    req.on('data', (chunk) => { received += chunk; });
    req.on('end', () => res.end(received));
  });
  t.after(() => closeServer(server));

  const params = new URLSearchParams({ a: '1', b: 'two words' });
  const res = await httpsFetch(url, { method: 'POST', body: params });
  assert.equal(await res.text(), String(params));
});

test('DELETE method is used when requested', async (t) => {
  const { server, url } = await startServer((req, res) => {
    res.end(req.method);
  });
  t.after(() => closeServer(server));

  const res = await httpsFetch(url, { method: 'DELETE' });
  assert.equal(await res.text(), 'DELETE');
});

test('body is async-iterable as chunks arrive with delays', async (t) => {
  const { server, url } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('chunk-1-');
    setTimeout(() => {
      res.write('chunk-2-');
      setTimeout(() => {
        res.end('chunk-3');
      }, 20);
    }, 20);
  });
  t.after(() => closeServer(server));

  const res = await httpsFetch(url);
  const decoder = new TextDecoder();
  let assembled = '';
  for await (const chunk of res.body) {
    assembled += decoder.decode(chunk, { stream: true });
  }
  assembled += decoder.decode();
  assert.equal(assembled, 'chunk-1-chunk-2-chunk-3');
});

test('pre-aborted signal rejects immediately with AbortError', async (t) => {
  const { server, url } = await startServer((req, res) => res.end('should not be reached'));
  t.after(() => closeServer(server));

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    httpsFetch(url, { signal: controller.signal }),
    (err) => err.name === 'AbortError',
  );
});

test('aborting mid-request rejects with AbortError', async (t) => {
  let resolveRequestSeen;
  const requestSeen = new Promise((resolve) => { resolveRequestSeen = resolve; });
  const { server, url } = await startServer((req, res) => {
    resolveRequestSeen();
    // Never respond — let the abort win the race.
  });
  t.after(() => closeServer(server));

  const controller = new AbortController();
  const pending = httpsFetch(url, { signal: controller.signal });
  const rejection = assert.rejects(pending, (err) => err.name === 'AbortError');
  await requestSeen;
  controller.abort();
  await rejection;
});

test('connection refused rejects with the original error code', async () => {
  const { server, url } = await startServer((req, res) => res.end());
  await closeServer(server); // port is now free and connection-refused

  await assert.rejects(
    httpsFetch(url),
    (err) => err.code === 'ECONNREFUSED',
  );
});

test('follows a 302 redirect to a 200', async (t) => {
  const { server: target, url: targetUrl } = await startServer((req, res) => {
    res.end('redirected-body');
  });
  t.after(() => closeServer(target));

  const { server: origin, url: originUrl } = await startServer((req, res) => {
    res.writeHead(302, { Location: targetUrl });
    res.end();
  });
  t.after(() => closeServer(origin));

  const res = await httpsFetch(originUrl);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'redirected-body');
});

test('303 redirect converts POST to GET and drops the body', async (t) => {
  const { server: target, url: targetUrl } = await startServer((req, res) => {
    res.end(JSON.stringify({ method: req.method, contentLength: req.headers['content-length'] ?? null }));
  });
  t.after(() => closeServer(target));

  const { server: origin, url: originUrl } = await startServer((req, res) => {
    res.writeHead(303, { Location: targetUrl });
    res.end();
  });
  t.after(() => closeServer(origin));

  const res = await httpsFetch(originUrl, { method: 'POST', body: 'ignored-after-303' });
  const payload = await res.json();
  assert.equal(payload.method, 'GET');
  // The follow-up GET must not carry a stale Content-Length from the dropped POST body,
  // or a server expecting a body of that size will stall waiting for bytes that never come.
  assert.equal(payload.contentLength, null);
});

test('more than 5 redirect hops rejects', async (t) => {
  // Server redirects to itself with an incrementing counter in the query string,
  // producing a chain that needs 6 hops to reach 200 — one more than the shim allows.
  const { server, url } = await startServer((req, res) => {
    const count = Number(new URL(req.url, 'http://placeholder').searchParams.get('n') ?? '0');
    if (count >= 6) {
      res.end('done');
      return;
    }
    res.writeHead(302, { Location: `/?n=${count + 1}` });
    res.end();
  });
  t.after(() => closeServer(server));

  await assert.rejects(httpsFetch(url), /redirect/i);
});

test('cross-origin redirect drops the Authorization header', async (t) => {
  const { server: target, url: targetUrl } = await startServer((req, res) => {
    res.end(JSON.stringify({ hasAuth: 'authorization' in req.headers }));
  });
  t.after(() => closeServer(target));

  const { server: origin, url: originUrl } = await startServer((req, res) => {
    res.writeHead(302, { Location: targetUrl });
    res.end();
  });
  t.after(() => closeServer(origin));

  const res = await httpsFetch(originUrl, { headers: { Authorization: 'Bearer secret' } });
  const payload = await res.json();
  assert.equal(payload.hasAuth, false);
});

test('unsupported protocol rejects with a TypeError', async () => {
  await assert.rejects(httpsFetch('ftp://example.com/file'), TypeError);
});
