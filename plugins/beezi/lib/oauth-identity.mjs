// Leaf module — imports nothing. The identity axis of CLAUDE_CODE_OAUTH_TOKEN.
//
// A machine exporting a fingerprintable setup token identifies BY THAT TOKEN ALONE: the check-in
// sends no accountUuid and no email, and each session report sends no account_uuid and no
// account_email. Only the fingerprint travels — in the check-in's `keys` array (kind
// `claude_oauth_token`) and as the report's oauth_key_prefix/last4/length.
//
// Why the other two are withheld rather than sent alongside: a setup token is the auth method of
// CI runners and re-provisioned boxes, and on exactly those machines ~/.claude.json's oauthAccount
// and `claude auth status --json` describe whatever login last touched the disk. Both are also
// blind to a token rotation. Both are matched BEFORE the fingerprint server-side, so sending a
// stale identity next to a live fingerprint does not add a second opinion — the stale one wins.
//
// What the server does with a fingerprint-only check-in: it does NOT resolve the fingerprint to an
// account — a fingerprint is low-entropy and unverifiable, so it is never treated as an identity
// claim. With no accountUuid and no email in the payload there is nothing for it to resolve FROM,
// so it binds the credential to whatever account that credential row already points at, and MINTS
// an anonymous one when it points at nothing.
//
// The danger is therefore the check-in that is NOT fingerprint-only. Send a uuid or an email
// alongside — which happens whenever the token is invisible to this plugin, since the suppression
// below is what withholds them — and the server resolves that identity to an account and fills the
// credential's binding with it. Bindings are filled but never moved, so a key bound that way to the
// wrong person's account stays there. That is not a hypothetical; it is why the suppression exists.
//
// Consequences worth knowing here:
//   - Rotating the token mints a new credential and therefore a new account row. Only a later
//     check-in that reports a real accountUuid alongside the same fingerprint merges them.
//   - A user who belongs to several vendor accounts gets the most recently active one. There is no
//     client-side signal that could do better: the usage cache's own accountUuid comes from the
//     same stale file.
//
// SERVER FLOOR: this requires the API's Case C, the credential-anchored account
// (CliAgentCredentialRepository.ensureAccountForOauthCredential, migration 1787850000000) and the
// tiered credential binding in upsertCredential. Against an older API a fingerprint-only check-in
// resolves no account at all and every session lands in the analytics IS NULL bucket. Do not
// publish a plugin version carrying this suppression before that API is live in prod.
//
// Rotation is an account switch on the client for the same reason it matters on the server: the
// fingerprint is the only local signal that moves when the token does.

// Below this length a prefix+suffix pair leaves too little hidden to be safe: at 20 characters the
// 12+4 window still conceals at least 4, which is also exactly what makes the server keep the entry
// (it drops anything where prefix.length + last4.length >= length). Real credentials are far longer;
// anything shorter is a placeholder, an empty export, or a truncated value — nothing worth a row.
const MIN_FINGERPRINTABLE_LENGTH = 20;

// The one predicate the suppression sites share, so they cannot drift. Truthiness is NOT enough:
// `CLAUDE_CODE_OAUTH_TOKEN=x` identifies nothing, the server would drop the key entry, and
// suppressing on it would trade a usable identity for none at all.
export function hasOauthTokenIdentity(env = process.env) {
  return keyFingerprint(env == null ? null : env.CLAUDE_CODE_OAUTH_TOKEN) != null;
}

// A non-reversible shape of a credential: the first 12 characters, the last 4, and the length.
// The middle is never read, never stored and never sent. Returns null for anything that is not a
// long-enough string — callers must treat null as "nothing known", never as an error.
export function keyFingerprint(value) {
  if (typeof value !== 'string') return null;
  // Every field is derived from the SAME trimmed string: mixing a raw length with trimmed
  // prefix/last4 would desynchronize the server's reconstruction check.
  const s = value.trim();
  if (s.length < MIN_FINGERPRINTABLE_LENGTH) return null;
  return { prefix: s.slice(0, 12), last4: s.slice(-4), length: s.length };
}

// The account anchor derived from the setup token, or null. `prefix` is `sk-ant-oat01` for every
// setup token, so last4 AND length are what discriminate. The length is in the value on purpose:
// the server's identity for this credential is the (prefix, last4, length) triple, so a rotation
// that happened to reuse the last4 would still be a different credential row — and a client that
// saw no change would never re-capture the plan for it.
//
// The value stays local (billing.json's accountAnchor); the wire carries the structured
// fingerprint instead. It is enough to see that the token CHANGED, never a claim about which
// account it names.
export function oauthTokenAnchor(env = process.env) {
  const fingerprint = keyFingerprint(env == null ? null : env.CLAUDE_CODE_OAUTH_TOKEN);
  if (fingerprint == null) return null;
  return {
    value: `${fingerprint.prefix}...${fingerprint.last4}:${fingerprint.length}`,
    source: 'oauth_key',
  };
}

// Do two fingerprints name the same credential? The server's identity for a credential is the
// (prefix, last4, length) triple, so all three must match — a rotation that happened to reuse the
// last4 is still a different key.
//
// NULL IS "NOT STATED", NEVER "DIFFERENT". A record written before billing.json v4, or by a capture
// whose env held no token, carries no fingerprint at all; reading that as a mismatch would make
// every such record look like it belonged to another key and invite callers to wipe it. Callers
// that need "these are known to differ" must check for null themselves first.
export function sameKeyFingerprint(a, b) {
  if (a == null || b == null) return false;
  return a.prefix === b.prefix && a.last4 === b.last4 && a.length === b.length;
}

// THE ONE SUPPRESSION PREDICATE. Which setup token is in force, from the LIVE env.
//
// EVERY suppression site must call this rather than keyFingerprint(env) directly. The check-in
// (account-sync.mjs) and the identity stamp (identity-stamp.mjs) both withhold the uuid and the
// email on its answer, and a machine whose two payloads disagree is the irreversible failure: the
// server fills a credential's account binding from whichever payload still carries an identity, and
// bindings are filled but never moved. One function makes that divergence unrepresentable.
//
// `billingConfig` is accepted and DELIBERATELY NOT CONSULTED. The parameter is here so the sites
// cannot drift back into reading it, because doing so is a trap that looks like an improvement:
//
//   - It buys nothing. billing.json's keyFingerprint is stamped by the reconcile from
//     oauthTokenEnvWithOsProbe, and every suppression site resolves its env the same way
//     (checkpoint.mjs, session-start.mjs). The stored value therefore names no token the env cannot
//     see; it can only DISAGREE with the env, and every such disagreement is a stale record.
//   - The stale case has no way out. billing-capture.mjs's `kept` branch never clears the
//     fingerprint, shouldKeepExisting's key guard blocks the overwrite "on the forced path too"
//     (/beezi:refresh included), and authModeReverted excuses selfReported records from the one
//     escape. So a self-reported key-scoped machine that moved back to an interactive login would
//     suppress its real identity forever and be minted an anonymous account row for a key it no
//     longer uses.
//
// billing.json IS the source of truth for the uuid, the email and the plan — see identity-stamp.mjs.
// The key in force is the one question it does not answer better than the env.
export function resolveKeyFingerprint(billingConfig, env = process.env) {
  return keyFingerprint(env == null ? null : env.CLAUDE_CODE_OAUTH_TOKEN);
}

// Does this machine identify by a setup token rather than by an account? The shared form of
// hasOauthTokenIdentity, which stays for the callers asking it of the env alone with no billing
// record in hand (the reconcile's own precheck, key-resolve's guard).
export function hasKeyIdentity(billingConfig, env = process.env) {
  return resolveKeyFingerprint(billingConfig, env) != null;
}
