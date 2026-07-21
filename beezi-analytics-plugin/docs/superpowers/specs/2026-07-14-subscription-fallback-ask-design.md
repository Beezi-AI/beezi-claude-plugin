# Subscription fallback: ask the user when auto-resolve fails — Design

Date: 2026-07-14
Status: Approved

## Problem

`/beezi:login` step 3 captures the subscription plan by reading the non-secret
`oauthAccount` from `~/.claude.json`. When that fails — no account info at all,
or tier fields that normalize to `unknown` — the plan is silently not captured
and analytics reports carry no subscription tier for the machine.

## Goal

When login cannot resolve the subscription automatically, ask the user their
tier via the AskUserQuestion tool (predefined list) and store the answer as a
self-reported plan.

## Scope

- Trigger: `/beezi:login` only. `/beezi:refresh` stays automatic-only.
- Fallback fires for BOTH failure shapes: no account info found, and account
  found but plan normalizes to `unknown`.
- Fallback does NOT fire when the billing source is not `subscription`
  (`anthropic_api_key`, `third_party`): the capture output shows
  `source=...`/`plan=n/a` in that case and a tier question is meaningless.

## Behavior (`commands/login.md`)

When Step 1 reports the machine is already linked, Step 2 (the device flow) is
skipped, but Step 3 (capture) and, when triggered, Step 4 (ask-fallback) still
run. This is the escape hatch for a tier change: re-running `/beezi:login` on
an already-linked machine is the only way to update a self-reported plan, since
`/beezi:refresh` stays automatic-only and an auto-capture can never resolve a
tier a human had to pick.

Step 3 runs the auto-capture exactly as today (after a successful Step 2 link,
or directly when Step 1 reported already-linked). Branch on its one-line output:

1. `plan=<known tier>` → done, report the summary. No change.
2. `source=anthropic_api_key` or `source=third_party` → skip silently. No ask.
3. `no Claude subscription info found` OR `plan=unknown` → new step 4:
   - AskUserQuestion Q1: "Which Claude subscription do you have?" with options
     **Pro / Max 5x / Max 20x / Team or Enterprise**.
   - If "Team or Enterprise" is picked, follow-up Q2: **Team / Enterprise**.
   - Map the answer through a fixed table and run EXACTLY:
     `node ${CLAUDE_PLUGIN_ROOT}/scripts/billing-capture.mjs --plan <value> --via login-user`
     where `<value>` is one of `pro | max_5x | max_20x | team | enterprise`.
   - If the user dismisses the question, or answers "Other" with text that maps
     to none of the five values, skip the capture and report that the link
     itself succeeded (current behavior preserved).
4. `keeping the self-reported plan` (the keep-existing guard fired: fresh
   capture still `unknown`, a self-reported plan already on disk) → step 4
   still runs. An answer overwrites the old self-report via the same `--plan`
   command; a dismissal leaves the old self-report untouched. Without this
   trigger, an already-linked machine whose account never resolves could never
   update its self-reported tier — the exact population the already-linked
   escape hatch exists for.

The AskUserQuestion tool caps a question at 4 options, which is why Team and
Enterprise share a slot with a follow-up question — every real tier stays
reachable by clicks. `free` is not offered: Claude Code cannot run on
subscription billing with a free plan.

## Implementation

### `lib/billing-capture.mjs`

- `parseArgs`: accept `--plan <value>`.
- `buildConfig`, when `args.plan` is present:
  - Validate against the exact-match allowlist
    `['pro', 'max_5x', 'max_20x', 'team', 'enterprise']`. Any other value →
    throw (`Unknown plan ...`), nothing written.
  - `--plan` together with `--from-claude` → throw (mutually exclusive).
  - When `--plan` is present, `--subscription-type` and `--rate-limit-tier`
    are ignored: the plan label is the single source of the derived fields.
  - Derive stored fields from the plan label:
    - `plan`: the validated value, stored directly (no `normalizePlan` call).
    - `subscriptionType`: `max_5x`/`max_20x` → `max`; otherwise the value
      itself (`pro`, `team`, `enterprise`).
    - `rateLimitTier`: `null` — it was never observed; stay honest.
  - New config field `selfReported: true`. Auto-captured configs omit it.
  - Config stays `version: 1`: the new field is optional and old readers
    tolerate its absence.
  - Non-subscription env (`detectBillingSource() !== SUBSCRIPTION`) keeps the
    existing behavior: plan fields are nulled. login.md avoids asking in that
    case anyway.

### `lib/billing-config.mjs`

- `isStale`: configs with `selfReported: true` are never stale by capture age
  or `credentialsExpiresAt`. The missing/`unknown`-plan check stays first (it
  cannot happen through the allowlist, but the guard is kept). Result: no
  weekly `/beezi:refresh` nudge loop for a plan that auto-refresh can never
  re-resolve; the user re-runs `/beezi:login` if their tier changes.

### `commands/login.md`

- New step 4 documenting the trigger conditions, the two questions, the fixed
  answer→command table, and the skip path — in the same "run EXACTLY this
  command" style as the rest of the file.

### `scripts/billing-capture.mjs`

- `--plan` flows through the existing `parsed` args path (`--from-claude`
  replaces args only in its own branch).
- Keep-existing guard: in the `--from-claude` path, after `buildConfig` builds
  the fresh config and before `writeBillingConfig`, check
  `shouldKeepExisting(freshConfig, readBillingConfig())` (from
  `lib/billing-capture.mjs`). If true — the fresh account fields still
  normalize to `plan: 'unknown'` AND the config on disk is a self-reported
  plan — skip the write, print a one-line message, and exit 0. This stops an
  automatic `/beezi:refresh` from clobbering a self-reported plan with
  `unknown` and restarting the nudge loop the `selfReported` staleness
  exemption exists to end. A fresh capture that resolves a real plan still
  overwrites normally, self-reported or not.

## Error handling

- Invalid `--plan` value: script exits 1 with the allowlist in the message;
  nothing persisted.
- `--plan` + `--from-claude`: script exits 1.
- User declines to answer: no capture, login still reports success.

## Testing

Existing node test runner files:

- `test/billing-capture.test.mjs`: `--plan` parsing; each allowlist value
  accepted with correct derived `subscriptionType`; invalid value throws;
  `selfReported: true` set; `--plan` + `--from-claude` throws; non-subscription
  env nulls the plan fields; `shouldKeepExisting` — keeps a self-reported plan
  when the fresh capture still resolves `unknown`; overwrites when the fresh
  capture resolves a known plan; overwrites when the existing config is not
  self-reported; overwrites when there is no existing config; overwrites when
  the existing plan itself is missing or `unknown`.
- `test/billing-config.test.mjs`: `selfReported` config not stale despite old
  `capturedAt`; auto-captured config staleness unchanged; configs without the
  field behave as before.
