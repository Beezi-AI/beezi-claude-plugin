import crypto from 'crypto';
import os from 'os';
import { apiOrigin, OAUTH_SCOPES, PROTECTED_RESOURCE_PATH } from './config.mjs';
import { UserError } from './friendly-error.mjs';
import { resolveFetch } from './fetch-compat.mjs';
import { resolveAbortController } from './abort-compat.mjs';

// Clerk development instances cold-start well past 5s; measured 5.6s–20s on first contact.
// Only the interactive login commands can afford to wait that long.
const TIMEOUT_MS = 15000;

// Refresh runs inside hooks, which Claude Code kills at 10s (see hooks/hooks.json). The
// refresh must therefore give up well inside that budget: a kill landing after the server
// rotated the refresh token but before the replacement is persisted leaves the stored token
// permanently dead, and every later refresh then reports a revoked grant.
const REFRESH_TIMEOUT_MS = 7000;

// Rejects as soon as `signal` fires, whatever `promise` is doing. The transport is not trusted
// to honour the signal itself: the compatibility client streams a body the caller reads later,
// and a fake fetch in a test honours nothing at all.
function raceAbort(signal, promise) {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(abortError()); };
    const cleanup = () => {
      try { signal.removeEventListener('abort', onAbort); } catch { /* shim without removal */ }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}

function abortError() {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

// One deadline for the whole exchange, headers AND body. It used to be cleared the moment
// `fetch()` resolved, so `res.json()` ran unbounded — a refresh that "fits in 7s" could run
// past the 10s hook kill and lose a rotated refresh token (finding 5). The timer stays armed
// until a body settles, so every caller must consume or `drain()` the response.
async function fetchWithTimeout(fetchImpl, url, init, timeoutMs = TIMEOUT_MS) {
  const AbortControllerImpl = resolveAbortController();
  const controller = new AbortControllerImpl();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await raceAbort(controller.signal, Promise.resolve(fetchImpl(url, { ...init, signal: controller.signal })));
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
  // A body can only be read once. The compatibility transport's IncomingMessage has already
  // emitted `end` by then, so a second read attaches an `end` listener that never fires — and
  // the deadline timer the first read cleared can no longer abort it, so the promise would stay
  // pending forever. The flag is what makes a later drain() a no-op instead of a hang.
  let consumed = false;
  const guard = (read) => async () => {
    consumed = true;
    try {
      return await raceAbort(controller.signal, Promise.resolve().then(read));
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
    body: res.body,
    isConsumed: () => consumed,
    json: guard(() => res.json()),
    text: guard(() => res.text()),
  };
}

// Reads and throws away a body nobody wants. Not tidiness: the deadline above is only cleared
// when a body settles, so an unread error response would keep its timer armed.
async function drain(res) {
  if (typeof res.isConsumed === 'function' && res.isConsumed()) return;
  try { await res.text(); } catch { /* the deadline or the socket already ended it */ }
}

export function pkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// Same discovery chain MCP clients use: the portal's RFC 9728 protected-resource
// document names the Clerk issuer; the issuer's own metadata names the endpoints.
export async function discover(deps = {}) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const origin = deps.origin == null ? apiOrigin() : deps.origin;

  const prRes = await fetchWithTimeout(fetchImpl, `${origin}${PROTECTED_RESOURCE_PATH}`);
  if (!prRes.ok) {
    await drain(prRes);
    throw new UserError(
      `OAuth discovery failed (HTTP ${prRes.status} from ${origin}). Check BEEZI_API_URL.`,
    );
  }
  const pr = await prRes.json();
  const issuer = pr.authorization_servers == null ? undefined : pr.authorization_servers[0];
  if (!issuer) {
    throw new UserError('OAuth discovery failed: portal metadata lists no authorization server.');
  }

  const asRes = await fetchWithTimeout(
    fetchImpl,
    `${String(issuer).replace(/\/$/, '')}/.well-known/oauth-authorization-server`,
  );
  if (!asRes.ok) {
    await drain(asRes);
    throw new UserError(`OAuth discovery failed (HTTP ${asRes.status} from the authorization server).`);
  }
  const as = await asRes.json();
  if (!as.authorization_endpoint || !as.token_endpoint || !as.registration_endpoint) {
    throw new UserError('OAuth discovery failed: authorization server metadata is incomplete.');
  }
  return {
    authorizationEndpoint: as.authorization_endpoint,
    tokenEndpoint: as.token_endpoint,
    registrationEndpoint: as.registration_endpoint,
    // RFC 7009. Advertised when the server publishes it; otherwise the string logout used to
    // guess unconditionally, kept so a server without the metadata behaves exactly as before.
    revocationEndpoint: as.revocation_endpoint
      ? as.revocation_endpoint
      : `${String(as.token_endpoint).replace(/\/$/, '')}/revoke`,
  };
}

// Dynamic client registration (RFC 7591): one public client per machine.
export async function registerClient(registrationEndpoint, redirectUri, deps = {}) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const hostname = deps.hostname == null ? os.hostname() : deps.hostname;
  const res = await fetchWithTimeout(fetchImpl, registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: `Beezi Claude Code plugin — ${hostname}`,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      // Registration and the authorization request must name the SAME scopes: a client
      // registered without offline_access is never issued a refresh token, and the plugin
      // only discovers that one access-token lifetime later (finding 7).
      scope: OAUTH_SCOPES,
    }),
  });
  if (!res.ok) {
    await drain(res);
    throw new UserError(`Could not register this machine with the login server (HTTP ${res.status}).`);
  }
  const body = await res.json();
  if (!body.client_id) throw new UserError('Login server returned no client_id.');
  return body.client_id;
}

async function postForm(fetchImpl, url, params, timeoutMs) {
  return fetchWithTimeout(fetchImpl, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  }, timeoutMs);
}

export async function exchangeCode({ tokenEndpoint, clientId, redirectUri, code, verifier }, deps = {}) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const res = await postForm(fetchImpl, tokenEndpoint, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });
  if (!res.ok) {
    await drain(res);
    throw new UserError(`Login failed at the token exchange (HTTP ${res.status}).`);
  }
  return res.json();
}

// The failure taxonomy the caller maps onto the `reason` vocabulary. `tokens: null` is kept on
// every failure so a caller that only asks "did I get tokens" still reads correctly.
export const REFRESH_FAILURES = Object.freeze({
  MISSING_REFRESH_TOKEN: 'missing_refresh_token',
  TIMEOUT: 'timeout',
  NETWORK: 'network',
  SERVER: 'server',
});

// A refresh token that stringifies to one of these is a bug upstream, not a grant: submitting
// it sends `refresh_token=undefined` and earns an invalid_grant that reads as a revoked link.
const NOT_A_TOKEN = new Set(['', 'undefined', 'null']);

// Returns {tokens} on success, {invalidGrant: true, error} when the server named the grant
// unusable, and {tokens: null, failure} for everything else.
export async function refreshTokens({ tokenEndpoint, clientId, refreshToken }, deps = {}) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  if (typeof refreshToken !== 'string' || NOT_A_TOKEN.has(refreshToken.trim())) {
    return { tokens: null, failure: REFRESH_FAILURES.MISSING_REFRESH_TOKEN };
  }
  try {
    const res = await postForm(fetchImpl, tokenEndpoint, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    }, deps.timeoutMs == null ? REFRESH_TIMEOUT_MS : deps.timeoutMs);
    if (res.ok) return { tokens: await res.json() };
    if (res.status === 400 || res.status === 401) {
      let body = {};
      try { body = await res.json(); } catch { /* keep {} */ }
      // Only a named revocation counts. A 400/401 with no parseable `error` is far more
      // often a proxy, captive portal or HTML error page than a revoked grant, and the
      // caller's response to invalidGrant is to stop retrying the grant — too final
      // to trigger on a body we could not read.
      if (body.error === 'invalid_grant' || body.error === 'invalid_client') {
        return { invalidGrant: true, error: body.error };
      }
    }
    await drain(res);
    return { tokens: null, failure: REFRESH_FAILURES.SERVER };
  } catch (error) {
    const name = error == null ? undefined : error.name;
    return {
      tokens: null,
      failure: name === 'AbortError' || name === 'TimeoutError'
        ? REFRESH_FAILURES.TIMEOUT
        : REFRESH_FAILURES.NETWORK,
    };
  }
}
