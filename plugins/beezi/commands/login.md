---
description: Link a Beezi account to this machine (browser sign-in); repeat to add more accounts
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/accounts.mjs:*), Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/backfill.mjs:*), Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/billing-capture.mjs:*), Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/key-resolve.mjs:*), Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/login-preflight.mjs:*), Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/login.mjs:*), Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs:*), AskUserQuestion
---

Do NOT read, open, or inspect any files yourself. Run only the given commands.

The user cannot see tool output (Claude Code collapses it), so any output you are told to show
or write verbatim is copied exactly into your reply text — never summarized or paraphrased.

AskUserQuestion, everywhere below: at most 4 questions in one call and at most 4 options in one
question; `multiSelect: true` only with 2 or more options. Make one AskUserQuestion call per
message and wait for its answers before the next (two calls in one message show the user only
the last). A dismissed question runs nothing.

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

The command opens the user's browser to Beezi's sign-in page and finishes by itself once they
approve there. Show the user the command's output. Its LAST line is `account=<key>` — remember
that key; every later step passes it as `--account <key>`. Never echo any token or credential.

If it says the machine is **already linked** as that account, tell the user, then still continue
with Step 2 below so a changed subscription tier is refreshed and an interrupted history upload
resumes. If it prints no `account=` line, STOP and show the output.

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

Step 1w — new folders (after a successful Step 1 link, or when Step 1 reported the machine was
already linked). Run EXACTLY, substituting only `<key>` with the key from Step 1:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs new-folders --account <key> --defer-upload`

Its output is for you only. Its last line is
`new-folders=<ask|send|none> set=<yes|no> multi=yes account=<key>` for an account in several
workspaces, or `new-folders=n/a multi=no account=<key>` for one in a single workspace (or whose
workspaces are not known yet). The lines before it include one
`W. <workspace> account=<key> tenant=<id> role=<role>` line per workspace.

Ask only when the last line contains `set=no`; otherwise say nothing about it and go on to this
session's own folder below. Ask (single-select) "Where should analytics go for repos and folders with no rule yet?"
with the options "Ask me (recommended)" (description "Beezi asks once per repo or folder, when a
session starts there"), "Send to…" ("Pick the workspaces that get them") and "Don't send"
("Nothing from a repo or folder with no rule is uploaded").

- "Ask me (recommended)" → run EXACTLY `node ${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs new-folders ask --account <key> --defer-upload`
- "Don't send" → run EXACTLY `node ${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs new-folders none --account <key> --defer-upload`
- "Send to…" → ask (`multiSelect: true`) "Which workspaces should get analytics for repos and
  folders with no rule?", one option per `W.` line: label = the workspace name (the text after
  `W. ` up to ` account=`), description = the line's `role=` value, or "Beezi workspace" when it
  is empty. More than 4 → split them evenly into questions of at most 4
  (5 → 3 + 2), each ending in " (j of k)". Nothing chosen → run nothing. Otherwise run EXACTLY,
  with the chosen lines' `tenant=` values joined by commas:

  `node ${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs new-folders send <ids> --account <key> --defer-upload`

Write the command's first line verbatim. A dismissal runs nothing (the next /beezi:login asks
again).

Then this session's own folder. When the session started before this account was linked, it was
never asked where its analytics go, and under Ask me they would wait. Only when the setting is now
Ask me —
the last line said `new-folders=ask` and no `new-folders send` or `new-folders none` command
succeeded just now — run EXACTLY (its output is for you only):

`node ${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs rules --account <key>`

Its `here:` line is `here: <short> (<label>) → <R<n> | no rule> account=<key> rule=<n|none>
kind=<repo|folder|outside> match=<…>` (no ` (<label>)` when `kind=outside`): `<short>` is the text
after `here: ` up to ` (` or ` →`, `<label>` the text in the parentheses. Only when it has
`rule=none`, ask about it the question Step 4a asks about one `P` line — the same question text
without the "(i of N) " prefix, with the same options built from this output's `W.` lines — then
run EXACTLY, with `<ids>` = the chosen `tenant=` values joined by commas, or `none` when the last
option was chosen (it wins over the others):

`node ${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs rule add --current --account <key> --defer-upload <ids>`

and write its first line verbatim. Nothing chosen or a dismissal runs nothing. Then continue to
Step 2.

Steps 2, 3s and 3 pick their workspace themselves, and Step 4 routes each past session by its own
repo or folder. Pass no `--tenant` anywhere.

Step 2 — capture the subscription plan for analytics (run this after a
successful Step 1 link, OR when Step 1 reported the machine was already
linked). Run EXACTLY this one command, substituting only `<key>` with the key from
Step 1:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/billing-capture.mjs --from-claude --via login --account <key>`

It asks Claude Code itself for the non-secret subscription info (`claude auth
status`) and reads the non-secret account metadata from `~/.claude.json` — never
any token, never the credentials file. Report its one-line summary. If it could not resolve the plan, continue to Step 3.

Step 3s — is this machine's plan Step 2's to know? ALWAYS run this, before
anything in Step 3, whatever Step 2 printed. Run EXACTLY:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/key-resolve.mjs status --account <key>`

It prints exactly one JSON object and answers the question by itself — nothing
about Step 2's output needs interpreting for it.

- `status` is `"no_key"` → this machine does not sign in with a Claude setup
  token, so Step 2 read its real plan. Say nothing about this command and
  continue to Step 3 below as normal.
- `status` is `"not_linked"` → report the object's `message` verbatim, then continue to Step 3
  below as normal.
- anything else → this machine signs in with `CLAUDE_CODE_OAUTH_TOKEN`. Claude
  Code writes no account metadata under that auth mode, so a plan Step 2 printed
  is a previous login's leftovers, not this machine's plan — accepting it
  silently is how a wrong plan gets reported for months. Do not ask the tier
  question either: the answer lives on the server, not with the user. Follow
  the table below on the JSON you just printed, including its questions where
  that table asks them, carrying `--account <key>` from Step 1 on every
  key-resolve command, then skip to Step 4. Do not run Step 3, 3a or 3c for
  this machine.

| `status`                          | What to do                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| `"resolved"`                      | Say the key's subscription is known, naming `subscriptionPlan`, and that it is now what Beezi reports for this machine. **Then, only if `accountAnchored` is `true` AND `planSource` is `"reported"`**, add that this plan comes from a subscription an earlier sign-in established rather than one confirmed for this key — name `accountEmail` when it is not null — and that re-pointing it is an admin's job, not something this command can do. |
| `"unknown_key"`                   | The server does not know this key yet (the command registers it when the read workspace is one this session sends to). Say Beezi could not register this key with the server yet and to try `/beezi:settings refresh` again later. |
| `"unlinked"`                      | Continue to Step 3s-a — this is the case worth asking about.                                 |
| `"unavailable"`                   | Report the object's `message` verbatim.                                                      |
| `"auth_unavailable"`              | Report the object's `message` verbatim. This machine IS linked — the saved login just could not be read this moment (a busy OS credential store, a renewal in flight). Never suggest `/beezi:login`: there is nothing wrong with the link and signing in again fixes nothing. |
| `null` (a JSON null, not a string) | The server answered something this plugin does not understand, so the key's subscription cannot be resolved right now. Say exactly that and suggest trying again later. |

Whichever row you land on, never state a subscription plan that did not come out
of this JSON object.

Step 3s-a — how do they want to resolve it. Ask with the AskUserQuestion tool: "Beezi does not
know which subscription this machine's Claude setup token bills. How do you want to resolve it?"

Build the options from the JSON you just read — do not invent them:

- "Use one of my subscriptions" — include this option **only if**
  `subscriptions` is a non-empty array.
- "Name the plan" — always include.
- "Enter an email or account id" — always include.

Step 3s-b — the follow-up, by what they picked.

**Picked "Use one of my subscriptions".** Ask a second question, "Which
subscription does this machine bill?", with one option per entry in
`subscriptions`, using that entry's `label` as the option label (the list rule
below). Then run, with the chosen entry's `target` substituted verbatim:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/key-resolve.mjs --target <target> --account <key>`

**Picked "Name the plan".** Ask a second question, "Which plan is this
subscription on?", with one option per entry in `selectablePlans`, using that
entry's `label` as the option label (the list rule below). Then run, with the
chosen entry's `plan` value (not its label) substituted verbatim:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/key-resolve.mjs --plan <plan> --account <key>`

The list rule: only the first 4 entries become options. With more than 4, end the question
with " Type another one's name under Other."; the "Other" answer is the entry whose `label`
matches it (ignoring case), and one that matches none is an answer that is not one of the
options.

**Picked "Enter an email or account id".** Do not ask a multiple-choice question
— wait for the user to type the value in their next message, then run:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/key-resolve.mjs --target <value> --account <key>`

Step 3s-c — report the result. Run the resolve command EXACTLY ONCE, then print its one line
verbatim. The two link outcomes are different events and the wording already distinguishes
them — joining an existing subscription is not the same as the key standing on its own, so do
not paraphrase them into one sentence.

If the user dismisses a question, or answers something that is not one of the
options you offered, skip the resolve command entirely and say the key was left
unresolved, so this machine’s usage is still reported without a plan. Do not fall
back to a local capture to fill the gap — a local capture on a setup-token machine reads a
previous login’s leftovers, which is what left the plan wrong in the first place.

A resolve command that succeeds records what the server named, so the next session
report carries it. `--plan` always names a plan. `--target` names one only when the
server reports the joined subscription's plan; when it does not, the next session
start fills it in from the resolution. Either way nothing else needs running.

Step 3 — ask the user how this machine pays. Two questions live here; which
ones you ask depends on Step 2's output.

Ask NOTHING and skip to Step 4 when Step 2 printed a known plan (for example
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
with exactly these options: "Pro", "Max", "Team or Enterprise", "API key (no
subscription)". If they pick "Max", ask one follow-up question with options
"Max 5x" and "Max 20x". If they pick "Team or Enterprise", ask one follow-up
question with options "Team" and "Enterprise". Omit the API-key option when you
are here from Step 3a — they have already ruled it out.

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
| API key (no subscription)             | `api_key`    |
| The gateway or provider's own billing | `gateway`    |

Run the capture EXACTLY ONCE, with the single value the questions above landed
on, substituting only `<value>` and `<key>` (the key from Step 1):

`node ${CLAUDE_PLUGIN_ROOT}/scripts/billing-capture.mjs --plan <value> --via login-user --account <key>`

Report its one-line summary. If the user dismisses a question or answers
something not in the table, skip the capture — the link itself already
succeeded, say so.

Step 4 — upload past sessions (ALWAYS run this after Steps 2/3, on both fresh links and
already-linked accounts; only Step 5 may follow it). Two parts, in order: 4a (new workspaces,
then repos and folders with no rule), then 4b.

Step 4a — new workspaces, then repos and folders with no rule.

First, new workspaces. Run EXACTLY, substituting only `<key>` with the key from Step 1:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs joined --account <key> --defer-upload`

Its output is for you only. For an account that joined a workspace since it was last reviewed on this
machine, it lists every repo and folder with where its analytics go now. Its lines:

- `<email>: you joined <names> — <N> repos or folders to review account=<key> new=<ids>` — starts the
  block; `<names>` names the new workspaces;
- `W. <workspace> account=<key> tenant=<id> new=<yes|no> role=<role>` — one per workspace; `new=yes`
  is one just joined;
- `J<i>. <short> (<full label>), <k> sessions, now: <where> account=<key> kind=<repo|folder> match=<match> now=<ids|none|pending>`
  — one repo or folder (a `J` line). `<where>` is where its analytics go today: workspace names, `not
  tracked`, or `no rule yet`. `J<i>. outside a project, <k> sessions, now: <where> … kind=outside match=outside`
  is one too: sessions in the home folder, `/` or a temp folder;
- `J<i>-command=<command>` — right after its `J` line: the command that adds one new workspace to it,
  ending in a literal `<tenant>`. It is not a `J` line;
- `add-all-command=<command>` — adds the new workspaces to every listed repo and folder that already
  sends somewhere;
- `done-command=<command>` — records that the new workspaces were reviewed, and keeps unpicked repos
  and folders sending where they send now;
- `joined=<total>` — the number of `J` lines, always last.

`joined=0` → nothing to ask; go to "Then, repos and folders with no rule" below.

More than 4 `J` lines → first ask (single-select) "You joined <names>. Where should analytics for these
<N> repos and folders go? Their past sessions will be sent there too." (`<N>` = the number of `J` lines)
with the options "Add <names> to all <N>" (description "Repos you don't track, and ones with no rule
yet, stay as they are"), "Choose repos" ("Pick which repos and folders go to each new workspace") and
"Leave them as they are" ("Nothing changes, and you're not asked about <names> again").

- "Add <names> to all <N>" → run the `add-all-command=` text EXACTLY ONCE.
- "Choose repos" → the per-workspace questions below.
- "Leave them as they are" → run the `done-command=` text EXACTLY ONCE.
- A dismissal → nothing; the next /beezi:login or /beezi:sync asks again.

4 or fewer `J` lines → the per-workspace questions.

Per-workspace questions — for each `W.` line with `new=yes`, in order, ask the `multiSelect: true`
question "Which repos and folders should also send analytics to <name>? Their past sessions will be sent
there too." `<name>` is the `W.` line's text after `W. ` up to ` account=`, and `<tenant>` its `tenant=`
value. Options: one per `J` line, in order — label = `<short>` (the `J` line's text after `J<i>. ` up to
` (` or `,`), description = "Now: <where>" (`<where>` = the text after `now: ` up to ` account=`),
or "No rule yet" when `<where>` is `no rule yet`; then "None of these" LAST (description "Nothing from
these goes to <name>"). So a question lists at most 3 places plus "None of these": more `J` lines → split
them in order into questions of at most 3 places, each ending in " (part j of k)"; that workspace's answer
is all of its parts together. Choosing "None of these" (alone or with places) means no pick from that
question.
At most 4 questions per AskUserQuestion call: more → further calls, one after
another.

For each new workspace, for each `J` line picked for it, run that line's `J<i>-command=` text EXACTLY
ONCE, changing nothing except the final `<tenant>`: that workspace's `tenant=` value (e.g. `t1`). Never
rebuild the command or re-quote its path yourself. A dismissed question runs nothing for its lines.
After every new workspace's questions have been answered ("None of these" is an answer; skipped or
dismissed is not), run the `done-command=` text EXACTLY ONCE; otherwise run no `done-command`, and the
next login or sync asks again. Write each command's first line verbatim.

Then, repos and folders with no rule. Run EXACTLY, substituting only `<key>` with the key
from Step 1:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs routes --account <key> --defer-upload`

Its output is for you only, except the one line named below. It lists repos and folders whose
past sessions have no rule yet (only for an account in several workspaces set to "Ask me" for new
folders). Its lines:

- `<email>: <N> repos or folders have past sessions with no rule (<M> sessions) account=<key>`;
- `W. <workspace> account=<key> tenant=<id> role=<role>` — one per workspace;
- `P<i>. <short> (<full label>), <k> sessions account=<key> kind=<repo|folder> match=<match>` —
  one repo or folder (a `P` line). `P<i>. outside a project, <k> sessions account=<key> kind=outside match=outside`
  is one too: every past session in the home folder, `/` or a temp folder;
- `P<i>-command=<command>` — right after its `P` line: the rule command for it, ending in a
  literal `<tenants>`. It is not a `P` line;
- `all-command=<command>` — the command that gives all of the account's `P` lines the same
  workspaces, ending in a literal `<tenants>`;
- `<n> other past sessions have no recorded folder and are not sent.` (or `1 other past session
  has no recorded folder and is not sent.`) — write this line verbatim, once; there is nothing to
  ask about it;
- `routes=<total>` — the number of `P` lines, always last.

`routes=0` → nothing to ask; go to Step 4b.

More than 4 `P` lines → first ask (single-select) "Where should analytics for these <N> repos and
folders go?" (`<N>` = the number of `P` lines) with the options "Send all <N> to the same
workspaces…" (description "Pick the workspaces once for all of them"), "Choose per repo" ("One
question per repo or folder") and "Skip" ("Nothing from them is sent this time; you're asked
again next time").

- "Send all <N> to the same workspaces…" → ask (`multiSelect: true`) "Which workspaces should get
  analytics for these <N> repos and folders?", one option per `W.` line (label and description as
  below; more than 4 → split evenly into questions of at most 4, each ending in " (j of k)").
  Nothing chosen → run nothing. Otherwise run the `all-command=` text EXACTLY ONCE, changing
  nothing except the final `<tenants>`, which becomes the chosen `tenant=` values joined by commas.
- "Choose per repo" → the per-repo questions below.
- "Skip" or a dismissal → nothing more; go to Step 4b.

4 or fewer `P` lines → the per-repo questions.

Per-repo questions — one `multiSelect: true` question per `P` line, numbered across the `P` lines
(`i` from 1, `N` = their number). `<short>` is the `P` line's text after `P<i>. ` up to ` (` or
`,`, and `<label>` the text in the parentheses after it. The question and its last option follow
the line's `kind=`:

| `kind=`   | Question                                                                        | Last option               |
| --------- | ------------------------------------------------------------------------------- | ------------------------- |
| `repo`    | "(i of N) Where should analytics for <short> go?"                               | "Don't track this repo"   |
| `folder`  | "(i of N) Where should analytics for <label> (and everything inside it) go?"    | "Don't track this folder" |
| `outside` | "(i of N) Where should analytics for sessions outside a project folder go?"     | "Don't track these"       |

Options: one per `W.` line — label = the workspace name (the text after `W. ` up to ` account=`),
description = the line's `role=` value, or "Beezi workspace" when it is empty — then the last
option, description "Nothing from <short> is uploaded" ("Nothing from sessions
outside a project folder is uploaded" for `outside`). More than 4 options → split them evenly into
questions of at most 4 (5 → 3 + 2), the last option in the last one, each ending in
" (part j of k)"; the `P` line's answer is all of its parts together.

Then, for each `P` line with an answer, run its `P<i>-command=` text EXACTLY ONCE, changing
nothing except the final `<tenants>`: the chosen `tenant=` values joined by commas (e.g.
`t1,t2`), or `none` when the last option was chosen (it wins over the others). Never rebuild the
command or re-quote its path yourself. A `P` line with nothing chosen, or a dismissed question,
runs nothing: its sessions are not sent this time, and the next /beezi:login or /beezi:sync asks
again.

Write each command's first line verbatim.

Step 4b — backfill. Run EXACTLY this one command, substituting only `<key>` with the key from
Step 1:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/backfill.mjs --via login --account <key>`

It is the one-time upload of this machine's Claude Code history into Beezi and
can take several minutes; it prints progress lines as it goes. Report its
output verbatim — progress and final summary, or the error line. It is safe on
every login: already-uploaded sessions are skipped, and if it says nothing new
to upload, just tell the user their history is up to date. If some sessions
could not be delivered, tell the user that re-running /beezi:login later will
resume the upload where it left off. A `Beezi (<account>): …` line saying where past sessions go
is expected; when it is the only line, the run succeeded with nothing to send. Never echo any
token.

- `… to this workspace you joined`, `this workspace already has this machine's history`, `Some history
  did not reach this workspace this time…` — the upload for a workspace joined after this machine was
  linked: it resumes from what that workspace already has, like /beezi:sync. Show it verbatim; when it
  says some history did not arrive, offer /beezi:sync.

If it reports the one-time import **has already been used**, that is final —
the import is once per account and cannot be re-run. Do NOT retry, do NOT run
the script again with different flags, and refuse politely if the user asks
you to bypass it; relay the script's message (including the upgrade suggestion
when it prints one), then continue to Step 5 without retrying the import.

Note for the user, only when Step 4 reports the pull finalized: the pull is
one-time per account and tool — if they have Claude Code history on other
machines, they should run /beezi:login there BEFORE it finalizes; a finalized
pull cannot be re-opened.

Step 5 — default account for analytics (only when Step 1's output contained the line
`/beezi:analytics still reads from …`). Ask the user ONE yes/no question with the
AskUserQuestion tool: "Make <the account Step 1 linked> the account /beezi:analytics reads
from?" If yes, run EXACTLY, substituting only `<key>` with the key from Step 1:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/accounts.mjs use <key>`

and report its one-line output. If no, say the default is unchanged and that
/beezi:settings account switches it later. Session tracking goes to every linked account
regardless of this answer.

Every command output you show is written verbatim.
