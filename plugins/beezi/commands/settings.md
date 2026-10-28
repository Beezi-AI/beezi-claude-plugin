---
description: Show and change Beezi settings: rules, new folders, account and plan, crash reports, status line
argument-hint: "[show | rules [show | add | remove <n>] | new-folders [show] | account [show] | refresh | undo | telemetry [show | on|off|correlate|anonymous] | statusline [on|off | badge on|off]]"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/accounts.mjs:*), Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/billing-capture.mjs:*), Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/key-resolve.mjs:*), Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/settings.mjs:*), Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/statusline-install.mjs:*), Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/telemetry.mjs:*), Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs:*), AskUserQuestion
---

Do NOT read, open, or inspect any files. Never echo any token.

Arguments: $ARGUMENTS

The user cannot see tool output: Claude Code collapses it after a few lines. A script's output
reaches the user only through your reply text or a question's `preview`, so output you are told
to show is copied VERBATIM into your reply, as its very first text: exactly as printed, never
summarized, paraphrased, reformatted or replaced by a sentence of your own ("I've noted…" is
wrong). Machine lines (`key=value` lines, and every line of an output you are told not to show)
are never shown.

Previews: whenever a single-select question below says "with previews", give EVERY option a
`preview` holding the named script output, copied exactly (a markdown table stays a table). The
preview is what the user reads while choosing, so never leave it out.

AskUserQuestion, everywhere below: at most 4 questions in one call and at most 4 options in one
question; `multiSelect: true` only with 2 or more options. Make one AskUserQuestion call per
message and wait for its answers before the next (two calls in one message show the user only
the last). A dismissed question runs nothing.

## Read the settings: one command

Everything this command reads comes from ONE command, picked by the first word of the arguments.
Run it once, first, and take everything below from its output: never run a read again, nor another
script to read settings. The commands below only change settings or refresh the plan.

| First word of the arguments                     | Run EXACTLY                                                |
| ----------------------------------------------- | ---------------------------------------------------------- |
| `show` alone                                    | `node ${CLAUDE_PLUGIN_ROOT}/scripts/settings.mjs all`         |
| `rules`                                         | `node ${CLAUDE_PLUGIN_ROOT}/scripts/settings.mjs rules`       |
| `new-folders`                                   | `node ${CLAUDE_PLUGIN_ROOT}/scripts/settings.mjs new-folders` |
| `account`                                       | `node ${CLAUDE_PLUGIN_ROOT}/scripts/settings.mjs account`     |
| `telemetry` or `statusline`, alone or + `show`  | `node ${CLAUDE_PLUGIN_ROOT}/scripts/settings.mjs privacy`     |
| `telemetry <mode>` or `statusline on`/`off`     | nothing: go to Crash reports & status line                 |
| `statusline badge on`/`off`                     | nothing: go to Crash reports & status line                 |
| `refresh`                                       | nothing: go to Refresh my Claude plan                      |
| `undo`                                          | nothing: run `node ${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs undo` and write its first line verbatim; stop |
| nothing, or anything else                       | `node ${CLAUDE_PLUGIN_ROOT}/scripts/settings.mjs`             |

Its output is blocks, each from a `<name …>` line to its `</name>` line:

- `<show>` — always first. Write its lines (not the tag lines) verbatim as your reply's first text.
- `<keys>` — for you only:
  - `menu=<label>|<label>…` — the sections that apply here;
  - one line per linked account: `account=<key> default=<yes|no> multi=<yes|no> workspaces=<n> status=<…> email=<email>`
    (`multi=yes`: the account is in several workspaces; `workspaces=<n>` is its known workspace
    count, `0` when not known yet; no such line: nothing is linked);
  - `crash=<correlate|on|anonymous|off> statusline=<on|off> badge=<on|off>`.
- `<labels>` — with no arguments only: one line per `menu=` label, in the same order, the label
  with its current state (e.g. `Rules: here → Acme`, `New folders: ask me`, `Account: 2 linked`);
  these are the menu question's option labels.
- `<rules account="<key>">` — one per account whose workspaces are known (with no arguments, or
  `rules`); see Rules.
- `<here-card account="<key>">` — one per such account when this folder is known (with no
  arguments, or `rules`): where you are and where its analytics go now; a preview for Rules.
- `<new-folders account="<key>">` — one per account in several workspaces (with no arguments, or
  `new-folders`); see New folders.
- `<preview section="<label>">` — one per menu section (with no arguments only).

Of the blocks, only `<show>`, the chosen section's `<preview section="…">` and the previews below
are ever shown. Each
section below starts from **the section's text**: its `<preview section="…">` block when you came
from the menu, else the `<show>` block you already wrote. Coming from the menu, write that preview
block verbatim as your reply's first text, before the section's first question.

## Route

First, `show` prints the current settings and changes nothing: `show` alone, or a section followed
by `show` (`rules show`, `new-folders show`, `account show`, `telemetry show` or `statusline show`)
→ the `<show>` block is the whole reply; stop.

Otherwise, by the first word of the arguments:

- `rules` → Rules, with the rest of the arguments.
- `new-folders` → New folders.
- `account` → Account.
- `refresh` → Account → Refresh my Claude plan.
- `undo` → the read table's `undo` row (already done there).
- `telemetry` or `statusline` → Crash reports & status line, with the rest of the arguments.
- Nothing, or anything else → ask (single-select, with previews: each option's `preview` = the
  lines of its section's `<preview section="<label>">` block) "What do you want to change?" with
  one option per `<labels>` line, in its order and with exactly its text. The n-th `<labels>` line
  is the n-th `menu=` label's section: descriptions and previews follow that `menu=` label, and so
  does the section you go to. Descriptions: Rules — "Where each repo or folder sends its
  analytics"; New folders — "Where analytics go for a repo or folder with no rule"; Account —
  "Refresh your Claude plan" (plus "or pick the default account" when there are several
  `account=` lines); Crash reports & status line — "Plugin crash reports and Beezi's status
  line". Go to the chosen section. A dismissal stops here.

## Choosing the account (Rules and New folders)

Rules uses the `<keys>` `account=` lines with `multi=yes` or `workspaces=1`. New folders uses only
the `account=` lines with `multi=yes`.

- No `account=` line at all → say this machine is not linked and to run /beezi:login; stop.
- None qualify → for New folders, say this setting applies only to an account in several
  workspaces, and stop. For Rules, say the account's workspaces are not known yet and to start a
  new Claude Code session, and stop.
- Exactly one → use it.
- Several → ask (single-select) "Whose rules?" (Rules) or "Whose New folders setting?" (New
  folders), one option per such line: label = its `email=`, at most 4 options (the "Other" answer
  takes a typed email).

`<key>` below is the chosen line's `account=` value.

## The workspace question

The same question Beezi asks at a session start, about one repo, folder, or the sessions outside a
project folder. Its line's `kind=` picks the text (`<short>` is the name the line gives, `<label>`
the text in parentheses right after it):

About the `here:` line (the repo or folder you're in):

| `kind=`   | Question                                                                        | Last option               |
| --------- | ------------------------------------------------------------------------------- | ------------------------- |
| `repo`    | "Where should analytics for <short>, the repo you're in, go?"                   | "Don't track <short>"     |
| `folder`  | "Where should analytics for <label>, the folder you're in (and everything inside it), go?" | "Don't track <short>" |
| `outside` | "Where should analytics for sessions outside a project folder go?"              | "Don't track these"       |

About an `R<n>.` line, an `F<i>.` line (Picker, below) or a typed target:

| `kind=`   | Question                                                                        | Last option               |
| --------- | ------------------------------------------------------------------------------- | ------------------------- |
| `repo`    | "Where should analytics for <short> go?"                                        | "Don't track this repo"   |
| `folder`  | "Where should analytics for <label> (and everything inside it) go?"             | "Don't track this folder" |
| `outside` | "Where should analytics for sessions outside a project folder go?"              | "Don't track these"       |

`multiSelect: true`. Options: one per `W.` line — label = the workspace name (the text after
`W. ` up to ` account=`), description = the line's `role=` value, or "Beezi workspace" when it is
empty — then the last option, description "Not tracked: nothing from <short> is sent" ("Not
tracked: nothing from sessions outside a project folder is sent" for `outside`). About the `here:` line, add ", current" to the descriptions of the
workspaces in its `now=` ids (or of the last option when `now=none`; nothing when
`now=pending`). When it changes an existing rule, add ", current" to the descriptions of the
workspaces in that rule's `tenants=` (or of the last option when `tenants=none`).

More than 4 options → split them evenly into questions of at most 4 (5 → 3 + 2), the last option
in the last question, each question's text ending in " (part j of k)"; the answer is all of them
together.

If the answer has the last option together with any workspace, across all of its parts, ask the
same question again once (every part), starting with
`"Don't track" can't be combined with a workspace — pick one or the other.` A second mixed answer is a
dismissal: run nothing. `<ids>` = the chosen workspaces' `tenant=` values joined by commas (e.g.
`t1,t2`), or `none` when the last option is chosen, only when it is the whole answer. Nothing
chosen → run nothing.

## Rules

The section's text is the rules table (from the menu, its compact preview). Choose the account;
its lines are the `<rules account="<key>">` block, for you only, and its card is the
`<here-card account="<key>">` block (none when this folder is not known).

For an account in several workspaces, its lines:

- `W. <workspace> account=<key> tenant=<id> role=<role>` — one per workspace;
- `R<n>. <short> (<label>) → <workspaces | not tracked> account=<key> rule=<n> kind=<…> tenants=<ids|none> match=<…>`
  — one per rule;
- `here: <short> (<label>) → <R<n> | no rule> now=<ids|none|pending> path=<path> account=<key> rule=<n|none> kind=<…> match=<…>`
  — this folder, and the rule it follows now. `now=` is where its analytics go today: the
  workspace ids joined by commas, `none` (not tracked), or `pending` (no rule yet, Ask me).
  `path=` is its repo root or folder; its value runs up to ` account=`, and it is absent for
  `kind=outside`.

For a one-workspace account (the chosen `account=` line, from `<keys>`, has `workspaces=1`), there
are no `W.` lines; the first line reads `<account>: <n> rule(s) account=<key> workspaces=1`
instead, and each `R<n>.` line reads `→ <not tracked | tracked>` in place of naming workspaces.

A `kind=outside` line has no ` (<label>)`. `<here>` = the `here:` line's `<short>`, or "sessions
outside a project" when its `kind=outside`. The `here:` line's rule is "its own" when that `R<n>.`
line has the same `kind=` and `match=` as the `here:` line; otherwise it is a wider rule (a parent
folder) that covers this repo or folder.

For a one-workspace account, use "One-workspace rules", below, instead of the rest of this
section.

Then by the rest of the arguments:

- `add` → Add.
- `remove <n>` → Remove, with rule `<n>` (drop a leading `R`).
- `remove` → Remove.
- Anything else, or nothing → ask (single-select, with previews, below) "You're in <here>. What do
  you want to do?" ("You're outside a project folder. What do you want to do?" when the `here:`
  line has `kind=outside`), offering only the options that apply, in this order:
  - "Add a rule for <here>" — the `here:` line has `rule=none`;
  - "Change where <here> goes" ("go" for `outside`) — the `here:` line names its own rule;
    description = that rule's `R<n>.` line up to ` account=`;
  - "Change where <rule short> goes (covers <here>)" — the `here:` line names a wider rule;
    `<rule short>` = that `R<n>.` line's `<short>`, description = that line up to ` account=`;
  - "Add a rule just for <here>" — the `here:` line names a wider rule; description "Only <here>
    changes; R<n> keeps the rest";
  - "Add a rule for another folder or repo…" — only when the `here:` line does not name a wider
    rule; description "Pick a different repo or folder"; see Typed target, below;
  - "Change a rule" — there is an `R<n>.` line;
  - "Remove a rule" — there is an `R<n>.` line;
  - "Close" — only when fewer than 4 options come before it (otherwise a dismissal is the way out).

  "Close" or a dismissal stops.

  Previews: an option about <here> ("Add a rule for <here>", "Change where <here> goes", "Add a
  rule just for <here>") has the account's `<here-card>` block as its preview (the section's text
  when there is none); every other option has the section's text.

Add, or "Add a rule just for <here>" — ask the workspace question about the `here:` line, then run
EXACTLY:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs rule add --current <ids> --account <key>`

"Change where … goes" (either form) — ask the workspace question about the `R<n>.` line the `here:`
line names, then run EXACTLY, with its `rule=` value:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs rule set <n> <ids> --account <key>`

Change a rule — pick a rule ("Which rule do you want to change?"), ask the workspace question
about its `R<n>.` line, then run the `rule set` command above with its number.

"Add a rule for another folder or repo…" — go to Picker, below; a typed answer goes to Typed
target, with `<ids>` from the workspace question it asks, then run EXACTLY, with the flag Typed
target picked:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs rule add --folder '<value>' <ids> --account <key>`

`node ${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs rule add --repo '<value>' <ids> --account <key>`

Remove — with no `R<n>.` line, say the account has no rules and stop. With a number from the
arguments: when no `R<n>.` line has it, say there is no rule R<n> and stop; otherwise ask
(single-select) "Remove R<n> (<short>)?" (`<short>` from that line) with the options "Yes"
(description "Delete the rule; new sessions there follow the default", or for a one-workspace
account "Delete the rule; new sessions there are tracked again") and "No" ("Keep it"), and
only "Yes" goes on. Without a number, pick a rule ("Which rule do you want to remove?"). Run
EXACTLY:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs rule remove <n> --account <key>`

Picking a rule — single-select, one option per `R<n>.` line, the first 4: label = "R<n>. <short>",
description = the text after `→ ` up to ` account=`. With only one `R<n>.` line, add the option
"Cancel" (description "Change nothing"). With more than 4, end the question with " Type another
rule's number under Other."; the "Other" answer is the number (drop a leading `R`). "Cancel" or a
dismissal runs nothing.

After `rule add`, `rule set` or `rule remove`, write its first line verbatim (an error line too;
it ends with " Undo: /beezi:settings undo" when there is a change to undo).

### One-workspace rules

For a one-workspace account (the chosen `account=` line has `workspaces=1`), there is no workspace
question anywhere below. `<here>` and "its own rule" are defined above.

By the rest of the arguments:

- `remove <n>` → Remove, above, with rule `<n>` (drop a leading `R`).
- `remove` → Remove, above.
- Anything else, or nothing (including `add`, which has no single meaning here) → the menu below.

Ask (single-select, with previews, as above: an option about <here> ("Don't track this …", "Track
<here> again") has the account's `<here-card>` block as its preview, every other option the
section's text) "You're in <here>. What do you want to do?" ("You're outside a project folder.
What do you want to do?" when the `here:` line has `kind=outside`), offering only the options that
apply, in this order:

- "Don't track this repo (<short>)" (`kind=repo`), "Don't track this folder (<short>)"
  (`kind=folder`) or "Don't track sessions outside a project" (`kind=outside`), by the `here:`
  line's `kind=` — the `here:` line has `rule=none`, or the rule it names (own or wider) is
  `tracked`. Run EXACTLY:

  `node ${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs rule add --current none --account <key>`

- "Track <here> again" — `<here>`'s own rule is `not tracked`. Run EXACTLY, with that rule's
  number, and without the Yes/No confirmation the general Remove flow uses:

  `node ${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs rule remove <n> --account <key>`

- "Don't track another folder or repo…" — go to Picker, below; a typed answer goes to Typed
  target, then run EXACTLY, with the flag Typed target picked:

  `node ${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs rule add --folder '<value>' none --account <key>`

  `node ${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs rule add --repo '<value>' none --account <key>`

- "Remove a rule" — there is an `R<n>.` line. Use the Remove flow, above.
- "Close" — only when fewer than 4 options come before it (otherwise a dismissal is the way out).

"Close" or a dismissal stops. After any command, write its first line verbatim (an error line too;
it ends with " Undo: /beezi:settings undo" when there is a change to undo).

### Picker

Shared by both account kinds, for "Don't track another folder or repo…" and "Add a rule for
another folder or repo…". First run EXACTLY:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs places --account <key>`

Its output is for you only: a header line, then up to 3 places, each
`F<i>. <short> (<label>), <n> sessions account=<key> kind=<repo|folder|outside> match=<…>`
(a `kind=outside` line has no ` (<label>)`: `F2. outside a project, 12 sessions account=…`)
followed by its own `F<i>-command=<command>` line (the command ends in a literal `<tenants>`),
then `places=<n>`.

- `places=0` → go to Typed target.
- Otherwise ask (single-select) "Which repo or folder should Beezi stop tracking?" (one-workspace
  account) or "Which repo or folder do you want a rule for?" (several workspaces), one option per
  `F<i>.` line: label = its `<short>`, description = "<label>, <n> sessions" (for `kind=outside`:
  label "sessions outside a project", description "<n> sessions"); with only one
  `F<i>.` line, add the option "Cancel" (description "Change nothing"). The user's typed
  answer (the question's own "Other") is a folder path or repo URL: go to Typed target with it
  as the reply, without asking again.
- A picked `F<i>.` line: for a one-workspace account, run its `F<i>-command=` value with
  `<tenants>` replaced by `none`; for several workspaces, ask the workspace question about that
  `F<i>.` line, then run its `F<i>-command=` value with `<tenants>` replaced by `<ids>`. Never
  rebuild the command; write its first line verbatim.

"Cancel" or a dismissal runs nothing.

### Typed target

Shared by both account kinds. Unless the Picker already has the reply, ask in plain text (not
AskUserQuestion): "Which folder or repo? Reply with a folder path (like ~/work/client) or a repo
URL." Then stop and wait for the user's reply.

An empty reply or "cancel" stops. A reply containing `://` or starting with `git@` is a repo (the
`--repo` flag, value `<reply>`); otherwise it is a folder (the `--folder` flag, value `<reply>`).
`<value>` is the reply exactly as typed, trimmed — the template above already quotes it: replace
each `'` in the reply with `'\''` before substituting it in.

For a one-workspace account, that is all: go run the command the calling step named, with `none`.
For an account in several workspaces, first ask the workspace question about it: `kind=` is
`folder` or `repo` by the reply; `<label>` is the typed folder and `<short>` is the last path
segment of the folder or repo. Then go run the command the calling step named, with the resulting
`<ids>`.

Either way, the script validates the value (home, `/`, or a non-URL repo are refused) and its first
line is shown verbatim, errors included.

## New folders

The section's text is the current setting. Choose the account; its lines are the
`<new-folders account="<key>">` block, for you only: a first summary line, `W.` lines as in Rules,
and last `new-folders=<ask|send|none> set=<yes|no> multi=yes account=<key>`.

Ask (single-select, with previews: the section's text) "For a repo or folder with no rule, where should analytics go?" with the
options "Ask me" (description "Beezi asks once per repo or folder, when a session starts there"),
"Send to…" ("Pick the workspaces that get them") and "Don't send" ("Nothing from a repo or folder
with no rule is sent"); add " (current)" to the description of the option matching
`new-folders=` (`ask`, `send`, `none`).

- "Ask me" → run EXACTLY `node ${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs new-folders ask --account <key>`
- "Don't send" → run EXACTLY `node ${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs new-folders none --account <key>`
- "Send to…" → ask (`multiSelect: true`) "Which workspaces should get analytics for repos and
  folders with no rule?", one option per `W.` line (label and description as in the workspace
  question); more than 4 → split evenly into questions of at most 4 (5 → 3 + 2), each ending in
  " (j of k)". Nothing chosen → run nothing. Otherwise run EXACTLY, with the chosen `tenant=`
  values joined by commas:

  `node ${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs new-folders send <ids> --account <key>`

Write the command's first line verbatim (an error line too).

## Account

The section's text is the current account settings. Then:

- No `account=` line → say this machine is not linked and to run /beezi:login; stop.
- One `account=` line → go straight to Refresh my Claude plan.
- Several → ask (single-select, with previews: the section's text) "What do you want to do?" with the options "Refresh my Claude
  plan" (description "Re-read which Claude subscription this machine bills") and "Default account"
  ("Pick which account /beezi:analytics reads from"). A dismissal stops.

### Default account

Selectable accounts are the `account=` lines whose `status=` is not `revoked`.

- None → say every linked account's authorization was revoked and to run /beezi:login; stop.
- Exactly one → use it without asking.
- Several → ask (single-select) "Which account should /beezi:analytics read from?", one option per
  selectable line: label = its `email=`, description "current default" when `default=yes`, else
  "Linked account"; at most 4 options (the "Other" answer takes a typed email).

Run EXACTLY, with the chosen line's `account=` value:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/accounts.mjs use <key>`

and write its output verbatim. (Session tracking goes to every linked account whatever the default;
/beezi:logout removes an account.)

### Refresh my Claude plan

Two steps, in this order. Step 1 always runs and decides the rest: on a machine
signing in with a Claude setup token it is the whole command, and Step 2 must not
run. Step 2 runs only for the machines Step 1 explicitly sends there.

#### Step 1 — ask the server about the setup token, if there is one

A machine signing in with `CLAUDE_CODE_OAUTH_TOKEN` cannot prove its plan
locally: Claude Code writes no account metadata under that auth mode, so anything
a local capture finds on such a machine is a previous login's leftovers. Only the
server knows whether that key has been given a subscription — which is why this
question is asked FIRST, before anything local is read or reported. Presenting a
leftover plan as this machine's plan and only then discovering it cannot be
trusted is the exact mistake this ordering exists to prevent.

Run EXACTLY ONCE (it covers Step 2 too):

`node ${CLAUDE_PLUGIN_ROOT}/scripts/settings.mjs refresh`

It prints a `<key-status>` block holding exactly one JSON object and, only when that object's
`status` is `"no_key"` or `"not_linked"`, a `<capture>` block holding Step 2's one line: Step 2's
capture has already run by then, so never run `billing-capture.mjs` yourself. Both blocks are for
you only. Read `status` from the JSON and do exactly this:

| `status`                          | What to do                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| `"resolved"`                      | Say the key's subscription is known, naming `subscriptionPlan`, and that it is now what Beezi reports for this machine. **Then, only if `accountAnchored` is `true` AND `planSource` is `"reported"`**, add that this plan comes from a subscription an earlier sign-in established rather than one confirmed for this key — name `accountEmail` when it is not null — and that re-pointing it is an admin's job, not something this command can do. **Stop — do not run Step 2.** |
| `"unknown_key"`                   | The server does not know this key yet (the command registers it when the read workspace is one this session sends to). Say Beezi could not register this key with the server yet and to try `/beezi:settings refresh` again later. **Stop — do not run Step 2.** |
| `"unlinked"`                      | Continue to Step 1a — this is the case worth asking about.                                   |
| `"unavailable"`                   | Report the object's `message` verbatim. **Stop — do not run Step 2.**                        |
| `"no_key"`                        | Say NOTHING about this step — do not print the object's `message`, do not mention setup tokens, `CLAUDE_CODE_OAUTH_TOKEN` or this check at all. This machine is not on a setup token, so the question did not apply to it and the local capture is its real answer. Go straight to Step 2; its one line is the whole output the user sees. |
| `"not_linked"`                    | Report the object's `message` verbatim, then continue to Step 2. |
| `"auth_unavailable"`              | Report the object's `message` verbatim. This machine IS linked — the saved login just could not be read this moment (a busy OS credential store, a renewal in flight). Never suggest `/beezi:login`: there is nothing wrong with the link and signing in again fixes nothing. **Stop — do not run Step 2.** |
| `null` (a JSON null, not a string) | The server answered something this plugin does not understand, so the key's subscription cannot be resolved right now. Say exactly that and suggest trying again later. **Stop — do not run Step 2.** |

Whichever row you land on, never state a subscription plan that did not come out
of this JSON object.

##### 1a — how do they want to resolve it

Ask with the AskUserQuestion tool: "Beezi does not know which subscription this
machine's Claude setup token bills. How do you want to resolve it?"

Build the options from the JSON you just read — do not invent them:

- "Use one of my subscriptions" — include this option **only if**
  `subscriptions` is a non-empty array.
- "Name the plan" — always include.
- "Enter an email or account id" — always include.

##### 1b — the follow-up, by what they picked

**Picked "Use one of my subscriptions".** Ask a second question, "Which
subscription does this machine bill?", with one option per entry in
`subscriptions`, using that entry's `label` as the option label (the list rule
below). Then run, with the chosen entry's `target` substituted verbatim:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/key-resolve.mjs --target <target>`

**Picked "Name the plan".** Ask a second question, "Which plan is this
subscription on?", with one option per entry in `selectablePlans`, using that
entry's `label` as the option label (the list rule below). Then run, with the
chosen entry's `plan` value (not its label) substituted verbatim:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/key-resolve.mjs --plan <plan>`

The list rule: only the first 4 entries become options. With more than 4, end the question
with " Type another one's name under Other."; the "Other" answer is the entry whose `label`
matches it (ignoring case), and one that matches none is an answer that is not one of the
options.

**Picked "Enter an email or account id".** Do not ask a multiple-choice question
— wait for the user to type the value in their next message, then run:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/key-resolve.mjs --target <value>`

##### 1c — report the result

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

#### Step 2 — capture what a non-setup-token machine can prove

Only for the two rows in Step 1 that send you here (`"no_key"` and
`"not_linked"`). `settings.mjs refresh` has already run the capture for them and
put its one line in the `<capture>` block.

The capture asks Claude Code itself for the non-secret subscription info
(`claude auth status`) and reads the non-secret account metadata from
`~/.claude.json` (never any token, never the credentials file), then stores the
plan. Report the `<capture>` line verbatim.

If it says nothing was captured, tell the user their Claude subscription info was
not found. If the output says the self-reported plan was kept, report that
verbatim. If the output contains `gateway=custom`, tell the user this machine goes
through a custom API endpoint, so only they can say what it bills — point them at
`/beezi:login`, which asks.

Account selection: use the default Beezi account (pass nothing) unless the user names another; for
another, add `--account <key>` (its `<keys>` `account=` value when you have that block, else the
email the user named) to the `settings.mjs refresh` command and to every key-resolve command in
this flow.

## Crash reports & status line

With a mode in the arguments, run it without asking (no read command ran first), then write its
output verbatim and stop:

- `telemetry on`, `telemetry off`, `telemetry correlate` or `telemetry anonymous` →
  `node ${CLAUDE_PLUGIN_ROOT}/scripts/settings.mjs set crash=<mode>`
- `statusline on` or `statusline off` → `node ${CLAUDE_PLUGIN_ROOT}/scripts/settings.mjs set statusline=<on|off>`
- `statusline badge on` or `statusline badge off` → `node ${CLAUDE_PLUGIN_ROOT}/scripts/settings.mjs set badge=<on|off>`

Otherwise the section's text is the current settings; make ONE AskUserQuestion call with two
questions:

1. (with previews: the section's text) "How should Beezi crash reports work?" with the options "Correlate (recommended)" (description
   "Crash reports with an installation ID, so support can find yours"), "On" ("Crash reports
   without an installation ID"), "Off" ("No crash reports; pending ones are deleted") and
   "Anonymous" ("Stay on, and delete the installation ID and the reports that carry it").
2. "Should Beezi's status line record your live plan usage?" with the options "On" (description
   "Records the usage numbers Claude Code already computes for the status line; your status line
   looks the same"), "On, with a Beezi badge" ("Also shows where this folder's analytics go, like
   Beezi → Acme, at the end of your status line") and "Off" ("Usage is still read from Claude
   Code's cache, less often").

Add ", current setting" to the description of the option matching `crash=` (`correlate`, `on`,
`off`, `anonymous`) and of the one matching `statusline=` and `badge=` (`statusline=on badge=off`
→ "On", `statusline=on badge=on` → "On, with a Beezi badge", `statusline=off` → "Off").

Then apply only what changed, in ONE command: run EXACTLY

`node ${CLAUDE_PLUGIN_ROOT}/scripts/settings.mjs set crash=<correlate|on|off|anonymous> statusline=<on|off> badge=<on|off>`

keeping only the parts whose answer differs from the current one (`crash=` for a crash-report
change; for question 2, "On" means `statusline=on badge=off`, "On, with a Beezi badge"
`statusline=on badge=on` and "Off" `statusline=off`, and only the parts that differ from the
current `statusline=` and `badge=` are kept). Write its output verbatim. When nothing changed,
run nothing and say the settings are unchanged.

If the user asks what crash reports collect: plugin and Claude Code versions, OS, and which plugin
file failed — never their code, prompts, file paths, or repository names. `correlate` is the
recommended way to turn them on; never talk the user out of `on` or `off`.

Every output you show is written verbatim.
