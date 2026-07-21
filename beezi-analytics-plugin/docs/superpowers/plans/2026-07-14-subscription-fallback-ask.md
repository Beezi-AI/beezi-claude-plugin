# Subscription Ask-Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `/beezi:login` cannot resolve the Claude subscription automatically, ask the user their tier via AskUserQuestion and store the answer as a self-reported plan.

**Architecture:** A new validated `--plan` flag on `billing-capture` stores a self-reported plan (marked `selfReported: true`); `isStale` exempts self-reported configs from age-based staleness; `commands/login.md` gains a step 4 that asks the user and runs the exact capture command. Spec: `docs/superpowers/specs/2026-07-14-subscription-fallback-ask-design.md`.

**Tech Stack:** Node ESM (`.mjs`), built-in `node:test` runner, no dependencies.

## Global Constraints

- All commands below run from `beezi-analytics-plugin/` (the package with `"test": "node --test"`).
- Plan allowlist, exact values: `pro`, `max_5x`, `max_20x`, `team`, `enterprise` (no `free` — Claude Code cannot run on subscription billing with a free plan).
- `--plan` and `--from-claude` are mutually exclusive → error, nothing written.
- When `--plan` is present, `--subscription-type` / `--rate-limit-tier` are ignored; the plan label is the single source of derived fields.
- Self-reported configs set `selfReported: true`; auto-captured configs omit the field entirely. Config stays `version: 1`.
- `commands/login.md` keeps its existing style: "run EXACTLY this command", never read files.

---

### Task 1: `--plan` flag with allowlist in billing-capture

**Files:**
- Modify: `lib/billing-capture.mjs`
- Test: `test/billing-capture.test.mjs`

**Interfaces:**
- Consumes: `detectBillingSource`, `BillingSource` from `lib/billing.mjs` (already imported).
- Produces: `parseArgs` additionally returns `{ plan?: string }` and throws on `--plan` + `--from-claude`; `buildConfig({ plan, via }, env, now)` returns a config object with `selfReported: true`, `plan` set directly from the allowlist, `subscriptionType` derived (`max_5x`/`max_20x` → `'max'`, else the value itself), `rateLimitTier: null`, `credentialsExpiresAt: null`. Task 2 relies on the `selfReported: true` field name exactly.

- [ ] **Step 1: Write the failing tests**

Append to `test/billing-capture.test.mjs`:

```js
test('parseArgs reads --plan', () => {
  const a = parseArgs(['--plan', 'max_5x', '--via', 'login-user']);
  assert.equal(a.plan, 'max_5x');
  assert.equal(a.via, 'login-user');
});

test('parseArgs throws when --plan is combined with --from-claude', () => {
  assert.throws(() => parseArgs(['--from-claude', '--plan', 'pro']), /mutually exclusive/);
});

test('buildConfig — each self-reported plan derives type, keeps tier null, marks selfReported', () => {
  const cases = [
    ['pro', 'pro'],
    ['max_5x', 'max'],
    ['max_20x', 'max'],
    ['team', 'team'],
    ['enterprise', 'enterprise'],
  ];
  for (const [plan, type] of cases) {
    const cfg = buildConfig({ plan, via: 'login-user' }, {}, new Date('2026-07-14T00:00:00.000Z'));
    assert.equal(cfg.version, 1);
    assert.equal(cfg.source, 'subscription');
    assert.equal(cfg.plan, plan);
    assert.equal(cfg.subscriptionType, type);
    assert.equal(cfg.rateLimitTier, null);
    assert.equal(cfg.credentialsExpiresAt, null);
    assert.equal(cfg.selfReported, true);
    assert.equal(cfg.capturedBy, 'login-user');
    assert.equal(cfg.capturedAt, '2026-07-14T00:00:00.000Z');
  }
});

test('buildConfig — rejects a plan outside the allowlist', () => {
  assert.throws(() => buildConfig({ plan: 'ultra' }, {}, new Date()), /Unknown plan/);
  assert.throws(() => buildConfig({ plan: 'max' }, {}, new Date()), /Unknown plan/);
});

test('buildConfig — self-reported plan is normalized (trim + lowercase) before the exact match', () => {
  const cfg = buildConfig({ plan: ' Max_20x ' }, {}, new Date());
  assert.equal(cfg.plan, 'max_20x');
});

test('buildConfig — --plan ignores subscription-type and rate-limit-tier args', () => {
  const cfg = buildConfig(
    { plan: 'pro', subscriptionType: 'enterprise', rateLimitTier: 'default_claude_max_20x' },
    {},
    new Date(),
  );
  assert.equal(cfg.plan, 'pro');
  assert.equal(cfg.subscriptionType, 'pro');
  assert.equal(cfg.rateLimitTier, null);
});

test('buildConfig — self-reported plan under api-key env nulls the plan fields', () => {
  const cfg = buildConfig({ plan: 'pro' }, { ANTHROPIC_API_KEY: 'sk-x' }, new Date());
  assert.equal(cfg.source, 'anthropic_api_key');
  assert.equal(cfg.plan, null);
  assert.equal(cfg.subscriptionType, null);
});

test('buildConfig — auto-captured config has no selfReported key', () => {
  const cfg = buildConfig({ subscriptionType: 'pro', via: 'login' }, {}, new Date());
  assert.equal('selfReported' in cfg, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/billing-capture.test.mjs`
Expected: FAIL — `parseArgs reads --plan` fails (`a.plan` undefined), the allowlist/selfReported tests fail (no `selfReported` field, no validation throw).

- [ ] **Step 3: Implement in `lib/billing-capture.mjs`**

Add `--plan` to `parseArgs` and the mutual-exclusion check at its end:

```js
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--subscription-type') out.subscriptionType = argv[++i];
    else if (flag === '--rate-limit-tier') out.rateLimitTier = argv[++i];
    else if (flag === '--expires-at') out.expiresAt = argv[++i];
    else if (flag === '--via') out.via = argv[++i];
    else if (flag === '--plan') out.plan = argv[++i];
    else if (flag === '--from-claude') out.fromClaude = true;
  }
  // The script's --from-claude branch rebuilds args from ~/.claude.json, which would
  // silently drop a user-supplied --plan; refuse the combination up front instead.
  if (out.fromClaude && out.plan != null) {
    throw new Error('--plan and --from-claude are mutually exclusive.');
  }
  return out;
}
```

Add the allowlist above `buildConfig` and the self-reported branch at its top (existing body stays as the fallthrough, unchanged):

```js
// Self-reported plans a user can pick in the /beezi:login fallback. `free` is
// absent: Claude Code cannot run on subscription billing with a free plan.
const SELF_REPORTED_PLANS = Object.freeze(['pro', 'max_5x', 'max_20x', 'team', 'enterprise']);

export function buildConfig(args, env = process.env, now = new Date()) {
  if (args.plan != null) {
    const plan = String(args.plan).trim().toLowerCase();
    if (!SELF_REPORTED_PLANS.includes(plan)) {
      throw new Error(`Unknown plan '${args.plan}'. Valid: ${SELF_REPORTED_PLANS.join(', ')}.`);
    }
    const source = detectBillingSource(env);
    const isSub = source === BillingSource.SUBSCRIPTION;
    return {
      version: 1,
      source,
      // The plan label is the single source of the derived fields; the tier was
      // never observed, so rateLimitTier stays null rather than a synthesized value.
      subscriptionType: isSub ? (plan.startsWith('max_') ? 'max' : plan) : null,
      rateLimitTier: null,
      plan: isSub ? plan : null,
      credentialsExpiresAt: null,
      capturedAt: now.toISOString(),
      capturedBy: safeField(args.via) ?? 'manual',
      selfReported: true,
    };
  }
  const subscriptionType = safeField(args.subscriptionType);
  const rateLimitTier = safeField(args.rateLimitTier);
  const via = safeField(args.via) ?? 'manual';
  const source = detectBillingSource(env);
  const isSub = source === BillingSource.SUBSCRIPTION;
  // null/undefined/'' must stay null — Number(null) is 0, which would look like an
  // already-expired timestamp and force a permanent "stale" state.
  const expiresAt = args.expiresAt == null || args.expiresAt === '' ? NaN : Number(args.expiresAt);
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

No change to `scripts/billing-capture.mjs`: `parseArgs` throws inside the existing try/catch (exit 1, `✗` message), and a valid `--plan` flows through the existing non-`fromClaude` path into `buildConfig`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/billing-capture.test.mjs`
Expected: PASS, all tests (old and new).

- [ ] **Step 5: Run the full suite**

Run: `node --test`
Expected: PASS — no other module consumes `parseArgs`/`buildConfig`.

- [ ] **Step 6: Commit**

```bash
git add lib/billing-capture.mjs test/billing-capture.test.mjs
git commit -m "feat(billing): validated --plan flag for self-reported subscription"
```

---

### Task 2: staleness exemption for self-reported configs

**Files:**
- Modify: `lib/billing-config.mjs:16-23` (`isStale`)
- Test: `test/billing-config.test.mjs`

**Interfaces:**
- Consumes: the `selfReported: true` config field written by Task 1's `buildConfig`.
- Produces: `isStale(config, now?, staleMs?)` returns `false` for any subscription config with `selfReported: true` and a known plan, regardless of `capturedAt` age or `credentialsExpiresAt`. Signature unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `test/billing-config.test.mjs`:

```js
test('isStale — self-reported plan never goes stale by age or credential expiry', () => {
  const now = 1_000_000_000_000;
  const old = {
    source: 'subscription',
    plan: 'max_20x',
    selfReported: true,
    credentialsExpiresAt: now - 1,
    capturedAt: new Date(now - 400 * DAY).toISOString(),
  };
  assert.equal(isStale(old, now), false);
});

test('isStale — self-reported config with missing or unknown plan is still stale', () => {
  const now = 1_000_000_000_000;
  assert.equal(isStale({ source: 'subscription', selfReported: true, capturedAt: new Date(now).toISOString() }, now), true);
  assert.equal(isStale({ source: 'subscription', plan: 'unknown', selfReported: true, capturedAt: new Date(now).toISOString() }, now), true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/billing-config.test.mjs`
Expected: FAIL — `never goes stale` test fails (returns `true` today); the missing/unknown-plan test already passes (guard exists).

- [ ] **Step 3: Implement in `lib/billing-config.mjs`**

```js
// Stale only matters for subscription billing: env-based sources carry no plan.
export function isStale(config, now = Date.now(), staleMs = STALE_MS) {
  if (!config || config.source !== BillingSource.SUBSCRIPTION) return false;
  if (!config.plan || config.plan === 'unknown') return true;
  // A self-reported plan can never be re-resolved automatically, so age must not
  // invalidate it; the user re-runs /beezi:login when their tier changes.
  if (config.selfReported) return false;
  if (typeof config.credentialsExpiresAt === 'number' && config.credentialsExpiresAt <= now) return true;
  const capturedAt = Date.parse(config.capturedAt ?? '');
  if (Number.isNaN(capturedAt)) return true;
  return now - capturedAt > staleMs;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/billing-config.test.mjs`
Expected: PASS, all tests (configs without `selfReported` hit the existing paths unchanged).

- [ ] **Step 5: Run the full suite**

Run: `node --test`
Expected: PASS — `session-start.mjs` consumes `isStale` but its tests stub it or use non-self-reported configs.

- [ ] **Step 6: Commit**

```bash
git add lib/billing-config.mjs test/billing-config.test.mjs
git commit -m "feat(billing): exempt self-reported plans from age staleness"
```

---

### Task 3: login.md fallback step

**Files:**
- Modify: `commands/login.md`

**Interfaces:**
- Consumes: the `--plan` flag from Task 1 and the Step 3 output strings printed by `scripts/billing-capture.mjs` (`no Claude subscription info found`, `plan=unknown`, `source=...`).
- Produces: prompt instructions only; nothing programmatic.

- [ ] **Step 1: Append Step 4 to `commands/login.md`**

Add after the existing Step 3 paragraph, replacing its last sentence ("If it says nothing was captured, skip silently — the link itself already succeeded.") with a pointer to Step 4:

```markdown
It reads only the non-secret account info from `~/.claude.json`. Report its
one-line summary. If it could not resolve the plan, continue to Step 4.

Step 4 — ask the user their tier (ONLY when Step 3 printed
`no Claude subscription info found` or `plan=unknown`; skip this step
entirely when Step 3 printed a known plan, or when its output shows
`source=anthropic_api_key` or `source=third_party` — those machines do not
bill a subscription, so a tier question does not apply).

Ask with the AskUserQuestion tool: "Which Claude subscription do you have?"
with exactly these options: "Pro", "Max 5x", "Max 20x", "Team or Enterprise".
If they pick "Team or Enterprise", ask one follow-up question with options
"Team" and "Enterprise".

Map the final answer through this table — no other values are valid:

| Answer     | value        |
| ---------- | ------------ |
| Pro        | `pro`        |
| Max 5x     | `max_5x`     |
| Max 20x    | `max_20x`    |
| Team       | `team`       |
| Enterprise | `enterprise` |

Then run EXACTLY this command, substituting only `<value>`:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/billing-capture.mjs --plan <value> --via login-user`

Report its one-line summary. If the user dismisses the question or answers
something not in the table, skip the capture — the link itself already
succeeded, say so.
```

- [ ] **Step 2: Verify the doc end-to-end by hand**

Read the modified `commands/login.md` top to bottom and check: (a) Step 3 no longer says "skip silently" for the not-captured case; (b) every `<value>` in the table is in Task 1's allowlist `pro|max_5x|max_20x|team|enterprise`; (c) the trigger strings match `scripts/billing-capture.mjs` output literally (`no Claude subscription info found` from the script's not-found line, `plan=unknown` / `source=` from the `✓ Beezi billing captured: source=... plan=...` summary).

Then verify the command works: `node scripts/billing-capture.mjs --plan pro --via login-user`
Expected: `✓ Beezi billing captured: source=subscription plan=pro.` (run on a subscription-billed machine; afterwards restore real data with `node scripts/billing-capture.mjs --from-claude --via refresh`).

And the rejection path: `node scripts/billing-capture.mjs --plan ultra --via login-user`
Expected: exit 1, `✗ Unknown plan 'ultra'. Valid: pro, max_5x, max_20x, team, enterprise.`

- [ ] **Step 3: Commit**

```bash
git add commands/login.md
git commit -m "feat(login): ask user their subscription tier when auto-resolve fails"
```
