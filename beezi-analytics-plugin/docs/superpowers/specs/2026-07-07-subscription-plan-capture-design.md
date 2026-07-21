# Subscription / plan capture for Beezi analytics

**Date:** 2026-07-07
**Status:** Implemented; extraction source revised (see Revision below).
**Scope:** spans two repos — `beezi-analytics-plugin` (this repo) and `hb-ai-agent-portal/api`.

## Revision (2026-07-07): extraction reads `~/.claude.json` oauthAccount, not `.credentials.json`

**Why:** The original design had the model run an inline shell filter to read
`.credentials.json` and pass the fields to the writer. In practice the model did
NOT run the given command — it improvised a PowerShell command against the wrong
path (`~/.beezi/credentials.json`, Beezi's own token store) and captured nothing.
Root cause: relying on the model to run a specific inline command is unreliable —
it can and did rewrite the path/shell.

**Fix (supersedes the "Security refinement" and command sections below):**
- Extraction now reads **`~/.claude.json` → `oauthAccount`** — Claude Code's main
  config, a plain file on **every** platform (incl. macOS; no Keychain), containing
  **no access/refresh token**. Fields: `billingType`, `seatTier`, `organizationType`,
  `userRateLimitTier`/`organizationRateLimitTier`. `subscription_type` is derived
  (`claude_team`→team, `claude_enterprise`→enterprise, else max/pro/free from
  `seatTier`); `rate_limit_tier` = `userRateLimitTier` (still yields max_5x/20x via
  `normalizePlan`). This is token-free and kills the macOS Keychain problem.
- A **deterministic script** does the read: `lib/claude-account.mjs`
  `readClaudeAccount()` (reads only `oauthAccount`, never tokens) →
  `scripts/billing-capture.mjs --from-claude`. The commands (`/beezi:refresh`,
  `/beezi:login` Step 3) now instruct the model to run **exactly one fixed command**
  (`node …/billing-capture.mjs --from-claude --via <login|refresh>`) — no inline
  filter for the model to rewrite. `allowed-tools` reduced to `Bash(node:*)`.
- `buildConfig` guards `expiresAt`: null/absent → `null` (not `Number(null)=0`, which
  had looked permanently expired). `~/.claude.json` carries no token expiry, so
  staleness relies on `capturedAt` age.
- Verified end-to-end on Windows against the real `~/.claude.json`:
  `source=subscription, subscriptionType=team, rateLimitTier=default_raven, plan=team`.

The sections below describe the original (superseded) `.credentials.json` approach;
kept for history.

## Problem

Beezi analytics currently records only a coarse `billing_source` per report
(`subscription` / `anthropic_api_key` / `third_party` / `unknown`), derived from
environment variables (`lib/billing.mjs`). It cannot answer "which Claude plan
is this session billing to" — Pro vs Max 5x vs Max 20x vs Team vs Enterprise.

That distinction is needed for cost/seat analytics. Claude Code stores it locally
in the OAuth credentials, but the plugin must not touch the access/refresh tokens
that sit alongside it.

## What Claude Code stores locally

- **Linux / Windows:** `~/.claude/.credentials.json` (mode 0600; `%USERPROFILE%` on
  Windows). Overridable by `CLAUDE_CONFIG_DIR`.
- **macOS:** the macOS Keychain, generic-password entry service
  `Claude Code-credentials` (no plain file). Readable only via the `security`
  CLI, which prompts an unrecognized caller — a non-interactive hook cannot read
  it silently.

Shape:

```json
{
  "claudeAiOauth": {
    "accessToken": "sk-ant-oat01-…",
    "refreshToken": "sk-ant-ort01-…",
    "expiresAt": 1754418735285,
    "scopes": ["user:inference", "user:profile"],
    "subscriptionType": "pro",
    "rateLimitTier": "default_claude_max_5x"
  }
}
```

Fields we want, and **only** these three: `subscriptionType`, `rateLimitTier`,
`expiresAt`. The two tokens must never leave the credentials source — not into a
plugin script, not into the model's context, not into a transcript, not onto the wire.

`rateLimitTier` is the reliable signal for the Max multiplier (`default_claude_max_5x`,
`default_claude_max_20x`, …). `subscriptionType` names the product. They can
disagree (the sample above has `pro` + `max_5x`); we keep both raw and treat the
raw pair as the source of truth.

## Auth-mode precedence (for `billing_source`)

Claude Code resolves the active auth method in this order; the highest match bills:

1. Cloud provider env: `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`,
   `CLAUDE_CODE_USE_FOUNDRY`
2. `ANTHROPIC_AUTH_TOKEN` (LLM-gateway bearer)
3. `ANTHROPIC_API_KEY`
4. `apiKeyHelper` script output
5. `CLAUDE_CODE_OAUTH_TOKEN` (long-lived, CI)
6. Subscription OAuth from `/login`

A Claude-apps gateway session outranks all of the above.

The subscription plan is only meaningful when the resolved source is subscription
(6). For any of 1–5, plan is `null`.

## Design decisions (locked)

1. **Plan granularity:** capture `subscriptionType` + `rateLimitTier`; normalize to a
   best-effort plan; keep both raw fields.
2. **Read mechanism:** model-mediated. Plugin scripts never open the token source.
3. **Session revalidation:** cache-first; refresh nudge when stale.
4. **Backend shape:** raw pair + normalized enum on the analytics row.

## Security refinement to the model-mediated read

A naive "model reads the file" puts the tokens into the model's context and the
session transcript on disk. To avoid that while still keeping plugin scripts away
from the token source, the model runs an **in-shell filter** that emits only the
three safe fields; the tokens are dropped in-process and never reach the model:

```bash
# Linux / Windows (respects CLAUDE_CONFIG_DIR):
node -e "const fs=require('fs'),os=require('os'),p=(process.env.CLAUDE_CONFIG_DIR||os.homedir()+'/.claude')+'/.credentials.json';const c=JSON.parse(fs.readFileSync(p,'utf8')).claudeAiOauth;process.stdout.write(JSON.stringify({subscriptionType:c.subscriptionType,rateLimitTier:c.rateLimitTier,expiresAt:c.expiresAt}))"

# macOS (Keychain → same filter on stdin):
security find-generic-password -s "Claude Code-credentials" -w | node -e "const c=JSON.parse(require('fs').readFileSync(0,'utf8')).claudeAiOauth;process.stdout.write(JSON.stringify({subscriptionType:c.subscriptionType,rateLimitTier:c.rateLimitTier,expiresAt:c.expiresAt}))"
```

The `node -e` one-liner is an inline command the model runs, not a bundled plugin
script — it satisfies "no plugin script opens the token source" while keeping the
extraction narrow. The model passes the three filtered values to the writer
(`billing-capture.mjs`); it never echoes the credential source.

Residual risk (documented, accepted): on Linux/Win the inline command reads the
file. If a stricter "nothing reads the token file" posture is later required, the
only alternative is worse (model reads raw → token in context). This is the
minimal-exposure path.

## Data flow

```
/beezi:login  ──► device link (existing) ──► Step 3: in-shell filter ──► billing-capture.mjs
                                                                              │
                                                                              ├─► write ~/.beezi/billing.json (0600)
                                                                              └─► POST /me/claude-code/billing  (Phase 2 bind)

SessionStart hook ──► detectBillingSource(env)         (every session, cheap)
                  └─► read billing.json; if source=subscription & stale ──► inject refresh nudge

PostToolUse checkpoint ──► read billing.json ──► attach subscription_type / rate_limit_tier /
                                                 subscription_plan to each queued report
                                              ──► POST /sessions/report  (existing)

/beezi:refresh ──► in-shell filter ──► billing-capture.mjs   (manual re-capture; reused by nudge)
```

## Plugin changes (`beezi-analytics-plugin/`)

### `lib/billing.mjs`
- Extend `detectBillingSource(env)` to the full precedence above. Mapping into the
  existing 4-value enum (no new enum values): Bedrock/Vertex/Foundry → `third_party`;
  `ANTHROPIC_AUTH_TOKEN` → `third_party` (gateway); `ANTHROPIC_API_KEY` → `anthropic_api_key`;
  `CLAUDE_CODE_OAUTH_TOKEN` → `subscription`; else `subscription`.
- Add `normalizePlan(subscriptionType, rateLimitTier)` → normalized plan string
  (see Normalization). Pure, deterministic, no I/O.

### `lib/billing-config.mjs` (new)
- `readBillingConfig()` → parsed `~/.beezi/billing.json` or `null`.
- `writeBillingConfig(obj)` → 0600 write (mirror `credentials.mjs` file-write: mkdir,
  `mode: 0o600`, `chmodSync` fallback).
- `isStale(config, now)` → `true` when `source === 'subscription'` and
  (`plan` absent, or `credentialsExpiresAt` in the past, or `capturedAt` older than
  the staleness window, default 7 days). Window is a module constant.

### `lib/paths.mjs`
- Add `billingConfigFile()` → `path.join(beeziHome(), 'billing.json')`.

### `scripts/billing-capture.mjs` (new)
CLI writer, invoked by the model with the three filtered values:
`node scripts/billing-capture.mjs --subscription-type <t> --rate-limit-tier <r> --expires-at <ms>`
(all optional; missing → recorded as unknown/null).
- **Reject token-shaped input:** refuse any arg matching `sk-ant`, longer than a small
  bound (e.g. 64 chars), or containing whitespace/newlines. Fail closed with a clear
  message; never write a suspect value.
- Compute `source` via `detectBillingSource()` and `plan` via `normalizePlan()`.
- Write `billing.json` with `capturedBy` set from a `--via` flag (`login` / `refresh` /
  `session-start`), `capturedAt` = ISO now.
- **Phase 2:** POST the snapshot to `/me/claude-code/billing` (best-effort, non-fatal,
  short timeout) to bind current plan to the device.
- Never print any token; never echo the credential source. Print a one-line summary.

### `commands/refresh.md` (new)
Slash command. `allowed-tools` scoped to `Bash(node:*)`, `Bash(security:*)`. Instructs
the model to: detect OS → run the in-shell filter → call `billing-capture.mjs --via refresh`
with the emitted values. Explicit rule: never print the credential file or any token.

### `commands/login.md`
Add **Step 3** after a successful link: run the same filter + `billing-capture.mjs --via login`
so the plan is "fully defined at link time." Keep the existing "do not read files"
guard for Steps 1–2; Step 3 carries its own narrow, token-safe instructions.

### `lib/checkpoint.mjs`
- Read `billing.json` once per checkpoint (alongside `detectBillingSource()`).
- Add to each enqueued payload: `subscription_type`, `rate_limit_tier`,
  `subscription_plan` — populated only when the resolved `billing_source` is
  `subscription`; otherwise `null`/omitted. `billing_source` stays as-is (env-derived,
  authoritative per report).

### `lib/session-start.mjs`
- Use the upgraded `detectBillingSource`.
- After the existing repo-status announce: if source is subscription and
  `isStale(readBillingConfig())`, append a **user-facing nudge** to the systemMessage:
  `Beezi: subscription plan info is missing/stale — run /beezi:refresh to update.`
- **Auto-refresh (config-gated, default off):** when
  `BEEZI_AUTO_REFRESH_BILLING=1`, instead inject `additionalContext` instructing the
  model to run `/beezi:refresh`, gated to at most once per staleness window (persist a
  `lastNudgeAt` in `billing.json` to bound frequency). Default remains the passive
  user nudge to avoid surprise credential-permission prompts at session start.

### Tests (mirror existing `test/*.test.mjs` node:test style)
- `billing.test.mjs`: extend for new precedence; add `normalizePlan` cases (each tier,
  disagreeing pair, unknown, missing).
- `billing-config.test.mjs` (new): read/write round-trip, 0600, `isStale` boundaries
  (missing plan, expired `expiresAt`, aged `capturedAt`, fresh).
- `billing-capture.test.mjs` (new): arg parsing, token-shaped rejection, config output,
  `--via` values.
- `checkpoint.test.mjs`: assert new fields present when subscription, null otherwise.
- `session-start.test.mjs`: stale → nudge appended; fresh → no nudge; non-subscription → no nudge.

## API changes (`hb-ai-agent-portal/api/`)

### `domain/enums/claude-code-subscription-plan.enum.ts` (new)
```ts
export enum ClaudeCodeSubscriptionPlan {
    FREE = 'free',
    PRO = 'pro',
    MAX_5X = 'max_5x',
    MAX_20X = 'max_20x',
    MAX = 'max',            // subscriptionType=max, multiplier unknown
    TEAM = 'team',
    ENTERPRISE = 'enterprise',
    UNKNOWN = 'unknown',
}
```

### `application/claude-code/dto/session-report.request.dto.ts`
Add three optional fields:
- `subscription_type?: string` — `@IsOptional @IsString @MaxLength(50)`
- `rate_limit_tier?: string` — `@IsOptional @IsString @MaxLength(100)`
- `subscription_plan?: ClaudeCodeSubscriptionPlan` — `@IsOptional @IsEnum(...)`

### `domain/entities/analytics.entity.ts`
Three nullable columns:
- `subscription_type varchar(50)`
- `rate_limit_tier varchar(100)`
- `subscription_plan` enum (`enumName: 'analytics_subscription_plan_enum'`, nullable)

### Migration
`cd api && npm run migration:create AddClaudeCodeSubscriptionPlan` (bare name — the
script stamps timestamp + class). Hand-fill `up`/`down` to add the enum type and the
three nullable columns on `analytics`. Do not hand-write the filename.

### `analytics.repository.types.ts` + `analytics.repository.upsertBySourceRef`
Thread the three fields through the upsert input type and the column mapping.

### `application/claude-code/services/session-report.service.ts`
Pass `dto.subscription_type`, `dto.rate_limit_tier`, `dto.subscription_plan` into the
`upsertBySourceRef` call. Applies to the first model row (like `codeChangeSummary`) or
all rows — decide during implementation; first-row-only keeps per-session aggregates clean.

### Phase 2 — device-level current plan (optional)
- `POST /me/claude-code/billing` on the Claude Code controller, guarded by the existing
  Claude Code token guard; body = `{ source, subscriptionType, rateLimitTier, plan }`.
- Add matching nullable columns to `claude-code-token.entity.ts`
  (`subscription_type`, `rate_limit_tier`, `subscription_plan`, `billing_source`,
  `billing_captured_at`) + migration.
- `whoami` returns the current plan so `/beezi:me` can show it.

Phase 2 is independent of the analytics-row plan and can ship later; the core value
(per-report plan) lands in Phase 1.

## Normalization rules

`normalizePlan(subscriptionType, rateLimitTier)`, tier wins for the multiplier:

| Condition | Plan |
|---|---|
| `rateLimitTier` contains `max_20x` | `MAX_20X` |
| `rateLimitTier` contains `max_5x` | `MAX_5X` |
| `subscriptionType` = `enterprise` | `ENTERPRISE` |
| `subscriptionType` = `team` | `TEAM` |
| `subscriptionType` = `max` (no tier match) | `MAX` |
| `subscriptionType` = `pro` | `PRO` |
| `subscriptionType` = `free` | `FREE` |
| otherwise | `UNKNOWN` |

Matching is case-insensitive and substring-based on the tier so new
`default_claude_max_*` variants degrade gracefully. Raw `subscriptionType` /
`rateLimitTier` are always stored regardless of normalization outcome.

## Non-goals

- No reading, storing, transmitting, or logging of `accessToken` / `refreshToken`.
- No attempt to distinguish Max multipliers beyond what `rateLimitTier` exposes.
- No silent Keychain reads inside a non-interactive hook on macOS.
- No backend enrichment via Anthropic admin API (possible future work).

## Rollout / compatibility

- **Old plugin → new API: safe.** The three new fields are optional (DTO) and nullable
  (entity column), so a plugin that never sends them keeps working.
- **New plugin → old API: NOT safe — deploy the API first.** The API's global
  `ValidationPipe` runs with `forbidNonWhitelisted: true`, so an un-upgraded API rejects
  the unknown `subscription_*` keys with `400`. `flushQueue` treats any 4xx as a permanent
  rejection and deletes the queued segment — that is silent analytics loss, not "extra
  fields ignored." Therefore ship the API (migration + DTO) **before** the updated plugin
  reaches subscription users, the same ordering every prior report-field addition required
  (`billing_source`, `session_name`).
- `billing.json` is versioned (`version: 1`) for forward migration.
- `migration:run` must be applied in staging/prod before the new DTO fields are accepted;
  the build gate does not exercise the migration against a live database.

## Open implementation choices (decide during build, low-risk)

- First-row-only vs all-rows for the plan fields on multi-model segments.
- Exact staleness window constant (default 7 days).
- Whether `/beezi:refresh` also prints the resolved plan for user confirmation.
