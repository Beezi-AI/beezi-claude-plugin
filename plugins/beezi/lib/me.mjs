import { getAuthentication as _getAuthentication, INTERACTIVE_REFRESH_WAIT_MS } from './token.mjs';
import { probeIdentity as _probeIdentity, PROBE_OUTCOMES } from './whoami.mjs';
import { AUTH_STATES, AUTH_REASONS } from './auth-state.mjs';
import { DIAGNOSTIC_SOURCES } from './telemetry-codes.mjs';
import { recordAuthResult as _recordAuthResult } from './telemetry-auth.mjs';
import {
  authStatusLines, FORBIDDEN_STATUS_LINES, VERIFICATION_UNAVAILABLE_STATUS_LINES,
} from './auth-messages.mjs';

// /beezi:me, as lines. A human is waiting, so this may wait out a running refresh worker rather
// than report `refreshing` the way a hook does.
export async function runMe(deps = {}) {
  const getAuthentication = deps.getAuthentication == null ? _getAuthentication : deps.getAuthentication;
  const probeIdentity = deps.probeIdentity == null ? _probeIdentity : deps.probeIdentity;
  const waitMs = deps.waitMs == null ? INTERACTIVE_REFRESH_WAIT_MS : deps.waitMs;
  const recordAuthResultImpl = deps.recordAuthResult == null ? _recordAuthResult : deps.recordAuthResult;

  const auth = await getAuthentication({}, { waitMs });
  if (auth.authState !== AUTH_STATES.READY) return authStatusLines(auth);

  let probe = await probeIdentity(auth.accessToken);
  if (probe.outcome === PROBE_OUTCOMES.UNAUTHORIZED) {
    // The server's word beats this client's expiry estimate for an opaque token — but only a
    // real 401 earns the retry. A 403 or a 503 is never a reason to spend a refresh grant.
    const retry = await getAuthentication({}, { forceRefresh: true, waitMs });
    if (retry.authState !== AUTH_STATES.READY) return authStatusLines(retry);
    probe = await probeIdentity(retry.accessToken);
  }
  if (probe.outcome === PROBE_OUTCOMES.FORBIDDEN) {
    recordAuthResultImpl(
      { authState: AUTH_STATES.UNAVAILABLE, reason: AUTH_REASONS.FORBIDDEN },
      { source: DIAGNOSTIC_SOURCES.ME },
    );
    return FORBIDDEN_STATUS_LINES;
  }
  if (probe.outcome === PROBE_OUTCOMES.UNAVAILABLE) {
    if (probe.reason != null) {
      recordAuthResultImpl(
        { authState: AUTH_STATES.UNAVAILABLE, reason: probe.reason },
        { source: DIAGNOSTIC_SOURCES.ME },
      );
    }
    return probe.verificationUnavailable
      ? VERIFICATION_UNAVAILABLE_STATUS_LINES
      : ['Beezi: could not reach the server to check your link. Check your connection and try again.'];
  }
  if (probe.outcome === PROBE_OUTCOMES.UNAUTHORIZED) {
    return [
      'Beezi: the server no longer accepts this machine’s authorization.',
      '  Your saved authorization is still here — run /beezi:login to authorize this machine again.',
    ];
  }

  const who = probe.identity;
  const lines = ['✓ Beezi: this machine is linked.'];
  if (who.name) lines.push(`  Account: ${who.name}${who.email ? ` <${who.email}>` : ''}`);
  else if (who.email) lines.push(`  Account: ${who.email}`);
  if (who.tenantTier) lines.push(`  Plan tier: ${who.tenantTier}`);
  if (who.trackingMode) {
    lines.push(`  Tracking: ${who.trackingMode}${who.backfillCompleted ? ' (history pull complete)' : ''}`);
  }
  return lines;
}
