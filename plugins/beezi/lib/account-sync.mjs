import crypto from 'crypto';
import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';
import { resolveFetch } from './fetch-compat.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { accountSyncStateFile } from './paths.mjs';
import { hasCustomGateway } from './billing.mjs';
import { readBillingConfig as _readBillingConfig } from './billing-config.mjs';
import { keyFingerprint, hasKeyIdentity } from './oauth-identity.mjs';
import { oauthTokenEnv } from './claude-settings-env.mjs';

// Re-exported from its leaf home so existing importers keep working; the definition moved so the
// identity helpers could live in a module with no import cycle back into billing config.
export { keyFingerprint };

const STATE_VERSION = 1;

// How long a payload that has not changed is trusted before it is re-sent anyway. The server's
// last_seen_at is the only thing this buys — without it a machine whose account never changes
// would go silent forever after its first check-in.
const RESYNC_MS = 7 * 24 * 60 * 60 * 1000;

// The server's credential-kind vocabulary, mirrored so a typo in a comparison can't ship a value
// the API's @IsEnum will reject (and a rejection is invisible here — every non-2xx is swallowed).
export const CredentialKind = Object.freeze({
  CLAUDE_OAUTH_TOKEN: 'claude_oauth_token',
  ANTHROPIC_API_KEY: 'anthropic_api_key',
  OPENAI_API_KEY: 'openai_api_key',
  AWS_BEDROCK: 'aws_bedrock',
  GOOGLE_VERTEX: 'google_vertex',
  AZURE_FOUNDRY: 'azure_foundry',
  GATEWAY_TOKEN: 'gateway_token',
});

// The API caps the array; sending more would 400 the whole check-in.
const MAX_KEYS = 8;

function pushKey(out, kind, value) {
  const fingerprint = keyFingerprint(value);
  if (fingerprint == null) return;
  const exists = out.some(
    (k) => k.kind === kind
      && k.prefix === fingerprint.prefix
      && k.last4 === fingerprint.last4
      && k.length === fingerprint.length,
  );
  if (exists) return;
  out.push({ kind, ...fingerprint });
}

// Which credentials this machine exposes in its environment, as fingerprints only. The kind axis
// mirrors detectBillingSource's precedence so a key and the billing source it produces can never
// disagree: the gateway CONJUNCTION (a credential presented to a host that is not Anthropic's)
// relabels the key as the gateway's, because that is who it pays.
//
// Deliberately absent:
//   - Vertex: authenticated through ADC files/service accounts, with no stable credential in the
//     environment to fingerprint.
//   - Foundry: only CLAUDE_CODE_USE_FOUNDRY is known; the name of its credential env var is
//     unverified, and guessing one would read an unrelated variable. Ships when confirmed.
//   - ANTHROPIC_AUTH_TOKEN against api.anthropic.com: that is how a ROTATING subscription OAuth
//     credential is passed, so a prefix/last4 identity would change under us on every rotation.
export function collectKeys(env = process.env) {
  const out = [];
  const gateway = hasCustomGateway(env);
  if (env.ANTHROPIC_API_KEY) {
    pushKey(out, gateway ? CredentialKind.GATEWAY_TOKEN : CredentialKind.ANTHROPIC_API_KEY, env.ANTHROPIC_API_KEY);
  }
  if (gateway && env.ANTHROPIC_AUTH_TOKEN) {
    pushKey(out, CredentialKind.GATEWAY_TOKEN, env.ANTHROPIC_AUTH_TOKEN);
  }
  // The long-lived setup token (CI), not the rotating access token in the credential store —
  // that file is never opened.
  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    pushKey(out, CredentialKind.CLAUDE_OAUTH_TOKEN, env.CLAUDE_CODE_OAUTH_TOKEN);
  }
  // The access key id names the AWS principal; the secret key is never touched.
  if (env.CLAUDE_CODE_USE_BEDROCK && env.AWS_ACCESS_KEY_ID) {
    pushKey(out, CredentialKind.AWS_BEDROCK, env.AWS_ACCESS_KEY_ID);
  }
  // Stable order so a future reordering of the checks above cannot flip the payload hash and
  // trigger a POST that carries no new information.
  out.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : (a.last4 < b.last4 ? -1 : a.last4 > b.last4 ? 1 : 0)));
  return out.slice(0, MAX_KEYS);
}

function label(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s ? s : null;
}

// The check-in body, built from the ALREADY-reconciled billing config — this never spawns the
// Claude CLI or re-reads ~/.claude.json, so it stays free on the session-start hot path.
//
// Identity: the stored accountUuid and accountEmail always identify, and go together whenever
// both are known — the server can only merge an email-provisional account row into the canonical
// uuid row (and link sessions, which report the uuid) when one check-in presents both. Configs
// predating a stored field fall back to the anchor ('account_uuid' supplies the uuid, 'email' the
// email), which is what keeps on-disk v2 configs working unmigrated. 'user_id' is Claude Code's
// opaque local hash — sending it as an accountUuid would mint a canonical account row for an id
// no vendor ever issued.
//
// EXCEPT on a machine exporting a fingerprintable CLAUDE_CODE_OAUTH_TOKEN, where only the
// fingerprint in `keys` travels: the stored uuid/email describe whatever login last touched that
// box, and both are matched BEFORE the fingerprint server-side, so sending them would let the
// stale one win outright. The server attributes such a check-in to the caller's own account
// membership. See oauth-identity.mjs for the rationale, the limits and the server-version floor.
//
// Every field is optional by contract: unknown is first-class, and a machine that can prove
// nothing simply reports nothing.
export function buildAccountSyncPayload({ config = null, env = process.env } = {}) {
  const anchor = config == null || config.accountAnchor == null ? null : config.accountAnchor;
  const anchorSource = anchor == null ? null : anchor.source;
  const anchorValue = anchor == null ? null : label(anchor.value);
  const payload = {};
  // The SHARED predicate, not keyFingerprint(env) inline. The identity stamp suppresses on
  // resolveKeyFingerprint, and this payload must suppress on exactly the same answer: a machine
  // whose check-in still carried a uuid while its session reports carried only a fingerprint would
  // hand the server an identity to resolve, and the credential's account binding — filled once,
  // never moved — would be filled with it. `config` is passed for that shared shape alone; the
  // predicate deliberately does not read it (see resolveKeyFingerprint).
  if (!hasKeyIdentity(config, env)) {
    const storedUuid = config == null ? null : label(config.accountUuid);
    const accountUuid = storedUuid != null
      ? storedUuid
      : (anchorSource === 'account_uuid' ? anchorValue : null);
    if (accountUuid != null) payload.accountUuid = accountUuid;
    const storedEmail = config == null ? null : label(config.accountEmail);
    const email = storedEmail != null ? storedEmail : (anchorSource === 'email' ? anchorValue : null);
    if (email != null) payload.email = email;
  }
  const subscriptionType = config == null ? null : label(config.subscriptionType);
  if (subscriptionType != null) payload.subscriptionType = subscriptionType;
  const rateLimitTier = config == null ? null : label(config.rateLimitTier);
  if (rateLimitTier != null) payload.rateLimitTier = rateLimitTier;
  const keys = collectKeys(env);
  if (keys.length > 0) payload.keys = keys;
  return payload;
}

// A payload that names nothing at all: no identity, no tier, no key. It would create no rows
// server-side, so it is not worth a request on a hook path.
export function isEmptyPayload(payload) {
  return payload == null || Object.keys(payload).length === 0;
}

// Deterministic serialization for the change hash: object keys sorted at every level so a
// reordered build can never look like new information. Only the payload is hashed — never a raw
// credential (the payload holds fingerprints, and the digest is one-way regardless).
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export function payloadHash(payload) {
  return crypto.createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

export function readAccountSyncState(deps = {}) {
  const read = deps.readJsonImpl == null ? readJson : deps.readJsonImpl;
  const raw = read(accountSyncStateFile(), null);
  if (!raw || raw.version !== STATE_VERSION) return null;
  return raw;
}

function writeAccountSyncState(state, deps = {}) {
  const write = deps.writeJsonImpl == null ? writeJsonSecure : deps.writeJsonImpl;
  try {
    write(accountSyncStateFile(), { version: STATE_VERSION, ...state });
  } catch { /* best-effort */ }
}

function dueForResync(state, nowMs) {
  const at = Date.parse(state == null || state.lastSyncedAt == null ? '' : state.lastSyncedAt);
  if (Number.isNaN(at)) return true;
  // A stamp from the future is a clock change, not a fresh sync.
  return nowMs - at > RESYNC_MS || at > nowMs;
}

// Tell Beezi which vendor account and which credential fingerprints this machine is using.
//
// Best-effort by contract: it never throws, never blocks a hook on anything but the bounded POST,
// and swallows every failure — an older API answering 404 is as harmless as being offline. The
// steady state (same payload, synced within the week) reads one small file and sends nothing.
//
// `options.force` skips the hash gate (a user-invoked /beezi:login or /beezi:refresh asked for a
// re-read, and a fresh login may inherit the previous identity's cached hash). `options.via` names
// the caller for local reasoning only — it is NEVER part of the wire body: the API whitelists the
// DTO, so one unknown key would 400 the whole check-in silently.
export async function syncAccountIfNeeded(token, options = {}, deps = {}) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const readConfig = deps.readBillingConfig == null ? _readBillingConfig : deps.readBillingConfig;
  // A token set in ~/.claude/settings.json reaches us as process.env in a normal session; when it
  // does not, oauthTokenEnv fills that one key. An INJECTED deps.env is trusted verbatim — it
  // describes a machine under test, and a developer's own settings file must not leak into it.
  const env = deps.env == null ? oauthTokenEnv(process.env) : deps.env;
  const now = deps.now == null ? new Date() : deps.now;
  const force = options.force === true;
  if (!token) return { synced: false, reason: 'no-token' };

  try {
    let config = null;
    try { config = readConfig(); } catch { config = null; }
    const payload = buildAccountSyncPayload({ config, env });
    if (isEmptyPayload(payload)) return { synced: false, reason: 'nothing-known' };

    const hash = payloadHash(payload);
    const state = readAccountSyncState(deps);
    const unchanged = state != null && state.lastSyncedHash === hash;
    if (!force && unchanged && !dueForResync(state, now.getTime())) {
      return { synced: false, reason: 'unchanged' };
    }

    const res = await postJson(`${apiBase()}${ENDPOINTS.accountSync}`, token, payload, { fetchImpl });
    if (res != null && res.status >= 200 && res.status < 300) {
      writeAccountSyncState({ lastSyncedHash: hash, lastSyncedAt: now.toISOString() }, deps);
      return { synced: true, status: res.status };
    }
    // The marker is left untouched on any refusal, so the next trigger retries.
    return { synced: false, status: res == null ? null : res.status, reason: 'rejected' };
  } catch {
    return { synced: false, reason: 'network' };
  }
}
