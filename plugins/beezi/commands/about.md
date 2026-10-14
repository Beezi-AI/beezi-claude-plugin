---
description: Show the installed Beezi plugin version, whether a newer one is published, when it was last updated, and how to update
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/about.mjs:*)
---

Do NOT read, open, or inspect any files. Do not ask the user any questions. Run only this command:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/about.mjs`

The user cannot see tool output (Claude Code collapses it), so copy the command's whole output
exactly into your reply, in a code block — never summarized or paraphrased. Add nothing else.

Never run the update commands it prints yourself, even if the user asks in this same message —
updating replaces the plugin under the running session, so the user runs them (and restarts Claude
Code) on their own.
