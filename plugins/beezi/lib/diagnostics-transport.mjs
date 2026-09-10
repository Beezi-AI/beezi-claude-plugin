// Bounded, AUTHORIZATION-FREE POST for consented diagnostics.
//
// Deliberately takes no token and sends no machineHeaders(): the whole point of the public
// ingestion route is that losing OAuth must not also lose the evidence about losing it. There is
// no Authorization, no Cookie, no X-Beezi-* header and no hostname on the wire, and this module
// imports nothing from token.mjs, so a diagnostic send can never trigger a token refresh.
// The absent token parameter is the guarantee — do not add one.
import { resolveFetch } from './fetch-compat.mjs';
import { resolveAbortController } from './abort-compat.mjs';

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

// Seconds or an HTTP-date, per RFC 9110. Anything else, or a value past an hour, reads as absent
// so a hostile or broken header cannot park the queue indefinitely.
export function retryAfterMs(header, now = Date.now()) {
  if (header == null) return null;
  const text = String(header).trim();
  if (/^\d+$/.test(text)) return Math.min(Number(text) * 1000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return null;
  const delta = at - now;
  return delta <= 0 ? 0 : Math.min(delta, MAX_RETRY_AFTER_MS);
}

// Resolves with { status, retryAfterMs, body }; throws only on transport failure or timeout,
// which the caller treats as "preserve and retry".
export async function postDiagnostics(url, payload, deps = {}) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const timeoutMs = deps.timeoutMs == null ? DEFAULT_TIMEOUT_MS : deps.timeoutMs;
  const now = deps.now == null ? () => Date.now() : deps.now;
  const AbortControllerImpl = resolveAbortController();
  const controller = new AbortControllerImpl();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: controller.signal,
    });
    const header = res == null || res.headers == null ? null : res.headers.get('retry-after');
    let body = null;
    // A body is only interesting on 200; every other status is decided by the code alone.
    if (res != null && res.status === 200) {
      try { body = await res.json(); } catch { body = null; }
    }
    return { status: res == null ? 0 : res.status, retryAfterMs: retryAfterMs(header, now()), body };
  } finally {
    clearTimeout(timeout);
  }
}
