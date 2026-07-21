---
description: Refresh this machine's Claude subscription/plan for Beezi analytics
allowed-tools: Bash(node:*)
---

Run EXACTLY this one command — do not modify it, do not substitute your own, and
do not read or inspect any files yourself:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/billing-capture.mjs --from-claude --via refresh`

The script reads only the non-secret account info from `~/.claude.json` (never any
token, never the credentials file) and stores the plan. Report its one-line output
verbatim. If it says nothing was captured, tell the user their Claude subscription
info was not found. If the output says the self-reported plan was kept, report
that verbatim to the user.
