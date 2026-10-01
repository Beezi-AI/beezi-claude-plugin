import { scanCoworkCache } from './cowork-cache.mjs';
import { linkedSessions } from './sessions.mjs';
import { readTrackingState, isLiveTrackingAllowed } from './tracking.mjs';
import { runAudit, SYNC_MODE } from './session-audit.mjs';
import { resolveFetch } from './fetch-compat.mjs';

// Run inside the existing throttled, locked background worker. The sync route can CREATE
// unseen sessions from costStates + started_at; /sessions/cost-state cannot do that.
export async function runCoworkSync(deps = {}, options = {}) {
  const getSessions = deps.linkedSessions == null ? linkedSessions : deps.linkedSessions;
  const readTracking = deps.readTrackingState == null ? readTrackingState : deps.readTrackingState;
  const scan = deps.scanCoworkCache == null ? scanCoworkCache : deps.scanCoworkCache;
  const audit = deps.runAudit == null ? runAudit : deps.runAudit;
  const sessions = (await getSessions(deps)).filter((session) => isLiveTrackingAllowed(readTracking(session.key)));
  const expected = deps.expectedAccountKeys == null ? [] : deps.expectedAccountKeys();
  const unavailable = expected.some((key) => !sessions.some((session) => session.key === key));
  if (sessions.length === 0) return { results: [], unavailable };
  let found;
  try { found = scan(); } catch { return { results: [], unavailable: true }; }
  if (found.sessions.length === 0) return { results: [], warnings: found.warnings, unavailable };
  const results = [];
  for (const session of sessions) {
    const allowed = () => deps.isEligible == null || deps.isEligible(session.key);
    if (!allowed()) continue;
    const fetch = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
    const guardedFetch = (...args) => {
      if (!allowed()) throw new Error('Cowork tracking stopped');
      return fetch(...args);
    };
    const result = await audit({ ...deps, fetchImpl: guardedFetch, shouldContinue: allowed, listTranscripts: () => found.sessions },
      { mode: SYNC_MODE, account: session.key, ...(options.live ? { coworkLive: true } : {}) });
    results.push({ key: session.key, ...result });
  }
  return { results, warnings: found.warnings, unavailable };
}
