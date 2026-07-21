import { apiBase, ENDPOINTS } from './config.mjs';
import { machineHeaders } from './machine-identity.mjs';

// Resolve the stored access token's validity/identity against the portal.
// Returns { valid: true, email, name } | { valid: false } | null (offline/unknown).
export async function whoami(token, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const base = deps.base ?? apiBase();
  try {
    const res = await fetchImpl(`${base}${ENDPOINTS.whoami}`, {
      headers: { Authorization: `Bearer ${token}`, ...machineHeaders() },
    });
    if (res.status === 401 || res.status === 403) return { valid: false };
    if (!res.ok) return null;
    let body = {};
    try { body = await res.json(); } catch { /* keep {} */ }
    return {
      valid: true,
      email: body.email ?? null,
      name: body.name ?? null,
    };
  } catch {
    return null;
  }
}
