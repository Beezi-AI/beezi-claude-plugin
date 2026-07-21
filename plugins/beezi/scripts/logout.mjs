import { apiBase, ENDPOINTS } from '../lib/config.mjs';
import { getCredentials, deleteCredentials } from '../lib/credentials.mjs';
import { getAccessToken } from '../lib/token.mjs';
import { machineHeaders } from '../lib/machine-identity.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';

const TIMEOUT_MS = 5000;

// Ask the portal to unlink this machine: drops its row and deletes its registered
// OAuth client, killing the grant. 401/403 means the link is already dead — done.
async function unlinkOnServer(token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${apiBase()}${ENDPOINTS.machine}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, ...machineHeaders() },
      signal: controller.signal,
    });
    return res.ok || res.status === 401 || res.status === 403;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Fallback when the portal is unreachable: revoke the grant at the authorization
// server directly (RFC 7009 endpoint sits next to the token endpoint).
async function revokeAtAuthServer(creds) {
  if (!creds?.token_endpoint || !creds.client_id) return false;
  const token = creds.refresh_token ?? creds.access_token;
  if (!token) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${creds.token_endpoint.replace(/\/$/, '')}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token,
        token_type_hint: creds.refresh_token ? 'refresh_token' : 'access_token',
        client_id: creds.client_id,
      }).toString(),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const creds = await getCredentials().catch(() => null);
  if (!creds) {
    console.log('Beezi: this machine is not linked. Nothing to do.');
    return;
  }

  // Refreshes when stale and primes the machine-identity headers.
  const token = await getAccessToken().catch(() => null);
  const serverUnlinked = token ? await unlinkOnServer(token) : false;
  const revoked = serverUnlinked ? false : await revokeAtAuthServer(creds);

  await deleteCredentials().catch(() => {});

  if (serverUnlinked) {
    console.log('✓ Logged out. This machine is unlinked from Beezi.');
  } else if (revoked) {
    console.log('✓ Logged out and access revoked.');
    console.log('  The portal may still list this machine — remove it from the Connections tab.');
  } else {
    console.log('✓ Logged out locally.');
    console.log('  Could not reach the server — this machine may still appear linked in the portal.');
    console.log('  You can remove it from the Connections tab there.');
  }
}

main().catch((error) => {
  console.error(`\n✗ ${friendlyMessage(error)}`);
  process.exit(1);
});
