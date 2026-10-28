---
description: Upload past Claude Code sessions to Beezi analytics, skipping ones already uploaded
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/sync.mjs:*), Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs:*), AskUserQuestion
---

Do not read or inspect any files yourself.

The user cannot see tool output (Claude Code collapses it), so any output you are told to show
or write verbatim is copied exactly into your reply text — never summarized or paraphrased.

AskUserQuestion, everywhere below: at most 4 questions in one call and at most 4 options in one
question; `multiSelect: true` only with 2 or more options. Make one AskUserQuestion call per
message and wait for its answers before the next (two calls in one message show the user only
the last). A dismissed question runs nothing.

## Step 1 — new workspaces, then repos and folders with no rule, then the upload

Run EXACTLY this one command, with the Bash tool's `timeout` set to 600000 (add `--account <key>`
when the user named an account, and the `--tenant` override from Step 2 when the user asked for it):

`node ${CLAUDE_PLUGIN_ROOT}/scripts/sync.mjs --review`

It prints a `<joined>` block (new workspaces, below) and stops there when that block's last line
is not `joined=0`. Otherwise it prints a `<routes>` block (repos and folders with no rule, below)
and stops there when its last line is not `routes=0`. When both are 0 it goes straight on to the
upload: everything after the `</routes>` line is Step 2's output, and no other command runs. A
listing that fails shows a `✗` line inside its block instead and counts as nothing to ask: write
that line verbatim.

First, new workspaces: the `<joined>` block, which `workspace.mjs joined` prints.

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

Run the printed commands unchanged; whatever they route gets its history uploaded.

`joined=0` → nothing to ask; go to "Then, repos and folders with no rule" below.

For each account with `J` lines (with several accounts, end every question text with " (<email>)"),
using that account's `W.` lines and commands:

More than 4 `J` lines → first ask (single-select) "You joined <names>. Where should analytics for these
<N> repos and folders go? Their past sessions will be sent there too." (`<N>` = that account's number of
`J` lines) with the options "Add <names> to all <N>" (description "Repos you don't track, and ones with
no rule yet, stay as they are"), "Choose repos" ("Pick which repos and folders go to each new
workspace") and "Leave them as they are" ("Nothing changes, and you're not asked about <names> again").

- "Add <names> to all <N>" → run the `add-all-command=` text EXACTLY ONCE.
- "Choose repos" → the per-workspace questions below.
- "Leave them as they are" → run the `done-command=` text EXACTLY ONCE.
- A dismissal → nothing; the next /beezi:sync asks again.

4 or fewer `J` lines → the per-workspace questions.

Per-workspace questions — for each `W.` line with `new=yes` of that account, in order, ask the
`multiSelect: true` question "Which repos and folders should also send analytics to <name>? Their past
sessions will be sent there too." `<name>` is the `W.` line's text after `W. ` up to ` account=`, and
`<tenant>` its `tenant=` value. Options: one per `J` line of that account, in order — label = `<short>`
(the `J` line's text after `J<i>. ` up to ` (` or `,`), description = "Now: <where>" (`<where>` = the text after `now: ` up to ` account=`),
or "No rule yet" when `<where>` is `no rule yet`; then "None of these" LAST (description "Nothing from
these goes to <name>"). So a question lists at most 3 places plus "None of these": more `J` lines → split
them in order into questions of at most 3 places, each ending in " (part j of k)"; that workspace's answer
is all of its parts together. "None of these" alone means no pick from that question. If it is chosen
together with any place in the same question, ask that workspace's question again once (every part),
starting with `"None of these" can't be combined with repos — pick one or the other.` A mixed answer is not an answer. A second
mixed answer is a dismissal: no `J<i>-command` for that workspace and no `done-command`.
At most 4 questions per AskUserQuestion call: more → further calls, one after
another. The printed `J` numbers are global across accounts: preserve each to match its command.

For each new workspace, for each `J` line picked for it, run that line's `J<i>-command=` text EXACTLY
ONCE, changing nothing except the final `<tenant>`: that workspace's `tenant=` value (e.g. `t1`). Never
rebuild the command or re-quote its path yourself. A dismissed question runs nothing for its lines.
After every new workspace's questions have been answered ("None of these" alone is an answer; skipped,
dismissed or mixed is not), run the `done-command=` text EXACTLY ONCE; otherwise run no `done-command`, and the
next login or sync asks again. Write each command's first line verbatim.

Then, repos and folders with no rule. Run nothing for them after `joined=0`: the Step 1 command
already printed the `<routes>` block. After the `J` questions (answered or dismissed) and their
commands, run EXACTLY, with the same `timeout`, `--account` and `--tenant` as Step 1's command:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/sync.mjs --review-routes`

It prints the `<routes>` block and, when its last line is `routes=0`, goes straight on to the
upload as Step 1's command does.

The `<routes>` block is `workspace.mjs routes` output. It is for you only, except the one line
named below. It lists, per account in several
workspaces set to "Ask me" for new folders, the repos and folders whose past sessions have no rule
yet. Its lines:

- `<email>: <N> repos or folders have past sessions with no rule (<M> sessions) account=<key>` —
  starts one account's block;
- `W. <workspace> account=<key> tenant=<id> role=<role>` — one per workspace of that account;
- `P<i>. <short> (<full label>), <k> sessions account=<key> kind=<repo|folder> match=<match>` —
  one repo or folder (a `P` line). `P<i>. outside a project, <k> sessions account=<key> kind=outside match=outside`
  is one too: every past session in the home folder, `/` or a temp folder;
- `P<i>-command=<command>` — right after its `P` line: the rule command for it, ending in a
  literal `<tenants>`. It is not a `P` line;
- `all-command=<command>` — one per account: the command that gives all of that account's `P`
  lines the same workspaces, ending in a literal `<tenants>`;
- `<n> other past sessions have no recorded folder and are not sent.` (or `1 other past session
  has no recorded folder and is not sent.`) — write this line verbatim, once; there is nothing to
  ask about it;
- `routes=<total>` — the number of `P` lines, always last.

Not linked, or `routes=0` → nothing to ask: the upload already ran in the same call; go to Step 2
for its output.

For each account with `P` lines (with several accounts, end every question text with
" (<email>)"):

More than 4 `P` lines → first ask (single-select) "Where should analytics for these <N> repos and
folders go?" (`<N>` = that account's number of `P` lines) with the options "Send all <N> to the
same workspaces…" (description "Pick the workspaces once for all of them"), "Choose per repo"
("One question per repo or folder") and "Skip" ("Nothing from them is sent this time; you're
asked again next time").

- "Send all <N> to the same workspaces…" → ask (`multiSelect: true`) "Which workspaces should get
  analytics for these <N> repos and folders?", one option per `W.` line of that account (label and
  description as below; more than 4 → split evenly into questions of at most 4, each ending in
  " (j of k)"). Nothing chosen → run nothing. Otherwise run that account's `all-command=` text
  EXACTLY ONCE, changing nothing except the final `<tenants>`, which becomes the chosen `tenant=`
  values joined by commas.
- "Choose per repo" → the per-repo questions below.
- "Skip" or a dismissal → nothing more for that account.

4 or fewer `P` lines → the per-repo questions.

Per-repo questions — one `multiSelect: true` question per `P` line, numbered across that
account's `P` lines (`i` from 1, `N` = their number). `<short>` is the `P` line's text after
`P<i>. ` up to ` (` or `,`, and `<label>` the text in the parentheses after it. The question and
its last option follow the line's `kind=`:

| `kind=`   | Question                                                                        | Last option               |
| --------- | ------------------------------------------------------------------------------- | ------------------------- |
| `repo`    | "(i of N) Where should analytics for <short> go?"                               | "Don't track this repo"   |
| `folder`  | "(i of N) Where should analytics for <label> (and everything inside it) go?"    | "Don't track this folder" |
| `outside` | "(i of N) Where should analytics for sessions outside a project folder go?"     | "Don't track these"       |

Options: one per `W.` line of that account — label = the workspace name (the text after `W. ` up
to ` account=`), description = the line's `role=` value, or "Beezi workspace" when it is empty —
then the last option, description "Not tracked: nothing from <short> is sent" ("Not tracked:
nothing from sessions outside a project folder is sent" for `outside`). More than 4 options → split
them evenly into questions of at most 4 (5 → 3 + 2), the last option in the last one, each ending
in " (part j of k)"; the `P` line's answer is all of its parts together.

If a `P` line's answer has the last option together with any workspace, across all of its parts,
run nothing for it yet: ask that `P` line's question again once (every part), starting with
`"Don't track" can't be combined with a workspace — pick one or the other.` A second mixed answer is a dismissal.
Then, for each `P` line with an answer, run its `P<i>-command=` text EXACTLY ONCE, changing
nothing except the final `<tenants>`: the chosen `tenant=` values joined by commas (e.g.
`t1,t2`), or `none` when the last option was chosen, only when it is the whole answer.
Never rebuild the command or re-quote its path yourself. A `P` line with nothing chosen, or a dismissed question,
runs nothing: its sessions are not sent this time, and the next /beezi:sync asks again.

Write each command's first line verbatim.

## Step 2 — sync

When the last listing printed `routes=0`, the upload already ran: its output is everything after
that listing's `</routes>` line. Run nothing more. Only after the `P` questions (answered or
dismissed) and their commands, run EXACTLY this one command, with the same `timeout`,
`--account` and `--tenant` as Step 1's command:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/sync.mjs`

For an account in several workspaces, each past session goes where its own repo or folder
routes: its rule, else the New folders setting ("Send to" workspaces get it; under "Ask me" or
"Don't send" it is not sent this time). Add `--account <key> --tenant <id>[,<id>…]` only when the
user asks to sync specific workspaces instead: that is an override that sends every past session
to those workspaces, ignoring rules.

Write the upload's output verbatim as your reply text. Never echo any token.

The script uploads every past session still on this machine that Beezi does not
already have. It asks the server how far each session already reaches and resumes
from exactly there, so it is safe to run as often as the user likes — a repeat run
uploads nothing and reports that everything is up to date.

Notes for interpreting the output:

- "everything is already uploaded" is a success, not a failure — it means Beezi is
  in sync. Do not re-run the command or suggest flags to force it.
- If it says this machine is not linked, point the user at `/beezi:login`.
- If it says the portal does not support `/beezi:sync` yet, the workspace's Beezi
  server needs updating — the user's history is not lost, and the command will work
  after the update.
- A `Beezi (<account>): …` line says where that account's past sessions go. "… not sent this
  time" is expected after a skipped question: the next /beezi:sync asks again, and
  /beezi:settings rules adds a rule from inside that repo or folder. When it is an account's only
  line, the run succeeded with nothing to send.

Account selection: With no flag, sync processes every linked account in turn. Add `--account <key>` to sync one account.

Every command output you show is written verbatim.
