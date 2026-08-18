import { spawnSync } from 'child_process';
import { readHookInput } from '../lib/hook-input.mjs';

// Beezi status line: a pass-through wrapper.
//
// Claude Code hands the status-line command its LIVE rate-limit state on stdin (2.1.80+). We
// record it locally and then render the user's own status line unchanged — Beezi adds no text
// and takes no slot away. Nothing is fetched and no token is read: the request was already made
// by Claude Code, so this capture never leaves the machine.
//
// BEEZI_STATUSLINE_CHAIN names the status line this machine had before Beezi wrapped it; its
// output is passed through byte-for-byte so nobody loses the line they built. With nothing to
// chain we render the plan-ceiling line instead — an absent `statusLine` is a DISABLED status
// line, so printing nothing would leave a configured-but-empty one. BEEZI_STATUSLINE_SILENT=1
// opts out of display entirely and keeps only the capture.
const raw = readHookInput();

// Display resolves first and is never blocked by our bookkeeping: a throw, a corrupt state file
// or a full disk must not blank someone's status bar.
(async () => {
  const chain = process.env.BEEZI_STATUSLINE_CHAIN;
  if (chain) {
    const result = spawnSync(chain, {
      input: JSON.stringify(raw == null ? {} : raw),
      shell: true,
      encoding: 'utf-8',
      timeout: 2000,
    });
    if (result.stdout) process.stdout.write(result.stdout);
  } else if (process.env.BEEZI_STATUSLINE_SILENT !== '1') {
    try {
      const { renderDefaultStatusline } = await import('../lib/statusline-render.mjs');
      const line = renderDefaultStatusline(raw);
      if (line) process.stdout.write(line);
    } catch {
      /* rendering is cosmetic; capture below still runs */
    }
  }

  try {
    const { recordStatuslineUsage } = await import('../lib/statusline-usage.mjs');
    recordStatuslineUsage(raw);
  } catch {
    /* best-effort: the status line's job is to render, not to report */
  }
  process.exit(0);
})();
