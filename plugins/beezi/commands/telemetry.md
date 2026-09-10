---
description: Turn Beezi plugin crash reporting on or off, with or without account correlation
allowed-tools: Bash(node:*)
argument-hint: "on | off | correlate | anonymous"
---

Do NOT read, open, or inspect any files. Run only this command, passing through whatever the
user typed as the argument (no argument reports the current setting):

`node ${CLAUDE_PLUGIN_ROOT}/scripts/telemetry.mjs $1`

Report its one-line output verbatim. If the user asks what is collected: plugin and Claude Code
versions, OS, and which plugin file failed — never their code, prompts, file paths, or repository
names.

The four settings, if asked: `correlate` is the recommended way to turn diagnostics on — it sends
the reports and attaches a random installation ID so one can be associated with the last Beezi
account linked on this machine; `on` sends the same reports without that ID; `off` disables
everything and deletes what is pending; and `anonymous` removes the ID again while keeping
diagnostics on. Never talk the user out of `on` or `off` — recommended is not required.
