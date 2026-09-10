import { apiBase, ENDPOINTS } from './config.mjs';
import { machineHeaders } from './machine-identity.mjs';
import { resolveFetch } from './fetch-compat.mjs';
import { AUTH_REASONS } from './auth-state.mjs';

// What the portal said about this token. 401 and 403 are NOT the same answer: 401 is a verdict
// on the credential (one refresh may fix it), 403 is a verdict on the account (a seat, a tenant,
// a restriction — refreshing cannot fix it), and 503 OAUTH_VERIFICATION_UNAVAILABLE means the
// portal could not reach its verifier at all. Collapsing them is what let a permissions refusal
// and a verification outage delete a healthy session (findings 1, 2).
export const PROBE_OUTCOMES = Object.freeze({
  AUTHENTICATED: 'authenticated',
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  UNAVAILABLE: 'unavailable',
});

// The API's "I could not complete verification" code; never a verdict on the credential.
const VERIFICATION_UNAVAILABLE = 'OAUTH_VERIFICATION_UNAVAILABLE';

// Resolve the stored access token against the portal. Returns
// { outcome, httpStatus, identity } — identity is the whoami body's fields on AUTHENTICATED
// and null otherwise. httpStatus is null when the request never reached a response.
export async function probeIdentity(token, deps = {}) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const base = deps.base == null ? apiBase() : deps.base;
  let res;
  try {
    res = await fetchImpl(`${base}${ENDPOINTS.whoami}`, {
      headers: { Authorization: `Bearer ${token}`, ...machineHeaders() },
    });
  } catch {
    // No response at all, so there is no status to preserve — its own reason says which.
    return {
      outcome: PROBE_OUTCOMES.UNAVAILABLE, httpStatus: null, identity: null,
      reason: AUTH_REASONS.PROBE_UNREACHABLE,
    };
  }
  if (res.status === 401) {
    return {
      outcome: PROBE_OUTCOMES.UNAUTHORIZED, httpStatus: 401, identity: null,
      reason: AUTH_REASONS.UNAUTHORIZED,
    };
  }
  if (res.status === 403) {
    return {
      outcome: PROBE_OUTCOMES.FORBIDDEN, httpStatus: 403, identity: null,
      reason: AUTH_REASONS.FORBIDDEN,
    };
  }
  if (!res.ok) {
    let code = null;
    try { const body = await res.json(); code = body == null ? null : body.code; } catch { /* keep null */ }
    const verificationUnavailable = code === VERIFICATION_UNAVAILABLE;
    // The reason a diagnostic carries, so "the server could not check" and "we were rate
    // limited" stay distinguishable from an ordinary 5xx in the evidence trail.
    let reason = null;
    if (verificationUnavailable) reason = AUTH_REASONS.VERIFICATION_UNAVAILABLE;
    else if (res.status === 429) reason = AUTH_REASONS.RATE_LIMITED;
    return {
      outcome: PROBE_OUTCOMES.UNAVAILABLE,
      httpStatus: res.status,
      identity: null,
      verificationUnavailable,
      reason,
    };
  }
  let body = {};
  try { body = await res.json(); } catch { /* keep {} */ }
  return {
    outcome: PROBE_OUTCOMES.AUTHENTICATED,
    httpStatus: res.status,
    identity: {
      email: body.email == null ? null : body.email,
      name: body.name == null ? null : body.name,
      tenantTier: body.tenantTier == null ? null : body.tenantTier,
      trackingMode: body.trackingMode == null ? null : body.trackingMode,
      backfillCompleted: body.backfillCompleted === true,
    },
  };
}

// Compatibility shape for the many callers that only ask "is this token good": { valid: true,
// … } | { valid: false } | null (offline/unknown). It cannot express forbidden-vs-unauthorized
// -vs-unavailable — every user-facing decision reads probeIdentity instead.
export async function whoami(token, deps = {}) {
  const probe = await probeIdentity(token, deps);
  if (probe.outcome === PROBE_OUTCOMES.AUTHENTICATED) return { valid: true, ...probe.identity };
  if (probe.outcome === PROBE_OUTCOMES.UNAVAILABLE) return null;
  return { valid: false };
}
