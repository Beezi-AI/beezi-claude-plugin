import { AUTH_STATES, AUTH_REASONS } from './auth-state.mjs';
import { DIAGNOSTIC_CODES, DIAGNOSTIC_SOURCES } from './telemetry-codes.mjs';
import { recordIssue as _recordIssue } from './telemetry.mjs';
import { readAuthState } from './auth-markers.mjs';
import { maybeSpawnDiagnostics as _maybeSpawnDiagnostics } from './diagnostics-trigger.mjs';

// Every authentication diagnostic in one place, so the call sites that own the state changes stay
// one line long and none of them has to know the code vocabulary.
//
// Nothing here throws: an authentication path must never fail because a diagnostic could not be
// written, and recordIssue is already consent-gated and self-suppressing.
const safely = (fn) => { try { return fn(); } catch { return false; } };

// An unreadable record reads as "changed": one diagnostic too many beats one never sent.
function isUnchanged(authState, reason) {
  try {
    const last = readAuthState();
    return last != null && last.lastState === authState && last.lastReason === reason;
  } catch {
    return false;
  }
}

// Called at the single funnel every authentication result passes through, BEFORE the caller acts
// on it — for the worker's branches, before the marker write that changes the state.
//
// `ready/ok` is deliberately silent: it is the normal case. So is a result identical to the last
// recorded state — the code is `auth_state_changed`, and nothing changed. That gate is what stops
// a permanently unlinked machine emitting a fresh event every time the queue drains: the
// pending-file fold only spans the window between drains. The caller writes the new last-state
// AFTER this call, so the comparison still happens before the change.
export function recordAuthResult(result, deps = {}) {
  const recordIssue = deps.recordIssue == null ? _recordIssue : deps.recordIssue;
  return safely(() => {
    if (result == null) return false;
    const { authState, reason } = result;
    const source = deps.source;
    if (deps.skipUnchanged !== false && isUnchanged(authState, reason)) return false;
    if (authState === AUTH_STATES.READY) {
      if (reason !== AUTH_REASONS.RECOVERED) return false;
      return recordIssue({
        code: DIAGNOSTIC_CODES.AUTH_RECOVERED, source,
        authState: AUTH_STATES.READY, reason: AUTH_REASONS.RECOVERED,
      });
    }
    // Two reasons have a code of their own; everything else is the generic transition.
    const code = reason === AUTH_REASONS.STORAGE_CONFLICT
      ? DIAGNOSTIC_CODES.CREDENTIAL_MIGRATION_CONFLICT
      : (reason === AUTH_REASONS.REFRESH_INTERRUPTED
        ? DIAGNOSTIC_CODES.REFRESH_INTERRUPTED
        : DIAGNOSTIC_CODES.AUTH_STATE_CHANGED);
    return recordIssue({ code, source, authState, reason });
  });
}

// The only place `logged_out` is emitted, recorded before the markers are cleared.
export function recordLogout(deps = {}) {
  const recordIssue = deps.recordIssue == null ? _recordIssue : deps.recordIssue;
  return safely(() => recordIssue({
    code: DIAGNOSTIC_CODES.AUTH_STATE_CHANGED,
    source: DIAGNOSTIC_SOURCES.LOGOUT,
    authState: AUTH_STATES.UNLINKED,
    reason: AUTH_REASONS.LOGGED_OUT,
  }));
}

// Logout removed the local credentials but the server never confirmed the revocation. The reason
// comes from the status alone: 401/403 are what the server said, anything else means it was
// never reached.
export function recordLogoutUnconfirmed(httpStatus, deps = {}) {
  const recordIssue = deps.recordIssue == null ? _recordIssue : deps.recordIssue;
  const reason = httpStatus === 401
    ? AUTH_REASONS.UNAUTHORIZED
    : (httpStatus === 403 ? AUTH_REASONS.FORBIDDEN : AUTH_REASONS.PROBE_UNREACHABLE);
  return safely(() => recordIssue({
    code: DIAGNOSTIC_CODES.LOGOUT_UNLINK_UNCONFIRMED,
    source: DIAGNOSTIC_SOURCES.LOGOUT,
    reason,
    httpStatus: typeof httpStatus === 'number' ? httpStatus : null,
  }));
}

// Interactive login failed; `reason` is the login/probe outcome the thrown error carried.
export function recordLoginFailure(reason, deps = {}) {
  const recordIssue = deps.recordIssue == null ? _recordIssue : deps.recordIssue;
  const spawn = deps.maybeSpawnDiagnostics == null ? _maybeSpawnDiagnostics : deps.maybeSpawnDiagnostics;
  const recorded = safely(() => recordIssue({
    code: DIAGNOSTIC_CODES.LOGIN_FAILED,
    source: DIAGNOSTIC_SOURCES.LOGIN,
    reason,
  }));
  // /beezi:login is not a hook, so nothing else would deliver this until the next prompt — and a
  // failed login is exactly the report that must not wait for a working login.
  if (recorded) safely(() => spawn());
  return recorded;
}

// The MCP bridge could not start or complete its handshake.
export function recordMcpStartupFailure(error, reason, deps = {}) {
  const recordIssue = deps.recordIssue == null ? _recordIssue : deps.recordIssue;
  // An unlinked machine is a normal state, not a bridge that failed to start.
  if (reason === AUTH_REASONS.NO_CREDENTIALS || reason === AUTH_REASONS.LOGGED_OUT) return false;
  return safely(() => recordIssue({
    code: DIAGNOSTIC_CODES.MCP_STARTUP_FAILED,
    source: DIAGNOSTIC_SOURCES.MCP_BRIDGE,
    error,
    reason,
  }));
}
