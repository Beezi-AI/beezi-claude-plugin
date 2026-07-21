import { parseArgs, buildConfig, shouldKeepExisting } from '../lib/billing-capture.mjs';
import { readBillingConfig, writeBillingConfig } from '../lib/billing-config.mjs';
import { readClaudeAccount } from '../lib/claude-account.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';

try {
  const parsed = parseArgs(process.argv.slice(2));

  // --from-claude: read the non-secret oauthAccount from ~/.claude.json ourselves,
  // deterministically. No tokens are read; the model does not supply any values.
  let args = parsed;
  if (parsed.fromClaude) {
    const account = readClaudeAccount();
    if (!account) {
      console.log('Beezi: no Claude subscription info found in ~/.claude.json — nothing captured.');
      process.exit(0);
    }
    args = {
      subscriptionType: account.subscriptionType,
      rateLimitTier: account.rateLimitTier,
      expiresAt: account.expiresAt,
      via: parsed.via,
    };
  }

  const config = buildConfig(args);

  if (parsed.fromClaude && shouldKeepExisting(config, readBillingConfig())) {
    console.log('Beezi: Claude account info still does not name a plan — keeping the self-reported plan.');
    process.exit(0);
  }

  writeBillingConfig(config);
  console.log(`✓ Beezi billing captured: source=${config.source} plan=${config.plan ?? 'n/a'}.`);
} catch (error) {
  console.error(`✗ ${friendlyMessage(error)}`);
  process.exit(1);
}
