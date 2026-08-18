// Fetch shim for Node < 18, which has no global `fetch`. `resolveFetch()` is what call
// sites use; it hands back the real global when present so behavior on Node 18+ is
// untouched, and falls back to `httpsFetch` — a minimal `http`/`https` client
// covering only the surface this codebase actually exercises (see task-1-brief.md):
// GET/POST/DELETE with string/URLSearchParams bodies, abort, redirects, streamed body.
// It is not a general-purpose fetch polyfill.
// Bare specifiers (not `node:`-prefixed) on purpose: the `node:` prefix needs Node
// 12.20 / 14.13.1+ in ESM, while bare `http`/`https` resolve on every Node version
// this shim could plausibly run under.
import http from 'http';
import https from 'https';

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function resolveFetch() {
  return typeof globalThis.fetch === 'function' ? globalThis.fetch : httpsFetch;
}

export async function httpsFetch(url, init = {}) {
  let currentUrl = new URL(url);
  let method = init.method == null ? 'GET' : init.method;
  let body = init.body;
  let headers = { ...(init.headers == null ? {} : init.headers) };
  const signal = init.signal;

  for (let hop = 0; ; hop++) {
    const res = await sendOnce(currentUrl, method, headers, body, signal);
    const location = REDIRECT_STATUSES.has(res.statusCode) ? res.headers.location : null;
    if (!location) return toResponse(res);

    // Discard the redirect response body — nothing reads it. A late socket error on an
    // already-decided response must not crash the process as an unhandled 'error' event.
    res.on('error', () => {});
    res.resume();
    if (hop >= MAX_REDIRECTS) {
      throw new Error(`Too many redirects (> ${MAX_REDIRECTS}) fetching ${url}`);
    }

    const nextUrl = new URL(location, currentUrl);
    if (res.statusCode === 303) {
      method = 'GET';
      body = undefined;
    }
    if (nextUrl.origin !== currentUrl.origin) {
      headers = stripAuthorization(headers);
    }
    currentUrl = nextUrl;
  }
}

function transportFor(url) {
  if (url.protocol === 'https:') return https;
  if (url.protocol === 'http:') return http;
  throw new TypeError(`Unsupported protocol: ${url.protocol}`);
}

function stripAuthorization(headers) {
  const kept = {};
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== 'authorization') kept[key] = headers[key];
  }
  return kept;
}

function hasHeader(headers, name) {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

function makeAbortError() {
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

// Sends one request (no redirect handling) and resolves with the IncomingMessage once
// response headers arrive. The body stream is left untouched for the caller to consume.
function sendOnce(url, method, headers, body, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(makeAbortError());
      return;
    }

    // Real fetch sends Content-Length for string bodies; without it Node falls back to
    // Transfer-Encoding: chunked, which some proxies/gateways reject or mishandle.
    // Built fresh per hop (not stored on the caller's `headers`) so a 303's dropped
    // body doesn't leave a stale Content-Length on the follow-up GET.
    const payload = body !== undefined ? String(body) : undefined;
    const requestHeaders = { ...headers };
    if (payload !== undefined && !hasHeader(requestHeaders, 'content-length')) {
      requestHeaders['Content-Length'] = String(Buffer.byteLength(payload));
    }

    const transport = transportFor(url);
    const req = transport.request(url, { method, headers: requestHeaders });

    // `{ once: true }` plus explicit removal on every settle path keeps a long-lived
    // signal (e.g. a shared AbortController) from accumulating listeners across calls.
    const onAbort = () => {
      cleanup();
      req.destroy();
      reject(makeAbortError());
    };
    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    req.on('response', (res) => {
      cleanup();
      resolve(res);
    });
    req.on('error', (err) => {
      cleanup();
      reject(err); // preserve the original Node error, including .code
    });

    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function bufferText(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });
}

function toResponse(res) {
  return {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    statusText: res.statusMessage,
    headers: {
      // Node already lower-cases incoming header names; lower-case the lookup key too.
      get: (name) => {
        const value = res.headers[String(name).toLowerCase()];
        return value == null ? null : value;
      },
    },
    text: () => bufferText(res),
    json: async () => JSON.parse(await bufferText(res)),
    body: res,
  };
}
