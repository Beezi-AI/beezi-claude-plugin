import fs from 'fs';
import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';
import { resolveFetch } from './fetch-compat.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { oauthKeyStatusFile } from './paths.mjs';
import { keyFingerprint } from './oauth-identity.mjs';
import { oauthTokenEnv } from './claude-settings-env.mjs';

// v2 caches the rest of the portal's answer (subscription type, tier, account email, whether the
// bound account has an identity of its own) so the session-start adoption can fill a whole record
// from one probe. A v1 file fails the gate in readOauthKeyStatus and is simply re-probed once.
//
// v3 adds planSource. The portal has always sent it and this module has always dropped it, which
// made session-start's anchored-key notice — gated on `planSource === 'reported'` — unable to fire
// at all: the property was undefined on every answer, live and cached. The version bump is what
// makes the fix take effect today rather than whenever each machine's six-hour cache lapses; a v2
// file fails the gate and is re-probed once, exactly as v1 was.
const STATE_VERSION = 3;

// How long an answer is trusted. Long enough that the steady state is one file read, short enough
// that a user who fixes their plan in the portal stops being nagged the same working day.
const FRESH_MS = 6 * 60 * 60 * 1000;

// Tighter than postJson's 3s default: this runs inline on SessionStart, whose whole budget is 10s
// and which may already have spent ~600ms spawning the Claude CLI. A slow answer is worth less than
// a fast start — the nudge simply waits for the next session.
const PROBE_TIMEOUT_MS = 1500;

export function readOauthKeyStatus(deps = {}) {
  const read = deps.readJsonImpl == null ? readJson : deps.readJsonImpl;
  const raw = read(oauthKeyStatusFile(), null);
  if (!raw || raw.version !== STATE_VERSION) return null;
  return raw;
}

function writeOauthKeyStatus(state, deps = {}) {
  const write = deps.writeJsonImpl == null ? writeJsonSecure : deps.writeJsonImpl;
  try {
    write(oauthKeyStatusFile(), { version: STATE_VERSION, ...state });
  } catch { /* best-effort */ }
}

// Drop the cached verdict so the next call asks the portal again.
//
// Called after a resolve lands: the answer the user just gave makes the cached one wrong, and
// without this a key resolved seconds ago keeps its needsAttention:true verdict for up to six
// hours and produces one more nudge telling the user to do what they already did.
export function clearOauthKeyStatus(deps = {}) {
  const remove = deps.unlinkImpl == null ? ((p) => fs.unlinkSync(p)) : deps.unlinkImpl;
  try {
    remove(oauthKeyStatusFile());
    return true;
  } catch {
    // Absent already, or an unwritable home. Neither is worth surfacing — the cache is a cache.
    return false;
  }
}

// Is a cached answer about THIS key, and recent enough to reuse? A rotation changes the
// fingerprint, so the previous key's verdict is discarded rather than aged out — the new key has
// its own account, or none.
function isUsable(cached, fingerprint, nowMs) {
  if (cached == null || cached.fingerprint == null) return false;
  if (
    cached.fingerprint.prefix !== fingerprint.prefix
    || cached.fingerprint.last4 !== fingerprint.last4
    || cached.fingerprint.length !== fingerprint.length
  ) {
    return false;
  }
  const at = Date.parse(cached.checkedAt == null ? '' : cached.checkedAt);
  if (Number.isNaN(at)) return false;
  // A stamp from the future is a clock change, not a fresh answer.
  return nowMs - at <= FRESH_MS && at <= nowMs;
}

// Does the portal know what this machine's setup token bills?
//
// Returns { needsAttention, known, subscriptionPlan } or null when the question could not be
// answered — offline, an older server with no such route, no token, a token too short to
// fingerprint. Null means SAY NOTHING: a machine that cannot reach the portal must not be told its
// billing is unresolved, because that is not what it observed.
//
// Best-effort by contract, like every other hook path: it never throws.
export async function fetchOauthKeyStatus(token, deps = {}) {
  // A token set in ~/.claude/settings.json reaches us as process.env in a normal session; when it
  // does not, oauthTokenEnv fills that one key. An INJECTED deps.env is trusted verbatim — it
  // describes a machine under test, and a developer's own settings file must not leak into it.
  const env = deps.env == null ? oauthTokenEnv(process.env) : deps.env;
  const fingerprint = keyFingerprint(env.CLAUDE_CODE_OAUTH_TOKEN);
  if (!token || fingerprint == null) return null;

  const now = deps.now == null ? new Date() : deps.now;
  const cached = readOauthKeyStatus(deps);
  // `refresh` forces a live read. Used right after a check-in registers this key: the cached answer
  // is from before it existed server-side, and believing it would report the key as unknown for
  // another six hours.
  if (deps.refresh !== true && isUsable(cached, fingerprint, now.getTime())) {
    return {
      known: cached.known === true,
      needsAttention: cached.needsAttention === true,
      subscriptionPlan: cached.subscriptionPlan == null ? null : cached.subscriptionPlan,
      subscriptionType: cached.subscriptionType == null ? null : cached.subscriptionType,
      rateLimitTier: cached.rateLimitTier == null ? null : cached.rateLimitTier,
      accountEmail: cached.accountEmail == null ? null : cached.accountEmail,
      accountLinked: cached.accountLinked === true,
      accountAnchored: cached.accountAnchored === true,
      planSource: cached.planSource == null ? null : cached.planSource,
      fingerprint,
    };
  }

  try {
    const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
    const res = await postJson(
      `${apiBase()}${ENDPOINTS.credentialStatus}`,
      token,
      { prefix: fingerprint.prefix, last4: fingerprint.last4, length: fingerprint.length },
      { fetchImpl, timeoutMs: PROBE_TIMEOUT_MS },
    );
    if (res == null || res.status < 200 || res.status >= 300) return null;
    const body = await res.json();
    if (body == null || typeof body !== 'object') return null;

    // Every new field is guarded exactly like subscriptionPlan was: an older API that does not send
    // them yields nulls, never undefined leaking into billing.json, and never a crash.
    const status = {
      known: body.known === true,
      needsAttention: body.needsAttention === true,
      subscriptionPlan: typeof body.subscriptionPlan === 'string' ? body.subscriptionPlan : null,
      subscriptionType: typeof body.subscriptionType === 'string' ? body.subscriptionType : null,
      rateLimitTier: typeof body.rateLimitTier === 'string' ? body.rateLimitTier : null,
      accountEmail: typeof body.accountEmail === 'string' ? body.accountEmail : null,
      accountLinked: body.accountLinked === true,
      // The bound account carries an identity of its own, so this key inherited a subscription some
      // interactive sign-in established rather than standing on its own.
      accountAnchored: body.accountAnchored === true,
      // WHERE the plan came from: 'reported' when a machine asserted it, 'manual' when a person
      // declared it in the portal. session-start pairs it with accountAnchored to decide whether
      // this key is riding a subscription nobody confirmed for it. Guarded like every sibling —
      // an older API that omits it yields null, never undefined leaking into a comparison.
      planSource: typeof body.planSource === 'string' ? body.planSource : null,
    };
    writeOauthKeyStatus(
      { fingerprint, checkedAt: now.toISOString(), ...status },
      deps,
    );
    // The fingerprint rides the return value, never the cache-shaped copy above: callers write the
    // adopted plan into billing.json scoped to the key it was resolved for, and re-deriving it there
    // from a second env read is how a rotation ends up mis-scoped.
    return { ...status, fingerprint };
  } catch {
    // Offline, timed out, or an old server. Not an observation about the key.
    return null;
  }
}
