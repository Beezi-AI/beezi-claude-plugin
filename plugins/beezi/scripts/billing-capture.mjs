import { parseArgs, buildConfig, reconcileBillingConfig } from '../lib/billing-capture.mjs';
import { writeBillingConfig } from '../lib/billing-config.mjs';
import { readClaudeAccount, readClaudeAccountAnchor } from '../lib/claude-account.mjs';
import { hasCustomGateway } from '../lib/billing.mjs';
import { defaultSession, sessionFor } from '../lib/sessions.mjs';
import { parseAccountFlag, getAccount, getDefaultKey } from '../lib/accounts.mjs';
import { parseCommandTargets, parseTenantFlags } from '../lib/workspace.mjs';
import { syncAccountIfNeeded } from '../lib/account-sync.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';
import { oauthTokenEnvWithOsProbe } from '../lib/claude-settings-env.mjs';

// Report the freshly reconciled account to the portal. Forced — the user just asked for a re-read,
// and an account switch is exactly what must not wait for the hash to drift. Silent throughout: an
// unlinked machine has no token and this script must keep working offline, so nothing here can
// change the command's output or its exit code.
async function reportAccount(account, tenantIds) {
  let token = null;
  try { token = account ? await sessionFor(account) : await defaultSession(); } catch { token = null; }
  if (!token) return;
  // One check-in per target workspace, in turn: each writes its own marker in the same file.
  for (const tenantId of tenantIds) {
    // Interactive command, so the token resolution runs the full chain — process.env → user
    // settings file → persistent OS environment. Claude Code deletes CLAUDE_CODE_OAUTH_TOKEN from
    // every child environment it builds, so nothing cheaper can see a setup token from here.
    try {
      await syncAccountIfNeeded(
        { ...token, tenantId },
        { force: true, via: 'billing-capture' },
        { env: oauthTokenEnvWithOsProbe(process.env) },
      );
    } catch { /* best-effort */ }
  }
}

// The session's target workspaces; none while its ask is unanswered, so only the local capture runs.
function captureTargets(rest, row) {
  try {
    return parseCommandTargets(rest, row);
  } catch (error) {
    if (error == null || error.workspaceRequired !== true) throw error;
    return { argv: parseTenantFlags(rest, row).argv, tenantIds: [] };
  }
}

async function run() {
  const { account: beeziAccount, rest } = await parseAccountFlag(process.argv.slice(2));
  // Offline or unlinked still works: no row means no tenant, and --tenant then says why.
  let row = null;
  try { row = await getAccount(beeziAccount || await getDefaultKey()); } catch { row = null; }
  const { argv, tenantIds } = captureTargets(rest, row);
  const parsed = parseArgs(argv);
  // A custom endpoint is reported as a fact, not a conclusion: whether it bills this machine's
  // subscription or its own credits is the one thing only the user can say, and /beezi:login reads
  // this flag to know it has to ask.
  const gateway = hasCustomGateway() ? ' gateway=custom' : '';

  if (parsed.fromClaude) {
    // The same self-healing capture the SessionStart hook runs, forced: ask Claude Code itself
    // (`claude auth status --json`), merge the non-secret oauthAccount metadata, detect an account
    // switch, protect a still-valid self-reported plan, stamp the anchor + heartbeat. No token or
    // credentials file is ever read; the model does not supply any values.
    // Same probing env as the check-in above (cached per process, so this costs nothing extra):
    // the reconcile decides the billing SOURCE, and on a setup-token machine that verdict is
    // exactly what an un-probed process.env gets wrong.
    const { config, outcome } = reconcileBillingConfig(
      { env: oauthTokenEnvWithOsProbe(process.env) },
      { force: true, via: parsed.via },
    );
    if (outcome === 'no-signal' || config == null) {
      // A machine that never did a subscription login still needs /beezi:login to ask what its
      // endpoint bills, and this is the only line it will see.
      console.log(`Beezi: no Claude subscription info found on this machine — nothing captured.${gateway}`);
    } else if (outcome === 'kept') {
      // Name the plan we actually kept. `kept` protects two different things — a plan the user
      // declared, and one the Beezi server resolved for this key — and calling the second
      // "self-reported" tells the user their answer is being used when the portal's is.
      const kept = config.planSource === 'key_resolution'
        ? 'the plan Beezi resolved for this machine’s setup token'
        : 'the self-reported plan';
      console.log(`Beezi: Claude account info still does not name a plan — keeping ${kept}.`);
    } else {
      const via = config.detectedVia == null ? '' : ` via=${config.detectedVia.replace(/_/g, '-')}`;
      const switched = outcome === 'switched' ? ' account=changed' : '';
      console.log(`✓ Beezi billing captured: source=${config.source} plan=${config.plan == null ? 'n/a' : config.plan}${via}${switched}${gateway}.`);
    }
    // After the reconcile, so the check-in carries the account this run just resolved.
    await reportAccount(beeziAccount, tenantIds);
  } else {
    // Self-report (--plan) or raw-field capture: the user's answer always writes. The cheap file
    // anchor rides along so a later account switch can invalidate this testimony; the CLI is not
    // spawned here — the next session-start heartbeat upgrades the anchor to the email one.
    let anchor = null;
    try { anchor = readClaudeAccountAnchor(); } catch { anchor = null; }
    // --plan only, identity only: that buildConfig branch reads the account purely through the
    // uuid/email resolvers, so the self-report's check-in can present both identity fields
    // without oauthAccount touching the plan the user just declared. The raw-field path stays
    // account-free — there a readable oauthAccount would change the source resolution.
    let account = null;
    if (parsed.plan != null) {
      try { account = readClaudeAccount(); } catch { account = null; }
    }
    const config = buildConfig(parsed, process.env, new Date(), account, anchor);
    writeBillingConfig(config);
    console.log(`✓ Beezi billing captured: source=${config.source} plan=${config.plan == null ? 'n/a' : config.plan}${gateway}.`);
    // The user just declared how this machine pays — that answer is exactly what the check-in
    // exists to carry, so it must not wait for the next session start's hash drift.
    await reportAccount(beeziAccount, tenantIds);
  }
}

run().catch((error) => {
  console.error(`✗ ${friendlyMessage(error)}`);
  process.exit(1);
});
