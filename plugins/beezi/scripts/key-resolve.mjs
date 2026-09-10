import { getAccessToken } from '../lib/token.mjs';
import {
  fetchKeyResolution,
  submitKeyPlan,
  submitKeyLink,
  formatLinkOutcome,
} from '../lib/key-resolution.mjs';
import {
  recordResolvedKeyPlan,
  recordResolvedKeyData,
  resolvedKeyDataFrom,
  submittedPlanFrom,
} from '../lib/plan-writeback.mjs';
import { hasOauthTokenIdentity } from '../lib/oauth-identity.mjs';
import { oauthTokenEnvWithOsProbe } from '../lib/claude-settings-env.mjs';
import { reconcileBillingConfig } from '../lib/billing-capture.mjs';
import { syncAccountIfNeeded } from '../lib/account-sync.mjs';
import { clearOauthKeyStatus } from '../lib/oauth-key-status.mjs';
import { UserError, friendlyMessage } from '../lib/friendly-error.mjs';

// Thin entrypoint for the interactive key-resolution flow in /beezi:refresh.
//
// `status` prints exactly ONE JSON object on stdout — on every path, including the failures. The
// model parses it and turns selectablePlans / subscriptions into AskUserQuestion options, so a
// human sentence printed to stdout instead would break the parse; the sentence rides inside the
// object's `message` instead. The two write subcommands are for a human to read and print one
// line each.
//
// Nothing here ever prints the setup token. Only its fingerprint (prefix / last4 / length) exists
// on this side of lib/key-resolution.mjs at all.
//
// Every path that ends with the server naming a plan for THIS key also writes that plan into
// billing.json (lib/plan-writeback.mjs). Without it the resolution stayed portal-side and every
// session report kept shipping whatever a previous interactive login left on disk. The write is
// best-effort and never speaks: the sentence the user reads is about the resolution, not about a
// local file, and a failed write is corrected by the next session start asking the portal again.

// Two modes in one invocation is a malformed call, not a preference. The model generates these,
// and last-wins would quietly perform one of the two writes it was asked for.
function setMode(out, mode) {
  if (out.mode != null && out.mode !== mode) {
    throw new UserError('Pick one: status, --plan <plan>, or --target <email-or-account-id> — not several at once.');
  }
  out.mode = mode;
}

export function parseArgs(argv) {
  const out = { mode: null, plan: null, target: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === 'status') setMode(out, 'status');
    else if (arg === '--plan') { setMode(out, 'plan'); out.plan = argv[++i]; }
    else if (arg === '--target') { setMode(out, 'link'); out.target = argv[++i]; }
    else throw new UserError(`Unknown argument "${arg}". Usage: key-resolve.mjs status | --plan <plan> | --target <email-or-account-id>`);
  }
  if (out.mode == null) {
    throw new UserError('Nothing to do. Usage: key-resolve.mjs status | --plan <plan> | --target <email-or-account-id>');
  }
  if (out.mode === 'plan' && (out.plan == null || out.plan === '')) throw new UserError('--plan needs a plan value.');
  if (out.mode === 'link' && (out.target == null || out.target === '')) {
    throw new UserError('--target needs an email address or an account id.');
  }
  return out;
}

function emit(object) {
  console.log(JSON.stringify(object));
}

// The env every call in this file is judged by, in the three places a setup token can live:
//
//   1. process.env — where it is in a session Claude Code did not scrub it out of.
//   2. The `env` block of the user's Claude settings.
//   3. The OS-level persistent environment.
//
// All three tiers live in ONE place — oauthTokenEnvWithOsProbe in lib/claude-settings-env.mjs,
// which the SessionStart and checkpoint hooks use as well. A second copy of the chain here would
// drift from theirs the first time either changed.
//
// Step 3 exists because of a verified fact about Claude Code (2.1.251): it deletes
// CLAUDE_CODE_OAUTH_TOKEN from the environment of EVERY subprocess it spawns, this script
// included, on every platform. So "process.env has no token" says nothing about whether the
// machine has one — see lib/os-env-token.mjs for what the probe costs on each platform. Resolving
// it in main() rather than inside runStatus is deliberate: /beezi:refresh is
// several separate processes (status, then --plan or --target), and each of the three lib calls
// re-derives the fingerprint from the env it is given, so a recovery that reached only `status`
// would strand the user's answer on the very next invocation.

async function runStatus(token, env) {
  if (!token) {
    emit({
      ok: false,
      status: 'not_linked',
      message: 'Beezi: this machine is not linked. Run /beezi:login to link it.',
    });
    return;
  }
  // Answered before any request, and with the SAME predicate the fingerprint uses, so the two
  // cannot drift: "there is no key here" and "the portal did not answer" are opposite actions.
  // `env` has already been through all three homes of the token (see main()), so reaching
  // here means the machine genuinely has none — not merely that Claude Code scrubbed it out of
  // this process, which by itself is true of every session.
  if (!hasOauthTokenIdentity(env)) {
    // Deliberately NOT phrased as "you have no setup token". One home of the token stays invisible
    // from here whatever we do: a plain `export CLAUDE_CODE_OAUTH_TOKEN=...` in a shell profile is
    // the documented, most common way to set one, and Claude Code deletes the variable from every
    // subprocess it spawns — this script included — so an exported token that the session is
    // actively authenticating with reaches us as nothing at all. Saying it does not exist would be
    // specifically false for exactly those users, so this names the scrub and the one form we can
    // read instead.
    emit({
      ok: false,
      status: 'no_key',
      message: 'Beezi: no Claude setup token (CLAUDE_CODE_OAUTH_TOKEN) is visible from here. Claude Code removes that variable from every command it runs, so a token exported in your shell profile cannot be seen by this plugin even while your session is using it. If you have one, add it to the "env" block of ~/.claude/settings.json (or set it in your Windows user environment) and run /beezi:refresh again. If you have not set one, there is no key to resolve.',
    });
    return;
  }
  // Clean before asking. If billing.json still describes the interactive login this machine used to
  // run under — or a key it no longer has — the reconcile's auth-mode/rotation detection resets it
  // to hold only what belongs to the key in force. Reused rather than reimplemented: a second
  // cleanup path here would be free to drift from the one the session-start hook runs.
  // A record already scoped to this key is a no-op. Best-effort, like every other reconcile call.
  try { reconcileBillingConfig({ env }, { via: 'refresh' }); } catch { /* best-effort */ }

  let payload = await fetchKeyResolution(token, { env });

  // A key the portal has never seen cannot be resolved: /key-resolution/plan and /link both refuse
  // a fingerprint with no account behind it. Only the account check-in registers one, so run it and
  // ask again rather than telling the user to come back next session — the whole point of them
  // typing this command is that they want it settled now. `force` skips the unchanged-payload gate,
  // which would otherwise send nothing at all on a machine whose payload has not moved.
  if (payload != null && payload.status === 'unknown_key') {
    try {
      await syncAccountIfNeeded(token, { force: true, via: 'refresh' }, { env });
      const reprobed = await fetchKeyResolution(token, { env });
      if (reprobed != null) payload = reprobed;
    } catch { /* best-effort — the unknown_key answer below is still honest */ }
  }

  if (payload == null) {
    // "Could not ask", never "not resolved": a machine that cannot reach the portal must not be
    // told its key is unresolved, because that is not what it observed.
    emit({
      ok: false,
      status: 'unavailable',
      message: 'Beezi: could not reach the server to read this key’s subscription. Check your connection and try again.',
    });
    return;
  }
  // `key` is dropped from the emitted object: the fingerprint has no consumer in the question the
  // model is about to ask, and there is no reason to put last4 into model context on every call.
  // It stays on the lib's return value for callers that do want it.
  const { key, ...rest } = payload;
  emit({ ok: true, ...rest });
  // A key the portal already resolved is an authoritative answer for this machine, not just
  // something to print: adopt it so the reports stop carrying the old login's plan without the user
  // having to answer a question they are about to be told they do not need to answer. The whole
  // payload, not just the plan — the type, tier and account email are equally unknowable locally.
  const resolved = resolvedKeyDataFrom(payload);
  if (resolved != null) recordResolvedKeyData(resolved);
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const token = await getAccessToken().catch(() => null);
  const env = oauthTokenEnvWithOsProbe(process.env);

  if (parsed.mode === 'status') {
    await runStatus(token, env);
    return;
  }

  if (parsed.mode === 'plan') {
    const result = await submitKeyPlan(token, parsed.plan, { env });
    // The server's own wording where it gave one — the user is about to act on it.
    if (!result.ok) throw new UserError(result.message);
    recordResolvedKeyPlan(submittedPlanFrom(result));
    // The cached verdict predates this answer and still says the key needs attention. Left in
    // place it would nudge the user, for up to six hours, to do what they just did.
    clearOauthKeyStatus();
    console.log(`✓ Beezi: this key’s subscription is now recorded as ${result.subscriptionPlan}.`);
    return;
  }

  const result = await submitKeyLink(token, parsed.target, { env });
  if (!result.ok) throw new UserError(result.message);
  // Only when the server named the plan of the subscription this key joined. A server that does not
  // send one leaves submittedPlanFrom null and nothing is written — a link is not a plan, and
  // inventing one would put a tier nobody stated into every report. The next session's adoption
  // fills it from the resolution instead.
  recordResolvedKeyPlan(submittedPlanFrom(result));
  // Same reason as the plan path: the cached verdict is about the world before this link.
  clearOauthKeyStatus();
  console.log(formatLinkOutcome(result));
}

main().catch((error) => {
  console.error(`✗ ${friendlyMessage(error)}`);
  process.exit(1);
});
