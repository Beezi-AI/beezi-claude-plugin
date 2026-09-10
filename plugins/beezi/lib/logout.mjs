import fs from 'fs';
import { apiBase, ENDPOINTS } from './config.mjs';
import {
  readCredentials, deleteCredentialGeneration, deleteLegacyCredentials, deleteAllGenerationEntries,
  CREDENTIAL_STATUS, DELETE_STATUS,
} from './credentials.mjs';
import { acquireCredentialLock, releaseCredentialLock } from './credential-lock.mjs';
import { clearAuthMarkers } from './auth-markers.mjs';
import { recordLogout, recordLogoutUnconfirmed } from './telemetry-auth.mjs';
import { auditLedgerFile } from './paths.mjs';
import { clearTrackingState } from './tracking.mjs';
import { getAuthentication as _getAuthentication, INTERACTIVE_REFRESH_WAIT_MS } from './token.mjs';
import { AUTH_STATES } from './auth-state.mjs';
import { machineHeaders } from './machine-identity.mjs';
import { discover as _discover } from './oauth.mjs';
import { rotateInstallationId as _rotateInstallationId } from './installation-id.mjs';
import { resolveFetch } from './fetch-compat.mjs';
import { UserError } from './friendly-error.mjs';

const TIMEOUT_MS = 5000;
const LOGOUT_LOCK_WAIT_MS = 30_000;

// Asks the portal to unlink this machine: drops its row and deletes its registered OAuth client,
// killing the grant. A 401 or 403 means the controller never ran — the request was refused
// before it could unlink anything — so it is a FAILED unlink, not a confirmed one (finding 8).
async function unlinkOnServer(token, deps) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${deps.base == null ? apiBase() : deps.base}${ENDPOINTS.machine}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, ...machineHeaders() },
      signal: controller.signal,
    });
    return { unlinked: res.ok === true, httpStatus: res.status };
  } catch {
    return { unlinked: false, httpStatus: null };
  } finally {
    clearTimeout(timer);
  }
}

// Fallback when the portal could not confirm the unlink: revoke the grant at the authorization
// server directly (RFC 7009). The endpoint comes from discovery when discovery works.
async function revokeAtAuthServer(credentials, deps) {
  if (credentials == null || !credentials.token_endpoint || !credentials.client_id) return false;
  const token = credentials.refresh_token == null ? credentials.access_token : credentials.refresh_token;
  if (!token) return false;
  const discover = deps.discover == null ? _discover : deps.discover;
  let endpoint = `${credentials.token_endpoint.replace(/\/$/, '')}/revoke`;
  try {
    const meta = await discover();
    if (meta != null && meta.revocationEndpoint) endpoint = meta.revocationEndpoint;
  } catch { /* offline discovery — the sibling of the token endpoint is the best guess left */ }
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token,
        token_type_hint: credentials.refresh_token ? 'refresh_token' : 'access_token',
        client_id: credentials.client_id,
      }).toString(),
      signal: controller.signal,
    });
    return res.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Explicit logout, as lines. Never claims a server unlink it did not get, and never claims to
// have logged out when the credentials are still there.
export async function runLogout(deps = {}) {
  const getAuthentication = deps.getAuthentication == null ? _getAuthentication : deps.getAuthentication;
  const rotateInstallationId = deps.rotateInstallationId == null ? _rotateInstallationId : deps.rotateInstallationId;

  const before = await readCredentials(deps).catch(() => null);
  if (before == null || before.status === CREDENTIAL_STATUS.NONE) {
    return ['Beezi: this machine is not linked. Nothing to do.'];
  }

  // Refreshes when stale and primes the machine-identity headers; a machine whose token cannot
  // be renewed still logs out locally, it just cannot prove the server-side unlink.
  const auth = await getAuthentication({}, { waitMs: INTERACTIVE_REFRESH_WAIT_MS }).catch(() => null);
  const token = auth != null && auth.authState === AUTH_STATES.READY ? auth.accessToken : null;
  const server = token ? await unlinkOnServer(token, deps) : { unlinked: false, httpStatus: null };

  // The lock, then a REREAD: a refresh worker may have committed a new generation while the
  // DELETE was in flight, and deleting the generation read before that would leave the new one.
  const lock = await acquireCredentialLock(
    { waitMs: deps.lockWaitMs == null ? LOGOUT_LOCK_WAIT_MS : deps.lockWaitMs }, deps,
  );
  if (lock == null) {
    // Deliberately fatal. Printing "✓ Logged out" while the credentials are still stored is
    // exactly the lie this replaces (finding 8).
    throw new UserError(
      'Another Beezi process is using the saved login, so nothing was removed. '
      + 'Wait a moment and run /beezi:logout again.',
    );
  }
  let revoked = false;
  try {
    const current = await readCredentials(deps, { lock }).catch(() => null);
    const credentials = current != null && current.status === CREDENTIAL_STATUS.READY
      ? current.credentials
      : null;
    if (!server.unlinked) revoked = await revokeAtAuthServer(credentials, deps);
    const removal = await deleteCredentialGeneration({ lock, force: true }, deps);
    if (removal.status !== DELETE_STATUS.DELETED) {
      throw new UserError(
        'Could not remove the saved Beezi authorization from this machine. Try /beezi:logout again.',
      );
    }
    // Orphans too: a generation entry a lock-lost commit left behind is never read, but a refresh
    // orphan holds the ROTATED refresh token — the live one — while the committed generation's is
    // already dead. Safe here and only here, because logout holds the lock.
    deleteAllGenerationEntries({ ...deps, lock });
    // The pre-generation copies too. The new store never reads them, but a downgraded install
    // or a Claude Code process from before the upgrade does, so leaving them behind would leave
    // a live credential on a machine the user just signed out of.
    deleteLegacyCredentials(deps);
    // Invalidates any refresh commit still in flight: its expected generation is gone, so its
    // CAS fails and nothing repopulates the store behind the logout.
    recordLogout();
    clearAuthMarkers();
  } finally {
    releaseCredentialLock(lock);
  }

  // Machine-global tenant state must not survive into the next login: a foreign audit ledger
  // would replay as "all uploaded" and seal the new workspace's pull empty.
  clearTrackingState();
  try { fs.rmSync(auditLedgerFile(), { force: true }); } catch { /* best-effort */ }
  // Events recorded from here on must not correlate back to the account that just left.
  try { rotateInstallationId(); } catch { /* best-effort */ }

  if (server.unlinked) return ['✓ Logged out. This machine is unlinked from Beezi.'];
  if (revoked) {
    return [
      '✓ Logged out and access revoked.',
      '  The portal may still list this machine — remove it from the Connections tab.',
    ];
  }
  recordLogoutUnconfirmed(server.httpStatus);
  const refused = server.httpStatus === 401 || server.httpStatus === 403;
  return [
    '✓ Logged out locally.',
    refused
      ? `  The server refused the unlink request (HTTP ${server.httpStatus}), so this machine may still appear linked in the portal.`
      : '  Could not reach the server — this machine may still appear linked in the portal.',
    '  You can remove it from the Connections tab there.',
  ];
}
