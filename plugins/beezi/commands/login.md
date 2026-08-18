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

Step 3 — ask the user how this machine pays. Two questions live here; which
ones you ask depends on Step 2's output.

Ask NOTHING and skip to Step 3b when Step 2 printed a known plan (for example
`plan=max_20x`) with no `gateway=custom`, or when its output shows
`source=anthropic_api_key` or `source=third_party` — those machines are already
settled.

Step 3a — the gateway question. Ask this FIRST, and only when Step 2's output
contains `gateway=custom`. This machine sends Claude Code to a custom API
endpoint, and nothing local can tell whether that endpoint forwards the user's
own Claude credential or bills its own. Ask with the AskUserQuestion tool:
"This machine sends Claude Code through a custom API endpoint. What pays for
that usage?" with exactly these options: "My Claude subscription (the endpoint
just forwards it)", "The gateway or provider's own billing", "An Anthropic API
key".

- "The gateway or provider's own billing" → value `gateway`. Final; do not ask
  the tier question.
- "An Anthropic API key" → value `api_key`. Final; do not ask the tier question.
- "My Claude subscription" → continue to Step 3c and use the tier they pick.
  The tier is NOT known from Step 2 on these machines (it prints `plan=n/a`),
  so the tier question always has to be asked here.

Step 3c — the tier question. Ask it when Step 2 printed
`no Claude subscription info found`, `plan=unknown`, or `keeping the
self-reported plan` and there was no `gateway=custom`; or when Step 3a was asked
and the user answered "My Claude subscription".

Ask with the AskUserQuestion tool: "How does this machine pay for Claude?"
with exactly these options: "Pro", "Max 5x", "Max 20x", "Team or Enterprise",
"I use an API key (no subscription)". If they pick "Team or Enterprise", ask one
follow-up question with options "Team" and "Enterprise". Omit the API-key option
when you are here from Step 3a — they have already ruled it out.

The API-key option matters: without it a machine paying per-token gets pinned to
a subscription tier, and its spend and errors are then reported under that plan.

Map the final answer through this table — no other values are valid:

| Answer                                | value        |
| ------------------------------------- | ------------ |
| Pro                                   | `pro`        |
| Max 5x                                | `max_5x`     |
| Max 20x                               | `max_20x`    |
| Team                                  | `team`       |
| Enterprise                            | `enterprise` |
| I use an API key                      | `api_key`    |
| The gateway or provider's own billing | `gateway`    |

Run the capture EXACTLY ONCE, with the single value the questions above landed
on, substituting only `<value>`:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/billing-capture.mjs --plan <value> --via login-user`

Report its one-line summary. If the user dismisses a question or answers
something not in the table, skip the capture — the link itself already
succeeded, say so.

Step 3b — live usage status line (after Step 3, before Step 4; both fresh
links and already-linked machines). Ask the user ONE
yes/no question: enable Beezi's live usage capture by wrapping their status
line? Explain in one sentence: it records the plan-usage numbers Claude Code
already computes for the status line — no extra requests — and any status line
they already have keeps rendering unchanged (or a minimal default appears if
they have none). If they agree, run EXACTLY:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/statusline-install.mjs`

Report its one-line output; if the status line does not change right away it
applies on the next Claude Code session. If they decline, skip silently —
usage is still captured from Claude Code's cache, just less often. To undo it
later they can re-run this script with `--uninstall`.

Step 4 — upload past sessions (ALWAYS run this last, after Steps 2/3/3b, on both
fresh links and already-linked machines). Run EXACTLY this one command:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/backfill.mjs --via login`

It is the one-time upload of this machine's Claude Code history into Beezi and
can take several minutes; it prints progress lines as it goes. Report its
output verbatim — progress and final summary, or the error line. It is safe on
every login: already-uploaded sessions are skipped, and if it says nothing new
to upload, just tell the user their history is up to date. If some sessions
could not be delivered, tell the user that re-running /beezi:login later will
resume the upload where it left off. Never echo any token.

If it reports the one-time import **has already been used**, that is final —
the import is once per account and cannot be re-run. Do NOT retry, do NOT run
the script again with different flags, and refuse politely if the user asks
you to bypass it; relay the script's message (including the upgrade suggestion
when it prints one) and stop.

Note for the user, only when Step 4 reports the pull finalized: the pull is
one-time per account and tool — if they have Claude Code history on other
machines, they should run /beezi:login there BEFORE it finalizes; a finalized
pull cannot be re-opened.
