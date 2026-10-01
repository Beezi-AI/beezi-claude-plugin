import { apiBase, ENDPOINTS } from './config.mjs';
import { authHeaders } from './http.mjs';
import { discover as _discover } from './oauth.mjs';
import { resolveFetch } from './fetch-compat.mjs';
const TIMEOUT_MS = 5000;

// Asks the portal to unlink this machine: drops its row and deletes its registered OAuth client,
// killing the grant. A 401 or 403 means the controller never ran — the request was refused
// before it could unlink anything — so it is a FAILED unlink, not a confirmed one (finding 8).
export async function unlinkOnServer(session, deps = {}) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${deps.base == null ? apiBase() : deps.base}${ENDPOINTS.machine}`, {
      method: 'DELETE',
      headers: authHeaders(session),
      signal: controller.signal,
    });
    return { unlinked: res.ok === true, httpStatus: res.status };
  } catch {
    return { unlinked: false, httpStatus: null };
  } finally {
    clearTimeout(timer);
  }
}

// Fallback when the portal could not confirm the unlink: revoke the grant at the authorization
// server directly (RFC 7009). The endpoint comes from discovery when discovery works.
export async function revokeAtAuthServer(credentials, deps = {}) {
  if (credentials == null || !credentials.token_endpoint || !credentials.client_id) return false;
  const token = credentials.refresh_token == null ? credentials.access_token : credentials.refresh_token;
  if (!token) return false;
  const discover = deps.discover == null ? _discover : deps.discover;
  let endpoint = `${credentials.token_endpoint.replace(/\/$/, '')}/revoke`;
  try {
    const meta = await discover();
    if (meta != null && meta.revocationEndpoint) endpoint = meta.revocationEndpoint;
  } catch { /* offline discovery — the sibling of the token endpoint is the best guess left */ }
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token,
        token_type_hint: credentials.refresh_token ? 'refresh_token' : 'access_token',
        client_id: credentials.client_id,
      }).toString(),
      signal: controller.signal,
    });
    return res.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
