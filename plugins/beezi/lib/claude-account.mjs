import fs from 'fs';
import os from 'os';
import path from 'path';

// Claude Code's main config `~/.claude.json` (NOT the secret `.credentials.json`).
// It is a plain file on every platform — including macOS, where the OAuth tokens live
// in the Keychain — and its `oauthAccount` object carries the subscription metadata with
// NO access/refresh token. Reading it is how we get plan info without touching a secret.
export function configCandidates(env, homedir) {
  const out = [];
  if (env.CLAUDE_CONFIG_DIR) out.push(path.join(env.CLAUDE_CONFIG_DIR, '.claude.json'));
  out.push(path.join(homedir, '.claude.json'));
  return out;
}

// Coarse product tier from the org/seat shape (team/enterprise/max/pro/free), or null.
// The rateLimitTier still carries the Max multiplier and is normalized downstream.
function deriveSubscriptionType(account) {
  const org = String(account.organizationType == null ? '' : account.organizationType).toLowerCase();
  if (org.includes('enterprise')) return 'enterprise';
  if (org.includes('team')) return 'team';
  const seat = String(account.seatTier == null ? '' : account.seatTier).toLowerCase();
  if (seat.includes('max')) return 'max';
  if (seat.includes('pro')) return 'pro';
  if (seat.includes('free')) return 'free';
  return null;
}

// Presence-only auth signals from Claude Code's own config, for machines where the billing method
// never reaches process.env. Mirrors what the CLI itself reads:
//   - `primaryApiKey` in ~/.claude.json is where an API key set through Claude Code's `/login` is
//     stored (its own resolver labels that source "/login managed key"). On macOS the key may go
//     to the Keychain instead, leaving this absent — that machine stays unresolved rather than
//     being guessed.
//   - `apiKeyHelper` in settings.json is a command that prints a key; its configuration alone is
//     enough to know a key is in play, and we never run it.
//
// NEITHER VALUE IS READ OR RETURNED — only whether the field is set. `primaryApiKey` is a live
// credential; this function must never widen to expose it.
export function readClaudeAuthSignals(deps = {}) {
  const readFile = deps.readFile == null ? ((p) => fs.readFileSync(p, 'utf-8')) : deps.readFile;
  const exists = deps.exists == null ? ((p) => fs.existsSync(p)) : deps.exists;
  const env = deps.env == null ? process.env : deps.env;
  const homedir = deps.homedir == null ? os.homedir() : deps.homedir;

  const readJsonAt = (p) => {
    if (!exists(p)) return null;
    try { return JSON.parse(readFile(p)); } catch { return null; }
  };

  let hasManagedApiKey = false;
  for (const p of configCandidates(env, homedir)) {
    const cfg = readJsonAt(p);
    if (!cfg) continue;
    hasManagedApiKey = typeof cfg.primaryApiKey === 'string' && cfg.primaryApiKey.length > 0;
    break;
  }

  // User-level settings only. A project-scoped apiKeyHelper would also count, but the hook has no
  // reliable project root at this point and a false positive here would mislabel every session.
  const claudeHome = env.CLAUDE_CONFIG_DIR || path.join(homedir, '.claude');
  const hasApiKeyHelper = ['settings.json', 'settings.local.json'].some((name) => {
    const cfg = readJsonAt(path.join(claudeHome, name));
    return cfg != null && typeof cfg.apiKeyHelper === 'string' && cfg.apiKeyHelper.length > 0;
  });

  return { hasManagedApiKey, hasApiKeyHelper };
}

// Read ONLY the non-secret oauthAccount subscription fields. Never opens `.credentials.json`,
// never returns or exposes access/refresh tokens. Returns null when no account info exists.
export function readClaudeAccount(deps = {}) {
  const readFile = deps.readFile == null ? ((p) => fs.readFileSync(p, 'utf-8')) : deps.readFile;
  const exists = deps.exists == null ? ((p) => fs.existsSync(p)) : deps.exists;
  const env = deps.env == null ? process.env : deps.env;
  const homedir = deps.homedir == null ? os.homedir() : deps.homedir;

  for (const p of configCandidates(env, homedir)) {
    if (!exists(p)) continue;
    let account;
    try {
      account = JSON.parse(readFile(p)).oauthAccount;
    } catch {
      continue;
    }
    if (!account || typeof account !== 'object') continue;
    return {
      // Pseudonymous account id — which Claude account this machine is logged into. Non-secret.
      accountUuid: typeof account.accountUuid === 'string' ? account.accountUuid : null,
      subscriptionType: deriveSubscriptionType(account),
      rateLimitTier: account.userRateLimitTier != null
        ? account.userRateLimitTier
        : (account.organizationRateLimitTier == null ? null : account.organizationRateLimitTier),
      // ~/.claude.json carries no token expiry; staleness relies on capturedAt age instead.
      expiresAt: null,
      billingType: account.billingType == null ? null : account.billingType,
      seatTier: account.seatTier == null ? null : account.seatTier,
      organizationType: account.organizationType == null ? null : account.organizationType,
    };
  }
  return null;
}
