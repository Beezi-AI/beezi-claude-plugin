import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Claude Code's main config `~/.claude.json` (NOT the secret `.credentials.json`).
// It is a plain file on every platform — including macOS, where the OAuth tokens live
// in the Keychain — and its `oauthAccount` object carries the subscription metadata with
// NO access/refresh token. Reading it is how we get plan info without touching a secret.
function configCandidates(env, homedir) {
  const out = [];
  if (env.CLAUDE_CONFIG_DIR) out.push(path.join(env.CLAUDE_CONFIG_DIR, '.claude.json'));
  out.push(path.join(homedir, '.claude.json'));
  return out;
}

// Coarse product tier from the org/seat shape (team/enterprise/max/pro/free), or null.
// The rateLimitTier still carries the Max multiplier and is normalized downstream.
function deriveSubscriptionType(account) {
  const org = String(account.organizationType ?? '').toLowerCase();
  if (org.includes('enterprise')) return 'enterprise';
  if (org.includes('team')) return 'team';
  const seat = String(account.seatTier ?? '').toLowerCase();
  if (seat.includes('max')) return 'max';
  if (seat.includes('pro')) return 'pro';
  if (seat.includes('free')) return 'free';
  return null;
}

// Read ONLY the non-secret oauthAccount subscription fields. Never opens `.credentials.json`,
// never returns or exposes access/refresh tokens. Returns null when no account info exists.
export function readClaudeAccount(deps = {}) {
  const readFile = deps.readFile ?? ((p) => fs.readFileSync(p, 'utf-8'));
  const exists = deps.exists ?? ((p) => fs.existsSync(p));
  const env = deps.env ?? process.env;
  const homedir = deps.homedir ?? os.homedir();

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
      subscriptionType: deriveSubscriptionType(account),
      rateLimitTier: account.userRateLimitTier ?? account.organizationRateLimitTier ?? null,
      // ~/.claude.json carries no token expiry; staleness relies on capturedAt age instead.
      expiresAt: null,
      billingType: account.billingType ?? null,
      seatTier: account.seatTier ?? null,
      organizationType: account.organizationType ?? null,
    };
  }
  return null;
}
