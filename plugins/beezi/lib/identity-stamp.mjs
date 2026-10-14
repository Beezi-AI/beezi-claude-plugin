import { resolveKeyFingerprint, isKeyScoped } from './oauth-identity.mjs';

// SERVER FLOOR: the usage-snapshot half of this stamp needs an API that accepts account_email,
// account_org_uuid/account_org_name and oauth_key_prefix/last4/length on POST
// /me/claude-code/usage, and the session report needs account_org_uuid/account_org_name on POST
// /sessions/report. Both ValidationPipes run forbidNonWhitelisted, so against an older API those
// fields 400 the WHOLE request — a refused snapshot is settled and dropped, a refused report never
// lands. Do not publish a plugin version carrying this before that API is live in prod. Same rule,
// same reason, as oauth-identity.mjs's floor.

// WHICH vendor account this session runs under, in every shape it can prove — the one answer
// both ingest paths send.
//
// It exists as its own module because there are two of them. The session report
// (lib/checkpoint.mjs) and the usage snapshots (lib/usage-snapshot-report.mjs) POST to different
// routes, and the server resolves an account from each independently: uuid (with its
// organization), then the reported email through the caller's own account links, then the
// setup-token fingerprint. Two builders that read the same sources in a different ORDER would land
// the same machine's sessions and its limits data on two different accounts — a divergence no test
// would catch, because each builder is right on its own. One function makes that unrepresentable.
//
// THE LIVE LOGIN FIRST, when it names an account. `~/.claude.json`'s oauthAccount, read live (and
// honouring CLAUDE_CONFIG_DIR), is the login THIS session runs under. `~/.beezi/billing.json` is
// machine-wide and rewritten by whichever session started last: after an account switch it names
// the new account while an older session is still working under the previous one, and stamping
// from it moved that session's later segments onto the wrong account. The organization is the
// sharpest case — a personal plan and a company org share one login's uuid and email, and only
// oauthAccount's organizationUuid tells them apart.
//
// EXCEPT on a record that belongs to a setup key, where billing.json stays the source of truth and
// its nulls stay answers. A machine authenticating with a setup token has a ~/.claude.json
// describing whoever logged in interactively last, and the token can be invisible to every env
// tier (exported from a shell profile), so the fingerprint branch below never fires. The RECORD
// still knows: isKeyScoped (a stored fingerprint or an `oauth_key` anchor) or a plan the CLI
// confirmed is a setup token's (planSource 'unresolved'). Treating a null billing field as
// "unknown, go look at claude.json" there would reach for exactly the value that is wrong on
// exactly the machines it is wrong on.
//
//   - `claudeAccount` is ~/.claude.json's oauthAccount, read live. First whenever it names a uuid
//     and the record does not belong to a key; the only source of the organization.
//   - `billingConfig` is ~/.beezi/billing.json. The answer when the live login names no uuid (the
//     VS Code extension and desktop SSO never write oauthAccount), and on key-scoped records. NOT
//     for the fingerprint: the key in force is the one question the record does not answer better
//     than the env, and resolveKeyFingerprint spells out why consulting it there is a trap.
//   - `env` is the sole source of the setup-token fingerprint, and must be a
//     RESOLVED env (oauthTokenEnvWithOsProbe): a token living in Claude Code's settings file or the
//     OS environment is invisible in a bare process.env, and a caller that passes the bare one
//     silently reports a different identity than its sibling.
//
// Keys are OMITTED, never nulled: absence is how this stamp says "not stated", and the server
// treats an explicit null as a claim.

// A record the live login must not override: it belongs to a setup key, so ~/.claude.json describes
// someone else's interactive login. See the header. Exported for the status-line drain, whose rows
// carry an identity read from that same file.
export function recordOwnsIdentity(billingConfig) {
  if (billingConfig == null) return false;
  return isKeyScoped(billingConfig) || billingConfig.planSource === 'unresolved';
}

// The email billing.json states — its stored field, then an `email` anchor. An anchor whose source
// is not 'email' is not one: 'account_uuid' and 'user_id' are ids, and 'oauth_key' is the masked
// fingerprint.
function billingEmail(billingConfig) {
  if (billingConfig.accountEmail) return billingConfig.accountEmail;
  const anchor = billingConfig.accountAnchor;
  if (anchor != null && anchor.source === 'email' && anchor.value != null) return anchor.value;
  return null;
}

// The vendor account uuid billing.json states.
//
// The ANCHOR is accepted only when it says `account_uuid`. readClaudeAccountAnchor falls back to
// ~/.claude.json's top-level userID under source 'user_id' — an opaque local hash that identifies
// nothing server-side, so sending it as an account uuid would be a claim about an account that
// cannot exist.
function billingUuid(billingConfig) {
  if (billingConfig.accountUuid) return billingConfig.accountUuid;
  const anchor = billingConfig.accountAnchor;
  if (anchor != null && anchor.source === 'account_uuid' && anchor.value != null) return anchor.value;
  return null;
}

// The live login's identity, uuid and organization from oauthAccount. The email is the one field
// billing.json may still supply, and only when it cannot belong to a different account:
//   - same uuid: billing.json's email first — it is the CLI's, which reflects the live credential
//     store, while oauthAccount's can survive a switch stale;
//   - a record naming no uuid cannot contradict this one, so it fills a missing live email;
//   - a record naming ANOTHER uuid describes another account, and its email never rides along —
//     a mixed pair the server would resolve by the uuid alone.
function liveIdentity(claudeAccount, billingConfig) {
  const uuid = claudeAccount.accountUuid;
  const liveEmail = claudeAccount.email ? claudeAccount.email : null;
  let email = liveEmail;
  if (billingConfig != null) {
    const storedUuid = billingUuid(billingConfig);
    const storedEmail = billingEmail(billingConfig);
    if (storedUuid === uuid) email = storedEmail != null ? storedEmail : liveEmail;
    else if (storedUuid == null && liveEmail == null) email = storedEmail;
  }
  return {
    uuid,
    email,
    orgUuid: claudeAccount.organizationUuid ? claudeAccount.organizationUuid : null,
    orgName: claudeAccount.organizationName ? claudeAccount.organizationName : null,
  };
}

// ONE record answers for the whole identity, never mixed field by field across sources. billing.json
// keeps its pair consistent — the reconcile writes both together and its switch detection compares
// both — and when it answers, the live organization stays off the wire: next to a uuid the live
// login did not supply, it would name a subscription of some other record.
function resolveIdentity(claudeAccount, billingConfig) {
  const liveUuid = claudeAccount != null && claudeAccount.accountUuid ? claudeAccount.accountUuid : null;
  if (liveUuid != null && !recordOwnsIdentity(billingConfig)) {
    return liveIdentity(claudeAccount, billingConfig);
  }
  if (billingConfig != null) {
    // A record that states no uuid states no uuid. See the header.
    return { uuid: billingUuid(billingConfig), email: billingEmail(billingConfig), orgUuid: null, orgName: null };
  }
  // No record and no live uuid: an oauthAccount carrying only an email is then the machine's one
  // vendor identity. Its organization is omitted with the uuid it would qualify.
  if (claudeAccount != null && claudeAccount.email) {
    return { uuid: null, email: claudeAccount.email, orgUuid: null, orgName: null };
  }
  return { uuid: null, email: null, orgUuid: null, orgName: null };
}

// Returns { account_uuid?, account_email?, account_org_uuid?, account_org_name?,
//           oauth_key_prefix?, oauth_key_last4?, oauth_key_length? }.
//
// A fingerprintable setup token REPLACES the uuid, the email and the organization. The reasoning is
// written out at the top of oauth-identity.mjs: on exactly the machines that use a setup token — CI
// runners, re-provisioned boxes — oauthAccount and `claude auth status` describe whichever login
// last touched the disk, and both are matched BEFORE the fingerprint server-side. Sending a stale
// identity next to a live fingerprint does not add a second opinion; the stale one wins. The
// server's cli_agent_account resolution reaches the account from the credential row instead, which
// is how a key with a resolved plan but no uuid and no email still attributes correctly.
export function buildIdentityStamp(claudeAccount, billingConfig, env) {
  const fingerprint = resolveKeyFingerprint(billingConfig, env);
  const stamp = {};

  if (fingerprint == null) {
    const identity = resolveIdentity(claudeAccount, billingConfig);
    if (identity.uuid) stamp.account_uuid = identity.uuid;
    if (identity.email != null) stamp.account_email = identity.email;
    if (identity.orgUuid != null) stamp.account_org_uuid = identity.orgUuid;
    if (identity.orgName != null) stamp.account_org_name = identity.orgName;
    return stamp;
  }

  stamp.oauth_key_prefix = fingerprint.prefix;
  stamp.oauth_key_last4 = fingerprint.last4;
  stamp.oauth_key_length = fingerprint.length;
  return stamp;
}
