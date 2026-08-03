# beezi

A Claude Code plugin that hooks into session lifecycle events (SessionStart, PostToolUse, SessionEnd) to collect and report token usage analytics for Beezi task branches. On session end it ships a summary — tokens consumed, tool calls made, and branch context — to the Beezi analytics endpoint so teams can track AI-assisted development cost and throughput per task.

It also ships ticket drafting: the `create-ticket` skill (`skills/create-ticket/SKILL.md`) plus a `.mcp.json` stdio bridge (`scripts/mcp.mjs` → `lib/mcp-bridge.mjs`) that forwards MCP traffic to the Beezi server authenticated with the stored `/beezi:login` credentials — no separate MCP OAuth prompt. The skill is a thin launcher — the drafting workflow is served by the server via `get_drafting_instructions`, so it stays current without a plugin reinstall. The bridge defaults to the production Beezi API; set `BEEZI_MCP_URL` to override.

## Install

```
/plugin marketplace add <github-username>/<repo-name>
# and
/plugin install beezi@beezi
```

## Commands

- `/beezi:login` — link this machine (browser sign-in with your Beezi account via Clerk OAuth + PKCE); stores the credentials in the OS secret store, or a restricted-permission file when no store is available (see Credential storage below). After upgrading from 0.1.x, run it once — old device-flow tokens are invalid.
- `/beezi:me` — show this machine's link status (linked account).
- `/beezi:logout` — unlink this machine: asks the portal to drop it and revoke its OAuth client, then deletes the stored credentials. Falls back to revoking directly at the auth server when the portal is unreachable; always logs out locally.
- `/beezi:track` — manually save analytics for the **current** session. Tracks whatever the session touched, the same way the automatic hooks do: work outside any repo (or in a repo with no `origin`) reports under a `local:<folder>` remote rather than being refused. Runs in a UserPromptSubmit hook the moment the command is submitted and shows its result as a system message — no model round trip, so it works even when the API is down (no credits, outage). Fails only if this machine is not linked, the session transcript cannot be found, or the server rejects the report. On success shows `analytics saved for <task-… | branch | folder>`.

Analytics are otherwise tracked automatically via the session lifecycle hooks — `/beezi:track` is only needed to force a save mid-session.

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
