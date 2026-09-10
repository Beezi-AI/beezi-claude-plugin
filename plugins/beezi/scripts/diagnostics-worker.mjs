import { suppressRecording } from '../lib/telemetry.mjs';
import { flushDiagnostics } from '../lib/telemetry-flush.mjs';

// Detached entry point. Argv carries nothing: consent, the queue and the backoff all live in
// files this process rereads itself.
//
// Recursion protection, and the reason this does NOT go through runHook: every failure in here
// is a failure of the diagnostics path, and recording it would enqueue a report that the next
// worker fails to deliver in exactly the same way.
suppressRecording(true);

// Belt and braces over the transport's own timeout: a spawn that wedges inside a native call
// never returns to JavaScript, and this process must not outlive the window it claimed.
const watchdog = setTimeout(() => process.exit(0), 30_000);

flushDiagnostics()
  .catch(() => {})
  .then(() => { clearTimeout(watchdog); process.exit(0); });
