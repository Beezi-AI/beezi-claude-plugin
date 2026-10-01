import { runLogin } from '../lib/login.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';
import { recordLoginFailure } from '../lib/telemetry-auth.mjs';
import { maybeSpawnCoworkLive } from '../lib/cowork-live.mjs';

// Login is one blocking browser flow. runLogin prints account=<key> last so
// subsequent capture and backfill commands target the account just authenticated.
runLogin().then(() => { maybeSpawnCoworkLive(); }).catch((error) => {
  recordLoginFailure(error == null ? null : error.loginReason);
  console.error(`\n✗ ${friendlyMessage(error)}`);
  process.exit(1);
});
