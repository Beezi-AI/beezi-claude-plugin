import fs from 'node:fs';
import path from 'node:path';
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
const DEFAULT_EXPIRES_IN_S = 86_400;

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
export async function getAccessToken(deps = {}) {
  const getCreds = deps.getCredentials ?? _getCredentials;
  const setCreds = deps.setCredentials ?? _setCredentials;
  const deleteCreds = deps.deleteCredentials ?? _deleteCredentials;
  const refresh = deps.refreshTokens ?? _refreshTokens;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  let creds;
  try { creds = await getCreds(deps); } catch { return null; }
  if (!creds) return null;
  setMachineClientId(creds.client_id);
  if ((creds.expires_at ?? 0) - now() > SKEW_MS) return creds.access_token;

  if (!acquireLock()) {
    // Another hook is refreshing; give it a beat, then use what it stored — but only if it
    // actually finished. Handing back the same expired token just produces a 401 downstream,
    // and a 401 is read as a revoked link.
    await sleep(750);
    const again = await getCreds(deps).catch(() => null);
    if (again && (again.expires_at ?? 0) - now() > SKEW_MS) return again.access_token;
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
    if (!r.tokens?.access_token) return null;
    const next = {
      ...creds,
      access_token: r.tokens.access_token,
      refresh_token: r.tokens.refresh_token ?? creds.refresh_token,
      expires_at: now() + (r.tokens.expires_in ?? DEFAULT_EXPIRES_IN_S) * 1000,
    };
    await setCreds(next, deps);
    return next.access_token;
  } finally {
    releaseLock();
  }
}
