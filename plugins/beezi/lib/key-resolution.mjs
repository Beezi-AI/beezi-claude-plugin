import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';
import { resolveFetch } from './fetch-compat.mjs';
import { keyFingerprint } from './oauth-identity.mjs';
import { oauthTokenEnv } from './claude-settings-env.mjs';

// Interactive resolution of the subscription behind CLAUDE_CODE_OAUTH_TOKEN.
//
// The read-only twin of this question is lib/oauth-key-status.mjs, which runs inline on
// SessionStart and only ever says "this key needs attention". This module is the other half: the
// user has now asked (/beezi:refresh), so we fetch what the portal knows, and then write back
// either a plan they picked or a subscription they chose to attach the key to.
//
// TWO TOKENS, kept strictly apart:
//   - `token` (the argument) is the BEEZI access token from getAccessToken(); it authenticates the
//     request and is the only thing in the Authorization header.
//   - env.CLAUDE_CODE_OAUTH_TOKEN is the ANTHROPIC setup token; it is NEVER sent. Only its
//     fingerprint (prefix / last4 / length, from keyFingerprint) travels, in the body's `key`.
// The plugin never learns an account id, so the fingerprint is the whole subject of every call.
//
// TWO "UNLINKED"s, also kept apart: the payload's status 'unlinked' means the KEY is not attached
// to a subscription. "This machine is not linked" is about the Beezi login and lives in the
// entrypoint. Never let the two share wording.
//
// Best-effort about the NETWORK only: nothing here throws when the server is unreachable. But a
// negative answer is not a failure — fetchKeyResolution returns null strictly for "could not ask",
// and the two submits return { ok: false, message } carrying the server's own words, because the
// user is standing at the prompt about to act on them.

// Deliberately far above postJson's 3s default and oauth-key-status's 1500ms probe. That probe is
// tight because it runs inside SessionStart's 10s hook budget; this runs because a human typed
// /beezi:refresh and is watching the terminal. Do not "align" it back down.
const REQUEST_TIMEOUT_MS = 8000;

const KNOWN_STATUSES = ['resolved', 'unlinked', 'unknown_key'];

function str(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// The fingerprint of the setup token this machine exports, or null when there is nothing to ask
// about (no token, or one too short for a prefix+suffix pair to hide anything).
function fingerprintFrom(deps) {
  // A token set in ~/.claude/settings.json reaches us as process.env in a normal session; when it
  // does not, oauthTokenEnv fills that one key. An INJECTED deps.env is trusted verbatim — it
  // describes a machine under test, and a developer's own settings file must not leak into it.
  const env = deps.env == null ? oauthTokenEnv(process.env) : deps.env;
  return keyFingerprint(env == null ? null : env.CLAUDE_CODE_OAUTH_TOKEN);
}

// The one body shape all three endpoints share. Nested under `key` on purpose — the flat shape
// belongs to /credential-status, which is a different route.
function keyBody(fingerprint) {
  return { key: { prefix: fingerprint.prefix, last4: fingerprint.last4, length: fingerprint.length } };
}

async function post(path, token, body, deps) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  return postJson(`${apiBase()}${path}`, token, body, { fetchImpl, timeoutMs: REQUEST_TIMEOUT_MS });
}

// A response body, or null. A 502 from a gateway is HTML, and an empty 204-ish error body is
// nothing at all — both make res.json() throw, and neither is worth losing the status code over.
async function safeJson(res) {
  try {
    const body = await res.json();
    return body == null || typeof body !== 'object' ? null : body;
  } catch {
    return null;
  }
}

// The server's own sentence when it wrote one, since the user is about to act on it. Falls back to
// the status code rather than a mystery, so a bad gateway is still diagnosable.
function errorMessage(status, body) {
  // The server's own words FIRST, on every status: a 401 that says "this key belongs to another
  // account" is more actionable than any sentence written here, and only the server knows which
  // rejection it made.
  if (body != null) {
    const said = str(body.message) || str(body.error) || str(body.detail);
    if (said != null) return said;
  }
  // Only when it said nothing. Same reading me.mjs gives a silent 401: expires_at is only ever this
  // client's estimate of an opaque token's life, so the server's word beats it — and "HTTP 401"
  // does not tell a user at a prompt that the fix is to sign in again.
  if (status === 401 || status === 403) {
    return 'Beezi: this machine’s link is no longer accepted. Run /beezi:login to re-link, then try again.';
  }
  return `The Beezi server rejected the request (HTTP ${status}).`;
}

// The server is being built alongside this, so nothing in the payload is trusted to exist or to
// have the right type. Entries missing their identifying field are dropped rather than rendered as
// `undefined` in a question the user has to answer.
function plans(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    if (entry == null || typeof entry !== 'object') continue;
    const plan = str(entry.plan);
    if (plan == null) continue;
    out.push({ plan, label: str(entry.label) == null ? plan : str(entry.label), monthlyUsd: num(entry.monthlyUsd) });
  }
  return out;
}

function subscriptions(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    if (entry == null || typeof entry !== 'object') continue;
    const target = str(entry.target);
    if (target == null) continue;
    out.push({ target, label: str(entry.label) == null ? target : str(entry.label), plan: str(entry.plan) });
  }
  return out;
}

// What does the portal know about this machine's setup token, and what may the caller do about it?
//
// Returns the normalized payload, or NULL when the question could not be asked or answered — no
// token, a token too short to fingerprint, offline, a timeout, an older server without the route.
// Null is "could not ask", never "not resolved": those lead to opposite words at the prompt.
export async function fetchKeyResolution(token, deps = {}) {
  const fingerprint = fingerprintFrom(deps);
  if (!token || fingerprint == null) return null;

  try {
    const res = await post(ENDPOINTS.keyResolution, token, keyBody(fingerprint), deps);
    if (res == null || res.status < 200 || res.status >= 300) return null;
    const body = await safeJson(res);
    if (body == null) return null;
    const status = KNOWN_STATUSES.indexOf(body.status) === -1 ? null : body.status;
    return {
      status,
      accountId: str(body.accountId),
      subscriptionPlan: str(body.subscriptionPlan),
      planSource: str(body.planSource),
      selectablePlans: plans(body.selectablePlans),
      subscriptions: subscriptions(body.subscriptions),
      key: { prefix: fingerprint.prefix, last4: fingerprint.last4, length: fingerprint.length },
    };
  } catch {
    // Offline, timed out, or a route that does not exist yet. Not an observation about the key.
    return null;
  }
}

// Record the plan the user picked for this key. { ok: true, subscriptionPlan } on success;
// { ok: false, message } for every refusal, with the server's wording where it gave one.
export async function submitKeyPlan(token, plan, deps = {}) {
  const fingerprint = fingerprintFrom(deps);
  if (!token) return { ok: false, message: 'Beezi: this machine is not linked. Run /beezi:login to link it.' };
  if (fingerprint == null) {
    return {
      ok: false,
      message: 'No Claude setup token found on this machine (CLAUDE_CODE_OAUTH_TOKEN). There is no key to resolve.',
    };
  }
  const chosen = str(plan);
  if (chosen == null) return { ok: false, message: 'No plan given. Pass --plan <plan>.' };

  let res;
  try {
    const body = keyBody(fingerprint);
    body.plan = chosen;
    res = await post(ENDPOINTS.keyResolutionPlan, token, body, deps);
  } catch {
    return { ok: false, message: 'Could not reach the Beezi server. Check your connection and try again.' };
  }
  if (res == null) return { ok: false, message: 'Could not reach the Beezi server. Check your connection and try again.' };
  const body = await safeJson(res);
  if (res.status < 200 || res.status >= 300) return { ok: false, message: errorMessage(res.status, body) };
  // The server is the authority on what it stored; fall back to what we asked for rather than
  // reporting nothing, since the write did succeed.
  const stored = body == null ? null : str(body.subscriptionPlan);
  return { ok: true, subscriptionPlan: stored == null ? chosen : stored };
}

// Attach this key to one of the caller's subscriptions, identified by email or account id.
// { ok: true, outcome, targetAccountId } on success — outcome is 'linked', 'claimed', or NULL when
// the server named neither. 'linked' and 'claimed' mean genuinely different things, so an
// unrecognized value must not be coerced into either (see formatLinkOutcome).
// { ok: false, message } otherwise.
export async function submitKeyLink(token, target, deps = {}) {
  const fingerprint = fingerprintFrom(deps);
  if (!token) return { ok: false, message: 'Beezi: this machine is not linked. Run /beezi:login to link it.' };
  if (fingerprint == null) {
    return {
      ok: false,
      message: 'No Claude setup token found on this machine (CLAUDE_CODE_OAUTH_TOKEN). There is no key to resolve.',
    };
  }
  const chosen = str(target);
  if (chosen == null) return { ok: false, message: 'No target given. Pass --target <email-or-account-id>.' };

  let res;
  try {
    const body = keyBody(fingerprint);
    body.target = chosen;
    res = await post(ENDPOINTS.keyResolutionLink, token, body, deps);
  } catch {
    return { ok: false, message: 'Could not reach the Beezi server. Check your connection and try again.' };
  }
  if (res == null) return { ok: false, message: 'Could not reach the Beezi server. Check your connection and try again.' };
  const body = await safeJson(res);
  if (res.status < 200 || res.status >= 300) return { ok: false, message: errorMessage(res.status, body) };
  // Deliberately NOT defaulted to 'linked': that is the stronger factual claim of the two, and
  // asserting a merge that may not have happened is the exact blur this flow exists to avoid.
  const outcome = body == null ? null : str(body.outcome);
  return {
    ok: true,
    outcome: outcome === 'linked' || outcome === 'claimed' ? outcome : null,
    targetAccountId: body == null ? null : str(body.targetAccountId),
    // Surfaced only when the server names it. Joining a subscription does not by itself tell this
    // side which plan that subscription is on, so this is null far more often than not — and the
    // caller must not fall back to a guess when it is. See lib/plan-writeback.mjs.
    subscriptionPlan: body == null ? null : str(body.subscriptionPlan),
  };
}

// The two success sentences, kept in one place so they cannot drift into sounding alike.
//
// linked  — a subscription matching the target already existed and the key joined it; its usage is
//           now priced against that subscription alongside whatever else it already carries.
// claimed — nothing matched, so no merge happened: the key's identity is now this account's own,
//           standing on its own. Saying "merged" here would describe an event that did not occur.
// null    — the write succeeded but the server named neither. Report the success and say nothing
//           about which happened; guessing would state one of the two as fact.
export function formatLinkOutcome(result) {
  if (result == null || result.ok !== true) {
    return `✗ ${result == null || result.message == null ? 'Could not link this key.' : result.message}`;
  }
  const where = result.targetAccountId == null ? '' : ` (account ${result.targetAccountId})`;
  if (result.outcome !== 'linked' && result.outcome !== 'claimed') {
    // No second sentence on purpose: naming a command that re-reads this would be a guess, and the
    // one fact available — the write landed — is already stated.
    return `✓ Beezi: this key’s subscription was resolved${where}.`;
  }
  if (result.outcome === 'claimed') {
    return '✓ Beezi: no existing subscription matched, so this key now stands on its own as your account’s. Its usage bills to you.';
  }
  return `✓ Beezi: this key joined your existing subscription${where}. Its usage now bills there.`;
}
