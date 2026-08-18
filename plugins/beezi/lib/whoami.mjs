import { apiBase, ENDPOINTS } from './config.mjs';
import { machineHeaders } from './machine-identity.mjs';
import { resolveFetch } from './fetch-compat.mjs';

// Resolve the stored access token's validity/identity against the portal, plus the tenant's
// tracking policy. Returns { valid: true, email, name, tenantTier, trackingMode,
// backfillCompleted } | { valid: false } | null (offline/unknown). The three policy fields are
// null/false against a pre-audit server — which every consumer must read as "allow".
export async function whoami(token, deps = {}) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const base = deps.base == null ? apiBase() : deps.base;
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
      email: body.email == null ? null : body.email,
      name: body.name == null ? null : body.name,
      tenantTier: body.tenantTier == null ? null : body.tenantTier,
      trackingMode: body.trackingMode == null ? null : body.trackingMode,
      backfillCompleted: body.backfillCompleted === true,
    };
  } catch {
    return null;
  }
}
