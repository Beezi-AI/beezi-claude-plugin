import { parseArgs, buildConfig, shouldKeepExisting } from '../lib/billing-capture.mjs';
import { readBillingConfig, writeBillingConfig } from '../lib/billing-config.mjs';
import { readClaudeAccount } from '../lib/claude-account.mjs';
import { hasCustomGateway } from '../lib/billing.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';

try {
  const parsed = parseArgs(process.argv.slice(2));

  // --from-claude: read the non-secret oauthAccount from ~/.claude.json ourselves,
  // deterministically. No tokens are read; the model does not supply any values.
  let args = parsed;
  let account = null;
  if (parsed.fromClaude) {
    account = readClaudeAccount();
    if (!account) {
      // The gateway flag rides along here too: a machine that never did a subscription login still
      // needs /beezi:login to ask what its endpoint bills, and this is the only line it will see.
      const note = hasCustomGateway() ? ' gateway=custom' : '';
      console.log(`Beezi: no Claude subscription info found in ~/.claude.json — nothing captured.${note}`);
      process.exit(0);
    }
    args = {
      subscriptionType: account.subscriptionType,
      rateLimitTier: account.rateLimitTier,
      expiresAt: account.expiresAt,
      via: parsed.via,
    };
  }

  const config = buildConfig(args, process.env, new Date(), account);

  if (parsed.fromClaude && shouldKeepExisting(config, readBillingConfig())) {
    console.log('Beezi: Claude account info still does not name a plan — keeping the self-reported plan.');
    process.exit(0);
  }

  writeBillingConfig(config);
  // A custom endpoint is reported as a fact, not a conclusion: whether it bills this machine's
  // subscription or its own credits is the one thing only the user can say, and /beezi:login reads
  // this flag to know it has to ask.
  const gateway = hasCustomGateway() ? ' gateway=custom' : '';
  console.log(`✓ Beezi billing captured: source=${config.source} plan=${config.plan == null ? 'n/a' : config.plan}${gateway}.`);
} catch (error) {
  console.error(`✗ ${friendlyMessage(error)}`);
  process.exit(1);
}
