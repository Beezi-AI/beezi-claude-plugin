# Beezi plugin release notes

## 0.46.6 (2026-11-19) — The card warns when not signed in and stays current

### Improved
- **The card warns when no account is authorized** — with no linked Beezi account, or only ones whose sign-in was rejected, the card shows `Not authorized · run /beezi:login` in warning color instead of `0 accounts`. The one-line view after the first prompt shows the same warning.
- **A violet upload bar** — past-session uploads show a short violet bar with the percent in its center, under the `Uploading past sessions to Acme 139/179` line, instead of a full-width bar.
- **The card stays current** — the card refreshes at every prompt and turn end, also while an upload runs, and once a minute, so a sign-in, sign-out or upload from this or another session shows up on its own.

## 0.46.5 (2026-11-19) — Maintenance release

### Improved
- **No changes in how Beezi works** — this release only moves the version forward, so the card's `v0.46.5 available` note and its `How to update` steps can be checked on a machine running 0.46.4.

## 0.46.4 (2026-11-19) — Setup uploads every past session

### Improved
- **Sessions that open with a very long line are found** — setup now lists and uploads a past session even when its first lines are very long, such as a queued prompt. Before, it could not tell which folder these sessions belonged to and left them out, so the next session asked about them again.
- **Uploaded sessions are not asked about again** — a session Beezi already holds is no longer offered a second time because it used subagents or had a quiet stretch with nothing to count.
- **Uploads show they are still working** — a spinner turns while past sessions upload, and once every session has been read the line says `Finishing upload to Acme…`, with plain `Beezi: all sessions read, finishing upload…` where there is no terminal.
- **The card shows the plugin version** — the Beezi card shows `v0.46.4`. When a newer version is out it adds `v0.46.5 available` and a `How to update` button that lists the steps.

## 0.46.3 (2026-11-18) — Past sessions follow the workspace owner

### Improved
- **Uploads follow the owner's current settings** — past sessions are uploaded with the names the workspace hides at the moment they are sent. If the owner turns off hiding for a kind of name after you agreed to an upload, that kind is sent as it is. When Beezi can't confirm the workspace's settings at that moment, nothing is sent and the upload tries again later.
- **Audit workspaces follow the owner's choice too** — an audit workspace whose owner chose to upload past sessions without asking now uploads them without asking, like any other workspace.
- **Plan usage follows the owner's current settings** — a plan usage reading waiting to be sent is sent with the names the workspace hides when it goes out, not the ones hidden when an earlier reading was taken.

## 0.46.2 (2026-11-18) — Startup card and upload progress

### New
- **A Beezi card above the prompt** — when a session starts, the terminal and the Claude desktop app show a card with your account and where this folder's sessions go, with a dot for its state: green tracked, amber no rule yet or analytics off, gray not sent. It notes when the workspace is anonymized. After your first prompt it shrinks to one line; `details` brings it back.
- **Change where a folder goes from the card** — `Change where this goes` lists the choices `/beezi:settings rules` offers, each saying what it does, and saves one with a key press. `/beezi:settings undo` takes it back. A folder with no rule yet shows `Choose where this goes`.
- **Where it shows** — on a Claude Code version with plugin modules, in the terminal and the desktop app. Older versions and the VS Code extension keep the text line at session start.
- **Upload progress in setup** — terminal setup and the one-line installers show a bar that fills in place while your past sessions upload, `Uploading past sessions to Acme  ▓▓▓▓░░░░░░░░░░  30/100`, then `✓ 100 past sessions uploaded to Acme`. Off a terminal you get plain `Beezi: 30/100 sessions read…` lines instead. Press Ctrl+C, or wait 100 seconds off a terminal, to stop following; an upload that is stopped or fails ends on `Beezi: the rest keeps uploading in the background`, and the rest keeps uploading.
- **Upload now shows its progress** — `Upload now` in a session follows the upload for up to 100 seconds with the same plain lines and ends on the done line, or on `✓ 30 of 100 past sessions uploaded to Acme; the rest keeps uploading in the background`.
- **Uploads that start by themselves show on the card** — the card shows a live progress row, then the done line. Where the card can't draw, such as the VS Code extension and older Claude Code versions, each prompt shows `Beezi: uploading past sessions to Acme  30/100` until it finishes, then the done line once.

### Improved
- **A finished upload is not announced twice** — once you have seen the done line, the next session start no longer repeats the result.

## 0.46.1 (2026-11-17) — Setup and uploads wait out a busy moment

### Fixed
- **Setup waits for a busy Beezi job** — setup no longer gives up on your past sessions when another Beezi job is briefly busy. It tries again for up to a minute.
- **No five-minute pause during a token refresh** — when another Beezi process is renewing your sign-in, uploads wait a few seconds for it instead of pausing for five minutes.

## 0.46.0 (2026-11-11) — One-question setup

### New
- **One question: what to track** — terminal setup and `/beezi:login` show the summary of your past sessions, then ask one question: track everything, or let you choose the repos and folders. With several workspaces it asks where everything goes, or lets you tick repos for each workspace. The answer is your consent: past sessions from what you track upload in the background, and nothing is sent from a repo or folder you left out. A workspace whose owner chose never to upload past sessions still gets none.
- **Asked once per account** — once tracking is set up for an account on this machine, signing in again asks nothing and says it is already set up. Change it any time in `/beezi:settings`.

### Improved
- **Fewer questions** — the plan is detected without asking; when it can't be, the closing lines say to set it in `/beezi:settings`. The questions about this session's folder, new workspaces, repos with no rule, uploading past sessions and the default account are gone from sign-in.
- **Crash reports and the status line are on after setup** — crash reports turn on unless you already chose, and the status line is installed when it is off. The last lines say what is on; `/beezi:settings` changes either.
- **Beezi's colours in terminal setup** — the Beezi mark at the top, violet marks for what is done, a shorter closing block, and tick lists that scroll on small terminals. `NO_COLOR` still turns the colours off.

## 0.45.3 (2026-11-10) — Project skills counted under their own name

### Fixed
- **Skills from a project folder keep one name** — a skill that lives in a project or worktree folder (Claude Code names it like `apps/web:deploy`) is now counted under its skill name, `deploy`, instead of the folder path. The same skill used from several worktrees now adds up under one name, and the folder no longer shows up as a plugin.

## 0.45.2 (2026-11-09) — Blocked time for every rate limit

### Fixed
- **Weekly limits now count as blocked time** — when Claude Code said a weekly limit "resets Oct 23, 11pm", Beezi could not read the date, so the error reached Beezi with no reset time and no blocked time. Beezi now sends the exact reset time Claude Code records with each rate limit, both live and in past-session uploads. The date form of the message is understood too.

## 0.45.1 (2026-11-09) — Max and Ultra plan names

### Improved
- **Claude's new plan names** — the plan question in `/beezi:login` and terminal setup offers "Max or Ultra", then Max or Ultra, and `/beezi:settings` shows Max or Ultra instead of Max 5x or Max 20x. Anthropic renamed Max 20x to Ultra; what Beezi records for each plan is unchanged.

## 0.45.0 (2026-11-03) — Past sessions upload without asking

### New
- **Workspaces can upload past sessions without asking** — when the workspace owner turns off "Ask the developer first", `/beezi:login`, terminal setup, `/beezi:sync` and a later session start show the same summary of what is sent and hidden, then say the workspace "uploads past sessions without asking, so there's no question" and upload. At session start the upload runs in the background. Such an upload is never recorded as a "Not now", and one that fails retries quietly without showing the notice again.
- **One summary for several workspaces** — when past sessions go to two or more workspaces, Beezi shows one summary with each workspace's sessions and what it hides, uploads to the ones that don't ask, then asks once about the rest: one multi-select question for up to 3 workspaces, with "Not now" last. Terminal setup ticks every workspace for you.

### Improved
- **`/beezi:sync` follows the owner's choice** — a workspace that uploads without asking uploads with no question in `/beezi:sync` too. Syncing specific workspaces with `--tenant` still asks.

## 0.44.0 (2026-11-03) — Anonymized workspaces

### New
- **Anonymized workspaces, chosen per kind** — each workspace picks what it hides: repo and folder names, branch names, session titles, this computer's name and your account email. The plugin sends made-up names for each kind the workspace hides and real ones for the rest. Hiding session titles also leaves out subagent task descriptions and error text; hiding the account email also leaves out the Claude organization name.
- **See it at a glance** — the session banner says which workspaces are anonymized, and `/beezi:settings account` shows the name this machine appears as when the workspace hides computer names.
- **Past sessions are summarized before any upload** — `/beezi:login`, terminal setup and a later session start show how many past sessions a workspace would get, from which dates and folders, and what each one carries, then ask. Nothing is uploaded until you choose Upload now, unless the workspace owner turned off "Ask the developer first" (from 0.45.0). "Not now" is remembered: Beezi asks again only when the workspace owner changes the setting or a new rule sends a folder there. Adding or changing a rule uploads nothing on its own.
- **`/beezi:sync` shows what it will send first** — it prints the same summary for each workspace and asks before uploading, even for a workspace that starts from today. From 0.45.0 a workspace that uploads past sessions without asking uploads without the question.
- **What the question hid stays hidden** — an upload hides every kind the question said was hidden, even if the workspace owner turns one off before it finishes.
- **Declined sessions stay declined** — sessions you said no to are not asked about again at login, in terminal setup or at session start; `/beezi:sync` still lists them. From 0.45.0, a workspace whose owner chose to upload past sessions without asking shows the notice and uploads them.
- **Repairs only touch what you sent** — the background repair of older uploads re-sends only sessions this machine uploaded after a yes or tracked live.
- **Typed emails follow the workspace** — an email you type to link a setup token to your account is hashed when the workspace hides account emails.
- **Enabled-plugin reports follow the workspace** — the repo a project's plugins are enabled for is sent as a made-up name when the workspace hides repo and folder names.

### Improved
- **Sign-in client name** — the sign-in client this machine registers is now named "Beezi Claude Code plugin", without the machine's hostname.

## 0.43.0 (2026-11-03) — Faster hooks, uploads in the background

### Improved
- **Uploads run in the background** — turn ends and session starts no longer wait for queued analytics to upload. One low-priority background uploader per machine sends them and stops when the queue is empty, after a few passes without progress, or after 5 minutes.
- **Hooks no longer read your sign-in** — the hooks that run while you work no longer read your saved Beezi sign-in from the system credential store (a slow PowerShell call on Windows). Errors, timelines and plan usage are handed to the background uploader, which reads the sign-in once per run.
- **Fewer and lighter hooks** — one process per tool call instead of two, and tool calls, compactions and subagent ends no longer wait for Beezi where Claude Code supports background hooks. Checkpoints read only the new part of the transcript, and on large sessions the activity timeline is rebuilt at most every 5 minutes (always at session end).
- **Batched uploads** — on servers that support it, up to 50 reports go in one request; older servers keep getting one report per request.

### Fixed
- **No double counting after an interrupted upload** — queued reports are sent so that a shorter window of a session always arrives before a longer one that contains it, and a window that failed holds back the ones after it.
- **Nothing re-sent after a killed hook** — the session's read position is saved before any upload starts.
- **Old queue files are cleaned up** — queues and leftover temporary files are pruned for every linked account.
- **Status line usage backlog drains** — each usage reading is cleared as soon as it is sent, so a stopped upload no longer resends the whole backlog.
- **`/beezi:sync` waits its turn** — it waits for the background uploader instead of uploading alongside it, and stops early with "another session sync is running" when it can't get its turn.

## 0.42.0 (2026-10-29) — Plan usage in the desktop app

### New
- **Plan usage check** — the Claude desktop app has no status line, so Beezi couldn't see your 5-hour and weekly plan usage there. Turn it on with `/beezi:settings usage-check on`: where the status line can't run, Beezi checks your usage with one small Haiku request on your plan at most every 30 minutes, and only when no fresher reading exists. It is off until you turn it on, and it never runs on machines that sign in with a setup token.

## 0.41.0 (2026-10-29) — Large sessions upload

### Fixed
- **Large sessions upload** — past and live sessions of any size are sent. Before, transcripts over 64 MB were skipped as "too large to read".
- **Accurate code-change and tool counts** — newer Claude Code keeps copies of each request in the transcript. Beezi no longer counts them, so lines changed, tool calls, tool token estimates and repo attribution are no longer inflated.

## 0.40.1 (2026-10-26) — Terminal setup sees what your sessions see

### Fixed
- **One subscription per machine** — a `CLAUDE_CODE_OAUTH_TOKEN` set only in your shell no longer reaches terminal setup, the same way Claude Code hides it from plugins, so setup no longer registers the machine under a second subscription. Setup prints a warning when it finds such a token, with how to make it visible.

## 0.40.0 (2026-10-23) — Enabled plugins in Beezi

### New
- **Enabled plugins** — once an hour Beezi records which Claude Code plugins are switched on for this machine (`enabledPlugins` in your user settings and in the project settings of folders you work in), with their versions. Only the plugin names, versions and the repo they are enabled for are sent. A project's plugins follow that folder's workspace rules, and nothing is sent for workspaces where live tracking is off.

## 0.39.2 (2026-10-22) — Several workspaces at setup, and "Don't track" stands alone

### Fixed
- **"Don't track" stands alone** — picking it together with a workspace no longer drops the workspace silently: the setup asks again, and Beezi's questions in Claude Code ask once more.
- **"None of these" stands alone** — choosing it with repos for a new workspace asks again instead of skipping the repos.

### Improved
- **Several workspaces** — "Where should analytics from this machine go?" has a "Several workspaces…" option that sends everything to each workspace you pick.

## 0.39.1 (2026-10-21) — `/beezi:about` is now part of `/beezi:status`

### Improved
- **Updates in `/beezi:status`** — it now also shows when the plugin was last updated on this machine, its marketplace and auto-update setting, and the steps to update when a newer version is out.
- **`/beezi:about` removed** — everything it showed is in `/beezi:status`.
- **Clearer way out** — the settings menus end with Close instead of Done.

## 0.39.0 (2026-10-20) — Release notes in Claude Code, and a one-question terminal setup

### New
- **`/beezi:release-notes`** — what changed in each version, right in Claude Code.

### Improved
- **One-question terminal setup** — the installer's setup asks the same single question as `/beezi:login`, "Where should analytics from this machine go?", with how many past sessions go there.
- **Lighter session start** — the session banner no longer fetches your weekly usage in the background.

## 0.38.0 (2026-10-20) — Clearer settings, a session banner and `/beezi:status`

### New
- **`/beezi:status`** — sign-in, workspace, where this folder's analytics go, plan and plugin version on one screen.
- **Session banner** — every new session starts with who you're signed in as, the workspace, and where this folder's analytics go.
- **Status-line badge** — `Beezi → Acme` at the end of your status line. Off by default; turn it on in `/beezi:settings`.
- **Undo** — `/beezi:settings undo` puts your last rule change back.

### Improved
- **You're here** — `/beezi:settings` shows where this folder's analytics go, with a Default row, a "← you're here" marker and each rule's sessions over the last 30 days.
- **Clearer menus** — options show their current state, and "Don't track this repo" shows the folder's path and what changes.
- **Folder picker** — stop tracking another folder by picking it from your most-used ones instead of typing a path.
- **One-question login** — accounts in several workspaces answer one question, "Where should analytics from this machine go?", with a preview of what it sets.
- **Faster commands** — `/beezi:settings`, `/beezi:login`, `/beezi:sync` and `/beezi:logout` run in fewer steps.

## 0.37.10 (2026-10-16) — Terminal setup shows its progress

### Improved
- **Progress you can see** — the terminal setup shows a spinner and names each step while it works.
- **Tidy output** — long lines wrap to fit the window.

## 0.37.9 (2026-10-14) — Pick repos for each workspace you join

### New
- **Repos per workspace** — after joining a workspace, choose which repos' past sessions go to it.

### Improved
- **Quicker start** — joining several workspaces looks through your repos once, so the upload starts sooner.

## 0.37.8 (2026-10-13) — Complete history uploads

### Fixed
- **Nothing missed** — uploading past sessions reads each session from its very start.

## 0.37.6 (2026-10-13) — Faster history upload, and history after joining a workspace

### New
- **History for new workspaces** — after you join a workspace, the next session asks whether to upload your past sessions to it.

### Improved
- **Faster uploads** — uploading past sessions is much faster.

## 0.37.5 (2026-10-12) — A friendlier terminal setup

### Improved
- **Friendlier setup** — colours, arrow-key menus and a summary when it finishes.

## 0.37.0 (2026-10-12) — Set up from one terminal command

### New
- **Terminal setup** — the one-line installer runs a short setup in the terminal that signs you in and gets the plugin ready.

## 0.36.1 (2026-10-12) — Sync and history upload work again

### Fixed
- **Sync works again** — `/beezi:sync` and the past-session upload work again after failing in 0.36.0.

## 0.36.0 (2026-10-08) — Choose where repos go after joining a workspace

### New
- **Route repos after a join** — after you join another workspace, you're asked where each repo's analytics should go.

## 0.35.1 (2026-10-06) — Organization and subscription reporting

### Improved
- **Your organization** — your Claude organization is reported along with your plan.

### Fixed
- **Steady subscription** — a session stays on the subscription it started with, even if you switch accounts while it runs.

## 0.35.0 (2026-10-06) — New `/beezi:about`

### New
- **`/beezi:about`** — the installed version, whether a newer one is out, when it was last updated and how to update.

## 0.34.0 (2026-10-05) — Exclude repos and folders in one-workspace accounts

### New
- **Don't track a repo** — accounts in a single workspace can mark repos and folders as not tracked.

## 0.33.1 (2026-10-05) — Fuller session detail from `/beezi:sync`

### Fixed
- **Full detail** — sessions uploaded with `/beezi:sync` keep their full breakdown alongside Claude's own cost figures.

## 0.30.3 (2026-09-29) — Apache-2.0 license

### Improved
- **Open license** — the plugin is released under the Apache-2.0 license.

## 0.30.2 (2026-09-14) — Period hint in the analytics menu

### Improved
- **Period hint** — the `/beezi:analytics` menu shows that you can pick 7d or 30d.

## 0.30.1 (2026-09-11) — Sync skips sessions still running

### Fixed
- **Running sessions wait** — `/beezi:sync` no longer uploads sessions that are still in progress; they're sent once they finish.

## 0.30.0 (2026-09-11) — The right plan after a setup token, and matching past costs

### Improved
- **Matching costs** — past sessions uploaded on first sign-in use Claude's own cost record, so their costs match Claude's.

### Fixed
- **Right plan after a setup token** — signing in after using a setup token corrects the Claude plan Beezi shows.
