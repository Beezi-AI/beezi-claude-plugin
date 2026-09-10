---
description: Refresh this machine's Claude subscription/plan for Beezi analytics
allowed-tools: Bash(node:*), AskUserQuestion
---

Two steps, in this order. Step 1 always runs and decides the rest: on a machine
signing in with a Claude setup token it is the whole command, and Step 2 must not
run. Step 2 runs only for the machines Step 1 explicitly sends there.

Do not read or inspect any files yourself, and never echo a token.

## Step 1 — ask the server about the setup token, if there is one

A machine signing in with `CLAUDE_CODE_OAUTH_TOKEN` cannot prove its plan
locally: Claude Code writes no account metadata under that auth mode, so anything
a local capture finds on such a machine is a previous login's leftovers. Only the
server knows whether that key has been given a subscription — which is why this
question is asked FIRST, before anything local is read or reported. Presenting a
leftover plan as this machine's plan and only then discovering it cannot be
trusted is the exact mistake this ordering exists to prevent.

Run:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/key-resolve.mjs status`

It prints exactly one JSON object. Read `status` from it and do exactly this:

| `status`                          | What to do                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| `"resolved"`                      | Say the key's subscription is known, naming `subscriptionPlan`, and that it is now what Beezi reports for this machine. **Then, only if `accountAnchored` is `true` AND `planSource` is `"reported"`**, add that this plan comes from a subscription an earlier sign-in established rather than one confirmed for this key — name `accountEmail` when it is not null — and that re-pointing it is an admin's job, not something this command can do. **Stop — do not run Step 2.** |
| `"unknown_key"`                   | The command already tried to register this key and ask again; reaching this row means that did not work. Say Beezi could not register this key with the server yet and to try `/beezi:refresh` again later. **Stop — do not run Step 2.** |
| `"unlinked"`                      | Continue to Step 1a — this is the case worth asking about.                                   |
| `"unavailable"`                   | Report the object's `message` verbatim. **Stop — do not run Step 2.**                        |
| `"no_key"` / `"not_linked"`       | Report the object's `message` verbatim, then continue to Step 2. `"no_key"` means this machine is not on a setup token at all, so the local capture is the right answer for it. |
| `null` (a JSON null, not a string) | The server answered something this plugin does not understand, so the key's subscription cannot be resolved right now. Say exactly that and suggest trying again later. **Stop — do not run Step 2.** |

Whichever row you land on, never state a subscription plan that did not come out
of this JSON object.

### 1a — how do they want to resolve it

Ask with the AskUserQuestion tool: "Beezi does not know which subscription this
machine's Claude setup token bills. How do you want to resolve it?"

Build the options from the JSON you just read — do not invent them:

- "Use one of my subscriptions" — include this option **only if**
  `subscriptions` is a non-empty array.
- "Name the plan" — always include.
- "Enter an email or account id" — always include.

### 1b — the follow-up, by what they picked

**Picked "Use one of my subscriptions".** Ask a second question, "Which
subscription does this machine bill?", with one option per entry in
`subscriptions`, using that entry's `label` as the option label. Then run, with
the chosen entry's `target` substituted verbatim:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/key-resolve.mjs --target <target>`

**Picked "Name the plan".** Ask a second question, "Which plan is this
subscription on?", with one option per entry in `selectablePlans`, using that
entry's `label` as the option label. Then run, with the chosen entry's `plan`
value (not its label) substituted verbatim:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/key-resolve.mjs --plan <plan>`

**Picked "Enter an email or account id".** Do not ask a multiple-choice question
— wait for the user to type the value in their next message, then run:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/key-resolve.mjs --target <value>`

### 1c — report the result

Run the resolve command EXACTLY ONCE, then print its one line verbatim. The two
link outcomes are different events and the wording already distinguishes them —
joining an existing subscription is not the same as the key standing on its own,
so do not paraphrase them into one sentence.

If the user dismisses a question, or answers something that is not one of the
options you offered, skip the resolve command entirely and say the key was left
unresolved, so this machine’s usage is still reported without a plan. Do not fall
back to Step 2 to fill the gap — a local capture on a setup-token machine reads a
previous login’s leftovers, which is what left the plan wrong in the first place.

A resolve command that succeeds records what the server named, so the next session
report carries it. `--plan` always names a plan. `--target` names one only when the
server reports the joined subscription's plan; when it does not, the next session
start fills it in from the resolution. Either way nothing else needs running.

## Step 2 — capture what a non-setup-token machine can prove

Only for the two rows in Step 1 that send you here (`"no_key"` and
`"not_linked"`). Run EXACTLY this one command — do not modify it and do not
substitute your own:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/billing-capture.mjs --from-claude --via refresh`

The script asks Claude Code itself for the non-secret subscription info
(`claude auth status`) and reads the non-secret account metadata from
`~/.claude.json` (never any token, never the credentials file), then stores the
plan. Report its one-line output verbatim.

If it says nothing was captured, tell the user their Claude subscription info was
not found. If the output says the self-reported plan was kept, report that
verbatim. If the output contains `gateway=custom`, tell the user this machine goes
through a custom API endpoint, so only they can say what it bills — point them at
`/beezi:login`, which asks.
