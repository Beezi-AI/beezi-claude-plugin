import fs from 'fs';
import path from 'path';
import {
  getCredentials as _getCredentials,
  setCredentials as _setCredentials,
  deleteCredentials as _deleteCredentials,
} from './credentials.mjs';
import { refreshTokens as _refreshTokens } from './oauth.mjs';
import { setMachineClientId } from './machine-identity.mjs';
import { beeziHome } from './paths.mjs';

const SKEW_MS = 60_000;
const LOCK_STALE_MS = 30_000;
// Only used when the token response omits expires_in. It must be an underestimate: the access
// token is opaque, so its real lifetime is unknowable here, and guessing long means we hand out
// a dead token for the whole difference without ever attempting a refresh. An hour is the
// shortest lifetime any of these servers is likely to issue; forceRefresh covers the rest.
const DEFAULT_EXPIRES_IN_S = 3_600;

const lockDir = () => path.join(beeziHome(), 'token-refresh.lock');

// mkdir is atomic: it either creates the lock or fails because another hook
// holds it. A lock older than LOCK_STALE_MS is from a crashed hook — break it.
function acquireLock() {
  const dir = lockDir();
  try {
    fs.mkdirSync(dir, { recursive: false });
    return true;
  } catch {
    try {
      if (Date.now() - fs.statSync(dir).mtimeMs > LOCK_STALE_MS) {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: false });
        return true;
      }
    } catch { /* fall through */ }
    return false;
  }
}

function releaseLock() {
  try { fs.rmSync(lockDir(), { recursive: true, force: true }); } catch { /* ignore */ }
}

// The one token accessor for hooks: returns a bearer-ready access token,
// refreshing (at most once, machine-wide) when it is about to expire.
// Returns null when the machine is not linked or the link was revoked.
//
// `options.forceRefresh` refreshes even when expires_at still looks healthy. expires_at is only
// ever this client's estimate — the access token is opaque, and a server that omits expires_in
// leaves us guessing — so a 401 from the API is better evidence of expiry than our own clock.
// Callers that get a 401 should retry once behind this flag before reporting a rejected link.
export async function getAccessToken(deps = {}, options = {}) {
  const getCreds = deps.getCredentials == null ? _getCredentials : deps.getCredentials;
  const setCreds = deps.setCredentials == null ? _setCredentials : deps.setCredentials;
  const deleteCreds = deps.deleteCredentials == null ? _deleteCredentials : deps.deleteCredentials;
  const refresh = deps.refreshTokens == null ? _refreshTokens : deps.refreshTokens;
  const now = deps.now == null ? Date.now : deps.now;
  const sleep = deps.sleep == null ? ((ms) => new Promise((r) => setTimeout(r, ms))) : deps.sleep;

  let creds;
  try { creds = await getCreds(deps); } catch { return null; }
  if (!creds) return null;
  setMachineClientId(creds.client_id);
  const looksFresh = (c) => (c == null || c.expires_at == null ? 0 : c.expires_at) - now() > SKEW_MS;
  if (!options.forceRefresh && looksFresh(creds)) return creds.access_token;

  if (!acquireLock()) {
    // Another hook is refreshing; give it a beat, then use what it stored — but only if it
    // actually finished. Handing back the same expired token just produces a 401 downstream,
    // and a 401 is read as a revoked link.
    await sleep(750);
    const again = await getCreds(deps).catch(() => null);
    // Under forceRefresh the stored token is the one that just 401'd, so "looks fresh" is not
    // enough — only a token the holder actually replaced is worth returning.
    if (again && looksFresh(again) && (!options.forceRefresh || again.access_token !== creds.access_token)) {
      return again.access_token;
    }
    return null;
  }
  try {
    const r = await refresh(
      { tokenEndpoint: creds.token_endpoint, clientId: creds.client_id, refreshToken: creds.refresh_token },
      deps,
    );
    if (r.invalidGrant) {
      await deleteCreds(deps);
      return null;
    }
    // Transient failure (network, timeout, unreadable error body). Report "no usable token"
    // rather than returning the expired one: callers treat a 401 as a revoked link and drop
    // the credentials, so a stale token turns a blip into a permanent logout.
    if (r.tokens == null || !r.tokens.access_token) return null;
    const next = {
      ...creds,
      access_token: r.tokens.access_token,
      refresh_token: r.tokens.refresh_token == null ? creds.refresh_token : r.tokens.refresh_token,
      expires_at: now() + (r.tokens.expires_in == null ? DEFAULT_EXPIRES_IN_S : r.tokens.expires_in) * 1000,
    };
    await setCreds(next, deps);
    return next.access_token;
  } finally {
    releaseLock();
  }
}
