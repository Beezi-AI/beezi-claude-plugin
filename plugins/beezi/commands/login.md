---
description: Link this machine to Beezi analytics (browser sign-in with your Beezi account)
allowed-tools: Bash(node:*), AskUserQuestion
---

Do NOT read, open, or inspect any files yourself. Run only the given commands.

Step 0 — preflight FIRST, before anything else. Run EXACTLY:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/login-preflight.mjs`

It checks the three things that make the link fail halfway: plan mode, auto mode (its
permission classifier denies this plugin's node scripts), and a state directory this
session cannot write to (a sandboxed Bash session only allows writes inside the working
directory).

If its output starts with `✗`, STOP: show those lines to the user verbatim and run no
other command — not the sign-in, not the plan capture, not the backfill. A flow that dies
partway leaves this machine half-linked.

If this command does not run at all — denied by the permission classifier, or blocked by
plan mode — that IS the answer, and the same rule applies: STOP. Do not retry it, do not
try PowerShell or another shell, do not run any later step. Tell the user their session's
permission mode is gating the plugin's scripts, that they should press Shift+Tab to switch
to normal mode, and run /beezi:login again.

If its output starts with `✓`, continue to Step 1.

Step 1 — sign in (opens the browser; blocks until the sign-in completes):

`node ${CLAUDE_PLUGIN_ROOT}/scripts/login.mjs`

The command opens the user's browser to Beezi's sign-in page and finishes by
itself once they approve there. Show the user the command's output. If it says
the machine is **already linked**, tell the user — then still continue with
Step 2 below, so a user whose subscription tier changed can still refresh it.
Never echo any token or credential.

If the sign-in fails with a network or connection error, do NOT retry and do NOT continue
to Step 2. The preflight only proves this session can write files, not that it can reach
the network — a sandboxed session with filesystem isolation off still blocks outbound
requests. Tell the user the sign-in could not reach Beezi, that a sandboxed session may be
network-isolated, and to run /beezi:login outside the sandbox. Capturing a plan for a
machine that never linked is worse than stopping.

A failed sign-in never removes an existing Beezi authorization: the previous one stays on
the machine until a new one has been stored. If the output says the machine's saved
authorization needs consent again, or that the previous authorization is untouched, relay
that verbatim — do not tell the user they have been logged out.

Step 2 — capture the subscription plan for analytics (run this after a
successful Step 1 link, OR when Step 1 reported the machine was already
linked). Run EXACTLY this one command, unmodified:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/billing-capture.mjs --from-claude --via login`

It asks Claude Code itself for the non-secret subscription info (`claude auth
status`) and reads the non-secret account metadata from `~/.claude.json` — never
any token, never the credentials file. Report its one-line summary. If it could not resolve the plan, continue to Step 3.

Step 3s — is this machine's plan Step 2's to know? ALWAYS run this, before
anything in Step 3, whatever Step 2 printed. Run EXACTLY:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/key-resolve.mjs status`

It prints exactly one JSON object and answers the question by itself — nothing
about Step 2's output needs interpreting for it.

- `status` is `"no_key"` → this machine does not sign in with a Claude setup
  token, so Step 2 read its real plan. Say nothing about this command and
  continue to Step 3 below as normal.
- anything else → this machine signs in with `CLAUDE_CODE_OAUTH_TOKEN`. Claude
  Code writes no account metadata under that auth mode, so a plan Step 2 printed
  is a previous login's leftovers, not this machine's plan — accepting it
  silently is how a wrong plan gets reported for months. Do not ask the tier
  question either: the answer lives on the server, not with the user. Follow
  `/beezi:refresh`'s Step 1 dispatch table on the JSON you just printed,
  including its questions where that table asks them, then skip to Step 3b.
  Do not run Step 3, 3a or 3c for this machine.

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

Step 3d — crash diagnostics (after Step 3b, before Step 4; both fresh links and
already-linked machines). Ask the user ONE yes/no question: let Beezi collect
anonymous crash reports about the plugin itself? Explain in one sentence: it
sends only plugin and Claude Code versions, the OS, and which plugin file
failed — never their code, prompts, file paths, or repository names — and it
helps fix bugs that would otherwise go unseen. If they agree, run EXACTLY:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/telemetry.mjs on`

If they decline, run EXACTLY:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/telemetry.mjs off`

so the machine is not asked again at session start. Report its one-line output.

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
