---
description: Log out one or all Beezi accounts on this machine
allowed-tools: Bash(node:*), AskUserQuestion
---

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/logout.mjs --list` and show the accounts.
If none are linked, stop. With one account, select it directly. With several, ask which
account to log out, including an "All accounts" option. Use account names and workspaces
as labels; the bracketed key is for the command only.

If removing the default while any accounts remain, ask which remaining account should become
the analytics default (when only one remains, use that key). Pass it as `--next-default`.

Run one of:

- `node ${CLAUDE_PLUGIN_ROOT}/scripts/logout.mjs --account <key>`
- `node ${CLAUDE_PLUGIN_ROOT}/scripts/logout.mjs --account <key> --next-default <remaining-key>`
- `node ${CLAUDE_PLUGIN_ROOT}/scripts/logout.mjs --all`

Report output verbatim, including any unconfirmed server unlink. Never echo credentials.
If a question is dismissed, perform no logout.
