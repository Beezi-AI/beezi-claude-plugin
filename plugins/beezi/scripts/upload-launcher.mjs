import path from 'path';
import { fileURLToPath } from 'url';
import { spawnDetached } from '../lib/background-spawn.mjs';

// The first of two hops. A hook starts this launcher detached; the launcher starts the worker
// detached and ends at once. Claude Code kills a timed-out hook's process tree by parent PID, and
// a detached child still dies with it while its parent is alive. By the time any kill can arrive
// this launcher is gone, so the worker's parent-PID chain no longer leads back to the hook.
//
// Deliberately tiny: only path, url and spawnDetached are imported, so the launcher is out of the
// way in milliseconds. It never forces its own exit (see lib/shutdown.mjs for the Windows
// UV_HANDLE_CLOSING abort): spawnDetached ignores the child's stdio and unrefs it, so nothing
// holds the event loop and the module simply ends.
if (process.env.BEEZI_TEST_NO_SPAWN !== '1') {
  spawnDetached(path.join(path.dirname(fileURLToPath(import.meta.url)), 'upload-worker.mjs'));
}
