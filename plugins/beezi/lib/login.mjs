import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { apiBase, OAUTH_SCOPES } from './config.mjs';
import { auditLedgerFile } from './paths.mjs';
import { clearTrackingState, markLinked, recordWhoami } from './tracking.mjs';
import { discover as _discover, registerClient as _registerClient, pkcePair, exchangeCode as _exchangeCode } from './oauth.mjs';
import { commitCredentials, readCredentials, CREDENTIAL_STATUS, COMMIT_STATUS } from './credentials.mjs';
import { acquireCredentialLock, releaseCredentialLock } from './credential-lock.mjs';
import { clearAuthMarkers } from './auth-markers.mjs';
import { startLoopback as _startLoopback } from './loopback.mjs';
import { setMachineClientId, getMachineClientId } from './machine-identity.mjs';
import { probeIdentity as _probeIdentity, PROBE_OUTCOMES } from './whoami.mjs';
import { getAuthentication as _getAuthentication, INTERACTIVE_REFRESH_WAIT_MS } from './token.mjs';
import { AUTH_STATES, AUTH_REASONS } from './auth-state.mjs';
import { syncAccountIfNeeded as _syncAccountIfNeeded } from './account-sync.mjs';
import { oauthTokenEnvWithOsProbe } from './claude-settings-env.mjs';
import { DIAGNOSTIC_SOURCES } from './telemetry-codes.mjs';
import { recordAuthResult as _recordAuthResult } from './telemetry-auth.mjs';
import { UserError } from './friendly-error.mjs';

// The commit at the end of a login must not lose a browser round-trip to a refresh worker that
// happens to hold the lock, so the wait is generous — a human is already waiting anyway.
const LOGIN_LOCK_WAIT_MS = 30_000;

export function openBrowser(url) {
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

// Whether this machine's registered client can be reused. It cannot when the provider has
// definitively rejected it (its Clerk application is likely gone, and reusing it earns
// invalid_client at the browser step), and it cannot when the stored grant carries no refresh
// token — that client was registered without offline_access and needs a correctly scoped
// replacement plus renewed consent (finding 7).
function reusableClient(credentials, verdict) {
  if (credentials == null || !credentials.client_id || !credentials.redirect_uri) return null;
  if (verdict === AUTH_REASONS.CONSENT_REQUIRED || verdict === AUTH_REASONS.UNAUTHORIZED) return null;
  if (verdict === AUTH_STATES.REAUTH_REQUIRED) return null;
  return credentials;
}

// Binds the loopback listener, reusing this machine's registered client when its callback port
// is free; otherwise registers a fresh client on a new port. Clerk matches redirect URIs exactly
// (port included), so client_id and redirect_uri always travel together.
async function bindClient(meta, reusable, state, deps) {
  const startLoopback = deps.startLoopback == null ? _startLoopback : deps.startLoopback;
  const registerClient = deps.registerClient == null ? _registerClient : deps.registerClient;
  if (reusable) {
    const port = Number(new URL(reusable.redirect_uri).port);
    try {
      const lb = await startLoopback({ port, expectedState: state });
      return { ...lb, clientId: reusable.client_id, registered: false };
    } catch {
      // Port taken by another process — fall through to a fresh registration.
    }
  }
  const lb = await startLoopback({ port: 0, expectedState: state });
  let clientId;
  try {
    clientId = await registerClient(meta.registrationEndpoint, lb.redirectUri);
  } catch (error) {
    // The old credentials are still committed; nothing has been replaced yet.
    error.loginReason = AUTH_REASONS.REGISTRATION_FAILED;
    throw error;
  }
  return { ...lb, clientId, registered: true };
}

// Interactive login. The previous credential generation survives every failure here — a
// cancelled browser flow, failed discovery, a failed registration, a failed exchange — and is
// replaced only once a validated token set has actually been committed. Probing the stored
// access token and deleting on its 401 or 403 is the defect this replaces (finding 1).
export async function runLogin(deps = {}) {
  const log = deps.log == null ? console.log : deps.log;
  const base = deps.base == null ? apiBase() : deps.base;
  const getAuthentication = deps.getAuthentication == null ? _getAuthentication : deps.getAuthentication;
  const probeIdentity = deps.probeIdentity == null ? _probeIdentity : deps.probeIdentity;
  const discover = deps.discover == null ? _discover : deps.discover;
  const exchangeCode = deps.exchangeCode == null ? _exchangeCode : deps.exchangeCode;
  const syncAccountIfNeeded = deps.syncAccountIfNeeded == null ? _syncAccountIfNeeded : deps.syncAccountIfNeeded;
  const open = deps.openBrowser == null ? openBrowser : deps.openBrowser;
  const now = deps.now == null ? Date.now : deps.now;
  const recordAuthResultImpl = deps.recordAuthResult == null ? _recordAuthResult : deps.recordAuthResult;

  // The shared accessor, not the raw stored token: it refreshes if it can, so an ordinary
  // expired access token never reaches the identity probe as evidence of a dead link.
  let auth = await getAuthentication({}, { waitMs: INTERACTIVE_REFRESH_WAIT_MS }).catch(() => null);
  if (auth == null) auth = { authState: AUTH_STATES.UNAVAILABLE, reason: AUTH_REASONS.STORAGE_UNAVAILABLE };
  let verdict = auth.authState === AUTH_STATES.READY ? null : auth.authState;
  if (auth.reason === AUTH_REASONS.MISSING_REFRESH_TOKEN) {
    // A client registered without offline_access. The behaviour — register a correctly scoped
    // replacement below — was already right; this puts the reason on the wire, so the evidence
    // says renewed consent was needed rather than just "some reauthorization".
    verdict = AUTH_REASONS.CONSENT_REQUIRED;
    recordAuthResultImpl(
      { authState: AUTH_STATES.REAUTH_REQUIRED, reason: AUTH_REASONS.CONSENT_REQUIRED },
      { source: DIAGNOSTIC_SOURCES.LOGIN },
    );
  }

  if (auth.authState === AUTH_STATES.READY) {
    let probe = await probeIdentity(auth.accessToken, { base });
    if (probe.outcome === PROBE_OUTCOMES.UNAUTHORIZED) {
      // Exactly one retry, and only after a real 401. A 403 or a 503 is a verdict on the
      // account or on the server's ability to check, and no refresh grant can answer either.
      const retry = await getAuthentication({}, { forceRefresh: true, waitMs: INTERACTIVE_REFRESH_WAIT_MS })
        .catch(() => null);
      if (retry != null && retry.authState === AUTH_STATES.READY) {
        auth = retry;
        probe = await probeIdentity(retry.accessToken, { base });
      }
    }
    if (probe.outcome === PROBE_OUTCOMES.AUTHENTICATED) {
      const who = { valid: true, ...probe.identity };
      // getAuthentication already stamped the machine client id from the committed generation.
      try { recordWhoami(who, getMachineClientId()); } catch { /* best-effort */ }
      const account = who.name || who.email;
      log(`\n✓ This machine is already linked to Beezi${account ? ` as ${account}` : ''}.`);
      log('  Nothing to do.\n');
      // Forced: the user asked for a re-link, and this is the one path that reaches the account
      // check-in with a token already in hand. Bounded and silent — a failure never fails a login.
      await syncAccountIfNeeded(
        auth.accessToken,
        { force: true, via: 'login' },
        { env: oauthTokenEnvWithOsProbe(process.env) },
      );
      return { status: 'already_linked' };
    }
    if (probe.outcome === PROBE_OUTCOMES.FORBIDDEN) {
      // Not a credential problem, and nothing is deleted over it. Signing in as a different
      // account is the only thing that could help, so the flow continues.
      log('\nBeezi: this account does not have access here (the server refused with 403).');
      log('  Ask your Beezi administrator about your seat, or sign in below as another account.\n');
    }
    if (probe.outcome === PROBE_OUTCOMES.UNAUTHORIZED) verdict = AUTH_REASONS.UNAUTHORIZED;
  }

  log('\nBeezi analytics — link this machine\n');
  const existing = await currentCredentials(deps);
  const reusable = reusableClient(existing, verdict);
  if (existing != null && reusable == null) {
    log('This machine’s saved authorization needs your consent again — registering it afresh.');
    log('  The existing one is kept until the new one is stored.\n');
  }

  let meta;
  try {
    meta = await discover();
  } catch (error) {
    error.loginReason = AUTH_REASONS.DISCOVERY_FAILED;
    throw error;
  }
  const { verifier, challenge } = pkcePair();
  const state = crypto.randomBytes(16).toString('base64url');
  const { redirectUri, clientId, code } = await bindClient(meta, reusable, state, deps);

  const authorizeUrl = `${meta.authorizationEndpoint}?${new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    // The same scopes the client was registered with; offline_access is what earns the refresh
    // token every later hook depends on.
    scope: OAUTH_SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })}`;

  log('Opening your browser to sign in with your Beezi account…');
  log(`If it does not open, go to:\n  ${authorizeUrl}\n`);
  open(authorizeUrl);

  let authCode;
  try {
    authCode = await code; // blocks until the callback or timeout
  } catch (error) {
    // Cancelled or timed out. The previous generation is exactly as it was.
    error.loginReason = AUTH_REASONS.LOGIN_CANCELLED;
    throw error;
  }

  // The lock comes BEFORE the exchange, not after: taking it afterwards means a lock timeout
  // throws away tokens the server has already issued and the user redoes the browser flow.
  const lock = await acquireCredentialLock(
    { waitMs: deps.lockWaitMs == null ? LOGIN_LOCK_WAIT_MS : deps.lockWaitMs }, deps,
  );
  if (lock == null) {
    throw new UserError(
      'Another Beezi process is using the saved login. Wait a moment and run /beezi:login again.',
    );
  }
  let where;
  let tokens;
  try {
    try {
      tokens = await exchangeCode({
        tokenEndpoint: meta.tokenEndpoint, clientId, redirectUri, code: authCode, verifier,
      });
    } catch (error) {
      error.loginReason = AUTH_REASONS.EXCHANGE_FAILED;
      throw error;
    }
    // A grant with no refresh token lasts one access-token lifetime and then submits the string
    // "undefined" forever; refuse it here rather than store it (finding 7).
    if (!nonEmpty(tokens.access_token) || !nonEmpty(tokens.refresh_token)) {
      const error = new UserError(
        'The login server did not return a usable session for this machine. Your previous Beezi '
        + 'authorization is untouched — try /beezi:login again.',
      );
      error.loginReason = AUTH_REASONS.EXCHANGE_FAILED;
      throw error;
    }
    const commit = await commitCredentials({
      client_id: clientId,
      redirect_uri: redirectUri,
      token_endpoint: meta.tokenEndpoint,
      scope: OAUTH_SCOPES,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      // Underestimate when the server omits expires_in — see DEFAULT_EXPIRES_IN_S in
      // lib/refresh-worker.mjs. Guessing long parks a dead token in the keychain for the whole
      // difference, and nothing refreshes it because expires_at still reads healthy.
      expires_at: now() + (tokens.expires_in == null ? 3_600 : tokens.expires_in) * 1000,
    }, { lock, force: true }, deps);
    if (commit.status !== COMMIT_STATUS.COMMITTED) {
      throw new UserError(
        'Could not store the new Beezi authorization on this machine. Try /beezi:login again.',
      );
    }
    where = commit.where;
    // The new generation is committed, so every marker about the old one is now inert.
    clearAuthMarkers();
  } finally {
    releaseCredentialLock(lock);
  }

  setMachineClientId(clientId);
  // A fresh login is a fresh identity: machine-global tenant state recorded under the previous
  // one (audit ledger, tracking cache) must not leak into this workspace — a foreign ledger
  // replayed here would seal the new tenant's pull empty.
  clearTrackingState();
  try { fs.rmSync(auditLedgerFile(), { force: true }); } catch { /* best-effort */ }
  // Stamp the link instant before anything can be tracked under it: the audit skips transcripts
  // touched after this, which is what stops it re-segmenting sessions live tracking already sent.
  markLinked();
  // The portal registers a machine from the X-Beezi-Host/Client headers that ride along on an
  // authenticated request — it has no registration endpoint. Best-effort: the link is stored.
  const probe = await probeIdentity(tokens.access_token, { base }).catch(() => null);
  const who = probe != null && probe.outcome === PROBE_OUTCOMES.AUTHENTICATED
    ? { valid: true, ...probe.identity }
    : null;
  if (who) {
    try { recordWhoami(who, clientId); } catch { /* best-effort */ }
  }
  log(`\n✓ Beezi analytics linked. Credentials stored in ${where}.`);
  const account = who ? (who.name || who.email) : null;
  if (account) log(`  Account: ${account}`);
  if (who && who.trackingMode && who.trackingMode !== 'live') {
    log('  This workspace is in audit mode — your session history uploads at the end of this login.');
  }
  // Forced for the same reason the tracking cache is cleared above: this is a fresh identity, and
  // an account-sync marker left by the PREVIOUS login would otherwise suppress the check-in.
  await syncAccountIfNeeded(
    tokens.access_token,
    { force: true, via: 'login' },
    { env: oauthTokenEnvWithOsProbe(process.env) },
  );
  return { status: 'linked', where, clientId };
}

const nonEmpty = (value) => typeof value === 'string' && value.trim() !== '';

// The committed credentials, or null. Read outside the lock on purpose: it only decides whether
// this machine's registered client can be reused, never what is stored.
async function currentCredentials(deps) {
  const read = await readCredentials(deps).catch(() => null);
  if (read == null || read.status !== CREDENTIAL_STATUS.READY) return null;
  return read.credentials;
}
