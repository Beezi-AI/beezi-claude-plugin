import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';
import { resolveFetch } from './fetch-compat.mjs';

// POST one session-error record to Beezi. Fire-and-forget by convention; callers
// swallow the result. Returns { reported, status? , reason? }.
export async function postSessionError(payload, token, deps = {}) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  if (payload == null || !payload.sessionId || !payload.error) return { reported: false, reason: 'missing-fields' };
  if (!token) return { reported: false, reason: 'no-token' };
  try {
    // timeoutMs is undefined for every hook caller, so postJson keeps its 3s default; the bulk
    // import raises it, having no 10s hook budget to protect.
    const res = await postJson(`${apiBase()}${ENDPOINTS.sessionErrors}`, token, payload, { fetchImpl, timeoutMs: deps.timeoutMs });
    return { reported: res.status >= 200 && res.status < 300, status: res.status };
  } catch {
    return { reported: false, reason: 'network' };
  }
}
