import { preflightLogin } from '../lib/login-preflight.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';

// Step 0 of /beezi:login: refuse to start the link flow when this session cannot finish it.
// Always exits 0 — the verdict is the printed line, so a failed check reads as "go ahead"
// instead of as a crash the model tries to recover from.
try {
  const { ok, reason, mode, dir, code } = preflightLogin({ env: process.env });
  if (ok) {
    console.log(`✓ Beezi: permission mode ${mode == null ? 'unknown' : mode}, ${dir} is writable — login can run.`);
  } else if (reason === 'auto_mode') {
    console.log('✗ Beezi: auto mode is on — /beezi:login cannot run in it.');
    console.log("  Auto mode's permission classifier denies this plugin's node scripts. The sign-in");
    console.log('  itself is usually allowed, so the link would complete and then stall on the plan');
    console.log('  capture — leaving this machine linked with no plan and no history upload.');
    console.log('  Press Shift+Tab to switch to normal mode, then run /beezi:login again.');
  } else if (reason === 'plan_mode') {
    console.log('✗ Beezi: plan mode is on — /beezi:login cannot run in it.');
    console.log('  Plan mode gates the commands the link is made of, so the browser sign-in and the');
    console.log('  plan capture would be refused partway through and leave this machine half-linked.');
    console.log('  Press Shift+Tab to leave plan mode, then run /beezi:login again.');
  } else {
    console.log(`✗ Beezi: cannot write to ${dir} (${code}) — /beezi:login cannot finish.`);
    console.log('  The link stores its credential and plan there. A sandboxed Bash session only allows');
    console.log('  writes inside the working directory, so they would fail and leave this machine half-linked.');
    console.log('  Run /beezi:login outside the sandbox, or allow writes to that directory, and try again.');
  }
} catch (error) {
  console.log(`✓ Beezi: could not run the login preflight (${friendlyMessage(error)}) — login can run.`);
}
