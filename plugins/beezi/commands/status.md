---
description: Show your Beezi sign-in, workspace, where this folder's analytics go, plan, and the plugin version with how to update it
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs:*)
---

Do NOT read, open, or inspect any files. Do not ask the user any questions. Run only this command:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs`

The user cannot see tool output (Claude Code collapses it), so copy the command's whole output
exactly into your reply, in a code block — never summarized or paraphrased. Add nothing else.

Never run the commands it names yourself (/beezi:login, /plugin, /beezi:settings) — the user runs
them when they want to. Never run the update commands it prints either, even if the user asks in
this same message — updating replaces the plugin under the running session, so the user runs them
(and restarts Claude Code) on their own.
