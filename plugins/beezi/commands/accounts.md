---
description: List the Beezi accounts linked on this machine and pick which one /beezi:analytics reads from
allowed-tools: Bash(node:*), AskUserQuestion
---

Do NOT read, open, or inspect any files. Never echo any token.

Step 1 — list. Run EXACTLY:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/accounts.mjs list`

Show the lines to the user without the trailing `key=…` part.

- Not linked → tell the user to run /beezi:login and stop.
- Exactly one account marked revoked (including `[default, revoked]`) → say its authorization was revoked, direct the user to /beezi:login as that account, and stop.
- Exactly one account that is linked → say it is the only linked account and already the default; stop.
- Several → continue.

Step 2 — ask with the AskUserQuestion tool: "Which account should /beezi:analytics read
from?" with one option per listed account (label = the account text before `key=` with any
`[…]` flags removed; put "current default" in the option description for the flagged one).
Skip every account whose flags contain `revoked` (including `[default, revoked]`). If no account is selectable (all are revoked), say so and
stop.

Step 3 — run EXACTLY, with the chosen account's key:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/accounts.mjs use <key>`

Report its output verbatim. Session tracking goes to every linked account regardless of the
default; to remove an account use /beezi:logout.
