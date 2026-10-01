import { execFileSync } from 'child_process';
import crypto from 'crypto';
import path from 'path';
import { apiBase, OAUTH_SCOPES } from './config.mjs';
import { markLinked, recordWhoami } from './tracking.mjs';
import { discover as _discover, registerClient as _registerClient, pkcePair, exchangeCode as _exchangeCode } from './oauth.mjs';
import { commitCredentials, deleteCredentialGeneration, deleteAllGenerationEntries, COMMIT_STATUS, DELETE_STATUS } from './credentials.mjs';
import { acquireCredentialLock, releaseCredentialLock } from './credential-lock.mjs';
import { clearAuthMarkers } from './auth-markers.mjs';
import { startLoopback as _startLoopback } from './loopback.mjs';
import { readIndex, listAccounts, findByEmail, newAccountKey, addAccount, updateAccount, describeAccount } from './accounts.mjs';
import { unlinkOnServer, revokeAtAuthServer } from './machine-unlink.mjs';
import { readTrackingState } from './tracking.mjs';
import { probeIdentity as _probeIdentity, PROBE_OUTCOMES } from './whoami.mjs';
import { getAuthentication as _getAuthentication, INTERACTIVE_REFRESH_WAIT_MS } from './token.mjs';
import { AUTH_STATES, AUTH_REASONS } from './auth-state.mjs';
import { syncAccountIfNeeded as _syncAccountIfNeeded } from './account-sync.mjs';
import { oauthTokenEnvWithOsProbe } from './claude-settings-env.mjs';
import { DIAGNOSTIC_SOURCES } from './telemetry-codes.mjs';
import { recordAuthResult as _recordAuthResult } from './telemetry-auth.mjs';
import { UserError } from './friendly-error.mjs';

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

// Browser authorization always mints a separate client; it cannot silently change an existing
// machine's client id and link date. Publishing credentials still uses the generation CAS lock.
export async function runLogin(deps = {}) {
  const log = deps.log || console.log;
  const base = deps.base || apiBase();
  const probeIdentity = deps.probeIdentity || _probeIdentity;
  const getAuthentication = deps.getAuthentication || _getAuthentication;
  const sync = deps.syncAccountIfNeeded || _syncAccountIfNeeded;
  const linked = await listAccounts(deps);
  const hint = 'To add a different account, sign out of Beezi in the browser first or use a private window.';
  log('\nBeezi analytics — link an account\n');
  if (linked.length) {
    for (const a of linked) log(`  ${describeAccount(a)}${a.status === 'revoked' ? ' (revoked)' : ''}`);
    log('Your browser signs in as whichever Beezi account it is already signed in as.');
    log(hint);
  }
  let meta;
  try { meta = await (deps.discover || _discover)(); }
  catch (e) { e.loginReason = AUTH_REASONS.DISCOVERY_FAILED; throw e; }
  const { verifier, challenge } = pkcePair();
  const state = crypto.randomBytes(16).toString('base64url');
  const lb = await (deps.startLoopback || _startLoopback)({ port: 0, expectedState: state });
  let clientId;
  try { clientId = await (deps.registerClient || _registerClient)(meta.registrationEndpoint, lb.redirectUri); }
  catch (e) { e.loginReason = AUTH_REASONS.REGISTRATION_FAILED; throw e; }
  const url = `${meta.authorizationEndpoint}?${new URLSearchParams({ response_type: 'code', client_id: clientId,
    redirect_uri: lb.redirectUri, scope: OAUTH_SCOPES, state, code_challenge: challenge, code_challenge_method: 'S256' })}`;
  log(`Opening your browser to sign in with your Beezi account…\nIf it does not open, go to:\n  ${url}\n`);
  (deps.openBrowser || openBrowser)(url);
  let code;
  try { code = await lb.code; }
  catch (e) { e.loginReason = AUTH_REASONS.LOGIN_CANCELLED; throw e; }
  // Reserve a keyed store before exchange so a lock failure cannot discard an issued grant.
  const provisional = newAccountKey();
  const lockOptions = { waitMs: deps.lockWaitMs == null ? 30_000 : deps.lockWaitMs };
  let lock = await acquireCredentialLock({ ...lockOptions, account: provisional }, deps);
  if (!lock) throw new UserError('Another Beezi process is using the saved login. Retry /beezi:login in a moment.');
  let fresh, creds, lifecycle, committed = false;
  const discardFresh = async () => {
    if (!fresh) return;
    const result = await (deps.unlinkOnServer || unlinkOnServer)(fresh, deps);
    if ((!result || !result.unlinked)) await (deps.revokeAtAuthServer || revokeAtAuthServer)(creds, deps);
  };
  try {
    let tokens;
    try { tokens = await (deps.exchangeCode || _exchangeCode)({ tokenEndpoint: meta.tokenEndpoint, clientId, redirectUri: lb.redirectUri, code, verifier }); }
    catch (e) { e.loginReason = AUTH_REASONS.EXCHANGE_FAILED; throw e; }
    if (!nonEmpty(tokens.access_token) || !nonEmpty(tokens.refresh_token)) {
      const e = new UserError('The login server did not return a usable session. Your previous Beezi authorization is untouched — try /beezi:login again.');
      e.loginReason = AUTH_REASONS.EXCHANGE_FAILED; throw e;
    }
    creds = { client_id: clientId, redirect_uri: lb.redirectUri, token_endpoint: meta.tokenEndpoint, scope: OAUTH_SCOPES,
      access_token: tokens.access_token, refresh_token: tokens.refresh_token,
      expires_at: (deps.now || Date.now)() + (tokens.expires_in == null ? 3600 : tokens.expires_in) * 1000 };
    fresh = { key: provisional, token: tokens.access_token, clientId };
    const verified = await probeIdentity(fresh, { ...deps, base });
    if (verified.outcome !== PROBE_OUTCOMES.AUTHENTICATED || !nonEmpty(verified.identity && verified.identity.email)) {
      throw new UserError('Signed in, but Beezi could not verify this account. Your saved accounts are untouched. Retry /beezi:login.');
    }
    lifecycle = await acquireCredentialLock({ ...lockOptions, lifecycle: true }, deps);
    if (!lifecycle) throw new UserError('Another Beezi account change is in progress. Retry /beezi:login in a moment.');
    const who = { valid: true, ...verified.identity };
    const identity = { email: who.email.toLowerCase(), name: who.name, tenantId: who.tenantId, tenantName: who.tenantName };
    async function checkStored(a) {
      let auth = await getAuthentication(deps, { account: a.key, waitMs: INTERACTIVE_REFRESH_WAIT_MS });
      if (auth.authState !== AUTH_STATES.READY) return { auth, probe: null };
      let session = { key: a.key, token: auth.accessToken, clientId: auth.clientId || a.clientId };
      let probe = await probeIdentity(session, { ...deps, base });
      if (probe.outcome === PROBE_OUTCOMES.UNAUTHORIZED) {
        auth = await getAuthentication(deps, { account: a.key, forceRefresh: true, waitMs: INTERACTIVE_REFRESH_WAIT_MS });
        if (auth.authState === AUTH_STATES.READY) {
          session = { ...session, token: auth.accessToken, clientId: auth.clientId || a.clientId };
          probe = await probeIdentity(session, { ...deps, base });
        } else probe = null;
      }
      return { auth, probe, session };
    }
    // A migrated row must be identified by its own grant, never guessed from the new login.
    for (const a of linked.filter(a => !a.email && a.status === 'linked')) {
      const check = await checkStored(a);
      if ((check.probe && check.probe.outcome) === PROBE_OUTCOMES.AUTHENTICATED) {
        await updateAccount(a.key, { ...check.probe.identity, clientId: check.session.clientId }, deps);
      } else {
        throw new UserError('An existing account could not be identified. Retry when its authorization can be checked, or remove it with /beezi:logout before adding an account.');
      }
    }
    const existing = await findByEmail(identity.email, deps);
    if ((existing && existing.status) === 'linked') {
      const check = await checkStored(existing);
      if ((check.probe && check.probe.outcome) === PROBE_OUTCOMES.AUTHENTICATED) {
        await discardFresh(); fresh = null;
        log(`\n✓ This machine is already linked as ${describeAccount(existing)}.`);
        log(hint);
        const index = await readIndex(deps);
        if (index.default !== existing.key) log(`  /beezi:analytics still reads from ${describeAccount(index.accounts.find(a => a.key === index.default))}.`);
        log(`account=${existing.key}`);
        return { status: 'already_linked', account: existing.key };
      }
      if (check.auth.reason === AUTH_REASONS.MISSING_REFRESH_TOKEN) {
        (deps.recordAuthResult || _recordAuthResult)({ authState: AUTH_STATES.REAUTH_REQUIRED, reason: AUTH_REASONS.CONSENT_REQUIRED }, { account: existing.key, source: DIAGNOSTIC_SOURCES.LOGIN });
      }
      const dead = check.auth.authState === AUTH_STATES.REAUTH_REQUIRED || check.auth.authState === AUTH_STATES.UNLINKED
        || (check.probe && check.probe.outcome) === PROBE_OUTCOMES.UNAUTHORIZED;
      if (!dead) throw new UserError('Your existing account could not be verified right now. Its saved authorization is untouched; retry later.');
    }
    const clash = (await listAccounts(deps)).find(a => a.key !== (existing && existing.key) && a.status === 'linked'
      && who.tenantId != null && a.tenantId === who.tenantId);
    if (clash) throw new UserError(`Workspace ${who.tenantName || clash.tenantName || who.tenantId} is already linked as ${clash.email}. Log that account out first to link ${identity.email}.`);
    const key = (existing && existing.key) || provisional;
    if (key !== provisional) {
      const targetLock = await acquireCredentialLock({ ...lockOptions, account: key }, deps);
      if (!targetLock) throw new UserError('Another Beezi process is using this account. Retry /beezi:login in a moment.');
      releaseCredentialLock(lock); lock = targetLock;
    }
    const metadata = { ...identity, clientId, status: 'linked' };
    // Publish an existing row before replacing its generation: if the index is unwritable,
    // the previous authorization is still exactly intact and discoverable. The account lock
    // keeps refresh writers out; session readers derive their client id from the generation.
    if (existing) await (deps.updateAccount || updateAccount)(key, metadata, deps);
    let commit;
    try {
      commit = await (deps.commitCredentials || commitCredentials)(creds, { account: key, lock, force: true }, deps);
      if (commit.status !== COMMIT_STATUS.COMMITTED) throw new UserError('Could not store the new Beezi authorization. Try /beezi:login again.');
    } catch (error) {
      if (existing) {
        try { await updateAccount(key, existing, deps); }
        catch (_) { throw new UserError('Could not save the new authorization or restore its account details. The account is still listed; retry /beezi:login to repair it.'); }
      }
      throw error;
    }
    committed = true;
    if (!existing) {
      try { await (deps.addAccount || addAccount)({ key, ...metadata }, deps); }
      catch (error) {
        // This key has never been published. Remove only our own generation while its lock
        // is still held, then let the outer failure path revoke the unused browser grant.
        committed = false;
        const removed = await deleteCredentialGeneration({ account: key, lock, expectedGeneration: commit.generation }, deps);
        if (removed.status !== DELETE_STATUS.DELETED) {
          throw new UserError(`Could not publish or remove the new account (${key}). Retry /beezi:login; the unused browser grant is being revoked.`);
        }
        deleteAllGenerationEntries({ ...deps, account: key, lock });
        throw new UserError('Could not publish the new Beezi account. Its saved authorization was removed; retry /beezi:login.');
      }
    }
    clearAuthMarkers(key);
    const tracking = readTrackingState(key);
    if (!tracking || !tracking.linkedAt) markLinked(key);
    recordWhoami(key, who, clientId);
    log(`\n✓ Beezi analytics linked as ${describeAccount(identity)}. Credentials stored in ${commit.where}.`);
    const index = await readIndex(deps);
    if (index.default !== key) log(`  /beezi:analytics still reads from ${describeAccount(index.accounts.find(a => a.key === index.default))}.`);
    await sync({ ...fresh, key }, { force: true, via: 'login' }, { env: oauthTokenEnvWithOsProbe(process.env) }).catch(() => {});
    log(`account=${key}`);
    return { status: 'linked', account: key, where: commit.where, clientId };
  } catch (error) {
    if (!committed) await discardFresh().catch(() => {});
    throw error;
  } finally { if (lifecycle) releaseCredentialLock(lifecycle); releaseCredentialLock(lock); }
}
const nonEmpty = value => typeof value === 'string' && value.trim() !== '';
