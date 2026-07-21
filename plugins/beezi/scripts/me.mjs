import { getAccessToken } from '../lib/token.mjs';
import { whoami } from '../lib/whoami.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';

async function main() {
  const token = await getAccessToken().catch(() => null);
  if (!token) {
    console.log('Beezi: this machine is not linked. Run /beezi:login to link it.');
    return;
  }

  const who = await whoami(token);
  if (who === null) {
    console.log('Beezi: could not reach the server to check your link. Check your connection and try again.');
    return;
  }
  if (!who.valid) {
    console.log('Beezi: this machine’s link was revoked. Run /beezi:login to re-link.');
    return;
  }

  console.log('✓ Beezi: this machine is linked.');
  if (who.name) console.log(`  Account: ${who.name}${who.email ? ` <${who.email}>` : ''}`);
  else if (who.email) console.log(`  Account: ${who.email}`);
}

main().catch((error) => {
  console.error(`\n✗ ${friendlyMessage(error)}`);
  process.exit(1);
});
