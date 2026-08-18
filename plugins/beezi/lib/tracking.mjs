import fs from 'fs';
import { trackingStateFile } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';

const STATE_VERSION = 1;

// Mirror of the server's TrackingMode enum — the whoami contract, never string-matched inline.
export const TrackingMode = Object.freeze({
  LIVE: 'live',
  BACKFILL_ONLY: 'backfill_only',
  DISABLED: 'disabled',
});

// Cached tenant tracking state, refreshed from whoami on SessionStart and from any 403
// TRACKING_DISABLED. Lives at the beeziHome() ROOT (beside billing.json) — pruneStale() sweeps
// state/ and queue/ only, and an expiring gate would silently re-enable dark-mode tenants.
//
// The gate is deliberately FAIL-OPEN: a missing/corrupt file or an old server (no trackingMode
// in whoami) means "allow" — the server's TrackingEnabledGuard is the actual boundary, and
// failing closed would dark-mode every fresh install until its first whoami.
export function readTrackingState(deps = {}) {
  const read = deps.readJsonImpl == null ? readJson : deps.readJsonImpl;
  const raw = read(trackingStateFile(), null);
  if (!raw || raw.version !== STATE_VERSION) return null;
  return raw;
}

export function writeTrackingState(state, deps = {}) {
  const write = deps.writeJsonImpl == null ? writeJsonSecure : deps.writeJsonImpl;
  // 0600 like every other beeziHome() root file; best-effort — a disk failure must never
  // break a hook.
  try {
    write(trackingStateFile(), { version: STATE_VERSION, ...state });
  } catch { /* best-effort */ }
}

export function isLiveTrackingAllowed(state = readTrackingState()) {
  const mode = state == null || state.trackingMode == null ? null : state.trackingMode;
  if (mode === TrackingMode.BACKFILL_ONLY || mode === TrackingMode.DISABLED) return false;
  return true;
}

// Mirrors the server's derivation: every mode except `disabled` is offered the one-time pull
// until it completes — paid tenants included, not just audit ones. A null mode means a
// pre-audit server: it has no backfill routes, so no hint.
export function shouldBackfill(state = readTrackingState()) {
  if (!state) return false;
  if (state.trackingMode == null) return false;
  if (state.backfillCompleted === true) return false;
  return state.trackingMode !== TrackingMode.DISABLED;
}

// The state is machine-global but the server's pull record is per (tenant, user, tool): a
// logout→login into another workspace must not inherit the previous one's flags. The OAuth
// client id changes on every login (dynamic registration), so it is the natural binding key;
// email is the fallback for states recorded before the id was known.
export function matchesIdentity(state, identity) {
  if (state == null || !state.identity || !identity) return true;
  return state.identity === identity;
}

// Merge `patch` over the stored state. Every mutator below goes through this: writing a bare
// object instead drops whatever fields the caller did not know about, which is exactly how a
// whoami refresh used to clobber the linkedAt stamp written at login.
function patchTrackingState(patch, deps = {}) {
  const current = readTrackingState(deps);
  writeTrackingState({ ...(current == null ? {} : current), ...patch }, deps);
}

// When this machine was linked, as an ISO instant. The audit uses it to skip transcripts that live
// tracking already owns; it used to be approximated by the credentials file's mtime, which is only
// written by the DPAPI/plaintext fallbacks — on any machine with a real credential store (CredMan,
// Keychain, secret-tool) that file never exists and the guard silently never fired.
export function markLinked(deps = {}) {
  patchTrackingState({ linkedAt: new Date().toISOString() }, deps);
}

// Takes the already-read state so callers that hold one don't re-read the file — and so the audit
// can feed it the same state its other gates key off.
export function linkedAtMs(state) {
  const at = state == null ? undefined : state.linkedAt;
  if (!at) return null;
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
}

// Persist the whoami verdict. `identity` is the current login's binding key (client id or email).
export function recordWhoami(who, identity, deps = {}) {
  if (!who || who.valid !== true) return;
  patchTrackingState(
    {
      trackingMode: who.trackingMode == null ? null : who.trackingMode,
      tenantTier: who.tenantTier == null ? null : who.tenantTier,
      backfillCompleted: who.backfillCompleted === true,
      identity: identity == null ? null : identity,
      fetchedAt: new Date().toISOString(),
      reason: null,
    },
    deps,
  );
}

// A live endpoint answered 403 TRACKING_DISABLED: the server has spoken — go dark until the
// next whoami says otherwise.
export function markTrackingDisabled(reason, deps = {}) {
  patchTrackingState(
    {
      trackingMode: TrackingMode.DISABLED,
      fetchedAt: new Date().toISOString(),
      reason: reason == null ? null : reason,
    },
    deps,
  );
}

// The pull sealed (locally observed or server-confirmed) — the audit fast path keys off this.
export function markBackfillCompleted(deps = {}) {
  patchTrackingState({ backfillCompleted: true, fetchedAt: new Date().toISOString() }, deps);
}

export function clearTrackingState(deps = {}) {
  const fsImpl = deps.fsImpl == null ? fs : deps.fsImpl;
  try {
    fsImpl.rmSync(trackingStateFile(), { force: true });
  } catch { /* best-effort */ }
}
