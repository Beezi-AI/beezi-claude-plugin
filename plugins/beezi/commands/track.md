---
description: Manually save Beezi analytics for this session
allowed-tools: Bash(node:*)
---

The line below runs at expansion time, before this message reaches the model — so tracking
still happens when the API itself is down, which is exactly when it's needed.

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/track.mjs`

Do NOT read, open, or inspect any files, and do NOT run the command again. Report the output
above to the user verbatim — the success line, or the error message if this machine is not
linked or the server could not be reached. Never echo any token.
