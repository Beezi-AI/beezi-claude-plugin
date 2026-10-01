import { rotateInstallationId as _rotateInstallationId } from './installation-id.mjs';
import fs from 'fs';
import { unlinkOnServer, revokeAtAuthServer } from './machine-unlink.mjs';
import { readIndex, resolveAccountRef, setDefault, removeAccount, describeAccount } from './accounts.mjs';
import {
  readCredentials, deleteCredentialGeneration, deleteAllGenerationEntries,
  CREDENTIAL_STATUS, DELETE_STATUS,
} from './credentials.mjs';
import { acquireCredentialLock, releaseCredentialLock } from './credential-lock.mjs';
import { clearAuthMarkers } from './auth-markers.mjs';
import { recordLogout, recordLogoutUnconfirmed } from './telemetry-auth.mjs';
import { auditLedgerFile } from './paths.mjs';
import { clearTrackingState } from './tracking.mjs';
import { getAuthentication as _getAuthentication, INTERACTIVE_REFRESH_WAIT_MS } from './token.mjs';
import { AUTH_STATES } from './auth-state.mjs';
import { UserError } from './friendly-error.mjs';

const LOGOUT_LOCK_WAIT_MS = 30_000;

// Explicit logout, as lines. Never claims a server unlink it did not get, and never claims to
// have logged out when the credentials are still there.
export async function runLogout(deps = {}, options = {}) {
  if (options.list) return logoutAccounts(deps, options);
  const lifecycle = await acquireCredentialLock({ lifecycle: true, waitMs: deps.lockWaitMs == null ? 30_000 : deps.lockWaitMs }, deps);
  if (!lifecycle) throw new UserError('Another Beezi account change is in progress. Retry /beezi:logout in a moment.');
  try { return await logoutAccounts(deps, options); }
  finally { releaseCredentialLock(lifecycle); }
}

async function logoutAccounts(deps, options) {
  const index = await readIndex(deps);
  if (options.list && !index.accounts.length) return ['Beezi: this machine is not linked. Nothing to do.'];
  if (options.list) return index.accounts.map((a, i) => `${i + 1}. ${describeAccount(a)} [${a.key}]${a.key === index.default ? ' (default)' : ''}`);
  if (!index.accounts.length) return ['Beezi: this machine is not linked. Nothing to do.'];
  if (!options.all && !options.account && index.accounts.length > 1) throw new UserError('Choose --account <key|email|number> or --all. Run /beezi:accounts to list accounts.');
  const keys = options.all ? index.accounts.map(a => a.key) : [options.account ? await resolveAccountRef(options.account, deps) : index.accounts[0].key];
  const remaining = index.accounts.filter(a => !keys.includes(a.key));
  let next = null;
  if (options.nextDefault) {
    next = await resolveAccountRef(options.nextDefault, deps);
    if (!remaining.some(a => a.key === next)) throw new UserError('The next default must be an account that remains linked.');
  }
  if (keys.includes(index.default) && remaining.length && !next) throw new UserError('Choose the remaining analytics default with --next-default <key|email|number> before logging out.');
  const lines = [];
  for (const account of keys) {
    lines.push(`${describeAccount(index.accounts.find(a => a.key === account))}:`, ...await logoutOne(account, deps));
    if (account === index.default && next) await setDefault(next, deps);
    await removeAccount(account, deps);
  }
  // No account remains to carry this machine's diagnostics. A later login must not inherit
  // the departed account's diagnostic identity; consent itself remains a machine preference.
  if (!remaining.length) {
    try { (deps.rotateInstallationId || _rotateInstallationId)(); } catch (_) { /* best-effort */ }
  }
  return lines;
}

async function logoutOne(account, deps) {
  const getAuthentication = deps.getAuthentication == null ? _getAuthentication : deps.getAuthentication;

  const before = await readCredentials(deps, { account }).catch(() => null);


  // Refreshes when stale and primes the machine-identity headers; a machine whose token cannot
  // be renewed still logs out locally, it just cannot prove the server-side unlink.
  const auth = await getAuthentication(deps, { account, waitMs: INTERACTIVE_REFRESH_WAIT_MS }).catch(() => null);
  const token = auth != null && auth.authState === AUTH_STATES.READY ? auth.accessToken : null;
  let server = token ? await unlinkOnServer({ key: account, token, clientId: auth.clientId || (before && before.credentials && before.credentials.client_id) }, deps) : { unlinked: false, httpStatus: null };

  if (server.httpStatus === 401) {
    const retry = await getAuthentication(deps, { account, forceRefresh: true, waitMs: INTERACTIVE_REFRESH_WAIT_MS }).catch(() => null);
    if ((retry && retry.authState) === AUTH_STATES.READY) server = await unlinkOnServer({ key: account, token: retry.accessToken, clientId: retry.clientId || (before && before.credentials && before.credentials.client_id) }, deps);
  }

  // The lock, then a REREAD: a refresh worker may have committed a new generation while the
  // DELETE was in flight, and deleting the generation read before that would leave the new one.
  const lock = await acquireCredentialLock(
    { account, waitMs: deps.lockWaitMs == null ? LOGOUT_LOCK_WAIT_MS : deps.lockWaitMs }, deps,
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
    const current = await readCredentials(deps, { account, lock }).catch(() => null);
    const credentials = current != null && current.status === CREDENTIAL_STATUS.READY
      ? current.credentials
      : null;
    if (!server.unlinked) revoked = await revokeAtAuthServer(credentials, deps);
    const removal = await deleteCredentialGeneration({ account, lock, force: true }, deps);
    if (removal.status !== DELETE_STATUS.DELETED) {
      throw new UserError(
        'Could not remove the saved Beezi authorization from this machine. Try /beezi:logout again.',
      );
    }
    // Orphans too: a generation entry a lock-lost commit left behind is never read, but a refresh
    // orphan holds the ROTATED refresh token — the live one — while the committed generation's is
    // already dead. Safe here and only here, because logout holds the lock.
    deleteAllGenerationEntries({ ...deps, account, lock });
    // Invalidates any refresh commit still in flight: its expected generation is gone, so its
    // CAS fails and nothing repopulates the store behind the logout.
    recordLogout();
    clearAuthMarkers(account);
  } finally {
    releaseCredentialLock(lock);
  }

  // Remove state belonging to this account only.
  clearTrackingState(account);
  try { fs.rmSync(auditLedgerFile(account), { force: true }); } catch { /* best-effort */ }


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
