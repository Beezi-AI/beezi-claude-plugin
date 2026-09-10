import { execFileSync } from 'child_process';
import { readClaudeAccount as _readClaudeAccount, readClaudeAccountAnchor as _readClaudeAccountAnchor } from './claude-account.mjs';
import { oauthTokenAnchor as _oauthTokenAnchor, hasOauthTokenIdentity } from './oauth-identity.mjs';
import { oauthTokenEnv } from './claude-settings-env.mjs';

// Subscription info via Claude Code's OWN CLI (`claude auth status --json`), never its credential
// store. The CLI reads its secret store itself — including the macOS Keychain, where it is the
// authorized caller — and prints only non-secret status fields, so no token ever crosses into
// plugin code. The spawn costs ~600ms: callers are the session-start reconcile (trigger-gated)
// and the manual capture commands ONLY — never the per-checkpoint hot path.
const AUTH_STATUS_TIMEOUT_MS = 5000;

// Output values are an open vocabulary — copied through when they look like short labels,
// dropped otherwise. Anything long or whitespace-y is not a status label.
function pickLabel(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s || s.length > 254 || /\s/.test(s)) return null;
  return s;
}

export function runClaudeAuthStatus(deps = {}) {
  const exec = deps.exec == null ? execFileSync : deps.exec;
  const platform = deps.platform == null ? process.platform : deps.platform;
  const baseEnv = deps.processEnv == null ? process.env : deps.processEnv;
  // The token this process recovered, handed down so the CHILD authenticates the way this machine
  // actually does. Claude Code deletes CLAUDE_CODE_OAUTH_TOKEN from every subprocess environment
  // it builds, so without re-injecting it the `claude` we spawn reads the on-disk credential store
  // and answers for whichever login last touched the disk — the stale account, every time.
  //
  // ENVIRONMENT ONLY. It must never reach argv: a process listing is world-readable, and the
  // Windows fallback below hands its command line to a shell. Nothing here logs it either — the
  // catch arms swallow the child's stderr and return null rather than surfacing a message.
  const oauthToken = deps.oauthToken == null ? null : String(deps.oauthToken);
  const options = {
    timeout: AUTH_STATUS_TIMEOUT_MS,
    windowsHide: true,
    encoding: 'utf-8',
    // stderr is discarded, not captured: an auth error message must never leak into output.
    stdio: ['ignore', 'pipe', 'ignore'],
  };
  // Set only when there is a token: with none, the spawn stays byte-identical to the pre-existing
  // one (inherited environment), which is the overwhelmingly common shape.
  if (oauthToken) options.env = { ...baseEnv, CLAUDE_CODE_OAUTH_TOKEN: oauthToken };
  let stdout;
  try {
    // The native install exposes a real executable; PATH resolves it without a shell.
    stdout = exec('claude', ['auth', 'status', '--json'], options);
  } catch {
    if (platform !== 'win32') return null;
    // npm installs on Windows ship a `claude.cmd` shim that only a shell can resolve. One fixed
    // literal command line (no interpolation, no args array) — nothing for a shell to mis-parse.
    try {
      stdout = exec('claude auth status --json', [], { ...options, shell: true });
    } catch {
      // CLI missing, timeout, non-zero exit — all read as "no answer", never as an error.
      return null;
    }
  }
  let parsed;
  try { parsed = JSON.parse(stdout); } catch { return null; }
  if (parsed == null || typeof parsed !== 'object') return null;
  return {
    loggedIn: parsed.loggedIn === true,
    authMethod: pickLabel(parsed.authMethod),
    apiProvider: pickLabel(parsed.apiProvider),
    subscriptionType: pickLabel(parsed.subscriptionType),
    email: pickLabel(parsed.email),
    orgId: pickLabel(parsed.orgId),
  };
}

// The best available account identity, freshest source first: a CLAUDE_CODE_OAUTH_TOKEN in the
// environment is the account this process is actually authenticating as, then the CLI's email
// (which reflects the LIVE credential store), then oauthAccount — it can survive an account switch
// stale, its accountUuid naming the previous account — and userID, a last-resort opaque hash from
// ~/.claude.json.
//
// Identity only — the plan tuple is decided separately, and on a token machine it is decided by
// asking the CLI rather than by reading the same disk this anchor already distrusts.
function buildAnchor(status, fileAnchor, tokenAnchor) {
  if (tokenAnchor != null) return tokenAnchor;
  if (status != null && status.email != null) return { value: status.email, source: 'email' };
  return fileAnchor == null ? null : fileAnchor;
}

// Case-insensitive identity comparison. Returns true/false when BOTH sides name an identity,
// and null when the comparison cannot be made — "unknown" is not "different".
function sameIdentity(a, b) {
  if (a == null || b == null) return null;
  const x = String(a).trim().toLowerCase();
  const y = String(b).trim().toLowerCase();
  if (!x || !y) return null;
  return x === y;
}

// Does the profile positively contradict the CLI about the product? Only a stated disagreement
// counts. A profile that cannot derive its own type states nothing, and a tier naming the CLI's
// product family corroborates it even when the coarse type labels differ (a Max seat inside a
// team org derives `team` while the CLI says `max`, yet `default_claude_max_20x` is still this
// account's multiplier).
function contradictsProduct(account, cliType) {
  if (account == null) return true;
  const derived = account.subscriptionType;
  if (derived == null) return false;
  const t = String(cliType).toLowerCase();
  if (String(derived).toLowerCase() === t) return false;
  const tier = String(account.rateLimitTier == null ? '' : account.rateLimitTier).toLowerCase();
  if (tier && tier.indexOf(t) !== -1) return false;
  return true;
}

// Layered subscription resolution, shaped like readClaudeAccount()'s result so every existing
// consumer works unmodified. subscriptionType comes from the CLI when it answers (fresh by
// construction); the Max multiplier lives only in oauthAccount's rateLimitTier.
//
// The profile's fields are kept unless it is shown to describe a DIFFERENT ACCOUNT — which is the
// question the previous product-type equality check was standing in for, and stood in for badly:
// it discarded a present multiplier whenever the profile could not name its own product, which is
// the normal shape for a personal Max subscription. Identity is checked first and decides on its
// own; the weaker product evidence is consulted only when no identity comparison can be made.
export function resolveClaudeSubscription(deps = {}) {
  const readStatus = deps.runClaudeAuthStatus == null ? runClaudeAuthStatus : deps.runClaudeAuthStatus;
  const readAccount = deps.readClaudeAccount == null ? _readClaudeAccount : deps.readClaudeAccount;
  const readFileAnchor = deps.readClaudeAccountAnchor == null ? _readClaudeAccountAnchor : deps.readClaudeAccountAnchor;
  const readTokenAnchor = deps.oauthTokenAnchor == null ? _oauthTokenAnchor : deps.oauthTokenAnchor;
  // Resolved the same way as every other token read, so the anchor this returns cannot disagree
  // with the fingerprint the check-in and the reports send. An injected deps.env is verbatim.
  const env = deps.env == null ? oauthTokenEnv(process.env) : deps.env;

  const oauthToken = env == null || env.CLAUDE_CODE_OAUTH_TOKEN == null ? null : env.CLAUDE_CODE_OAUTH_TOKEN;
  let status = null;
  // The token goes DOWN into the spawn, never up into a log or a return value: it is the only way
  // to make the CLI answer for the credential this machine actually authenticates with.
  try { status = readStatus({ oauthToken }); } catch { status = null; }
  let account = null;
  try { account = readAccount(); } catch { account = null; }
  let fileAnchor = null;
  try { fileAnchor = readFileAnchor(); } catch { fileAnchor = null; }
  let tokenAnchor = null;
  try { tokenAnchor = readTokenAnchor(env); } catch { tokenAnchor = null; }

  // The CLI naming `oauth_token` is a positive statement that the credential in force is the setup
  // token we just handed it — NOT the interactive login whose leftovers are on disk. Claude Code
  // emits email/orgId/subscriptionType only for `claude.ai`, so under a token it states no account
  // and no product at all, and everything ~/.claude.json says describes whoever logged in last.
  // The plan is therefore not merely unknown, it is known to be someone else's: clear it and say
  // so, rather than reporting a tier this machine may not have.
  //
  // This is checked BEFORE the cliType gate below on purpose. A token answer carries no
  // subscriptionType, so it would otherwise fall into the "no CLI answer" arm and return the whole
  // stale profile — the same bug by a second route.
  //
  // Only `oauth_token` clears. `authMethod` is an open vocabulary (third_party, claude.ai,
  // api_key_helper, oauth_token, api_key, none — and whatever ships next), and an answer we cannot
  // interpret is not evidence of anything: it must leave the pre-existing behavior alone.
  //
  // SECOND ROUTE IN, and it does not consult the CLI at all: a fingerprintable token in the
  // resolved env. `env` here has already been through every tier — process.env, Claude Code's
  // settings file, and the OS environment (Windows registry, macOS launchctl) — so seeing one is a
  // positive statement that this machine authenticates by key, made without asking anyone.
  //
  // It has to outrank a contradicting CLI answer, because the rest of the plugin already believes
  // it: hasOauthTokenIdentity gates the identity stamp, so with a token visible every report
  // already withholds the local uuid and email and sends the fingerprint instead. Trusting the CLI
  // here while the reports trust the env produced the exact hazard this branch exists to prevent —
  // billing.json keeping the previous login's plan, the report stamping it with the KEY's
  // fingerprint, and the server pricing that key's account with a tier it may not have.
  //
  // The CLI can disagree for mundane reasons (a token it rejected, a build too old to report
  // authMethod, a spawn that timed out), and none of them make the local profile evidence about
  // the credential in force. Clearing is the honest answer either way: the server prices a key
  // from its own credential row, which is the only thing that can.
  const tokenInForce = hasOauthTokenIdentity(env);
  if (tokenInForce || (status != null && status.authMethod === 'oauth_token')) {
    return {
      // NOT copied from `account`. The CLI just told us the credential in force is the setup token,
      // and under that auth mode Claude Code writes no account metadata — so ~/.claude.json's
      // oauthAccount names whoever logged in interactively last, on a machine that may belong to
      // someone else entirely. Returning it here is how a previous login's identity used to end up
      // stored against a key's record and shipped in the check-in that binds it.
      accountUuid: null,
      email: null,
      subscriptionType: null,
      rateLimitTier: null,
      expiresAt: null,
      billingType: null,
      seatTier: null,
      organizationType: null,
      // Distinct from "not captured yet": we asked, and the answer was that nothing local can
      // name this credential's plan. Only the server, from the key row, can.
      planSource: 'unresolved',
      detectedVia: 'oauth_token',
      anchor: buildAnchor(status, fileAnchor, tokenAnchor),
    };
  }

  const cliType = status != null && status.loggedIn === true ? status.subscriptionType : null;
  if (cliType == null) {
    // No CLI answer: oauthAccount alone, exactly the pre-existing behavior. Accepted gap: a
    // CLI-status email with no oauthAccount is not captured — an identity-only return here would
    // flip the reconcile's 'no-signal' outcome to 'kept' and change /beezi:login routing.
    if (!account) return null;
    return { ...account, detectedVia: 'oauth_account', anchor: buildAnchor(status, fileAnchor, tokenAnchor) };
  }

  // A matching email is the strongest signal available that the profile and the live credential
  // store name the same account; a differing one is proof they do not. Only when neither side
  // offers an email does the product evidence get a say.
  const identity = account == null ? false : sameIdentity(status.email, account.email);
  const trustProfile = identity == null ? !contradictsProduct(account, cliType) : identity === true;
  return {
    accountUuid: account == null ? null : account.accountUuid,
    // Freshest source first, like the anchor: the CLI email reflects the live credential store,
    // while oauthAccount's can survive an account switch stale.
    email: status.email != null ? status.email : (account == null ? null : account.email),
    subscriptionType: cliType,
    rateLimitTier: trustProfile ? account.rateLimitTier : null,
    expiresAt: null,
    billingType: trustProfile ? account.billingType : null,
    seatTier: trustProfile ? account.seatTier : null,
    organizationType: trustProfile ? account.organizationType : null,
    detectedVia: trustProfile ? 'merged' : 'cli_status',
    anchor: buildAnchor(status, fileAnchor, tokenAnchor),
  };
}
