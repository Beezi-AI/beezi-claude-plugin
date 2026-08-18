// Bounded POST of a JSON body with bearer auth. Returns the fetch Response so callers
// own the status/body handling; throws on network error or timeout (caller catches).
// The timeout guards the hook's 10s budget — a hung server must not stall the turn.
import { machineHeaders } from './machine-identity.mjs';
import { resolveFetch } from './fetch-compat.mjs';
import { resolveAbortController } from './abort-compat.mjs';

const DEFAULT_TIMEOUT_MS = 3000;

export async function postJson(url, token, body, deps = {}) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const timeoutMs = deps.timeoutMs == null ? DEFAULT_TIMEOUT_MS : deps.timeoutMs;
  const AbortControllerImpl = resolveAbortController();
  const controller = new AbortControllerImpl();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...machineHeaders(),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}
