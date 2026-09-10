---
description: Upload past Claude Code sessions to Beezi analytics, skipping ones already uploaded
allowed-tools: Bash(node:*)
---

Run EXACTLY this one command — do not modify it, do not add flags, and do not read
or inspect any files yourself:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/sync.mjs`

Report its output verbatim. Never echo any token.

The script uploads every past session still on this machine that Beezi does not
already have. It asks the server how far each session already reaches and resumes
from exactly there, so it is safe to run as often as the user likes — a repeat run
uploads nothing and reports that everything is up to date.

Notes for interpreting the output:

- "everything is already uploaded" is a success, not a failure — it means Beezi is
  in sync. Do not re-run the command or suggest flags to force it.
- If it says this machine is not linked, point the user at `/beezi:login`.
- If it says the portal does not support `/beezi:sync` yet, the workspace's Beezi
  server needs updating — the user's history is not lost, and the command will work
  after the update.
- Sessions "still active" are open in another window; they upload on their own once
  they settle. Do not offer to force them.
