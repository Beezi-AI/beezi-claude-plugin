# Beezi plugin release notes

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
