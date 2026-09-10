// The cross-repo authentication vocabulary (see the plan's shared-vocabulary.md). These exact
// strings travel to the API on diagnostic events, so they are a contract, not local naming.

export const AUTH_STATES = Object.freeze({
  READY: 'ready',
  UNLINKED: 'unlinked',
  REFRESHING: 'refreshing',
  UNAVAILABLE: 'unavailable',
  REAUTH_REQUIRED: 'reauth_required',
});

export const AUTH_REASONS = Object.freeze({
  OK: 'ok',
  RECOVERED: 'recovered',
  NO_CREDENTIALS: 'no_credentials',
  LOGGED_OUT: 'logged_out',
  STORAGE_UNAVAILABLE: 'storage_unavailable',
  STORAGE_CONFLICT: 'storage_conflict',
  LOCK_TIMEOUT: 'lock_timeout',
  REFRESH_IN_PROGRESS: 'refresh_in_progress',
  REFRESH_TIMEOUT: 'refresh_timeout',
  REFRESH_NETWORK_ERROR: 'refresh_network_error',
  REFRESH_SERVER_ERROR: 'refresh_server_error',
  REFRESH_INTERRUPTED: 'refresh_interrupted',
  REFRESH_SPAWN_FAILED: 'refresh_spawn_failed',
  REFRESH_STORAGE_FAILED: 'refresh_storage_failed',
  VERIFICATION_UNAVAILABLE: 'verification_unavailable',
  RATE_LIMITED: 'rate_limited',
  INVALID_GRANT: 'invalid_grant',
  INVALID_CLIENT: 'invalid_client',
  MISSING_REFRESH_TOKEN: 'missing_refresh_token',
  CONSENT_REQUIRED: 'consent_required',
  FORBIDDEN: 'forbidden',
  UNAUTHORIZED: 'unauthorized',
  PROBE_UNREACHABLE: 'probe_unreachable',
  LOGIN_CANCELLED: 'login_cancelled',
  DISCOVERY_FAILED: 'discovery_failed',
  REGISTRATION_FAILED: 'registration_failed',
  EXCHANGE_FAILED: 'exchange_failed',
  BINDING_CONFLICT: 'binding_conflict',
});

export const isKnownAuthState = (value) => Object.values(AUTH_STATES).includes(value);
export const isKnownAuthReason = (value) => Object.values(AUTH_REASONS).includes(value);
