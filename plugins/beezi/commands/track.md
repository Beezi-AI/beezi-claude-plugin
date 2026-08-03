---
description: Manually save Beezi analytics for this session
allowed-tools: Bash(node:*)
---

The Beezi plugin saves this session's analytics the moment /beezi:track is submitted — a
prompt hook runs the checkpoint and shows its result to the user as a system message, before
and independent of this message.

If a "Beezi:" result line is visible above, reply with one short sentence confirming it —
do NOT run any commands or read any files.

Only if no "Beezi:" result line appeared (the hook did not run), run
`node ${CLAUDE_PLUGIN_ROOT}/scripts/track.mjs` and report its output verbatim.
Never echo any token.
