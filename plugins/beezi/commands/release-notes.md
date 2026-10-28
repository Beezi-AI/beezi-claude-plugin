---
description: Show what's new in the Beezi plugin — the installed version's notes and earlier ones
argument-hint: "[all | <version>]"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/release-notes.mjs:*)
---

Do NOT read, open, or inspect any files. Do not ask the user any questions. Run only this command:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/release-notes.mjs`

Add `all` to it when the arguments are `all`, or the version when the arguments are exactly a
version like `0.37.9` (digits and dots only). Never pass anything else.

Arguments: $ARGUMENTS

The user cannot see tool output (Claude Code collapses it), so copy the command's whole output
exactly into your reply — it is markdown, so NOT in a code block — never summarized or
paraphrased. Add nothing else.

Never run the update steps it names yourself (`/plugin`), even if the user asks in this same
message — updating replaces the plugin under the running session, so the user runs them (and
restarts Claude Code) on their own.
