import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { apiBase, OAUTH_SCOPES } from '../lib/config.mjs';
import { discover, registerClient, pkcePair, exchangeCode } from '../lib/oauth.mjs';
import { getCredentials, setCredentials } from '../lib/credentials.mjs';
import { startLoopback } from '../lib/loopback.mjs';
import { whoami } from '../lib/whoami.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';

function openBrowser(url) {
  // The URL comes from the server response — never pass it through a shell. Require a
  // plain http(s) URL and hand it to the launcher as a single argv element (no shell,
  // no interpolation), so it cannot smuggle command-line metacharacters.
  if (!/^https?:\/\//i.test(url)) return;
  try {
    if (process.platform === 'win32') {
      const sysRoot = process.env.SystemRoot || 'C:\\Windows';
      // Start-Process uses ShellExecute → the default browser's http(s) association, and
      // handles query strings (?code=…&…) correctly. explorer.exe mis-parses such URLs and
      // can pop a File Explorer / search window instead of the browser. Absolute PowerShell
      // path avoids resolving a bare name against the current directory; the URL is passed
      // as an env var, never spliced into the command text, so it can't be run as script.
      const powershell = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process $env:BEEZI_LOGIN_URL'], {
        stdio: 'ignore',
        env: { ...process.env, BEEZI_LOGIN_URL: url },
      });
    } else if (process.platform === 'darwin') {
      execFileSync('/usr/bin/open', [url], { stdio: 'ignore' });
    } else {
      execFileSync('xdg-open', [url], { stdio: 'ignore' });
    }
  } catch {
    // Non-fatal — the user can open the printed URL manually.
  }
}

// Bind the loopback listener, reusing this machine's registered client when its
// callback port is free; otherwise register a fresh client on a new port. Clerk
// matches redirect URIs exactly (port included), so client_id and redirect_uri
// always travel together.
async function bindClient(meta, existing, state) {
  if (existing?.client_id && existing.redirect_uri) {
    const port = Number(new URL(existing.redirect_uri).port);
    try {
      const lb = await startLoopback({ port, expectedState: state });
      return { ...lb, clientId: existing.client_id };
    } catch {
      // Port taken by another process — fall through to a fresh registration.
    }
  }
  const lb = await startLoopback({ port: 0, expectedState: state });
  const clientId = await registerClient(meta.registrationEndpoint, lb.redirectUri);
  return { ...lb, clientId };
}

async function run() {
  const base = apiBase();

  const existing = await getCredentials().catch(() => null);
  if (existing) {
    const who = await whoami(existing.access_token, { base });
    if (who?.valid) {
      const account = who.name || who.email;
      console.log(`\n✓ This machine is already linked to Beezi${account ? ` as ${account}` : ''}.`);
      console.log('  Nothing to do.\n');
      return;
    }
    // Token invalid/revoked → fall through and re-link.
  }

  console.log('\nBeezi analytics — link this machine\n');
  const meta = await discover();
  const { verifier, challenge } = pkcePair();
  const state = crypto.randomBytes(16).toString('base64url');
  const { redirectUri, clientId, code } = await bindClient(meta, existing, state);

  const authorizeUrl = `${meta.authorizationEndpoint}?${new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: OAUTH_SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })}`;

  console.log('Opening your browser to sign in with your Beezi account…');
  console.log(`If it does not open, go to:\n  ${authorizeUrl}\n`);
  openBrowser(authorizeUrl);

  const authCode = await code; // blocks until the callback or timeout

  const tokens = await exchangeCode({
    tokenEndpoint: meta.tokenEndpoint,
    clientId,
    redirectUri,
    code: authCode,
    verifier,
  });

  const where = await setCredentials({
    client_id: clientId,
    redirect_uri: redirectUri,
    token_endpoint: meta.tokenEndpoint,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + (tokens.expires_in ?? 86_400) * 1000,
  });
  console.log(`\n✓ Beezi analytics linked. Credentials stored in ${where}.`);
}

// argv ('start'/'wait') is ignored: the PKCE flow is a single blocking command,
// and a stale two-phase login.md invoking `wait` just re-runs the fast
// already-linked check.
run().catch((error) => {
  console.error(`\n✗ ${friendlyMessage(error)}`);
  process.exit(1);
});
