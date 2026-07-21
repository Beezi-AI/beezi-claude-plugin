# Subscription / Plan Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture the user's Claude subscription tier + rate-limit multiplier (Pro / Max 5x / Max 20x / Team / Enterprise) from Claude Code's local credentials, without touching tokens, and record it on every Beezi analytics report.

**Architecture:** The model (during `/beezi:login` and `/beezi:refresh`) extracts only `subscriptionType` + `rateLimitTier` + `expiresAt` via an in-shell filter and hands them to a plugin writer that persists `~/.beezi/billing.json`. The `PostToolUse` checkpoint reads that cache and attaches the plan to each queued report. `SessionStart` nudges a refresh when the cache is stale. The API adds three nullable fields to the report contract and the `analytics` row.

**Tech Stack:** Node ESM + `node --test` (plugin); NestJS 10 + TypeORM + `class-validator` + Jest (api).

## Global Constraints

- Plugin: Node ESM, `type: module`; tests use `node:test` + `node:assert/strict`; run with `npm test` (`node --test`) in `beezi-analytics-plugin/`.
- API: TypeScript strict; no `any`/`unknown`; API interfaces are `I`-prefixed; interfaces in dedicated files; model status/tier as **enum**, never string-union; file/dir names kebab-case; tests via `npx jest <pattern>` in `api/`.
- **Tokens are never read into a plugin script, logged, transmitted, or printed.** Only `subscriptionType`, `rateLimitTier`, `expiresAt` ever leave the credentials source.
- Migrations: create with `npm run migration:create AddClaudeCodeSubscriptionPlan` (bare name — the script stamps timestamp + class; do not hand-write the filename or full path).
- **Commits are gated:** the repo owner's standing rule is do NOT `git commit`/`push` unless the user explicitly approves. Each task's final step stages changes; hold the commit until approved.
- New fields are optional (DTO) + nullable (entity), so old plugin → new API is safe. New plugin → old API is NOT safe: the API's `forbidNonWhitelisted: true` ValidationPipe 400s unknown keys and `flushQueue` drops 4xx permanently → data loss. **Deploy the API (migration + DTO) before the updated plugin.**

---

## File Structure

**API (`hb-ai-agent-portal/api/`)**
- Create `src/domain/enums/claude-code-subscription-plan.enum.ts` — normalized plan enum.
- Modify `src/application/claude-code/dto/session-report.request.dto.ts` — 3 optional fields.
- Create `src/application/claude-code/dto/session-report.request.dto.spec.ts` — DTO validation test.
- Modify `src/domain/entities/analytics.entity.ts` — 3 nullable columns.
- Create `src/infrastructure/persistence/migrations/<ts>-AddClaudeCodeSubscriptionPlan.ts` — enum type + columns.
- Modify `src/infrastructure/persistence/repositories/analytics.repository.types.ts` — 3 fields on the upsert input.
- Modify `src/application/claude-code/services/session-report.service.ts` — pass fields through.
- Modify `src/application/claude-code/services/session-report.service.spec.ts` — assertions.

**Plugin (`beezi-analytics-plugin/`)**
- Modify `lib/billing.mjs` — fuller precedence + `normalizePlan`.
- Modify `lib/paths.mjs` — `billingConfigFile()`.
- Create `lib/billing-config.mjs` — read/write/isStale/`subscriptionReportFields`.
- Create `lib/billing-capture.mjs` — `parseArgs` / `safeField` / `buildConfig` (pure).
- Create `scripts/billing-capture.mjs` — thin CLI wrapper.
- Modify `lib/checkpoint.mjs` — attach plan fields to the payload.
- Modify `lib/session-start.mjs` — stale-plan nudge.
- Create `commands/refresh.md` — model extract + capture.
- Modify `commands/login.md` — Step 3 capture + `allowed-tools`.
- Create tests: `test/billing-config.test.mjs`, `test/billing-capture.test.mjs`; extend `test/billing.test.mjs`, `test/session-start.test.mjs`.

---

## Task 1: Subscription plan enum + report DTO fields (API)

**Files:**
- Create: `api/src/domain/enums/claude-code-subscription-plan.enum.ts`
- Modify: `api/src/application/claude-code/dto/session-report.request.dto.ts`
- Test: `api/src/application/claude-code/dto/session-report.request.dto.spec.ts`

**Interfaces:**
- Produces: `enum ClaudeCodeSubscriptionPlan { FREE='free', PRO='pro', MAX_5X='max_5x', MAX_20X='max_20x', MAX='max', TEAM='team', ENTERPRISE='enterprise', UNKNOWN='unknown' }`; DTO gains `subscription_type?: string`, `rate_limit_tier?: string`, `subscription_plan?: ClaudeCodeSubscriptionPlan`.

- [ ] **Step 1: Create the enum**

`api/src/domain/enums/claude-code-subscription-plan.enum.ts`:
```ts
export enum ClaudeCodeSubscriptionPlan {
    FREE = 'free',
    PRO = 'pro',
    MAX_5X = 'max_5x',
    MAX_20X = 'max_20x',
    MAX = 'max', // subscriptionType=max with an unknown multiplier
    TEAM = 'team',
    ENTERPRISE = 'enterprise',
    UNKNOWN = 'unknown',
}
```

- [ ] **Step 2: Write the failing DTO test**

`api/src/application/claude-code/dto/session-report.request.dto.spec.ts`:
```ts
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SessionReportRequestDto } from './session-report.request.dto';
import { ClaudeCodeSubscriptionPlan } from '../../../domain/enums/claude-code-subscription-plan.enum';

const base = {
    segmentId: 's',
    sessionId: 'x',
    remote: 'r',
    branch: 'b',
    from_line: 0,
    to_line: 1,
    models: {},
    token_total: 0,
    token_input: 0,
    token_output: 0,
    token_cache: 0,
    duration_sec: 0,
};

const validateDto = (patch: Record<string, unknown>) =>
    validate(plainToInstance(SessionReportRequestDto, { ...base, ...patch }));

describe('SessionReportRequestDto — subscription fields', () => {
    it('accepts valid subscription fields', async () => {
        const errors = await validateDto({
            subscription_type: 'pro',
            rate_limit_tier: 'default_claude_max_5x',
            subscription_plan: ClaudeCodeSubscriptionPlan.MAX_5X,
        });
        expect(errors).toHaveLength(0);
    });

    it('rejects an unknown subscription_plan value', async () => {
        const errors = await validateDto({ subscription_plan: 'platinum' });
        expect(errors.some((e) => e.property === 'subscription_plan')).toBe(true);
    });

    it('rejects a subscription_type over 50 chars', async () => {
        const errors = await validateDto({ subscription_type: 'x'.repeat(51) });
        expect(errors.some((e) => e.property === 'subscription_type')).toBe(true);
    });

    it('accepts the base DTO with no subscription fields', async () => {
        expect(await validateDto({})).toHaveLength(0);
    });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd api && npx jest session-report.request.dto -v`
Expected: FAIL — `subscription_plan`/`subscription_type` not yet on the DTO, so `platinum` and the 51-char string are accepted (no validation error).

- [ ] **Step 4: Add the DTO fields**

In `api/src/application/claude-code/dto/session-report.request.dto.ts`, add the import near the other enum import:
```ts
import { ClaudeCodeSubscriptionPlan } from '../../../domain/enums/claude-code-subscription-plan.enum';
```
Then add, directly after the existing `billing_source` block (after line ~93):
```ts
    @IsOptional()
    @IsString()
    @MaxLength(50)
    readonly subscription_type?: string;

    @IsOptional()
    @IsString()
    @MaxLength(100)
    readonly rate_limit_tier?: string;

    @IsOptional()
    @IsEnum(ClaudeCodeSubscriptionPlan)
    readonly subscription_plan?: ClaudeCodeSubscriptionPlan;
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd api && npx jest session-report.request.dto -v`
Expected: PASS (4 tests).

- [ ] **Step 6: Stage changes** (commit only if the user approved — see Global Constraints)

```bash
cd api && git add src/domain/enums/claude-code-subscription-plan.enum.ts src/application/claude-code/dto/session-report.request.dto.ts src/application/claude-code/dto/session-report.request.dto.spec.ts
```

---

## Task 2: Analytics entity columns + migration (API)

**Files:**
- Modify: `api/src/domain/entities/analytics.entity.ts`
- Create: `api/src/infrastructure/persistence/migrations/<ts>-AddClaudeCodeSubscriptionPlan.ts`

**Interfaces:**
- Consumes: `ClaudeCodeSubscriptionPlan` (Task 1).
- Produces: `Analytics.subscriptionType: string | null`, `Analytics.rateLimitTier: string | null`, `Analytics.subscriptionPlan: ClaudeCodeSubscriptionPlan | null`; Postgres enum type `analytics_subscription_plan_enum`.

- [ ] **Step 1: Add the entity columns**

In `api/src/domain/entities/analytics.entity.ts`, add the import beside the other enum imports:
```ts
import { ClaudeCodeSubscriptionPlan } from '../enums/claude-code-subscription-plan.enum';
```
Add, directly after the `billingSource` column block (after line ~143):
```ts
    @Column({ type: 'varchar', length: 50, name: 'subscription_type', nullable: true })
    subscriptionType: string | null;

    @Column({ type: 'varchar', length: 100, name: 'rate_limit_tier', nullable: true })
    rateLimitTier: string | null;

    @Column({
        type: 'enum',
        enum: ClaudeCodeSubscriptionPlan,
        enumName: 'analytics_subscription_plan_enum',
        name: 'subscription_plan',
        nullable: true,
    })
    subscriptionPlan: ClaudeCodeSubscriptionPlan | null;
```

- [ ] **Step 2: Create the blank migration**

Run: `cd api && npm run migration:create AddClaudeCodeSubscriptionPlan`
Expected: a new stub at `api/src/infrastructure/persistence/migrations/<timestamp>-AddClaudeCodeSubscriptionPlan.ts` with an empty `up`/`down`. (If in doubt about the workflow, use the `migrations` skill.)

- [ ] **Step 3: Fill in the migration body**

Replace the generated `up`/`down` with:
```ts
public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
        `CREATE TYPE "analytics_subscription_plan_enum" AS ENUM('free','pro','max_5x','max_20x','max','team','enterprise','unknown')`,
    );
    await queryRunner.query(`ALTER TABLE "analytics" ADD COLUMN "subscription_type" character varying(50)`);
    await queryRunner.query(`ALTER TABLE "analytics" ADD COLUMN "rate_limit_tier" character varying(100)`);
    await queryRunner.query(
        `ALTER TABLE "analytics" ADD COLUMN "subscription_plan" "analytics_subscription_plan_enum"`,
    );
}

public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "analytics" DROP COLUMN "subscription_plan"`);
    await queryRunner.query(`ALTER TABLE "analytics" DROP COLUMN "rate_limit_tier"`);
    await queryRunner.query(`ALTER TABLE "analytics" DROP COLUMN "subscription_type"`);
    await queryRunner.query(`DROP TYPE "analytics_subscription_plan_enum"`);
}
```
Keep the generated `name`/`class` line and the `import { MigrationInterface, QueryRunner } from 'typeorm';` header as stamped.

- [ ] **Step 4: Verify it compiles**

Run: `cd api && npm run build`
Expected: build succeeds (entity + migration typecheck clean).

- [ ] **Step 5: Apply the migration** (requires a local Postgres per `typeorm.config.ts`)

Run: `cd api && npm run migration:run`
Expected: the migration runs; `analytics` has the three new columns. If no local DB is available, skip and note it — the build in Step 4 is the gate for CI.

- [ ] **Step 6: Stage changes** (commit only if approved)

```bash
cd api && git add src/domain/entities/analytics.entity.ts src/infrastructure/persistence/migrations/
```

---

## Task 3: Repo input type + service passthrough (API)

**Files:**
- Modify: `api/src/infrastructure/persistence/repositories/analytics.repository.types.ts:50-76`
- Modify: `api/src/application/claude-code/services/session-report.service.ts:107-149`
- Test: `api/src/application/claude-code/services/session-report.service.spec.ts`

**Interfaces:**
- Consumes: `ClaudeCodeSubscriptionPlan` (Task 1); `Analytics` columns (Task 2).
- Produces: `IUpsertClaudeCodeAnalyticsInput` gains `subscriptionType: string | null`, `rateLimitTier: string | null`, `subscriptionPlan: ClaudeCodeSubscriptionPlan | null`. The service writes these on **every** model row (plan is a session attribute, not summed like duration).

- [ ] **Step 1: Add the fields to the upsert input type**

In `api/src/infrastructure/persistence/repositories/analytics.repository.types.ts`, add the import:
```ts
import type { ClaudeCodeSubscriptionPlan } from '../../../domain/enums/claude-code-subscription-plan.enum';
```
Add to `IUpsertClaudeCodeAnalyticsInput`, after `codeChangeSummary` (line ~75):
```ts
    subscriptionType: string | null;
    rateLimitTier: string | null;
    subscriptionPlan: ClaudeCodeSubscriptionPlan | null;
```
(No change to `analytics.repository.ts` `upsertBySourceRef` — it spreads the input straight into `ormRepository.upsert`, so the new keys map to the new entity columns by name.)

- [ ] **Step 2: Write the failing service tests**

In `api/src/application/claude-code/services/session-report.service.spec.ts`, add the import at the top:
```ts
import { ClaudeCodeSubscriptionPlan } from '../../../domain/enums/claude-code-subscription-plan.enum';
```
Add these tests inside the `describe('SessionReportService', …)` block:
```ts
it('persists subscription plan fields on every model row', async () => {
    const dto = {
        ...baseDto(),
        subscription_type: 'pro',
        rate_limit_tier: 'default_claude_max_5x',
        subscription_plan: ClaudeCodeSubscriptionPlan.MAX_5X,
        models: {
            'claude-sonnet-4-5-20250929': {
                token_input: 10, token_output: 4, token_cache_read: 0, token_cache_creation: 0, requests: 1,
            },
            'claude-haiku-4-5-20250101': {
                token_input: 6, token_output: 2, token_cache_read: 0, token_cache_creation: 0, requests: 1,
            },
        },
    } as SessionReportRequestDto;
    await service.report('user-1', 'tenant-1', dto);
    const rows = upsert.mock.calls.map((c) => c[0]);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.subscriptionType === 'pro')).toBe(true);
    expect(rows.every((r) => r.rateLimitTier === 'default_claude_max_5x')).toBe(true);
    expect(rows.every((r) => r.subscriptionPlan === ClaudeCodeSubscriptionPlan.MAX_5X)).toBe(true);
});

it('leaves subscription fields null when absent', async () => {
    await service.report('user-1', 'tenant-1', baseDto());
    const row = upsert.mock.calls[0][0];
    expect(row.subscriptionType).toBeNull();
    expect(row.rateLimitTier).toBeNull();
    expect(row.subscriptionPlan).toBeNull();
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd api && npx jest session-report.service -v`
Expected: FAIL — service does not yet set `subscriptionType`/`rateLimitTier`/`subscriptionPlan` (undefined, not `'pro'`/null-typed).

- [ ] **Step 4: Pass the fields through the service**

In `api/src/application/claude-code/services/session-report.service.ts`, inside the `this.analyticsRepository.upsertBySourceRef({ … })` object (the `modelEntries.map` call, ~line 109), add after `billingSource,`:
```ts
                    subscriptionType: dto.subscription_type ?? null,
                    rateLimitTier: dto.rate_limit_tier ?? null,
                    subscriptionPlan: dto.subscription_plan ?? null,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd api && npx jest session-report.service -v`
Expected: PASS (all existing + 2 new).

- [ ] **Step 6: Stage changes** (commit only if approved)

```bash
cd api && git add src/infrastructure/persistence/repositories/analytics.repository.types.ts src/application/claude-code/services/session-report.service.ts src/application/claude-code/services/session-report.service.spec.ts
```

---

## Task 4: Billing detection + plan normalization (plugin)

**Files:**
- Modify: `beezi-analytics-plugin/lib/billing.mjs`
- Test: `beezi-analytics-plugin/test/billing.test.mjs`

**Interfaces:**
- Produces: `detectBillingSource(env) -> 'third_party'|'anthropic_api_key'|'subscription'`; `normalizePlan(subscriptionType, rateLimitTier) -> 'free'|'pro'|'max_5x'|'max_20x'|'max'|'team'|'enterprise'|'unknown'`.

- [ ] **Step 1: Write the failing tests**

Append to `beezi-analytics-plugin/test/billing.test.mjs`:
```js
import { normalizePlan } from '../lib/billing.mjs';

test('detectBillingSource — third_party for Foundry', () => {
  assert.equal(detectBillingSource({ CLAUDE_CODE_USE_FOUNDRY: '1' }), 'third_party');
});

test('detectBillingSource — third_party for ANTHROPIC_AUTH_TOKEN (gateway)', () => {
  assert.equal(detectBillingSource({ ANTHROPIC_AUTH_TOKEN: 'tok' }), 'third_party');
});

test('detectBillingSource — subscription for CLAUDE_CODE_OAUTH_TOKEN', () => {
  assert.equal(detectBillingSource({ CLAUDE_CODE_OAUTH_TOKEN: 'oat' }), 'subscription');
});

test('normalizePlan — rateLimitTier wins for the multiplier', () => {
  assert.equal(normalizePlan('pro', 'default_claude_max_5x'), 'max_5x');
  assert.equal(normalizePlan('max', 'default_claude_max_20x'), 'max_20x');
});

test('normalizePlan — falls back to subscriptionType', () => {
  assert.equal(normalizePlan('pro', undefined), 'pro');
  assert.equal(normalizePlan('team', null), 'team');
  assert.equal(normalizePlan('enterprise', ''), 'enterprise');
  assert.equal(normalizePlan('max', 'weird_tier'), 'max');
  assert.equal(normalizePlan('free', undefined), 'free');
});

test('normalizePlan — unknown when nothing matches', () => {
  assert.equal(normalizePlan(undefined, undefined), 'unknown');
  assert.equal(normalizePlan('mystery', 'mystery'), 'unknown');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd beezi-analytics-plugin && npm test`
Expected: FAIL — `normalizePlan` is not exported; Foundry/AUTH_TOKEN/OAUTH cases return `subscription`.

- [ ] **Step 3: Implement**

Replace `beezi-analytics-plugin/lib/billing.mjs` with:
```js
// Detect how Claude Code is authenticated, from the environment.
// Precedence mirrors Claude Code: cloud providers → gateway/auth token → API key → subscription.
export function detectBillingSource(env = process.env) {
  if (env.CLAUDE_CODE_USE_BEDROCK || env.CLAUDE_CODE_USE_VERTEX || env.CLAUDE_CODE_USE_FOUNDRY) {
    return 'third_party';
  }
  if (env.ANTHROPIC_BASE_URL || env.ANTHROPIC_AUTH_TOKEN) return 'third_party';
  if (env.ANTHROPIC_API_KEY) return 'anthropic_api_key';
  // CLAUDE_CODE_OAUTH_TOKEN (CI) and the default interactive login both bill the subscription.
  return 'subscription';
}

// Normalize the local credential fields to a plan label. rateLimitTier wins for the
// Max multiplier; subscriptionType names the product. Substring match so new
// default_claude_max_* tiers degrade gracefully. Raw fields remain the source of truth.
export function normalizePlan(subscriptionType, rateLimitTier) {
  const tier = String(rateLimitTier ?? '').toLowerCase();
  if (tier.includes('max_20x')) return 'max_20x';
  if (tier.includes('max_5x')) return 'max_5x';
  const type = String(subscriptionType ?? '').toLowerCase();
  if (type === 'enterprise') return 'enterprise';
  if (type === 'team') return 'team';
  if (type === 'max') return 'max';
  if (type === 'pro') return 'pro';
  if (type === 'free') return 'free';
  return 'unknown';
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd beezi-analytics-plugin && npm test`
Expected: PASS (existing billing tests + 6 new).

- [ ] **Step 5: Stage changes** (commit only if approved)

```bash
cd beezi-analytics-plugin && git add lib/billing.mjs test/billing.test.mjs
```

---

## Task 5: Billing config store (plugin)

**Files:**
- Modify: `beezi-analytics-plugin/lib/paths.mjs`
- Create: `beezi-analytics-plugin/lib/billing-config.mjs`
- Test: `beezi-analytics-plugin/test/billing-config.test.mjs`

**Interfaces:**
- Consumes: `beeziHome()` (paths.mjs).
- Produces: `billingConfigFile() -> string`; `readBillingConfig() -> object|null`; `writeBillingConfig(obj) -> void`; `isStale(config, now?, staleMs?) -> boolean`; `subscriptionReportFields(billingSource, config) -> {subscription_type,rate_limit_tier,subscription_plan}|{}`.

- [ ] **Step 1: Add the path helper**

In `beezi-analytics-plugin/lib/paths.mjs`, add after `credentialsFile()`:
```js
export function billingConfigFile() {
  return path.join(beeziHome(), 'billing.json');
}
```

- [ ] **Step 2: Write the failing tests**

`beezi-analytics-plugin/test/billing-config.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readBillingConfig,
  writeBillingConfig,
  isStale,
  subscriptionReportFields,
} from '../lib/billing-config.mjs';

function withTempHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-billing-'));
  const prev = process.env.BEEZI_HOME;
  process.env.BEEZI_HOME = dir;
  try { return fn(dir); } finally {
    if (prev === undefined) delete process.env.BEEZI_HOME; else process.env.BEEZI_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('write then read round-trips the config', () => {
  withTempHome(() => {
    const cfg = { version: 1, source: 'subscription', plan: 'max_5x' };
    writeBillingConfig(cfg);
    assert.deepEqual(readBillingConfig(), cfg);
  });
});

test('readBillingConfig returns null when absent', () => {
  withTempHome(() => assert.equal(readBillingConfig(), null));
});

const DAY = 24 * 60 * 60 * 1000;

test('isStale — false for non-subscription source', () => {
  assert.equal(isStale({ source: 'anthropic_api_key' }), false);
});

test('isStale — true when plan missing or unknown', () => {
  const now = 1_000_000_000_000;
  assert.equal(isStale({ source: 'subscription', capturedAt: new Date(now).toISOString() }, now), true);
  assert.equal(isStale({ source: 'subscription', plan: 'unknown', capturedAt: new Date(now).toISOString() }, now), true);
});

test('isStale — true when credentials expired', () => {
  const now = 1_000_000_000_000;
  const cfg = { source: 'subscription', plan: 'pro', credentialsExpiresAt: now - 1, capturedAt: new Date(now).toISOString() };
  assert.equal(isStale(cfg, now), true);
});

test('isStale — true when older than the window, false when fresh', () => {
  const now = 1_000_000_000_000;
  const fresh = { source: 'subscription', plan: 'pro', capturedAt: new Date(now - 1 * DAY).toISOString() };
  const old = { source: 'subscription', plan: 'pro', capturedAt: new Date(now - 8 * DAY).toISOString() };
  assert.equal(isStale(fresh, now), false);
  assert.equal(isStale(old, now), true);
});

test('subscriptionReportFields — populated for subscription, empty otherwise', () => {
  const cfg = { subscriptionType: 'pro', rateLimitTier: 'default_claude_max_5x', plan: 'max_5x' };
  assert.deepEqual(subscriptionReportFields('subscription', cfg), {
    subscription_type: 'pro',
    rate_limit_tier: 'default_claude_max_5x',
    subscription_plan: 'max_5x',
  });
  assert.deepEqual(subscriptionReportFields('anthropic_api_key', cfg), {});
  assert.deepEqual(subscriptionReportFields('subscription', null), {});
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd beezi-analytics-plugin && npm test`
Expected: FAIL — `../lib/billing-config.mjs` does not exist.

- [ ] **Step 4: Implement**

`beezi-analytics-plugin/lib/billing-config.mjs`:
```js
import fs from 'node:fs';
import path from 'node:path';
import { billingConfigFile } from './paths.mjs';

const STALE_MS = 7 * 24 * 60 * 60 * 1000; // refresh plan info at least weekly

export function readBillingConfig() {
  try { return JSON.parse(fs.readFileSync(billingConfigFile(), 'utf-8')); }
  catch { return null; }
}

export function writeBillingConfig(obj) {
  const p = billingConfigFile();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj), { encoding: 'utf-8', mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch { /* no-op on Windows */ }
}

// Stale only matters for subscription billing: env-based sources carry no plan.
export function isStale(config, now = Date.now(), staleMs = STALE_MS) {
  if (!config || config.source !== 'subscription') return false;
  if (!config.plan || config.plan === 'unknown') return true;
  if (typeof config.credentialsExpiresAt === 'number' && config.credentialsExpiresAt <= now) return true;
  const capturedAt = Date.parse(config.capturedAt ?? '');
  if (Number.isNaN(capturedAt)) return true;
  return now - capturedAt > staleMs;
}

// The report payload keys for the subscription plan, or {} when not applicable.
export function subscriptionReportFields(billingSource, config) {
  if (billingSource !== 'subscription' || !config) return {};
  return {
    subscription_type: config.subscriptionType ?? null,
    rate_limit_tier: config.rateLimitTier ?? null,
    subscription_plan: config.plan ?? null,
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd beezi-analytics-plugin && npm test`
Expected: PASS.

- [ ] **Step 6: Stage changes** (commit only if approved)

```bash
cd beezi-analytics-plugin && git add lib/paths.mjs lib/billing-config.mjs test/billing-config.test.mjs
```

---

## Task 6: Billing capture writer (plugin)

**Files:**
- Create: `beezi-analytics-plugin/lib/billing-capture.mjs`
- Create: `beezi-analytics-plugin/scripts/billing-capture.mjs`
- Test: `beezi-analytics-plugin/test/billing-capture.test.mjs`

**Interfaces:**
- Consumes: `detectBillingSource`, `normalizePlan` (Task 4); `writeBillingConfig` (Task 5).
- Produces: `parseArgs(argv) -> {subscriptionType?,rateLimitTier?,expiresAt?,via?}`; `buildConfig(args, env?, now?) -> config object`. `buildConfig` throws on token-shaped input.

- [ ] **Step 1: Write the failing tests**

`beezi-analytics-plugin/test/billing-capture.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, buildConfig } from '../lib/billing-capture.mjs';

test('parseArgs reads the named flags', () => {
  const a = parseArgs(['--subscription-type', 'pro', '--rate-limit-tier', 'default_claude_max_5x', '--expires-at', '123', '--via', 'login']);
  assert.deepEqual(a, { subscriptionType: 'pro', rateLimitTier: 'default_claude_max_5x', expiresAt: '123', via: 'login' });
});

test('buildConfig — subscription env yields plan + raw fields', () => {
  const cfg = buildConfig(
    { subscriptionType: 'pro', rateLimitTier: 'default_claude_max_5x', expiresAt: '1754418735285', via: 'login' },
    {},
    new Date('2026-07-07T00:00:00.000Z'),
  );
  assert.equal(cfg.version, 1);
  assert.equal(cfg.source, 'subscription');
  assert.equal(cfg.subscriptionType, 'pro');
  assert.equal(cfg.rateLimitTier, 'default_claude_max_5x');
  assert.equal(cfg.plan, 'max_5x');
  assert.equal(cfg.credentialsExpiresAt, 1754418735285);
  assert.equal(cfg.capturedBy, 'login');
  assert.equal(cfg.capturedAt, '2026-07-07T00:00:00.000Z');
});

test('buildConfig — api-key env nulls the plan fields', () => {
  const cfg = buildConfig(
    { subscriptionType: 'pro', rateLimitTier: 'default_claude_max_5x', via: 'refresh' },
    { ANTHROPIC_API_KEY: 'sk-x' },
    new Date('2026-07-07T00:00:00.000Z'),
  );
  assert.equal(cfg.source, 'anthropic_api_key');
  assert.equal(cfg.subscriptionType, null);
  assert.equal(cfg.rateLimitTier, null);
  assert.equal(cfg.plan, null);
});

test('buildConfig — rejects token-shaped input', () => {
  assert.throws(() => buildConfig({ subscriptionType: 'sk-ant-oat01-secret' }, {}, new Date()));
  assert.throws(() => buildConfig({ rateLimitTier: 'x'.repeat(65) }, {}, new Date()));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd beezi-analytics-plugin && npm test`
Expected: FAIL — `../lib/billing-capture.mjs` does not exist.

- [ ] **Step 3: Implement the pure lib**

`beezi-analytics-plugin/lib/billing-capture.mjs`:
```js
import { detectBillingSource, normalizePlan } from './billing.mjs';

// The credential fields are short opaque labels. Anything token-shaped (an
// sk-ant secret, an over-long string, or embedded whitespace) is refused so a
// misdirected value can never be persisted.
const TOKEN_LIKE = /sk-ant|\s/;

function safeField(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.length > 64 || TOKEN_LIKE.test(s)) {
    throw new Error('Refusing a suspicious value (looks token-like). Nothing written.');
  }
  return s;
}

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--subscription-type') out.subscriptionType = argv[++i];
    else if (flag === '--rate-limit-tier') out.rateLimitTier = argv[++i];
    else if (flag === '--expires-at') out.expiresAt = argv[++i];
    else if (flag === '--via') out.via = argv[++i];
  }
  return out;
}

export function buildConfig(args, env = process.env, now = new Date()) {
  const subscriptionType = safeField(args.subscriptionType);
  const rateLimitTier = safeField(args.rateLimitTier);
  const via = safeField(args.via) ?? 'manual';
  const source = detectBillingSource(env);
  const isSub = source === 'subscription';
  const expiresAt = Number(args.expiresAt);
  return {
    version: 1,
    source,
    subscriptionType: isSub ? subscriptionType : null,
    rateLimitTier: isSub ? rateLimitTier : null,
    plan: isSub ? normalizePlan(subscriptionType, rateLimitTier) : null,
    credentialsExpiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
    capturedAt: now.toISOString(),
    capturedBy: via,
  };
}
```

- [ ] **Step 4: Implement the thin CLI**

`beezi-analytics-plugin/scripts/billing-capture.mjs`:
```js
import { parseArgs, buildConfig } from '../lib/billing-capture.mjs';
import { writeBillingConfig } from '../lib/billing-config.mjs';

try {
  const config = buildConfig(parseArgs(process.argv.slice(2)));
  writeBillingConfig(config);
  console.log(`✓ Beezi billing captured: source=${config.source} plan=${config.plan ?? 'n/a'}.`);
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exit(1);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd beezi-analytics-plugin && npm test`
Expected: PASS.

- [ ] **Step 6: Smoke-test the CLI end-to-end**

Run (bash):
```bash
cd beezi-analytics-plugin && BEEZI_HOME="$(mktemp -d)" node scripts/billing-capture.mjs --via login --subscription-type pro --rate-limit-tier default_claude_max_5x --expires-at 1754418735285 && echo OK
```
Expected: prints `✓ Beezi billing captured: source=subscription plan=max_5x.` then `OK`.

- [ ] **Step 7: Stage changes** (commit only if approved)

```bash
cd beezi-analytics-plugin && git add lib/billing-capture.mjs scripts/billing-capture.mjs test/billing-capture.test.mjs
```

---

## Task 7: Attach plan to the report payload (plugin)

**Files:**
- Modify: `beezi-analytics-plugin/lib/checkpoint.mjs:10-11,44,99-109`

**Interfaces:**
- Consumes: `subscriptionReportFields` (Task 5); existing `detectBillingSource` (Task 4).
- Produces: each enqueued payload carries `subscription_type` / `rate_limit_tier` / `subscription_plan` when `billing_source === 'subscription'` and a cached config exists.

- [ ] **Step 1: Import the helpers**

In `beezi-analytics-plugin/lib/checkpoint.mjs`, beside the existing `import { detectBillingSource } from './billing.mjs';` (line 10), add:
```js
import { readBillingConfig, subscriptionReportFields } from './billing-config.mjs';
```

- [ ] **Step 2: Compute the fields once per checkpoint**

Directly after `const billingSource = detectBillingSource();` (line ~44), add:
```js
  const subscriptionFields = subscriptionReportFields(billingSource, readBillingConfig());
```

- [ ] **Step 3: Spread them into the enqueued payload**

In the `enqueue({ … })` call inside the segment loop (line ~99), add after `billing_source: billingSource,`:
```js
        ...subscriptionFields,
```

- [ ] **Step 4: Run the full plugin suite (no regressions)**

Run: `cd beezi-analytics-plugin && npm test`
Expected: PASS — existing `checkpoint.test.mjs` still green; `subscriptionReportFields` is covered by Task 5.

- [ ] **Step 5: Stage changes** (commit only if approved)

```bash
cd beezi-analytics-plugin && git add lib/checkpoint.mjs
```

---

## Task 8: Stale-plan nudge on SessionStart (plugin)

**Files:**
- Modify: `beezi-analytics-plugin/lib/session-start.mjs:1-9,44-69`
- Test: `beezi-analytics-plugin/test/session-start.test.mjs`

**Interfaces:**
- Consumes: `detectBillingSource` (Task 4); `readBillingConfig`, `isStale` (Task 5).
- Produces: `runSessionStart` appends a `/beezi:refresh` nudge to its returned message when the resolved source is subscription and the cached plan is stale/missing. All three are injectable via `deps` for testing.

- [ ] **Step 1: Write the failing tests**

Add to `beezi-analytics-plugin/test/session-start.test.mjs` (follow the file's existing dep-injection style; these use explicit `deps`):
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSessionStart } from '../lib/session-start.mjs';

const okWhoami = () => ({ ok: true, status: 200, json: async () => ({ valid: true }) });
// whoami() reads body.valid !== false as valid; repos/status returns not-connected → no repo line.
const baseDeps = (over = {}) => ({
  getToken: async () => 'tok',
  deleteToken: async () => {},
  fetchImpl: async (url) => (String(url).includes('/me/claude-code/whoami') ? okWhoami() : { ok: false, status: 404, json: async () => ({}) }),
  gitImpl: () => { throw new Error('not a git repo'); },
  detectBillingSource: () => 'subscription',
  readBillingConfig: () => ({ source: 'subscription', plan: 'pro', capturedAt: new Date().toISOString() }),
  isStale: () => false,
  ...over,
});

test('SessionStart — appends a refresh nudge when the plan is stale', async () => {
  const msg = await runSessionStart({ session_id: 's1', cwd: process.cwd() }, baseDeps({ isStale: () => true }));
  assert.match(msg ?? '', /\/beezi:refresh/);
});

test('SessionStart — no nudge when the plan is fresh', async () => {
  const msg = await runSessionStart({ session_id: 's2', cwd: process.cwd() }, baseDeps({ isStale: () => false }));
  assert.equal(/\/beezi:refresh/.test(msg ?? ''), false);
});

test('SessionStart — no nudge for a non-subscription source', async () => {
  const msg = await runSessionStart(
    { session_id: 's3', cwd: process.cwd() },
    baseDeps({ detectBillingSource: () => 'anthropic_api_key', isStale: () => true }),
  );
  assert.equal(/\/beezi:refresh/.test(msg ?? ''), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd beezi-analytics-plugin && npm test`
Expected: FAIL — `runSessionStart` ignores the new deps and never emits the nudge.

- [ ] **Step 3: Implement**

In `beezi-analytics-plugin/lib/session-start.mjs`, add imports beside the existing ones (top of file):
```js
import { detectBillingSource as _detectBillingSource } from './billing.mjs';
import { readBillingConfig as _readBillingConfig, isStale as _isStale } from './billing-config.mjs';
```
Inside `runSessionStart`, add to the `deps` resolution block (near the other `deps.… ??` lines, ~line 47):
```js
  const detectBillingSource = deps.detectBillingSource ?? _detectBillingSource;
  const readBillingConfig = deps.readBillingConfig ?? _readBillingConfig;
  const isStale = deps.isStale ?? _isStale;
```
Replace the final `return systemMessage;` (line ~68) with:
```js
  let message = systemMessage;
  if (detectBillingSource() === 'subscription' && isStale(readBillingConfig())) {
    const nudge = 'Beezi: subscription plan info is missing or stale — run /beezi:refresh to update it.';
    message = message ? `${message}\n${nudge}` : nudge;
  }
  return message;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd beezi-analytics-plugin && npm test`
Expected: PASS (existing session-start tests + 3 new).

- [ ] **Step 5: Stage changes** (commit only if approved)

```bash
cd beezi-analytics-plugin && git add lib/session-start.mjs test/session-start.test.mjs
```

---

## Task 9: `/beezi:refresh` command + login Step 3 (plugin)

**Files:**
- Create: `beezi-analytics-plugin/commands/refresh.md`
- Modify: `beezi-analytics-plugin/commands/login.md`

**Interfaces:**
- Consumes: `scripts/billing-capture.mjs` (Task 6).
- Produces: two model-facing commands that extract only the 3 safe fields via an in-shell filter and call the writer.

- [ ] **Step 1: Create the refresh command**

`beezi-analytics-plugin/commands/refresh.md`:
```markdown
---
description: Refresh this machine's Claude subscription/plan for Beezi analytics
allowed-tools: Bash(node:*), Bash(security:*)
---

Extract ONLY the subscription plan fields and store them. NEVER print the
credentials file, the access token, or the refresh token.

macOS — run:

`security find-generic-password -s "Claude Code-credentials" -w | node -e "const c=JSON.parse(require('fs').readFileSync(0,'utf8')).claudeAiOauth;process.stdout.write(JSON.stringify({subscriptionType:c.subscriptionType,rateLimitTier:c.rateLimitTier,expiresAt:c.expiresAt}))"`

Linux or Windows — run:

`node -e "const fs=require('fs'),os=require('os'),p=(process.env.CLAUDE_CONFIG_DIR||os.homedir()+'/.claude')+'/.credentials.json';const c=JSON.parse(fs.readFileSync(p,'utf8')).claudeAiOauth;process.stdout.write(JSON.stringify({subscriptionType:c.subscriptionType,rateLimitTier:c.rateLimitTier,expiresAt:c.expiresAt}))"`

That prints a small JSON object `{subscriptionType, rateLimitTier, expiresAt}` and
no token. Pass those values to the writer (omit any flag whose value is missing):

`node ${CLAUDE_PLUGIN_ROOT}/scripts/billing-capture.mjs --via refresh --subscription-type <subscriptionType> --rate-limit-tier <rateLimitTier> --expires-at <expiresAt>`

Report the writer's one-line summary. If the extractor errors or prints nothing
(no subscription credentials present), tell the user and stop — run nothing else.
```

- [ ] **Step 2: Update the login command frontmatter + add Step 3**

In `beezi-analytics-plugin/commands/login.md`, change the frontmatter `allowed-tools` line to:
```
allowed-tools: Bash(node:*), Bash(security:*)
```
Change the opening guard line from `Do NOT read, open, or inspect any files. Run only the two commands below.` to:
```
For Steps 1 and 2, do NOT read, open, or inspect any files — run only the given
commands. Step 3 has its own narrow, token-safe extraction.
```
Append at the end of the file:
```markdown

Step 3 — capture the subscription plan for analytics (only if Step 2 linked
successfully; skip if the machine was already linked):

Extract ONLY the plan fields as in `/beezi:refresh` (run the OS-appropriate
one-liner; never print the credentials file or any token), then:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/billing-capture.mjs --via login --subscription-type <subscriptionType> --rate-limit-tier <rateLimitTier> --expires-at <expiresAt>`

Report the writer's summary. If the extractor prints nothing, skip silently — the
link itself already succeeded.
```

- [ ] **Step 3: Verify the commands are well-formed + writer still runs**

Run: `cd beezi-analytics-plugin && npm test`
Expected: PASS (full suite; if a manifest/smoke test enumerates commands it now includes `refresh.md`).

Run (bash) to confirm the writer path the commands call is valid:
```bash
cd beezi-analytics-plugin && BEEZI_HOME="$(mktemp -d)" node scripts/billing-capture.mjs --via refresh --subscription-type max --rate-limit-tier default_claude_max_20x --expires-at 1754418735285
```
Expected: `✓ Beezi billing captured: source=subscription plan=max_20x.`

- [ ] **Step 4: Stage changes** (commit only if approved)

```bash
cd beezi-analytics-plugin && git add commands/refresh.md commands/login.md
```

---

## Deferred to a follow-up plan (Phase 2 — device-level current plan)

Out of scope here; ships independently. When picked up:
- `POST /me/claude-code/billing` on the Claude Code controller (guarded by the existing Claude Code token guard); body `{ source, subscriptionType, rateLimitTier, plan }`.
- `billing-capture.mjs` posts the snapshot best-effort (non-fatal, short timeout) after writing the config.
- Nullable columns on `claude-code-token.entity.ts` (`subscription_type`, `rate_limit_tier`, `subscription_plan`, `billing_source`, `billing_captured_at`) + migration; `whoami` returns the current plan for `/beezi:me`.
- Optional `BEEZI_AUTO_REFRESH_BILLING=1` path: SessionStart injects `additionalContext` to auto-run `/beezi:refresh`, gated to once per staleness window (persist `lastNudgeAt` in `billing.json`). Requires changing the `session-start.mjs` return contract to carry `additionalContext` — hence deferred.

---

## Self-Review

**Spec coverage:**
- Data source (`subscriptionType`+`rateLimitTier`+`expiresAt`, no tokens) → Tasks 6/9 (filter + writer).
- Secure in-shell read → Task 9 command one-liners.
- Fuller `detectBillingSource` precedence → Task 4.
- `normalizePlan` table (tier wins) → Task 4.
- `~/.beezi/billing.json` schema + staleness → Task 5.
- Writer with token-shaped rejection → Task 6.
- checkpoint payload fields → Task 7.
- SessionStart cache-first + nudge → Task 8.
- `/beezi:refresh` + login Step 3 → Task 9.
- API enum + DTO + entity + migration + repo + service → Tasks 1/2/3.
- Phase 2 device bind + auto-refresh → explicitly deferred.

**Placeholder scan:** none — every code step carries full content.

**Type consistency:** `subscription_type`/`rate_limit_tier`/`subscription_plan` (snake_case) on the wire + DTO; `subscriptionType`/`rateLimitTier`/`subscriptionPlan` (camelCase) on entity + upsert input; `plan` on the local `billing.json`; `subscriptionReportFields` returns the snake_case wire keys used by `checkpoint.mjs`. `ClaudeCodeSubscriptionPlan` values match the migration enum literals and `normalizePlan` return strings exactly.
