import {
  BillingSource,
  detectBillingSource,
  resolveBillingSource,
  normalizePlan,
} from './billing.mjs';
import {
  BILLING_CONFIG_VERSION,
  readBillingConfig as _readBillingConfig,
  writeBillingConfig as _writeBillingConfig,
  resolveSource as _resolveSource,
  syncBillingSource,
  isStale as _isStale,
} from './billing-config.mjs';
import { resolveClaudeSubscription as _resolveClaudeSubscription } from './claude-auth-status.mjs';
import {
  oauthTokenAnchor as _oauthTokenAnchor,
  keyFingerprint,
  sameKeyFingerprint,
  hasOauthTokenIdentity,
} from './oauth-identity.mjs';
import {
  readClaudeAccountAnchor as _readClaudeAccountAnchor,
  readClaudeAccount as _readClaudeAccount,
} from './claude-account.mjs';
import { oauthTokenEnv } from './claude-settings-env.mjs';
import { UserError } from './friendly-error.mjs';

// The credential fields are short opaque labels. Anything token-shaped (an
// sk-ant secret, an over-long string, or embedded whitespace) is refused so a
// misdirected value can never be persisted.
const TOKEN_LIKE = /sk-ant|\s/;

function safeField(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.length > 64 || TOKEN_LIKE.test(s)) {
    throw new UserError('Refusing a suspicious value (looks token-like). Nothing written.');
  }
  return s;
}

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--subscription-type') out.subscriptionType = argv[++i];
    else if (flag === '--rate-limit-tier') out.rateLimitTier = argv[++i];
    else if (flag === '--expires-at') out.expiresAt = argv[++i];
    else if (flag === '--via') out.via = argv[++i];
    else if (flag === '--plan') out.plan = argv[++i];
    else if (flag === '--from-claude') out.fromClaude = true;
  }
  // The script's --from-claude branch rebuilds args from ~/.claude.json, which would
  // silently drop a user-supplied --plan; refuse the combination up front instead.
  if (out.fromClaude && out.plan != null) {
    throw new UserError('--plan and --from-claude are mutually exclusive.');
  }
  return out;
}

// Self-reported plans a user can pick in the /beezi:login fallback. `free` is
// absent: Claude Code cannot run on subscription billing with a free plan.
const SELF_REPORTED_PLANS = Object.freeze(['pro', 'max_5x', 'max_20x', 'team', 'enterprise']);

// Not plans — the ways a user declares they are NOT on a subscription. Without them the tier
// question is the only answer available, which pins a machine paying with an API key to a
// subscription plan it does not have and buckets its spend and errors under that plan.
// `gateway` covers the case no local signal can settle: Claude Code pointed at a custom endpoint,
// which may forward this machine's own subscription credential or bill the gateway's instead.
const SELF_REPORTED_API_KEY = 'api_key';
const SELF_REPORTED_GATEWAY = 'gateway';

// The declared source for each non-subscription answer.
function declaredNonSubscriptionSource(plan) {
  if (plan === SELF_REPORTED_API_KEY) return BillingSource.ANTHROPIC_API_KEY;
  if (plan === SELF_REPORTED_GATEWAY) return BillingSource.THIRD_PARTY;
  return null;
}

// WHICH setup token this record describes, or null when the env in force exposes none. Stored
// structurally rather than parsed back out of the anchor: the anchor slot is single-occupancy and
// may legitimately hold an `email`/`account_uuid` identity while the plan came from a key.
//
// Null means "not stated", never "no key" — see sameKeyFingerprint in oauth-identity.mjs. The env
// is the caller's already-resolved one, so this can never disagree with the fingerprint the
// check-in and the session reports send.
function fingerprintOf(env) {
  return keyFingerprint(env == null ? null : env.CLAUDE_CODE_OAUTH_TOKEN);
}

// The stored accountAnchor field: identity value + which source produced it, dated. Null in →
// null out, so a machine exposing no identity keeps the pre-anchor behavior.
function stampAnchor(anchor, now) {
  if (anchor == null || anchor.value == null || anchor.source == null) return null;
  return { value: anchor.value, source: anchor.source, updatedAt: now.toISOString() };
}

// The vendor account id stored ALONGSIDE the anchor, whichever source won the anchor slot: the
// CLI's email outranks the file uuid as the switch detector, but the server can only merge an
// email-provisional account row into the canonical uuid row (and link sessions, which report the
// uuid) when the check-in presents both identity fields.
function resolveAccountUuid(account, anchor) {
  if (account != null && typeof account.accountUuid === 'string' && account.accountUuid) {
    return account.accountUuid;
  }
  if (anchor != null && anchor.source === 'account_uuid' && anchor.value != null) {
    return anchor.value;
  }
  return null;
}

// The vendor email stored alongside the uuid, for the same merge: a machine anchored on the uuid
// still knows the email and must present both. Copied raw like the anchor value — safeField's
// 64-char cap would throw away a legitimate address (emails run to 254).
function resolveAccountEmail(account, anchor) {
  if (account != null && typeof account.email === 'string' && account.email) {
    return account.email;
  }
  if (anchor != null && anchor.source === 'email' && anchor.value != null) {
    return anchor.value;
  }
  return null;
}

export function buildConfig(args, env = process.env, now = new Date(), account = null, anchor = null) {
  if (args.plan != null) {
    const plan = String(args.plan).trim().toLowerCase();
    const declaredSource = declaredNonSubscriptionSource(plan);
    if (declaredSource != null) {
      const envSource = detectBillingSource(env);
      const capturedVia = safeField(args.via);
      return {
        version: BILLING_CONFIG_VERSION,
        // An env that positively names a provider still wins; otherwise take the user's word.
        source: envSource === BillingSource.UNKNOWN ? declaredSource : envSource,
        subscriptionType: null,
        rateLimitTier: null,
        plan: null,
        credentialsExpiresAt: null,
        capturedAt: now.toISOString(),
        capturedBy: capturedVia == null ? 'manual' : capturedVia,
        selfReported: true,
        detectedVia: null,
        planSource: null,
        accountAnchor: stampAnchor(anchor, now),
        accountUuid: resolveAccountUuid(account, anchor),
        accountEmail: resolveAccountEmail(account, anchor),
        keyFingerprint: fingerprintOf(env),
        envKeyPresent: fingerprintOf(env) != null,
      };
    }
    if (!SELF_REPORTED_PLANS.includes(plan)) {
      throw new UserError(
        `Unknown plan '${args.plan}'. Valid: ${[...SELF_REPORTED_PLANS, SELF_REPORTED_API_KEY, SELF_REPORTED_GATEWAY].join(', ')}.`,
      );
    }
    // Naming a subscription tier IS the evidence: the user is telling us they bill a subscription,
    // which is exactly the fact no local signal could establish. It resolves UNKNOWN, but it never
    // overrides an env that positively says otherwise — an exported API key outranks the claim.
    const envSource = detectBillingSource(env);
    const source = envSource === BillingSource.UNKNOWN ? BillingSource.SUBSCRIPTION : envSource;
    const isSub = source === BillingSource.SUBSCRIPTION;
    const capturedVia = safeField(args.via);
    return {
      version: BILLING_CONFIG_VERSION,
      source,
      // The plan label is the single source of the derived fields; the tier was
      // never observed, so rateLimitTier stays null rather than a synthesized value.
      subscriptionType: isSub ? (plan.startsWith('max_') ? 'max' : plan) : null,
      rateLimitTier: null,
      plan: isSub ? plan : null,
      credentialsExpiresAt: null,
      capturedAt: now.toISOString(),
      capturedBy: capturedVia == null ? 'manual' : capturedVia,
      selfReported: true,
      detectedVia: null,
      // Provenance of the PLAN: null when the env overruled the declaration, since there is then
      // no plan above for it to describe.
      planSource: isSub ? 'self_reported' : null,
      accountAnchor: stampAnchor(anchor, now),
      accountUuid: resolveAccountUuid(account, anchor),
      accountEmail: resolveAccountEmail(account, anchor),
      keyFingerprint: fingerprintOf(env),
      envKeyPresent: fingerprintOf(env) != null,
    };
  }
  const subscriptionType = safeField(args.subscriptionType);
  const rateLimitTier = safeField(args.rateLimitTier);
  const via = safeField(args.via);
  // A readable oauthAccount is positive subscription evidence; without it (and without an env
  // signal) the source stays unknown rather than being assumed.
  const source = resolveBillingSource(env, account);
  const isSub = source === BillingSource.SUBSCRIPTION;
  // The resolver told us the on-disk profile describes a different credential than the one in
  // force (a setup token), so there is no plan tuple to persist. Gate it explicitly: the incoming
  // fields are already null, and normalizePlan(null, null) is 'unknown' — a label that reads as
  // "captured, could not classify" and would be reported as such. `null` says we did not capture.
  const planUnresolved = account != null && account.planSource === 'unresolved';
  const keepPlan = isSub && !planUnresolved;
  // null/undefined/'' must stay null — Number(null) is 0, which would look like an
  // already-expired timestamp and force a permanent "stale" state.
  const expiresAt = args.expiresAt == null || args.expiresAt === '' ? NaN : Number(args.expiresAt);
  return {
    version: BILLING_CONFIG_VERSION,
    source,
    subscriptionType: keepPlan ? subscriptionType : null,
    rateLimitTier: keepPlan ? rateLimitTier : null,
    plan: keepPlan ? normalizePlan(subscriptionType, rateLimitTier) : null,
    credentialsExpiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
    capturedAt: now.toISOString(),
    capturedBy: via == null ? 'manual' : via,
    detectedVia: account == null || account.detectedVia == null ? null : account.detectedVia,
    // Provenance of the PLAN, distinct from detectedVia (provenance of the tuple's fields).
    // 'unresolved' records that the nulls above are a verdict rather than a gap, which is what
    // keeps isStale() and the report gate from treating them as a plan waiting to be re-read.
    planSource: planUnresolved ? 'unresolved' : (keepPlan ? 'claude_login' : null),
    accountAnchor: stampAnchor(anchor, now),
    accountUuid: resolveAccountUuid(account, anchor),
    accountEmail: resolveAccountEmail(account, anchor),
    keyFingerprint: fingerprintOf(env),
    envKeyPresent: fingerprintOf(env) != null,
  };
}

// The one degradation that is never new information: the SAME product with the multiplier gone.
// `max` alongside a stored `max_5x`/`max_20x` means the tier was not readable this time, not that
// the user moved to a different plan — and the loss is unrecoverable, because `max` is not
// `unknown` so no staleness check and no nudge ever asks again.
//
// Deliberately narrow. A fresh `pro` or `team` over a stored `max_20x` IS a real plan change and
// must still record; only same-product detail loss is refused.
export function losesMultiplier(freshPlan, existingPlan) {
  if (freshPlan !== 'max') return false;
  return existingPlan === 'max_5x' || existingPlan === 'max_20x';
}

// Does this record BELONG to a setup key? Both ways one can be recorded count, and they are not
// interchangeable in practice: the portal writeback stamps a fingerprint, while a record whose key
// was captured through the anchor alone (an env tier that exposed the token to the anchor read but
// no fingerprintable value, a pre-fingerprint record grandfathered forward) carries only the
// `oauth_key` anchor. Reading just the fingerprint left the second shape unprotected — its plan was
// scoped to a key exactly the same way, and a capture that could not see one overwrote it.
function isKeyScoped(config) {
  if (config == null) return false;
  if (config.keyFingerprint != null) return true;
  return config.accountAnchor != null && config.accountAnchor.source === 'oauth_key';
}

// A self-reported plan must survive automatic re-capture: when the fresh account
// fields still normalize to 'unknown', overwriting would destroy the only good
// data and restart the refresh-nudge loop the selfReported exemption exists to end.
export function shouldKeepExisting(freshConfig, existingConfig, options = {}) {
  if (existingConfig == null) return false;
  // Applies to every record, self-reported or not, and to the forced path too: /beezi:refresh
  // exists to correct a stale plan, but a re-resolution that dropped the tier has not learned
  // anything to correct it with.
  if (losesMultiplier(freshConfig.plan, existingConfig.plan)) return true;
  // An `unresolved` capture is the ABSENCE of local evidence, so it must never erase a plan that
  // came from somewhere local evidence cannot reach. The Beezi server's answer for this key's
  // fingerprint (planSource 'key_resolution', written by plan-writeback.mjs) is exactly that: it
  // is the ONLY thing that can price a setup-token machine, and every weekly heartbeat re-runs a
  // capture that will keep reporting 'unresolved' for as long as the token is in force.
  // The literal rather than an import: this must not couple the local capture to the writeback
  // module, and the vocabulary is documented in one place there.
  if (freshConfig.planSource === 'unresolved' && existingConfig.planSource === 'key_resolution') return true;
  // A record that belongs to a KEY must not be overwritten by a capture that could not see one.
  //
  // Without this the reset undoes itself. When the token is exported from a shell profile it is
  // invisible to all three env tiers, so the weekly heartbeat spawns the CLI with no token, gets
  // `authMethod:'claude.ai'` describing the previous interactive login, and builds a fresh
  // `claude_login` capture carrying that account's plan. Nothing above stops it — the fresh record
  // is not 'unresolved', and the existing one is not selfReported — so learnedPlan() would make it
  // win, restoring the wrong plan AND forcing the check-in ('captured') that re-binds the key.
  //
  // A capture whose env held no token is by construction not evidence about a key. Narrow on
  // purpose: it does not touch self-reported records, does not block an 'unresolved' verdict (which
  // is a real observation about this key), and does not reach the account-switch path, which
  // bypasses this function entirely.
  //
  // `options.keyRevertConfirmed` is the one thing that stands this rule down: the reconcile saw no
  // token in ANY env tier and the CLI positively answered for an interactive login. Without that
  // escape a genuine migration off a setup token could never update the record — not on session
  // start, not on the weekly heartbeat, and not through /beezi:refresh, since this rule applies to
  // the forced path too. The caller owns that judgement because only it has the env and the CLI's
  // answer; this function has neither.
  if (isKeyScoped(existingConfig)
    && freshConfig.keyFingerprint == null
    && freshConfig.planSource === 'claude_login'
    && options.keyRevertConfirmed !== true) return true;
  if (existingConfig.selfReported !== true) return false;
  const declaredTier = Boolean(existingConfig.plan) && existingConfig.plan !== 'unknown';
  // A declared api-key or gateway machine carries no plan at all — the source IS the declaration.
  const declaredSource = existingConfig.source === BillingSource.ANTHROPIC_API_KEY
    || existingConfig.source === BillingSource.THIRD_PARTY;
  if (!declaredTier && !declaredSource) return false;
  // An `unresolved` verdict says the on-disk PROFILE is not evidence for the credential in force.
  // It says nothing about the user's own testimony — the token may well belong to the very account
  // they described — so it must not wipe the one answer no automatic capture can reconstruct, or
  // the nudge loop this exemption exists to end starts over. (An account SWITCH still overrides,
  // above in the reconcile: there the record demonstrably describes someone else.)
  if (freshConfig.planSource === 'unresolved') return true;
  // Overwrite only when the fresh capture actually learned something. An `unknown` source means it
  // did not, so the user's answer must survive — otherwise every /beezi:refresh on a machine whose
  // billing cannot be observed wipes the answer and restarts the nudge loop.
  return freshConfig.plan === 'unknown' || freshConfig.source === BillingSource.UNKNOWN;
}

// How long an account-anchor verdict is trusted before the reconcile re-checks it (one CLI spawn).
const ANCHOR_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

// A positive identity mismatch ONLY: both anchors present, produced by the same source, naming
// different values. Cross-source differences (a CLI email vs a file userID) and any null side are
// inconclusive — they must not wipe a self-reported plan.
function anchorChanged(stored, current) {
  if (stored == null || current == null) return false;
  if (stored.source !== current.source) return false;
  if (stored.value == null || current.value == null) return false;
  return stored.value !== current.value;
}

// Case-insensitive, padding-tolerant equality for one identity field. Returns null when either
// side states nothing — "unknown" is never "different", the same rule anchorChanged follows.
function sameIdentityValue(a, b) {
  if (a == null || b == null) return null;
  const x = String(a).trim().toLowerCase();
  const y = String(b).trim().toLowerCase();
  if (!x || !y) return null;
  return x === y;
}

// Does an observation of the machine's Claude account POSITIVELY disagree with the stored record?
//
// The question anchorChanged structurally cannot answer. Its rule — a mismatch counts only between
// anchors of the SAME source — is right for anchors and must stay, but it leaves the ordinary
// account switch undetectable on the ordinary machine: `buildAnchor` anchors on the CLI's email
// whenever the CLI answers, while readClaudeAccountAnchor can only ever return `account_uuid` or
// `user_id`. That pair is cross-source by construction, so the precheck could never fire and the
// switch waited for the seven-day heartbeat.
//
// Compared field by field instead, uuid against uuid and email against email, where EITHER stating
// a different value is a switch. `observed` is a readClaudeAccount() result or a
// resolveClaudeSubscription() one; both name the fields the same way.
//
// A NULL SIDE IS "NOT STATED", NEVER "DIFFERENT" — which is exactly the two cases that must stay
// quiet: the uuid still matches and this observation names no email (keep the stored email), or
// the email still matches and it names no uuid (keep the stored uuid). Neither is news, and
// treating either as a switch would wipe a good record on every machine whose login surface fills
// only half the pair.
export function identityChanged(stored, observed) {
  if (stored == null || observed == null) return false;
  if (sameIdentityValue(stored.accountUuid, observed.accountUuid) === false) return true;
  const observedEmail = observed.email == null ? observed.accountEmail : observed.email;
  if (sameIdentityValue(stored.accountEmail, observedEmail) === false) return true;
  return false;
}

function sameAnchor(stored, current) {
  if (stored == null && current == null) return true;
  if (stored == null || current == null) return false;
  return stored.source === current.source && stored.value === current.value;
}

// How long before a machine that could not confirm an auth-mode switch is allowed to ask again.
// Shorter than ANCHOR_RECHECK_MS because the question is answerable as soon as the CLI works;
// long enough that a machine which can NEVER answer it does not spawn `claude auth status` on
// every single session.
//
// This is now the SLOW path only. A real transition — the env token appearing or disappearing —
// fires immediately through envKeyStateChanged below, so the window no longer decides how fast a
// user's auth-mode change is noticed; it only bounds how often an unconfirmable DISAGREEMENT (a
// token exported from a shell profile, invisible to every env tier) is re-asked. That is what
// makes an hour affordable where six were not.
const AUTH_MODE_RECHECK_MS = 60 * 60 * 1000;

// Has this machine moved from an interactive login onto a setup token?
//
// The case anchorChanged structurally cannot see. Its rule — a mismatch counts only between anchors
// of the SAME source — is right and must stay: a CLI email versus a file userID is two different
// questions, not a changed answer, and treating it as a switch would wipe self-reported plans. But
// the login → token transition is exactly a cross-source pair (`email`/`account_uuid`/`user_id` on
// the record, `oauth_key` in force), so it read as inconclusive and nothing fired. The plan captured
// from the previous login kept shipping under a key that may belong to someone else entirely.
//
// selfReported records are excluded on purpose, matching the invariant documented in
// shouldKeepExisting: an `unresolved` verdict says nothing about the user's own testimony, and the
// token may well belong to the very account they described. Their record is left to the heartbeat.
//
// This is only HALF the decision — it says the question is worth asking, not what the answer is.
// The caller must additionally require that the CLI positively confirmed a setup token before
// treating it as a switch; see the reconcile.
function authModeSwitched(existing, tokenAnchor) {
  if (tokenAnchor == null) return false;
  if (existing == null || existing.accountAnchor == null) return false;
  if (existing.accountAnchor.source === 'oauth_key') return false;
  return existing.selfReported !== true;
}

// The MIRROR of the above: has this machine moved off a setup token back to an interactive login?
//
// anchorChanged cannot see this one either, and for the same structural reason — `oauth_key` on the
// record versus `email`/`account_uuid` in force is a cross-source pair. Worse, shouldKeepExisting
// deliberately blocks a `claude_login` capture from overwriting a key-scoped record, so the plan the
// portal resolved for a key that is no longer in use kept shipping under the new login forever: the
// heartbeat re-ran, took the `kept` branch, and even /beezi:refresh could not correct it (the guard
// applies to the forced path too).
//
// This says only that the question is worth asking. What answers it is the CLI — see the reconcile,
// which additionally requires that it POSITIVELY answered for an interactive login.
function authModeReverted(existing, tokenAnchor) {
  // A token is in force, so nothing was reverted.
  if (tokenAnchor != null) return false;
  if (existing == null) return false;
  // A record that was never key-scoped was never a token machine, so nothing was reverted.
  if (!isKeyScoped(existing)) return false;
  // selfReported records are excluded, matching authModeSwitched — and here the exclusion is
  // load-bearing in a way it is not there. This function's answer becomes options.keyRevertConfirmed,
  // which stands shouldKeepExisting's key guard down, and that guard is evaluated BEFORE its
  // selfReported branch: it was what protected a declared plan from a capture whose env simply
  // could not see the token. Until this escape existed the guard was absolute (0.21.0, d511e64), so
  // this restores that protection rather than adding a new rule.
  //
  // It has to be here rather than at the reconcile because confirmsInteractiveLogin cannot tell a
  // real migration from a token exported out of every env tier — the honest limit written out
  // below. Guessing wrong is permanent on a declared record: isStale() never re-asks one, so the
  // user's own answer would be gone with nothing left to restore it. An account SWITCH still
  // overrides, through anchorChanged, where the record demonstrably describes someone else.
  //
  // This also stands the revert clause's CLI spawn down for such records, exactly as
  // authModeSwitched does: they are left to the heartbeat, /beezi:refresh and anchorChanged.
  return existing.selfReported !== true;
}

// Did the env's setup token APPEAR or DISAPPEAR since the last reconcile?
//
// The transition itself, as opposed to authModeSwitched/authModeReverted, which report a
// DISAGREEMENT between the record and the env. The difference decides the rate limit: a
// disagreement stays true for as long as the machine cannot confirm it — the shell-profile token
// is invisible to every env tier, so its predicate never goes false — and re-asking it every
// session would spawn `claude auth status` forever. A flip is true exactly once, on the session
// that observes it, because every write stamps the state it saw. So it needs no window at all, and
// a user who switches auth mode and restarts is told on that restart.
//
// `envKeyPresent` absent is NOT STATED, never "flipped": records written before this field exists
// (and by the manual capture commands of older versions) must not all look like a change on the
// first session after an upgrade.
function envKeyStateChanged(existing, present) {
  if (existing == null) return false;
  if (typeof existing.envKeyPresent !== 'boolean') return false;
  return existing.envKeyPresent !== present;
}

// Did the CLI positively confirm an interactive login, as opposed to merely failing to contradict
// one? This is the whole weight of the revert decision, so it is deliberately narrow.
//
// `oauth_account` does NOT count. That is the arm resolveClaudeSubscription takes when the CLI gave
// no usable answer and only ~/.claude.json's stale profile is left — precisely the evidence that is
// worthless here, since under setup-token auth that profile describes whoever logged in last.
// `oauth_token` does not count either: it says a token IS in force.
//
// HONEST LIMIT, stated because no code can close it: a token exported from a shell profile is
// invisible to all three env tiers, and Claude Code scrubs it from the hooks it spawns — so `claude
// auth status` answers `claude.ai` for the previous login and looks exactly like a real migration.
// Locally the two are indistinguishable. The reconcile therefore SURFACES the change rather than
// making it silently, so a machine that guessed wrong is one /beezi:refresh from being corrected.
function confirmsInteractiveLogin(sub) {
  if (sub == null) return false;
  if (sub.planSource === 'unresolved') return false;
  return sub.detectedVia === 'cli_status' || sub.detectedVia === 'merged';
}

// What actually CHANGED about this machine's billing, as a list a human can read.
//
// Deliberately a diff of the stored facts rather than a reading of `outcome`. An outcome says a
// write happened, which is not the same thing: the weekly heartbeat re-captures the identical
// tuple and lands on 'captured' every time, and announcing that would train the user to ignore the
// line. Only a value that moved counts.
//
// A first capture is NOT a change — there was nothing to change from — so an absent record yields
// an empty list and the caller stays silent.
//
// Order matters: the credential comes first because it explains the rest. When a machine moves off
// a setup token its plan and account appear to change too, and reading "plan max_20x → pro" without
// "setup token → Claude login" in front of it is baffling.
// Did one setup token replace ANOTHER? The credential arms above see a key arriving or leaving,
// never one swapped for the next: both sides are key-scoped, so neither fires — and every other
// field the diff reads goes quiet at the same moment (the plan is cleared to null, which reads as
// absent; a token machine states no account; the source stays `subscription`). A rotation therefore
// rewrote the record and told the user nothing, which is the one write worth announcing: the plan
// the portal resolved for the previous key is gone and the new key is priced from scratch.
//
// The fingerprint decides when both sides carry one. When either does not — a record written before
// billing.json v4, or one whose key was only ever captured through the anchor — the `oauth_key`
// anchor stands in: its value encodes prefix...last4:length, so it moves on every rotation. A
// fingerprint merely BECOMING visible on an unmoved anchor is a blank being filled, not a change.
function keyRotated(existing, next) {
  const a = existing.keyFingerprint;
  const b = next.keyFingerprint;
  if (a != null && b != null) return !sameKeyFingerprint(a, b);
  const before = existing.accountAnchor;
  const after = next.accountAnchor;
  if (before == null || after == null) return false;
  if (before.source !== 'oauth_key' || after.source !== 'oauth_key') return false;
  if (before.value == null || after.value == null) return false;
  return before.value !== after.value;
}

export function describeBillingChanges(existing, next) {
  if (existing == null || next == null) return [];
  const out = [];

  const hadKey = existing.keyFingerprint != null
    || (existing.accountAnchor != null && existing.accountAnchor.source === 'oauth_key');
  const hasKey = next.keyFingerprint != null
    || (next.accountAnchor != null && next.accountAnchor.source === 'oauth_key');
  if (hadKey && !hasKey) out.push('setup token → Claude login');
  else if (!hadKey && hasKey) out.push('Claude login → setup token');
  else if (hadKey && hasKey && keyRotated(existing, next)) out.push('setup token rotated');

  // FILLING A BLANK IS NOT A CHANGE, and this is the rule that keeps the notice worth reading.
  // Most writes to this file are the plugin learning something it did not know before: a record
  // written before billing.json v3 gaining accountEmail, a source resolving off `unknown` once
  // evidence arrives, a coarse `max` sharpening to `max_20x` when a better capture lands. Nothing
  // about the user's billing moved in any of those — announcing them would fire once on nearly
  // every machine at upgrade and teach people to skip the line.
  //
  // So a field reports only when a KNOWN value became a DIFFERENT known value. The credential
  // transitions above are exempt: those are observations about which credential is in force, and
  // both directions are real news whatever the record knew before.
  const moved = (from, to) => from != null && to != null && from !== to;

  // 'unknown' is how this file writes "no plan"; treat it as absent on both sides. A same-product
  // sharpening (`max` → `max_5x`/`max_20x`) is the multiplier becoming readable, not a plan the
  // user moved to — the inverse of what losesMultiplier refuses to write — so it is a refinement
  // and stays quiet. A move to a different product still reports.
  const plan = (v) => (v == null || v === 'unknown' ? null : v);
  const sharpened = losesMultiplier(existing.plan, next.plan);
  if (moved(plan(existing.plan), plan(next.plan)) && !sharpened) {
    out.push(`plan ${existing.plan} → ${next.plan}`);
  }

  // Identity, best evidence first, and only one line for it: a uuid and an email that move together
  // are one account switch, not two.
  const who = (c) => (c.accountEmail != null ? c.accountEmail : c.accountUuid);
  if (moved(who(existing), who(next))) {
    out.push(`account ${who(existing)} → ${who(next)}`);
  }

  // The billing METHOD, a different question from the plan: a machine can move from a subscription
  // to an API key without either plan being wrong. 'unknown' is absent here too.
  const src = (v) => (v == null || v === BillingSource.UNKNOWN ? null : v);
  if (moved(src(existing.source), src(next.source))) {
    out.push(`billing source ${existing.source} → ${next.source}`);
  }

  return out;
}

// Bounds how often the above is allowed to cost a process spawn. anchorCheckedAt is stamped on
// every reconcile attempt, including the kept and no-signal paths, so a machine that keeps failing
// to confirm re-asks at most four times a day instead of once per session.
function authModeCheckDue(existing, now) {
  if (existing == null) return true;
  const checkedAt = Date.parse(existing.anchorCheckedAt == null ? '' : existing.anchorCheckedAt);
  if (Number.isNaN(checkedAt)) return true;
  // A stamp from the future is a clock change, not a fresh check.
  return now.getTime() - checkedAt > AUTH_MODE_RECHECK_MS || checkedAt > now.getTime();
}

// A capture that resolved a real subscription plan. Anything weaker must not overwrite an
// existing record outside an account switch — a broken CLI or a wiped oauthAccount would
// otherwise degrade a good capture to nulls on the next stale check.
function learnedPlan(config) {
  return config.source === BillingSource.SUBSCRIPTION && config.plan != null && config.plan !== 'unknown';
}

// The self-healing capture, shared by the SessionStart hook and the manual commands so the two
// can never disagree about switch detection or what a self-reported plan survives.
//
// Session-start mode (default): re-capture only when the record is missing, stuck on `unknown`,
// stale, or belongs to a different account — all decided from local reads. The one process spawn
// (claude auth status, ~600ms) happens only after a trigger fires; the steady state (fresh config,
// same account) reads two small files and writes nothing.
//
// Forced mode (`options.force`, /beezi:login and /beezi:refresh): the user asked for a re-read, so
// the capture always runs and a resolved account overwrites anything but a still-protected
// self-reported plan — including re-writing `plan=unknown`, which is what routes the login flow to
// its tier question. `options.via` names the writer (capturedBy).
//
// Returns { config, source, outcome } — outcome is 'switched' | 'captured' | 'cleared' | 'kept' |
// 'no-signal' | 'none' (no trigger fired), for the manual commands' one-line reports. 'cleared' is
// a write like 'captured', but of a record with NO plan: the CLI said the credential in force is a
// setup token, so the tuple that was there described a different account.
// Best-effort by contract: any failure returns whatever is known and must never throw.
export function reconcileBillingConfig(deps = {}, options = {}) {
  const readConfig = deps.readBillingConfig == null ? _readBillingConfig : deps.readBillingConfig;
  const writeConfig = deps.writeBillingConfig == null ? _writeBillingConfig : deps.writeBillingConfig;
  const resolveSourceImpl = deps.resolveSource == null ? _resolveSource : deps.resolveSource;
  const isStaleImpl = deps.isStale == null ? _isStale : deps.isStale;
  const resolveSubscription = deps.resolveClaudeSubscription == null ? _resolveClaudeSubscription : deps.resolveClaudeSubscription;
  const readFileAnchor = deps.readClaudeAccountAnchor == null ? _readClaudeAccountAnchor : deps.readClaudeAccountAnchor;
  const readFileAccount = deps.readClaudeAccount == null ? _readClaudeAccount : deps.readClaudeAccount;
  const tokenAnchorOf = deps.oauthTokenAnchor == null ? _oauthTokenAnchor : deps.oauthTokenAnchor;
  // Same rule as every other token read: a settings-file token counts when nothing exported
  // one, and an injected deps.env is trusted verbatim.
  const env = deps.env == null ? oauthTokenEnv(process.env) : deps.env;
  const now = deps.now == null ? new Date() : deps.now;
  const force = options.force === true;
  const via = options.via == null ? 'session-start' : options.via;

  let chosen = null;
  let outcome = 'none';
  // The record as it stood BEFORE this reconcile, held at function scope so the change summary at
  // the tail can diff against it — after the source sync, which is itself a billing fact.
  let before = null;
  try {
    const existing = readConfig();
    before = existing;
    chosen = existing;
    const storedAnchor = existing == null ? null : existing.accountAnchor;
    // Cheap precheck, no spawn; the CLI's own (fresher) anchor re-checks after one. A
    // cross-source pair here is inconclusive by design — the weekly heartbeat covers it.
    let fileAnchor = null;
    try { fileAnchor = readFileAnchor(); } catch { fileAnchor = null; }

    // The setup token's OWN anchor, read from the already-resolved env — free, no process spawn.
    // Without it a key ROTATION is invisible here: ~/.claude.json's file anchor does not move when
    // the token changes, so on a token machine the precheck compared two things that never differ,
    // nothing triggered, and a plan the server resolved for the PREVIOUS fingerprint kept shipping
    // under the new one. A key_resolution plan is an answer scoped to one fingerprint, so serving it
    // under a different one is a category error — worse than a stale plan, and one the pre-token
    // code could not make, because plans were not key-scoped then.
    let tokenAnchor = null;
    try { tokenAnchor = tokenAnchorOf(env); } catch { tokenAnchor = null; }

    // ~/.claude.json's account fields, read live. Free (the same small file the anchor read opens)
    // and the only precheck that can see an ordinary account switch — see identityChanged.
    let fileAccount = null;
    try { fileAccount = readFileAccount(); } catch { fileAccount = null; }

    // Whether a fingerprintable setup token is in force RIGHT NOW, from the resolved env. Compared
    // against what the record saw last time; stamped on every write below so the next session can
    // do the same.
    const envKeyPresent = tokenAnchor != null;

    // WHEN the uuid/email pair is evidence at all. Never on a machine whose record belongs to a
    // setup token: under a key, ~/.claude.json describes whoever logged in interactively last,
    // while the portal writes its OWN accountEmail into that record (plan-writeback.mjs) — so the
    // two disagree on a machine whose key never moved, and reading that as a switch would wipe a
    // key_resolution plan. Identity there IS the fingerprint, and both token transitions have
    // their own clauses below.
    //
    // Keyed off the RECORD first, and that ordering is load-bearing: a token exported from a shell
    // profile is invisible to every env tier (the honest limit documented on
    // confirmsInteractiveLogin), so an env check alone would leave exactly those machines exposed.
    const identityComparable = existing != null
      && !isKeyScoped(existing)
      && !hasOauthTokenIdentity(env);
    const fileIdentitySwitch = identityComparable && identityChanged(existing, fileAccount);

    // The heartbeat bounds how long an account switch can stay invisible: an email anchor only
    // exists in the CLI's answer, and a self-reported plan never goes stale, so without a periodic
    // re-check neither would ever be re-verified. anchorCheckedAt is stamped on every attempt.
    const checkedAt = Date.parse(existing == null || existing.anchorCheckedAt == null ? '' : existing.anchorCheckedAt);
    const heartbeatDue = existing != null
      && (Number.isNaN(checkedAt) || now.getTime() - checkedAt > ANCHOR_RECHECK_MS || checkedAt > now.getTime());

    const trigger = force
      || existing == null
      || (existing.source === BillingSource.UNKNOWN && existing.selfReported !== true)
      || isStaleImpl(existing, now.getTime())
      || anchorChanged(storedAnchor, fileAnchor)
      || anchorChanged(storedAnchor, tokenAnchor)
      // The ordinary account switch: ~/.claude.json now names a different uuid or a different
      // email than the record holds. Free, and unlike the anchor pair it does not need the two
      // sides to have come from the same source.
      || fileIdentitySwitch
      // The login → setup-token transition, which no anchorChanged pair can express. Rate-limited
      // because a machine whose CLI cannot answer would otherwise re-ask on every session forever:
      // the predicate stays true until a confirming capture rewrites the anchor to oauth_key.
      // The auth mode CHANGED since the last reconcile — a token appeared or disappeared. Free to
      // observe and true exactly once, so it is deliberately not rate-limited: this is what makes a
      // user who switches auth mode and restarts hear about it on that restart.
      || envKeyStateChanged(existing, envKeyPresent)
      || (authModeSwitched(existing, tokenAnchor) && authModeCheckDue(existing, now))
      // And its mirror, the setup-token → login transition. Same reason it needs its own clause
      // (no anchorChanged pair can express a cross-source move) and the same rate limit, so a
      // machine whose CLI cannot answer does not spawn one every session.
      || (authModeReverted(existing, tokenAnchor) && authModeCheckDue(existing, now))
      || heartbeatDue;

    if (trigger) {
      let sub = null;
      // `env` is passed EXPLICITLY, and that is the whole point of this line. resolveClaudeSubscription
      // otherwise defaults to oauthTokenEnv(process.env) — the NON-probing variant — and rebuilds a
      // second, un-probed env of its own. On a setup-token machine that env has no token (Claude Code
      // scrubs CLAUDE_CODE_OAUTH_TOKEN from every child it spawns), so the CLI is asked without the
      // token, answers authMethod:"claude.ai", and the previous login's plan is captured as fact —
      // exactly the bug the oauth_token branch below exists to prevent. The reconcile's env has been
      // through all three tiers; the resolver must judge by the same one.
      try { sub = resolveSubscription({ env }); } catch { sub = null; }
      const currentAnchor = sub != null && sub.anchor != null ? sub.anchor : fileAnchor;
      // The transition counts as a switch ONLY once the CLI has confirmed it. `planSource
      // 'unresolved'` is set by exactly one branch of resolveClaudeSubscription: the one that saw
      // authMethod 'oauth_token', i.e. positive evidence that the credential in force is the setup
      // token rather than the login on disk.
      //
      // Without this guard the 'switched' arm below — which writes wholesale and consults nothing —
      // would stamp whatever resolveClaudeSubscription happened to return under a fresh oauth_key
      // anchor and fingerprint. Two shapes make that actively destructive: a machine whose `claude`
      // CLI is missing or slow still yields the stale oauthAccount profile (the previous login's
      // plan, permanently key-scoped, and shipped as this key's tier in the check-in that binds it);
      // and `sub == null` yields plan 'unknown', wiping a good key_resolution answer with junk.
      // Both now fall through to the ordinary overwrite/kept logic, which is today's behaviour.
      const authSwitch = authModeSwitched(existing, tokenAnchor)
        && sub != null && sub.planSource === 'unresolved';
      // The CLI's own answer, checked on the same terms as the file's: it is the fresher of the
      // two, and on a machine whose ~/.claude.json was never rewritten it is the only one that
      // moved.
      const cliIdentitySwitch = identityComparable && identityChanged(existing, sub);
      // A ROTATION, proven by the env alone. It deliberately does not wait for the CLI: the
      // fingerprint is the only local signal that moves with the token, and `currentAnchor` drops
      // back to the file anchor whenever resolveClaudeSubscription could not answer — which sent a
      // proven rotation down the `kept` branch, where it adopted the NEW fingerprint and left the
      // PREVIOUS key's plan in place. That is an answer about a different credential served under
      // this one. Clearing to `unknown` is the honest state; the portal re-prices the new key on
      // this same session start.
      const keyRotation = anchorChanged(storedAnchor, tokenAnchor);
      const switched = anchorChanged(storedAnchor, currentAnchor)
        || keyRotation
        || fileIdentitySwitch
        || cliIdentitySwitch
        || authSwitch;
      const fresh = buildConfig(
        {
          subscriptionType: sub == null ? null : sub.subscriptionType,
          rateLimitTier: sub == null ? null : sub.rateLimitTier,
          expiresAt: sub == null ? null : sub.expiresAt,
          via,
        },
        env, now, sub, currentAnchor,
      );
      const stampedNow = now.toISOString();
      // Forced (user-invoked) captures keep the historical /beezi:refresh contract: a resolved
      // account overwrites anything shouldKeepExisting does not protect, `plan=unknown` included.
      // The automatic path additionally demands a real plan, so a transiently unreadable machine
      // can never degrade a good record on its own.
      // Losing a plan we now know we cannot resolve IS new information, so it has to be able to
      // win the write. Without this a machine that once captured `team` from a previous
      // interactive login would keep reporting it forever under a setup token: learnedPlan(fresh)
      // is false for a cleared capture, so the automatic path would take the `kept` branch and
      // leave the stale tuple in place on every heartbeat.
      const clearsPlan = fresh.planSource === 'unresolved';
      // The machine moved off its setup token and the CLI confirmed the login that replaced it.
      // This is the ONLY thing that lets a claude_login capture overwrite a key-scoped record; see
      // shouldKeepExisting, and confirmsInteractiveLogin for what "confirmed" is worth.
      const keyRevertConfirmed = authModeReverted(existing, tokenAnchor) && confirmsInteractiveLogin(sub);
      const overwrite = sub != null && !shouldKeepExisting(fresh, existing, { keyRevertConfirmed })
        && (force || learnedPlan(fresh) || clearsPlan);
      if (switched) {
        // The account changed: the old record — self-reported or not — describes someone else.
        // A degraded fresh capture still wins; the unknown-nudge then asks the right account.
        chosen = { ...fresh, anchorCheckedAt: stampedNow };
        writeConfig(chosen);
        outcome = 'switched';
      } else if (overwrite) {
        const written = { ...fresh, anchorCheckedAt: stampedNow };
        // SAME ACCOUNT, half an identity: a capture that learned a better plan but named no uuid
        // or no email must not blank the field the record already held. Reached only when
        // `switched` is false, so a real switch still writes wholesale and the previous account's
        // fields are never carried onto the new one. Mirrors what the `kept` branch below has
        // always done for the identity fields.
        if (written.accountUuid == null && existing != null && existing.accountUuid != null) {
          written.accountUuid = existing.accountUuid;
        }
        if (written.accountEmail == null && existing != null && existing.accountEmail != null) {
          written.accountEmail = existing.accountEmail;
        }
        chosen = written;
        writeConfig(chosen);
        // `migrated` is a `captured` that also dropped the key scoping: fresh carries no
        // keyFingerprint (the env held no token) and a login anchor, so the record stops belonging
        // to a key. Named separately because it is the one automatic rewrite worth telling the user
        // about — their plan just changed source, and if the machine guessed wrong the message is
        // what lets them notice and run /beezi:refresh.
        outcome = clearsPlan ? 'cleared' : (keyRevertConfirmed ? 'migrated' : 'captured');
      } else if (existing != null) {
        // Kept: adopt the anchor (v1 grandfathering included) so the NEXT switch is detectable,
        // and stamp the heartbeat. Identity-only write — plan fields and capturedAt untouched.
        // A newly visible accountUuid or accountEmail is identity too and is adopted the same
        // way, so a machine whose plan record is protected forever still gains the identity
        // fields the check-in needs.
        const next = currentAnchor == null ? storedAnchor : currentAnchor;
        const keptAnchor = next == null
          ? (existing.accountAnchor == null ? null : existing.accountAnchor)
          : (sameAnchor(existing.accountAnchor, next) ? existing.accountAnchor : stampAnchor(next, now));
        const keptUuid = resolveAccountUuid(sub, currentAnchor);
        const keptEmail = resolveAccountEmail(sub, currentAnchor);
        // A newly visible fingerprint is adopted on the same terms as the identity fields: it says
        // which key this machine runs, and a record that knows it can no longer be overwritten by a
        // capture that saw no key (see shouldKeepExisting). Never cleared here — an env that stopped
        // exposing the token is not evidence the record stopped belonging to it.
        const keptFingerprint = fingerprintOf(env);
        chosen = {
          ...existing,
          version: BILLING_CONFIG_VERSION,
          accountAnchor: keptAnchor,
          anchorCheckedAt: stampedNow,
          // Stamped even here, where nothing else about the record moved: this is the observation
          // that lets the NEXT session see a flip, and a machine whose plan is protected forever
          // would otherwise never record one.
          envKeyPresent,
          keyFingerprint: keptFingerprint == null
            ? (existing.keyFingerprint == null ? null : existing.keyFingerprint)
            : keptFingerprint,
          accountUuid: keptUuid == null
            ? (existing.accountUuid == null ? null : existing.accountUuid)
            : keptUuid,
          accountEmail: keptEmail == null
            ? (existing.accountEmail == null ? null : existing.accountEmail)
            : keptEmail,
        };
        writeConfig(chosen);
        outcome = sub == null ? 'no-signal' : 'kept';
      } else {
        outcome = 'no-signal';
      }
    }
  } catch { /* best-effort */ }

  let source = BillingSource.UNKNOWN;
  try {
    source = resolveSourceImpl(chosen, env);
    const synced = syncBillingSource(chosen, source, now);
    if (synced) {
      writeConfig(synced);
      chosen = synced;
    }
  } catch { /* best-effort */ }

  // Computed last, so a source realignment counts as the billing change it is. Best-effort like
  // everything else here: a summary that throws must not cost the caller its config.
  let changes = [];
  try { changes = describeBillingChanges(before, chosen); } catch { changes = []; }

  return { config: chosen, source, outcome, changes };
}
