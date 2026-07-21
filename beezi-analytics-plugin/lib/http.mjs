// Bounded POST of a JSON body with bearer auth. Returns the fetch Response so callers
// own the status/body handling; throws on network error or timeout (caller catches).
// The timeout guards the hook's 10s budget — a hung server must not stall the turn.
const DEFAULT_TIMEOUT_MS = 3000;

export async function postJson(url, token, body, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}
