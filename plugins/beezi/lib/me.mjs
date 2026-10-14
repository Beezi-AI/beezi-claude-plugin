import { readIndex, describeAccount, updateAccount } from './accounts.mjs';
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
  const index = await readIndex(deps);
  if (!index.accounts.length) return ['Beezi: this machine is not linked. Run /beezi:login to link an account.'];
  const blocks = await Promise.all(index.accounts.map(async account => {
    const heading = `${describeAccount(account)}${account.key === index.default ? ' (default)' : ''}`;
    return [heading, ...await accountLines(account, deps)];
  }));
  return [`Beezi: ${index.accounts.length} account(s). /beezi:analytics reads from the default.`, ...blocks.flatMap(b => [...b, ''])];
}

// Signs the account in, checks it with the server and saves its identity; `lines` say what is wrong ([] when ok).
export async function accountHealth(account, deps = {}) {
  const fail = (lines) => ({ ok: false, lines, identity: null });
  if (account.status === 'revoked') return fail(['  Revoked — run /beezi:login and sign in as this account.']);
  const getAuthentication = deps.getAuthentication == null ? _getAuthentication : deps.getAuthentication;
  const probeIdentity = deps.probeIdentity == null ? _probeIdentity : deps.probeIdentity;
  const waitMs = deps.waitMs == null ? INTERACTIVE_REFRESH_WAIT_MS : deps.waitMs;
  const recordAuthResultImpl = deps.recordAuthResult == null ? _recordAuthResult : deps.recordAuthResult;

  const auth = await getAuthentication(deps, { account: account.key, waitMs });
  if (auth.authState !== AUTH_STATES.READY) return fail(authStatusLines(auth));

  let probe = await probeIdentity({ key: account.key, token: auth.accessToken, clientId: auth.clientId || account.clientId }, deps);
  if (probe.outcome === PROBE_OUTCOMES.UNAUTHORIZED) {
    // The server's word beats this client's expiry estimate for an opaque token — but only a
    // real 401 earns the retry. A 403 or a 503 is never a reason to spend a refresh grant.
    const retry = await getAuthentication(deps, { account: account.key, forceRefresh: true, waitMs });
    if (retry.authState !== AUTH_STATES.READY) return fail(authStatusLines(retry));
    probe = await probeIdentity({ key: account.key, token: retry.accessToken, clientId: retry.clientId || account.clientId }, deps);
  }
  if (probe.outcome === PROBE_OUTCOMES.FORBIDDEN) {
    recordAuthResultImpl(
      { authState: AUTH_STATES.UNAVAILABLE, reason: AUTH_REASONS.FORBIDDEN },
      { account: account.key, source: DIAGNOSTIC_SOURCES.ME },
    );
    return fail(FORBIDDEN_STATUS_LINES);
  }
  if (probe.outcome === PROBE_OUTCOMES.UNAVAILABLE) {
    if (probe.reason != null) {
      recordAuthResultImpl(
        { authState: AUTH_STATES.UNAVAILABLE, reason: probe.reason },
        { account: account.key, source: DIAGNOSTIC_SOURCES.ME },
      );
    }
    return fail(probe.verificationUnavailable
      ? VERIFICATION_UNAVAILABLE_STATUS_LINES
      : ['Beezi: could not reach the server to check your link. Check your connection and try again.']);
  }
  if (probe.outcome === PROBE_OUTCOMES.UNAUTHORIZED) {
    return fail([
      'Beezi: the server no longer accepts this machine’s authorization.',
      '  Your saved authorization is still here — run /beezi:login to authorize this machine again.',
    ]);
  }

  const who = probe.identity;
  await updateAccount(account.key, who, deps);
  return { ok: true, lines: [], identity: who };
}

async function accountLines(account, deps) {
  const health = await accountHealth(account, deps);
  if (!health.ok) return health.lines;
  const who = health.identity;
  const lines = ['✓ Beezi: this machine is linked.'];
  if (who.name) lines.push(`  Account: ${who.name}${who.email ? ` <${who.email}>` : ''}`);
  else if (who.email) lines.push(`  Account: ${who.email}`);
  // The web-side workspace and its tracking mode say nothing about where a multi-workspace account sends.
  const multi = who.tenants != null && who.tenants.length > 1;
  if (who.tenantName && !multi) lines.push(`  Workspace: ${who.tenantName}`);
  if (who.tenantTier) lines.push(`  Plan tier: ${who.tenantTier}`);
  if (who.trackingMode && !multi) {
    lines.push(`  Tracking: ${who.trackingMode}${who.backfillCompleted ? ' (history pull complete)' : ''}`);
  }
  return lines;
}
