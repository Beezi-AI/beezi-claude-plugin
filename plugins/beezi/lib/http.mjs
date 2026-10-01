// Bounded HTTP with a timeout: an authenticated POST of a JSON body, and an unauthenticated GET
// returning parsed JSON. Both throw on network error or timeout (caller catches).
// The timeout guards the hook's 10s budget — a hung server must not stall the turn.
import { machineHeaders } from './machine-identity.mjs';
import { resolveFetch } from './fetch-compat.mjs';
import { resolveAbortController } from './abort-compat.mjs';

const DEFAULT_TIMEOUT_MS = 3000;

export function authHeaders(session) {
  if (session == null || typeof session.token !== 'string' || !session.token) {
    throw new TypeError('An authenticated account session is required.');
  }
  return { Authorization: `Bearer ${session.token}`, ...machineHeaders(session.clientId) };
}

export async function postJson(url, session, body, deps = {}) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const timeoutMs = deps.timeoutMs == null ? DEFAULT_TIMEOUT_MS : deps.timeoutMs;
  const AbortControllerImpl = resolveAbortController();
  const controller = new AbortControllerImpl();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      method: 'POST',
      headers: {
        ...authHeaders(session),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

// Bounded, UNAUTHENTICATED GET returning parsed JSON.
//
// Deliberately takes no token and sends no machineHeaders(): its only caller reads a PUBLIC
// marketplace manifest from raw.githubusercontent.com, and this plugin's bearer token must never
// leave the Beezi API host. The absent token parameter is the guarantee — do not add one.
// Throws on network error, timeout, non-2xx, or a body that is not JSON; the caller catches.
export async function getJson(url, deps = {}) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const timeoutMs = deps.timeoutMs == null ? DEFAULT_TIMEOUT_MS : deps.timeoutMs;
  const AbortControllerImpl = resolveAbortController();
  const controller = new AbortControllerImpl();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: controller.signal,
    });
    if (res == null || res.status < 200 || res.status >= 300) {
      throw new Error(`GET failed with status ${res == null ? 'none' : res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}
