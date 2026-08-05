---
description: Link this machine to Beezi analytics (browser sign-in with your Beezi account)
allowed-tools: Bash(node:*), AskUserQuestion
---

Do NOT read, open, or inspect any files yourself. Run only the given commands.

Step 1 — sign in (opens the browser; blocks until the sign-in completes):

`node ${CLAUDE_PLUGIN_ROOT}/scripts/login.mjs`

The command opens the user's browser to Beezi's sign-in page and finishes by
itself once they approve there. Show the user the command's output. If it says
the machine is **already linked**, tell the user — then still continue with
Step 2 below, so a user whose subscription tier changed can still refresh it.
Never echo any token or credential.

Step 2 — capture the subscription plan for analytics (run this after a
successful Step 1 link, OR when Step 1 reported the machine was already
linked). Run EXACTLY this one command, unmodified:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/billing-capture.mjs --from-claude --via login`

It reads only the non-secret account info from `~/.claude.json`. Report its
one-line summary. If it could not resolve the plan, continue to Step 3.

Step 3 — ask the user their tier (ONLY when Step 2 printed
`no Claude subscription info found`, `plan=unknown`, or
`keeping the self-reported plan`; skip this step entirely when Step 2 printed
a known plan, or when its output shows `source=anthropic_api_key` or
`source=third_party` — those machines do not bill a subscription, so a tier
question does not apply).

Ask with the AskUserQuestion tool: "How does this machine pay for Claude?"
with exactly these options: "Pro", "Max 5x", "Max 20x", "Team or Enterprise",
"I use an API key (no subscription)". If they pick "Team or Enterprise", ask one
follow-up question with options "Team" and "Enterprise".

The API-key option matters: without it a machine paying per-token gets pinned to
a subscription tier, and its spend and errors are then reported under that plan.

Map the final answer through this table — no other values are valid:

| Answer                | value        |
| --------------------- | ------------ |
| Pro                   | `pro`        |
| Max 5x                | `max_5x`     |
| Max 20x               | `max_20x`    |
| Team                  | `team`       |
| Enterprise            | `enterprise` |
| I use an API key      | `api_key`    |

Then run EXACTLY this command, substituting only `<value>`:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/billing-capture.mjs --plan <value> --via login-user`

Report its one-line summary. If the user dismisses the question or answers
something not in the table, skip the capture — the link itself already
succeeded, say so.
