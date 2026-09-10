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

// The capture goes FIRST because this process is killed, not waited for. Claude Code re-renders
// on a 300ms debounce and every render aborts the one still in flight — the signal reaches us as
// a SIGTERM to the whole process group. Rendering first meant the capture sat behind the WHOLE
// runtime of the chained command, so a status line slower than the gap between renders (a
// git-heavy monorepo line, anything spawned through npx) lost every observation, silently: the
// wrapped line looked fine and nothing was ever recorded. Capturing first bounds the exposure to
// node's own startup instead of the user's command.
//
// The bookkeeping still cannot blank a status bar: it is one small local write, and every
// failure path below is swallowed so the display runs regardless.
(async () => {
  try {
    const { recordStatuslineUsage } = await import('../lib/statusline-usage.mjs');
    recordStatuslineUsage(raw);
  } catch {
    /* best-effort: the status line's job is to render, not to report */
  }

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
      /* rendering is cosmetic; the capture above already landed */
    }
  }
  // NOT process.exit(): stdout is a pipe here, so a line longer than the pipe buffer is still
  // queued when this line runs and exit() would drop the rest of it. Nothing holds the loop open
  // once the write drains — spawnSync keeps no handle — so a natural exit ends just as promptly.
  process.exitCode = 0;
})();
