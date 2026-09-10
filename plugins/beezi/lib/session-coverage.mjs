import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';
import { resolveFetch } from './fetch-compat.mjs';

// The route caps sessionIds at 200 per request; a machine with years of history scans thousands.
export const MAX_COVERAGE_IDS = 200;

// Same reasoning as the flush timeout: a foreground command, and the server folds many segment
// rows per session. postJson's 3s default only exists to protect the 10s hook budget.
const DEFAULT_COVERAGE_TIMEOUT_MS = 60_000;

export function planCoverageBatches(sessionIds, size = MAX_COVERAGE_IDS) {
  const batches = [];
  for (let i = 0; i < sessionIds.length; i += size) batches.push(sessionIds.slice(i, i + size));
  return batches;
}

// How far each session already reaches on the server, as a Map of sessionId -> line count already
// stored (0 when the server holds nothing usable). Sessions absent from the response are absent
// from the Map, which the caller reads as 0.
//
// Returns NULL — not an empty Map — when the answer cannot be trusted: an older server with no
// such route, a transport failure, or a partial batch. Null means "fall back to local state
// cursors"; an empty Map would mean "the server has nothing", and re-sending every session from
// line 0 on a transient blip is the one thing this module exists to prevent.
export async function fetchCoverage(sessionIds, token, deps = {}, options = {}) {
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) return new Map();
  const postJsonImpl = deps.postJsonImpl == null ? postJson : deps.postJsonImpl;
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const timeoutMs = options.timeoutMs == null ? DEFAULT_COVERAGE_TIMEOUT_MS : options.timeoutMs;
  const url = `${apiBase()}${ENDPOINTS.sessionsCoverage}`;

  const coverage = new Map();
  for (const batch of planCoverageBatches(sessionIds)) {
    let res;
    try {
      res = await postJsonImpl(url, token, { sessionIds: batch }, { fetchImpl, timeoutMs });
    } catch {
      return null;
    }
    if (!res || !res.ok) return null;
    let body;
    try {
      body = await res.json();
    } catch {
      return null;
    }
    // A 2xx that is not the documented shape is an unknown contract, not "no coverage".
    if (body == null || body.coverage == null || typeof body.coverage !== 'object') return null;
    for (const sessionId of Object.keys(body.coverage)) {
      const value = body.coverage[sessionId];
      if (typeof value === 'number' && isFinite(value) && value > 0) coverage.set(sessionId, Math.floor(value));
    }
  }
  return coverage;
}
