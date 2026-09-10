import {
  readCredentials, commitCredentials, CREDENTIAL_STATUS, COMMIT_STATUS,
} from './credentials.mjs';
import { acquireCredentialLock, releaseCredentialLock } from './credential-lock.mjs';
import { refreshTokens as _refreshTokens, REFRESH_FAILURES } from './oauth.mjs';
import { ownStartTime } from './process-start-time.mjs';
import { AUTH_STATES, AUTH_REASONS } from './auth-state.mjs';
import { recordAuthResult } from './telemetry-auth.mjs';
import { DIAGNOSTIC_SOURCES } from './telemetry-codes.mjs';
import {
  readInflight, recordInflight, clearInflight, isWorkerAlive,
  recordBackoff, recordReauthRequired, clearRefreshFailureState,
} from './auth-markers.mjs';

// The whole operation, lock included. A worker that outlives this has lost a race with something
// (a wedged keychain prompt, a stalled socket the transport did not abort) and must get out of
// the way rather than hold the namespace lock for the next hook.
export const WORKER_BUDGET_MS = 30_000;

// The token request itself, through body consumption. Deliberately far inside the budget so a
// commit still fits after it.
export const REFRESH_REQUEST_TIMEOUT_MS = 7_000;

const SKEW_MS = 60_000;
const DEFAULT_EXPIRES_IN_S = 3_600;

// Maps the token endpoint's verdict onto the pinned reason vocabulary.
const FAILURE_REASONS = Object.freeze({
  [REFRESH_FAILURES.TIMEOUT]: AUTH_REASONS.REFRESH_TIMEOUT,
  [REFRESH_FAILURES.NETWORK]: AUTH_REASONS.REFRESH_NETWORK_ERROR,
  [REFRESH_FAILURES.SERVER]: AUTH_REASONS.REFRESH_SERVER_ERROR,
});

// Refreshes ONE generation, out of process. Never takes a token as input: it rereads the store
// under the lock, so a stale caller cannot make it submit a grant that has already been replaced.
// Returns { outcome, reason } for tests; the script entry ignores it and exits.
//
// The budget is a hard ceiling on the whole operation, not just the request: an OS store that
// blocks (a keychain prompt, a hung `secret-tool`) would otherwise hold the namespace lock for
// every later hook. On expiry the worker abandons the attempt and the process exits; the
// in-flight marker it leaves is what tells the next attempt the grant may have been spent.
export async function runRefreshWorker(options = {}, deps = {}) {
  const budgetMs = options.budgetMs == null ? WORKER_BUDGET_MS : options.budgetMs;
  const setTimeoutImpl = deps.setTimeoutImpl == null ? setTimeout : deps.setTimeoutImpl;
  let timer = null;
  const expired = new Promise((resolve) => {
    // Deliberately NOT unref'd: this timer is the only thing that will settle a worker whose
    // request never returns, so the process must stay alive for it.
    timer = setTimeoutImpl(() => resolve({ outcome: 'expired', reason: AUTH_REASONS.REFRESH_TIMEOUT }), budgetMs);
  });
  try {
    return await Promise.race([refreshOnce(options, deps), expired]);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

async function refreshOnce(options, deps) {
  const now = deps.now == null ? Date.now : deps.now;
  const budgetMs = options.budgetMs == null ? WORKER_BUDGET_MS : options.budgetMs;
  const deadline = now() + budgetMs;
  const overBudget = () => now() >= deadline;

  // waitMs 0: a held lock means another worker, a login or a logout owns this generation.
  // Queuing behind it would only submit a grant that is about to be superseded.
  const lock = await acquireCredentialLock({ waitMs: 0 }, deps);
  if (lock == null) return { outcome: 'busy', reason: AUTH_REASONS.REFRESH_IN_PROGRESS };
  try {
    const current = await readCredentials(deps, { lock }).catch(() => null);
    if (current == null || current.status !== CREDENTIAL_STATUS.READY) {
      clearInflight();
      return { outcome: 'no_credentials', reason: AUTH_REASONS.STORAGE_UNAVAILABLE };
    }

    // A marker still naming this generation, from a process that is gone: the grant may have
    // been consumed and its replacement lost. Credentials are preserved; the caller is told.
    const stale = readInflight();
    if (stale != null && stale.generation === current.generation && !isWorkerAlive(stale, deps)) {
      clearInflight();
      recordAuthResult({ authState: AUTH_STATES.UNAVAILABLE, reason: AUTH_REASONS.REFRESH_INTERRUPTED }, { source: DIAGNOSTIC_SOURCES.REFRESH_WORKER });
      recordBackoff(current.generation, AUTH_REASONS.REFRESH_INTERRUPTED, now());
      return { outcome: 'interrupted', reason: AUTH_REASONS.REFRESH_INTERRUPTED };
    }

    if (options.generation != null && current.generation !== options.generation) {
      return { outcome: 'superseded', reason: null };
    }
    const creds = current.credentials;
    const fresh = (creds.expires_at == null ? 0 : creds.expires_at) - now() > SKEW_MS;
    if (!options.force && fresh) return { outcome: 'fresh', reason: AUTH_REASONS.OK };
    if (typeof creds.refresh_token !== 'string' || !creds.refresh_token) {
      recordAuthResult({ authState: AUTH_STATES.REAUTH_REQUIRED, reason: AUTH_REASONS.MISSING_REFRESH_TOKEN }, { source: DIAGNOSTIC_SOURCES.REFRESH_WORKER });
      recordReauthRequired(current.generation, AUTH_REASONS.MISSING_REFRESH_TOKEN, now());
      return { outcome: 'reauth_required', reason: AUTH_REASONS.MISSING_REFRESH_TOKEN };
    }
    if (overBudget()) {
      recordAuthResult({ authState: AUTH_STATES.UNAVAILABLE, reason: AUTH_REASONS.REFRESH_TIMEOUT }, { source: DIAGNOSTIC_SOURCES.REFRESH_WORKER });
      recordBackoff(current.generation, AUTH_REASONS.REFRESH_TIMEOUT, now());
      return { outcome: 'failed', reason: AUTH_REASONS.REFRESH_TIMEOUT };
    }

    // Before the grant leaves this machine, not after: if the process dies mid-request this is
    // the only record that a rotating token may already have been spent.
    recordInflight(current.generation, process.pid, ownStartTime());

    const refresh = deps.refreshTokens == null ? _refreshTokens : deps.refreshTokens;
    const r = await refresh({
      tokenEndpoint: creds.token_endpoint,
      clientId: creds.client_id,
      refreshToken: creds.refresh_token,
    }, { ...deps, timeoutMs: deps.timeoutMs == null ? REFRESH_REQUEST_TIMEOUT_MS : deps.timeoutMs });

    if (r.invalidGrant) {
      // The one definitive rejection. Nothing is deleted — not the refresh token, not the
      // registered client, not the diagnostic identity — only this generation's retries stop.
      const reason = r.error === 'invalid_client'
        ? AUTH_REASONS.INVALID_CLIENT
        : AUTH_REASONS.INVALID_GRANT;
      recordAuthResult({ authState: AUTH_STATES.REAUTH_REQUIRED, reason }, { source: DIAGNOSTIC_SOURCES.REFRESH_WORKER });
      recordReauthRequired(current.generation, reason, now());
      clearInflight();
      return { outcome: 'reauth_required', reason };
    }
    if (r.tokens == null || !r.tokens.access_token) {
      const reason = r.failure === REFRESH_FAILURES.MISSING_REFRESH_TOKEN
        ? AUTH_REASONS.MISSING_REFRESH_TOKEN
        : (FAILURE_REASONS[r.failure] == null ? AUTH_REASONS.REFRESH_SERVER_ERROR : FAILURE_REASONS[r.failure]);
      if (reason === AUTH_REASONS.MISSING_REFRESH_TOKEN) {
        recordAuthResult({ authState: AUTH_STATES.REAUTH_REQUIRED, reason }, { source: DIAGNOSTIC_SOURCES.REFRESH_WORKER });
        recordReauthRequired(current.generation, reason, now());
      } else {
        recordAuthResult({ authState: AUTH_STATES.UNAVAILABLE, reason }, { source: DIAGNOSTIC_SOURCES.REFRESH_WORKER });
        recordBackoff(current.generation, reason, now());
      }
      clearInflight();
      return { outcome: reason === AUTH_REASONS.MISSING_REFRESH_TOKEN ? 'reauth_required' : 'failed', reason };
    }

    const next = {
      ...creds,
      access_token: r.tokens.access_token,
      refresh_token: r.tokens.refresh_token == null ? creds.refresh_token : r.tokens.refresh_token,
      expires_at: now() + (r.tokens.expires_in == null ? DEFAULT_EXPIRES_IN_S : r.tokens.expires_in) * 1000,
    };
    let commit;
    try {
      commit = await commitCredentials(next, { lock, expectedGeneration: current.generation }, deps);
    } catch {
      commit = { status: COMMIT_STATUS.LOCK_LOST };
    }
    clearInflight();
    if (commit.status === COMMIT_STATUS.COMMITTED) {
      clearRefreshFailureState();
      return { outcome: 'committed', reason: AUTH_REASONS.OK, generation: commit.generation };
    }
    if (commit.status === COMMIT_STATUS.SUPERSEDED) return { outcome: 'superseded', reason: null };
    // The replacement never became durable, and the grant that produced it may be spent.
    recordAuthResult({ authState: AUTH_STATES.UNAVAILABLE, reason: AUTH_REASONS.REFRESH_STORAGE_FAILED }, { source: DIAGNOSTIC_SOURCES.REFRESH_WORKER });
    recordBackoff(current.generation, AUTH_REASONS.REFRESH_STORAGE_FAILED, now());
    return { outcome: 'failed', reason: AUTH_REASONS.REFRESH_STORAGE_FAILED };
  } finally {
    releaseCredentialLock(lock);
  }
}
