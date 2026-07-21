import crypto from 'node:crypto';
import os from 'node:os';
import { apiOrigin, PROTECTED_RESOURCE_PATH } from './config.mjs';
import { UserError } from './friendly-error.mjs';

// Clerk development instances cold-start well past 5s; measured 5.6s–20s on first contact.
const TIMEOUT_MS = 15000;

async function fetchWithTimeout(fetchImpl, url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function pkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// Same discovery chain MCP clients use: the portal's RFC 9728 protected-resource
// document names the Clerk issuer; the issuer's own metadata names the endpoints.
export async function discover(deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const origin = deps.origin ?? apiOrigin();

  const prRes = await fetchWithTimeout(fetchImpl, `${origin}${PROTECTED_RESOURCE_PATH}`);
  if (!prRes.ok) {
    throw new UserError(
      `OAuth discovery failed (HTTP ${prRes.status} from ${origin}). Check BEEZI_API_URL.`,
    );
  }
  const pr = await prRes.json();
  const issuer = pr.authorization_servers?.[0];
  if (!issuer) {
    throw new UserError('OAuth discovery failed: portal metadata lists no authorization server.');
  }

  const asRes = await fetchWithTimeout(
    fetchImpl,
    `${String(issuer).replace(/\/$/, '')}/.well-known/oauth-authorization-server`,
  );
  if (!asRes.ok) {
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
  };
}

// Dynamic client registration (RFC 7591): one public client per machine.
export async function registerClient(registrationEndpoint, redirectUri, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const hostname = deps.hostname ?? os.hostname();
  const res = await fetchWithTimeout(fetchImpl, registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: `Beezi Claude Code plugin — ${hostname}`,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  if (!res.ok) {
    throw new UserError(`Could not register this machine with the login server (HTTP ${res.status}).`);
  }
  const body = await res.json();
  if (!body.client_id) throw new UserError('Login server returned no client_id.');
  return body.client_id;
}

async function postForm(fetchImpl, url, params) {
  return fetchWithTimeout(fetchImpl, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
}

export async function exchangeCode({ tokenEndpoint, clientId, redirectUri, code, verifier }, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const res = await postForm(fetchImpl, tokenEndpoint, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });
  if (!res.ok) throw new UserError(`Login failed at the token exchange (HTTP ${res.status}).`);
  return res.json();
}

// Returns {tokens} on success, {invalidGrant: true} when the grant was revoked
// (machine unlinked / user deactivated), {tokens: null} on transient failure.
export async function refreshTokens({ tokenEndpoint, clientId, refreshToken }, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  try {
    const res = await postForm(fetchImpl, tokenEndpoint, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    });
    if (res.ok) return { tokens: await res.json() };
    if (res.status === 400 || res.status === 401) {
      let body = {};
      try { body = await res.json(); } catch { /* keep {} */ }
      if (!body.error || body.error === 'invalid_grant' || body.error === 'invalid_client') {
        return { invalidGrant: true };
      }
    }
    return { tokens: null };
  } catch {
    return { tokens: null };
  }
}
