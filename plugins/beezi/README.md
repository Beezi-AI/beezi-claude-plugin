# beezi

A Claude Code plugin that hooks into session lifecycle events (SessionStart, PostToolUse, SessionEnd) to collect and report token usage analytics for Beezi task branches. On session end it ships a summary — tokens consumed, tool calls made, and branch context — to the Beezi analytics endpoint so teams can track AI-assisted development cost and throughput per task.

It also ships a personal analytics summary: the `analytics` skill (`skills/analytics/SKILL.md`) answers "how much did I spend this week?" in the terminal, covering your own last 7 or 30 days with an alert status and up to three recommendations. It is a thin launcher — the workflow, response format, and insight rules are served by `get_analytics_instructions`, so wording and rules change server-side without a plugin release. Data always covers the invoking user only, whatever their role or plan.

The skill reaches the server over a `.mcp.json` stdio bridge (`scripts/mcp.mjs` → `lib/mcp-bridge.mjs`) that forwards MCP traffic authenticated with the stored `/beezi:login` credentials — no separate MCP OAuth prompt. The bridge defaults to the production Beezi API; set `BEEZI_MCP_URL` to override.

## Install

```
/plugin marketplace add <github-username>/<repo-name>
# and
/plugin install beezi@beezi
```

## Commands

- `/beezi:login` — link this machine (browser sign-in with your Beezi account via Clerk OAuth + PKCE); stores the credentials in the OS secret store, or a restricted-permission file when no store is available (see Credential storage below). After upgrading from 0.1.x, run it once — old device-flow tokens are invalid. The flow then captures the machine's Claude subscription plan and finishes with the **history backfill** (see below) — re-running `/beezi:login` on an already-linked machine is the way to refresh the plan or resume an interrupted backfill.
- `/beezi:me` — show this machine's link status (linked account).
- `/beezi:logout` — unlink this machine: asks the portal to drop it and revoke its OAuth client, then deletes the stored credentials. Falls back to revoking directly at the auth server when the portal is unreachable; always logs out locally.
- `/beezi:track` — manually save analytics for the **current** session. Tracks whatever the session touched, the same way the automatic hooks do: work outside any repo (or in a repo with no `origin`) reports under a `local:<folder>` remote rather than being refused. Runs in a UserPromptSubmit hook the moment the command is submitted and shows its result as a system message — no model round trip, so it works even when the API is down (no credits, outage). Fails only if this machine is not linked, the session transcript cannot be found, or the server rejects the report. On success shows `analytics saved for <task-… | branch | folder>`.

## History backfill (runs inside `/beezi:login`)

The **one-time** upload of past sessions — not a command of its own; it runs automatically as the last step of `/beezi:login` (after the link and the plan capture). It scans every transcript under `~/.claude/projects/`, re-parses each one with the same code path the live hooks use (main transcript + subagents), and ships them to the backfill endpoint in chunks of up to 50 reports; the server absorbs duplicates through its own upsert keys. After a fully clean run the pull is **finalized** (sealed) server-side — per account and tool, so log in on every machine that holds history *before* it finalizes; a finalized pull cannot be re-opened. Once used, the import is closed for good: the plugin verifies against the server before scanning anything, and a machine that re-runs it (including manual script runs and `--force`) is refused with a clear message — on audit workspaces it suggests upgrading the plan instead. Safe on every login: a durable ledger at `~/.beezi/audit-ledger.json` means only sessions the server never judged are retried, and the ledger is bound to the login that wrote it — an interrupted upload resumes on the next `/beezi:login`.

- On workspaces with live tracking, only transcripts from **before this machine was linked** are uploaded (later work was already tracked live), and transcripts touched in the last 30 minutes are skipped as probably-open sessions.
- On platform workspaces, only sessions whose repository is **connected to Beezi** can land; expect some to come back as "repository is not connected to Beezi". Analytics workspaces track every repo.
- Plan and billing fields (`billing_source`, `subscription_plan`, `rate_limit_tier`) are read from the **current** environment, not from the historical session — an uploaded March session carries today's plan.
- Session timelines travel inside the backfill chunks themselves, so backfilled sessions carry their activity timeline everywhere. Rate-limit events remain live-tracking-only — audit-mode datasets do not include them.
- For manual runs, `node scripts/backfill.mjs` accepts `--dry-run` (report what would be sent, send nothing), `--since <YYYY-MM-DD>` (only transcripts modified on or after that date — a scoped run never finalizes) and `--force` (ignore the local ledger; only meaningful before the pull finalizes — re-sending a partly-tracked session can re-segment on different boundaries once its per-session cursor has aged out, which can duplicate tokens/cost; use it only when a repository has since been connected).

Analytics are otherwise tracked automatically via the session lifecycle hooks — `/beezi:track` is only needed to force a save mid-session, and the history backfill only ever uploads sessions the hooks never saw. On audit-mode workspaces (no live tracking) the hooks stay silent by design: the server refuses live reports there, and the plugin caches that verdict in `~/.beezi/tracking.json` from the session-start `whoami`.

## Dependencies

**Zero dependencies** — the plugin runs on Node built-ins alone (`package.json` declares no
deps), so `/plugin install` works immediately with nothing to `npm install` or vendor, on
every platform.

## Credential storage

The `/beezi:login` token is stored in the OS secret store via its built-in CLI — no native
module, no `npm install`:

- **macOS** — the login keychain (`security add/find/delete-generic-password`).
- **Linux** — the Secret Service / libsecret (`secret-tool`) when installed; otherwise the file fallback.
- **Windows** — DPAPI (user-bound encryption via PowerShell); the ciphertext is kept in the file. (Credential Manager can store but not return a secret from the CLI, so DPAPI is used instead.)
- **Fallback** — a `0600` file at `BEEZI_HOME/credentials.json` (default `~/.beezi/`) whenever no store is available.

## Development

```bash
npm test   # runs node --test (Node built-in runner, no jest); no install/build step
```

- ESM only: all source files are `.mjs`; `package.json` sets `"type": "module"`.
- No build step, no dependencies.

## Limitations & server contract

- **Idempotency key**: the `segmentId` field (`"<session_id>:<fromLine>-<toLine>"`) is an idempotency key. Overlapping PostToolUse and SessionEnd hook processes can deliver the same segment more than once; the server MUST upsert on `segmentId`, not sum-on-insert.
- **Transcript compaction**: if a transcript file is rewritten shorter than the persisted cursor (e.g. history compaction on the same session id), leading lines of the rewritten transcript may be skipped. This is a known limitation — no mitigation is applied client-side.
- **Repo-root resolution**: a segment is billed to a repo when its lines resolve to a git repo root with an `origin` remote. Resolution is layered: `git rev-parse --show-toplevel` first, then a persisted known-root map (`~/.beezi/repo-map.json`, longest-prefix), then a filesystem walk-up (`.git` as dir **or** worktree file). Each transcript line's own recorded `cwd` is used as a signal when no file-path (`Read`/`Edit`/`Write`/`cd`) signal is present — this attributes signal-less lines (thinking / web-search / grep, and whole research subagents) and tracks `cd`s, instead of billing everything to the session's launch cwd. Origin is resolved via git, then a git-free `.git/config` parse (survives Windows *dubious-ownership*), then the map. A segment that still resolves to no repo (cwd genuinely outside any repo **and** no path signal), or to a repo with no reachable `origin`, is billed to a `local:<folder>` remote — only the folder's own name travels, never the path around it, and the `local:` prefix keeps it from ever canonicalizing onto a real remote server-side. The plugin never guesses a repo; it just refuses to throw the work away. The map is a self-healing hint: pre-warmed at SessionStart (launch cwd + a one-level child scan when the launch cwd is a multi-repo parent) and pruned of roots whose `.git` has vanished.
- **Operation categories (`operations`)**: each segment carries a per-category `{ count, est_tokens }` breakdown (`file`, `search`, `internet`, `mcp`, `shell`, `skill`, `other`) derived from its `tool_use` blocks. `count` is exact. `est_tokens` is an **estimate** — the API bills tokens per assistant message, not per tool, so a tool's real cost (its result text) is approximated as the matched `tool_result` payload bytes ÷ 4. Cache tiering is ignored, and a `tool_use` whose `tool_result` lands in the next segment (repo/branch switch between call and result) contributes `count` but no `est_tokens`. Finer identity: `mcp.by_server` (`{ "<server>": count }` from the `mcp__<server>__<tool>` name), `skill.by_skill` (`{ "<skillId>": count }` from the `Skill` tool's `input.skill`), and a `plugins` cross-cut (`{ "<plugin>": { count, est_tokens } }`) grouping skill/MCP calls by the owning plugin — a skill id's namespace (`superpowers:tdd` → `superpowers`), `builtin` for a namespaceless skill, `unknown` for MCP (server→plugin is not in the transcript). `plugins` **overlaps** the `mcp`/`skill` category buckets, so it is a separate view — never summed alongside them.
- **Subagent identity**: subagent segments (from `<sessionId>/subagents/agent-*.jsonl`) additionally carry `is_subagent: true`, `agent_id`, `agent_type` and `spawn_depth` (the latter two read from the sibling `agent-<id>.meta.json`, `null` when it is missing). Their token counts are the subagent's **real** per-message `usage` — the only exactly-attributable per-mode token total. `agent_type`/`spawn_depth` may be `null` on older Claude Code versions that omit the meta file.
- **Session span vs. `duration_sec`**: `started_at`/`ended_at` mark when the session was *running*; `duration_sec` is the active clock inside it. They are derived from **different** line sets on purpose. Claude Code stamps lines when nobody is working — the `away_summary` recap (the last record in 107 of 231 local transcripts, sometimes an hour past the final turn), `--resume` bookkeeping, local slash-command echoes (`/clear` opened one session 236 minutes before its first prompt), injected `isMeta` context, `<synthetic>` placeholders, and the torn-down `Tool permission request failed: AbortError` result. Those set neither end of the span. They ARE still counted for `duration_sec`, because an attachment written mid-turn is real evidence the agent was working — filtering them there under-counted billed time by 2.7%. Line numbers are never filtered, so `segmentId` ranges stay stable and a live-reported session still upserts onto its row when the backfill re-reads it.
- **Timeline states (`periods[*].state`)**: `working`, `planning`, `waiting_user`, `idle`, and `break`. **`break` is newer than the others — a client that does not know it must not drop the period or fail to render.** It marks a gap of at least 6h (`BREAK_GAP_SEC`), meaning the session was abandoned and later resumed rather than waited on; locally 16 such bands are 45% of all charted time, so charting them as `waiting_user` made a session look days long. The test is duration only, never a calendar-day boundary: a 23:50→00:20 pause is 30 minutes of stepping away and stays `waiting_user`. A gap ending at a subagent `<task-notification>` stays `idle` at any length — the main thread was blocked on its own agent, which is real work. `started_at`/`ended_at` still span the break; nothing is deleted. `waiting_user` also covers every wait the agent spends blocked on a **human decision**, even though the answer arrives as a `tool_result` rather than a turn-start and so used to fall through to `idle` or `planning`: a pending **`AskUserQuestion`**, an **`ExitPlanMode`** plan awaiting approval or rejection, and a **declined permission prompt** (the `The user doesn't want to proceed with this tool use` result, which any tool can return). Presenting a plan ends the planning — what follows is the human deciding — so this deliberately moves plan-approval waits out of `planning`. `idle` is then exactly what it claims: the gap between two AGENT activities with no human action in between. Across 228 local transcripts all 547 idle bands are agent-closed (subagent completions, tool results, assistant turns) and all 981 `waiting_user` bands are human-closed. Ordinary tool_results are unaffected — a 22-minute `Bash` build, or one that fails with `Exit code 128`, is still `idle`, not the human deciding. A decision left unanswered past `BREAK_GAP_SEC` is still a `break`.
- **Reasoning effort (`models[*].by_effort`)**: each `models` entry carries an optional `by_effort` record — `{ "<effort>": { token_input, token_output, token_cache_read, token_cache_creation, requests } }` — read from the transcript's top-level per-message `effort` field (an **open vocabulary**: `medium`/`high`/`xhigh`/`max` today, new values may appear with Claude Code releases). Lines without the field (older Claude Code versions) land in the `"unknown"` bucket, so the buckets always partition the parent model tally. Servers must treat unknown effort keys as data, not reject them.
