---
description: Unlink this machine from Beezi analytics (sign out)
allowed-tools: Bash(node:*)
---

Do NOT read, open, or inspect any files. Run only this command:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/logout.mjs`

Report its output verbatim. It distinguishes a confirmed server unlink from a local-only
one, and it fails rather than claim a logout it did not perform — if it reports an error,
the machine is still linked. Never echo any token.
