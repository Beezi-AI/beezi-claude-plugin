import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';

// POST one session-error record to Beezi. Fire-and-forget by convention; callers
// swallow the result. Returns { reported, status? , reason? }.
export async function postSessionError(payload, token, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (!payload?.sessionId || !payload?.error) return { reported: false, reason: 'missing-fields' };
  if (!token) return { reported: false, reason: 'no-token' };
  try {
    const res = await postJson(`${apiBase()}${ENDPOINTS.sessionErrors}`, token, payload, { fetchImpl });
    return { reported: res.status >= 200 && res.status < 300, status: res.status };
  } catch {
    return { reported: false, reason: 'network' };
  }
}
