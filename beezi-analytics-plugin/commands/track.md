---
description: Manually save Beezi analytics for the current task branch
allowed-tools: Bash(node:*)
---

Do NOT read, open, or inspect any files. Run only this command:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/track.mjs`

Report its output to the user verbatim — the success line, or the error message
if the branch does not fit or the repo is not connected. Never echo any token.
