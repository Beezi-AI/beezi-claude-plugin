export function apiBase() {
  return (
    process.env.BEEZI_API_URL ?? "https://beezi-api-prod.azurewebsites.net/api"
  );
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
  sessionErrors: "/sessions/errors",
  sessionsTimeline: "/sessions/timeline",
  reposStatus: "/repos/status",
  whoami: "/me/claude-code/whoami",
  machine: "/me/claude-code/machine",
});

export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";
