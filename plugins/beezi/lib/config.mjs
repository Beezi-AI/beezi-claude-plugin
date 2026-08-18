import { ENV_API_BASE } from './paths.mjs';

// BEEZI_API_URL overrides for local development; otherwise the variant's baked env.json decides,
// and a plugin without one (source checkout) talks to prod.
export function apiBase() {
  if (process.env.BEEZI_API_URL != null) return process.env.BEEZI_API_URL;
  if (ENV_API_BASE != null) return ENV_API_BASE;
  return "https://beezi-api-prod.azurewebsites.net/api";
}

// Origin of the API host — the OAuth discovery documents are mounted at the
// root, outside the /api prefix.
export function apiOrigin() {
  return new URL(apiBase()).origin;
}

export const OAUTH_SCOPES = "email profile";

// The Beezi REST surface, in one place. Paths are relative to apiBase().
export const ENDPOINTS = Object.freeze({
  sessionsReport: "/sessions/report",
  // Chunked backfill of past sessions (runs at the end of /beezi:login); duplicates are absorbed by the
  // server's upsert keys, and /complete seals the one-time pull.
  sessionsBackfill: "/sessions/backfill",
  sessionsBackfillComplete: "/sessions/backfill/complete",
  sessionErrors: "/sessions/errors",
  sessionsTimeline: "/sessions/timeline",
  reposStatus: "/repos/status",
  whoami: "/me/claude-code/whoami",
  machine: "/me/claude-code/machine",
  usageSnapshot: "/me/claude-code/usage",
});

export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";
