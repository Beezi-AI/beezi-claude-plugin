import { resolveKeyFingerprint } from './oauth-identity.mjs';

// SERVER FLOOR: the usage-snapshot half of this stamp needs an API that accepts account_email and
// oauth_key_prefix/last4/length on POST /me/claude-code/usage. Its ValidationPipe runs
// forbidNonWhitelisted, so against an older API those fields 400 the WHOLE snapshot — and the
// drain breaks on a non-2xx without clearing, so pending rows pile up to MAX_PENDING and the
// oldest are dropped. Limits tracking stops silently. Do not publish a plugin version carrying
// this before that API is live in prod. Same rule, same reason, as oauth-identity.mjs's floor.

// WHICH vendor account this machine is logged into, in every shape it can prove — the one answer
// both ingest paths send.
//
// It exists as its own module because there are two of them. The session report
// (lib/checkpoint.mjs) and the usage snapshots (lib/usage-snapshot-report.mjs) POST to different
// routes, and the server resolves an account from each independently: uuid, then the reported
// email through the caller's own account links, then the setup-token fingerprint. Two builders
// that read the same sources in a different ORDER would land the same machine's sessions and
// its limits data on two different accounts — a divergence no test would catch, because each
// builder is right on its own. One function makes that unrepresentable.
//
// BILLING.JSON IS THE SOURCE OF TRUTH. `~/.beezi/billing.json` is the reconciled record: rewritten
// on every session start, key-scoped, carrying the uuid, the email and the key fingerprint the
// server's cli_agent_account resolution actually consumes. `~/.claude.json` is consulted ONLY when
// no billing record exists at all — never field by field, and never to fill a null.
//
// The null is the whole point of that rule. A machine authenticating with a setup token has a
// ~/.claude.json describing whoever logged in interactively last, and the reconcile deliberately
// carries a previously known uuid forward (billing-capture.mjs's overwrite path) rather than
// blanking it. Treating a null billing field as "unknown, go look at claude.json" would reach for
// exactly the value that is wrong on exactly the machines it is wrong on. billing.json's silence is
// an answer: this machine states no account.
//
//   - `billingConfig` is ~/.beezi/billing.json. First for the uuid and the email. NOT for the
//     fingerprint: the key in force is the one question the record does not answer better than the
//     env, and resolveKeyFingerprint spells out why consulting it there is a trap.
//   - `claudeAccount` is ~/.claude.json's oauthAccount, read live. The fallback for a machine that
//     has no billing record yet — a first session before the reconcile has ever written one.
//   - `env` is the sole source of the setup-token fingerprint, and must be a
//     RESOLVED env (oauthTokenEnvWithOsProbe): a token living in Claude Code's settings file or the
//     OS environment is invisible in a bare process.env, and a caller that passes the bare one
//     silently reports a different identity than its sibling.
//
// Keys are OMITTED, never nulled: absence is how this stamp says "not stated", and the server
// treats an explicit null as a claim.

// The email. billing.json answers whenever a record exists — its stored field, then an `email`
// anchor. An anchor whose source is not 'email' is not one: 'account_uuid' and 'user_id' are ids,
// and 'oauth_key' is the masked fingerprint.
function resolveEmail(billingConfig, claudeAccount) {
  if (billingConfig != null) {
    if (billingConfig.accountEmail) return billingConfig.accountEmail;
    const anchor = billingConfig.accountAnchor;
    if (anchor != null && anchor.source === 'email' && anchor.value != null) return anchor.value;
    // A record that states no email states no email. See the null rule above.
    return null;
  }
  if (claudeAccount != null && claudeAccount.email) return claudeAccount.email;
  return null;
}

// The vendor account uuid, same rule.
//
// The ANCHOR is accepted only when it says `account_uuid`. readClaudeAccountAnchor falls back to
// ~/.claude.json's top-level userID under source 'user_id' — an opaque local hash that identifies
// nothing server-side, so sending it as an account uuid would be a claim about an account that
// cannot exist.
function resolveUuid(billingConfig, claudeAccount) {
  if (billingConfig != null) {
    if (billingConfig.accountUuid) return billingConfig.accountUuid;
    const anchor = billingConfig.accountAnchor;
    if (anchor != null && anchor.source === 'account_uuid' && anchor.value != null) return anchor.value;
    return null;
  }
  if (claudeAccount != null && claudeAccount.accountUuid) return claudeAccount.accountUuid;
  return null;
}

// Returns { account_uuid?, account_email?, oauth_key_prefix?, oauth_key_last4?, oauth_key_length? }.
//
// A fingerprintable setup token REPLACES the uuid and the email. The reasoning is written out at
// the top of oauth-identity.mjs: on exactly the machines that use a setup token — CI runners,
// re-provisioned boxes — oauthAccount and `claude auth status` describe whichever login last
// touched the disk, and both are matched BEFORE the fingerprint server-side. Sending a stale
// identity next to a live fingerprint does not add a second opinion; the stale one wins. The
// server's cli_agent_account resolution reaches the account from the credential row instead, which
// is how a key with a resolved plan but no uuid and no email still attributes correctly.
export function buildIdentityStamp(claudeAccount, billingConfig, env) {
  const fingerprint = resolveKeyFingerprint(billingConfig, env);
  const stamp = {};

  if (fingerprint == null) {
    const uuid = resolveUuid(billingConfig, claudeAccount);
    if (uuid) stamp.account_uuid = uuid;
    const email = resolveEmail(billingConfig, claudeAccount);
    if (email != null) stamp.account_email = email;
    return stamp;
  }

  stamp.oauth_key_prefix = fingerprint.prefix;
  stamp.oauth_key_last4 = fingerprint.last4;
  stamp.oauth_key_length = fingerprint.length;
  return stamp;
}
