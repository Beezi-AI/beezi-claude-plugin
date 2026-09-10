import { runLogin } from '../lib/login.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';
import { recordLoginFailure } from '../lib/telemetry-auth.mjs';

// argv ('start'/'wait') is ignored: the PKCE flow is a single blocking command,
// and a stale two-phase login.md invoking `wait` just re-runs the fast
// already-linked check.
runLogin().catch((error) => {
  recordLoginFailure(error == null ? null : error.loginReason);
  console.error(`\n✗ ${friendlyMessage(error)}`);
  process.exit(1);
});
