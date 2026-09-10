export const DIAGNOSTIC_CODES = Object.freeze({
  HOOK_CRASH: 'hook_crash',
  HOOK_UNHANDLED_REJECTION: 'hook_unhandled_rejection',
  QUEUE_FILE_QUARANTINED: 'queue_file_quarantined',
  QUEUE_FLUSH_HTTP_ERROR: 'queue_flush_http_error',
  TOKEN_REFRESH_FAILED: 'token_refresh_failed',
  TRANSCRIPT_PARSE_FAILED: 'transcript_parse_failed',
  MCP_HANDSHAKE_TIMEOUT: 'mcp_handshake_timeout',
  STATE_WRITE_FAILED: 'state_write_failed',
  // Appended for the authorization-free diagnostics path; mirrors the API's PluginDiagnosticCode.
  AUTH_STATE_CHANGED: 'auth_state_changed',
  AUTH_RECOVERED: 'auth_recovered',
  LOGIN_FAILED: 'login_failed',
  LOGOUT_UNLINK_UNCONFIRMED: 'logout_unlink_unconfirmed',
  CREDENTIAL_MIGRATION_CONFLICT: 'credential_migration_conflict',
  REFRESH_INTERRUPTED: 'refresh_interrupted',
  MCP_STARTUP_FAILED: 'mcp_startup_failed',
  HOOK_IMPORT_FAILED: 'hook_import_failed',
  INSTALLATION_BINDING_FAILED: 'installation_binding_failed',
});

export const DIAGNOSTIC_SOURCES = Object.freeze({
  CHECKPOINT: 'checkpoint',
  STOP: 'stop',
  STOP_FAILURE: 'stop_failure',
  REPORT: 'report',
  SESSION_START: 'session_start',
  TRACK_PROMPT: 'track_prompt',
  USAGE_PING: 'usage_ping',
  PULSE: 'pulse',
  STATUSLINE: 'statusline',
  MCP_BRIDGE: 'mcp_bridge',
  BACKFILL: 'backfill',
  SYNC: 'sync',
  LOGIN: 'login',
  TELEMETRY_FLUSH: 'telemetry_flush',
  // Appended for the authorization-free diagnostics path.
  REFRESH_WORKER: 'refresh_worker',
  LOGOUT: 'logout',
  ME: 'me',
  DIAGNOSTICS_WORKER: 'diagnostics_worker',
  // Neutral fallback: a call site that reports before any runHook has published a source.
  UNKNOWN: 'unknown',
});

export const isKnownCode = (value) => Object.values(DIAGNOSTIC_CODES).includes(value);
export const isKnownSource = (value) => Object.values(DIAGNOSTIC_SOURCES).includes(value);
