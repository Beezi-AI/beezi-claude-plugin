# Reflog-Joined Branch Attribution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attribute Claude Code analytics to the branch that was actually checked out at each transcript line's timestamp (via `git reflog`), emitting contiguous non-overlapping per-branch segments and never dropping beezi work at manual save.

**Architecture:** A new pure `lib/reflog.mjs` parses `git reflog` into a branch-over-time timeline. `computeDelta` (`lib/delta.mjs`) consumes that timeline, resolves each transcript line's branch by timestamp, and builds ordered contiguous runs (one segment per maximal same-branch run) instead of one min/max bucket per branch. `lib/checkpoint.mjs` builds the timeline and passes it in. `/beezi:track` logic moves to a testable `lib/track.mjs` with its current-branch gate removed.

**Tech Stack:** Node ESM (`.mjs`), `node --test` runner (no jest), no build step. `git` shelled via injected `gitImpl`.

## Global Constraints

- ESM only: all source is `.mjs`; `package.json` has `"type": "module"`. No TypeScript.
- No new runtime dependencies. `keytar` stays an optional dependency.
- Test runner is `node --test`; run all with `npm test`, one file with `node --test test/<file>`.
- **Attribution source of truth:** `git reflog` checkout events. Fall back to the transcript's per-line `gitBranch` only when the timeline is `null` (no checkout events) or a line has no `timestamp`.
- Branch tracked only when it matches `TASK_BRANCH_RE` = `/\/task-[a-zA-Z0-9_-]+/` (from `lib/git.mjs`).
- `segmentId` format is unchanged: `` `${session_id}:${fromLine}-${toLine}` ``. No payload or server changes.
- Reflog read command is exactly: `git reflog --date=iso-strict -n 1000`.
- The marketplace directory is **not a git repo yet**. Commit steps below are written for when it is initialized; if it is not, skip the `git commit` step and instead just re-run `npm test` at each task boundary. Do not run `git init` unless the user asks.

---

### Task 1: `lib/reflog.mjs` — reflog parsing + branch timeline (pure)

**Files:**
- Create: `lib/reflog.mjs`
- Test: `test/reflog.test.mjs`

**Interfaces:**
- Consumes: nothing (injected `gitImpl(args, cwd) -> string`).
- Produces:
  - `readCheckoutEvents(gitImpl, cwd) -> Array<{ ms: number, from: string, to: string }>` (ascending by `ms`)
  - `buildBranchTimeline(events) -> Array<{ ms: number, branch: string }> | null` (`null` when `events` is empty)
  - `branchAt(timeline, ms) -> string` (branch of last boundary with `boundary.ms <= ms`; assumes non-null `timeline`)

- [ ] **Step 1: Write the failing tests**

Create `test/reflog.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCheckoutEvents, buildBranchTimeline, branchAt } from '../lib/reflog.mjs';

// `git reflog --date=iso-strict` output is newest-first and mixes checkout / commit / reset.
const SAMPLE = [
  'a1 HEAD@{2026-07-03T10:10:00+00:00}: checkout: moving from feature/task-A to main',
  'b2 HEAD@{2026-07-03T10:05:00+00:00}: commit: wip',
  'c3 HEAD@{2026-07-03T10:00:00+00:00}: checkout: moving from main to feature/task-A',
  'd4 HEAD@{2026-07-03T09:50:00+00:00}: reset: moving to HEAD~1',
].join('\n');

const fakeGit = (out) => () => out;
const t = (iso) => Date.parse(iso);

test('readCheckoutEvents — only checkout lines, ascending by ms', () => {
  const events = readCheckoutEvents(fakeGit(SAMPLE), 'x');
  assert.equal(events.length, 2);
  assert.equal(events[0].from, 'main');
  assert.equal(events[0].to, 'feature/task-A');
  assert.equal(events[1].from, 'feature/task-A');
  assert.equal(events[1].to, 'main');
  assert.ok(events[0].ms < events[1].ms);
});

test('buildBranchTimeline — sentinel is first event.from; boundaries ordered', () => {
  const tl = buildBranchTimeline(readCheckoutEvents(fakeGit(SAMPLE), 'x'));
  assert.equal(tl[0].ms, -Infinity);
  assert.equal(tl[0].branch, 'main');
  assert.equal(tl[1].branch, 'feature/task-A');
  assert.equal(tl[2].branch, 'main');
});

test('buildBranchTimeline — null when no checkout events', () => {
  assert.equal(buildBranchTimeline([]), null);
  const commitsOnly = readCheckoutEvents(fakeGit('x1 HEAD@{2026-07-03T10:00:00+00:00}: commit: y'), 'x');
  assert.equal(buildBranchTimeline(commitsOnly), null);
});

test('branchAt — resolves by timestamp; checkout second belongs to the new branch', () => {
  const tl = buildBranchTimeline(readCheckoutEvents(fakeGit(SAMPLE), 'x'));
  assert.equal(branchAt(tl, t('2026-07-03T09:00:00+00:00')), 'main');
  assert.equal(branchAt(tl, t('2026-07-03T10:00:00+00:00')), 'feature/task-A');
  assert.equal(branchAt(tl, t('2026-07-03T10:03:00+00:00')), 'feature/task-A');
  assert.equal(branchAt(tl, t('2026-07-03T10:10:00+00:00')), 'main');
  assert.equal(branchAt(tl, t('2026-07-03T11:00:00+00:00')), 'main');
});

test('readCheckoutEvents — detached HEAD (to = sha) preserved verbatim', () => {
  const out = 'z9 HEAD@{2026-07-03T10:00:00+00:00}: checkout: moving from main to 1a2b3c4';
  const events = readCheckoutEvents(fakeGit(out), 'x');
  assert.equal(events[0].to, '1a2b3c4');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/reflog.test.mjs`
Expected: FAIL — `Cannot find module '../lib/reflog.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `lib/reflog.mjs`:

```javascript
// Authoritative branch-over-time timeline from `git reflog`. Used to attribute each
// transcript line to the branch that was checked out at that line's timestamp.

const CHECKOUT_RE = /HEAD@\{([^}]+)\}:\s*checkout:\s*moving from (\S+) to (\S+)/;
const REFLOG_LIMIT = 1000;

// Parse `git reflog --date=iso-strict` checkout events, ascending by time.
export function readCheckoutEvents(gitImpl, cwd) {
  const out = gitImpl(['reflog', '--date=iso-strict', '-n', String(REFLOG_LIMIT)], cwd);
  const events = [];
  for (const raw of out.split('\n')) {
    const m = CHECKOUT_RE.exec(raw);
    if (!m) continue;
    const ms = Date.parse(m[1]);
    if (Number.isNaN(ms)) continue;
    events.push({ ms, from: m[2], to: m[3] });
  }
  events.sort((a, b) => a.ms - b.ms);
  return events;
}

// Ascending boundary list, or null when there are no checkout events (→ gitBranch fallback).
export function buildBranchTimeline(events) {
  if (!events || events.length === 0) return null;
  const boundaries = [{ ms: -Infinity, branch: events[0].from }];
  for (const e of events) boundaries.push({ ms: e.ms, branch: e.to });
  return boundaries;
}

// Branch of the last boundary whose ms <= target. Assumes a non-null timeline
// (which always carries the -Infinity sentinel, so any timestamp resolves).
export function branchAt(timeline, ms) {
  let branch = timeline[0].branch;
  for (const b of timeline) {
    if (b.ms <= ms) branch = b.branch;
    else break;
  }
  return branch;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/reflog.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit** (skip if repo not initialized — see Global Constraints)

```bash
git add lib/reflog.mjs test/reflog.test.mjs
git commit -m "feat(reflog): parse git reflog into a branch-over-time timeline"
```

---

### Task 2: `lib/delta.mjs` — run-based segmentation with reflog timeline

**Files:**
- Modify: `lib/delta.mjs` (rewrite `computeDelta`; keep `summarize` and `IDLE_GAP_SEC`)
- Test: `test/delta.test.mjs` (append new tests; existing 15 tests must stay green)

**Interfaces:**
- Consumes: `branchAt(timeline, ms)` from `lib/reflog.mjs` (Task 1).
- Produces: `computeDelta(transcriptPath, fromLine, timeline = null) -> { nextCursor: number, segments: Array<{ branch, fromLine, toLine, stats }> }`. `segments` is ordered by first appearance; ranges are disjoint and non-overlapping. `stats` shape is unchanged from today (`models`, `token_input`, `token_output`, `token_cache`, `token_total`, `duration_sec`, `started_at`, `ended_at`).

- [ ] **Step 1: Write the failing tests**

Append to `test/delta.test.mjs` (keep existing helpers `writeFixture`, `assistantLine`, and existing tests):

```javascript
import { readCheckoutEvents, buildBranchTimeline } from '../lib/reflog.mjs';

// Reflog with three checkouts: main→A @10:00, A→B @10:02, B→A @10:04.
const INTERLEAVE_REFLOG = [
  'e3 HEAD@{2026-07-03T10:04:00+00:00}: checkout: moving from feature/task-B to feature/task-A',
  'e2 HEAD@{2026-07-03T10:02:00+00:00}: checkout: moving from feature/task-A to feature/task-B',
  'e1 HEAD@{2026-07-03T10:00:00+00:00}: checkout: moving from main to feature/task-A',
].join('\n');

test('R1. reflog interleave A→B→A yields three contiguous non-overlapping runs', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const timeline = buildBranchTimeline(readCheckoutEvents(() => INTERLEAVE_REFLOG, 'x'));
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

  // gitBranch is deliberately WRONG on every line — reflog must override it.
  const file = writeFixture(dir, [
    assistantLine('wrong/branch', 'model-a', usage, '2026-07-03T10:00:30.000Z'), // → task-A
    assistantLine('wrong/branch', 'model-a', usage, '2026-07-03T10:01:30.000Z'), // → task-A (+60s)
    assistantLine('wrong/branch', 'model-a', usage, '2026-07-03T10:02:30.000Z'), // → task-B
    assistantLine('wrong/branch', 'model-a', usage, '2026-07-03T10:04:30.000Z'), // → task-A
  ]);

  const { segments } = computeDelta(file, 0, timeline);

  assert.equal(segments.length, 3);
  assert.deepEqual(segments.map(s => s.branch), ['feature/task-A', 'feature/task-B', 'feature/task-A']);
  assert.deepEqual(segments.map(s => [s.fromLine, s.toLine]), [[1, 2], [3, 3], [4, 4]]);

  // Ranges disjoint & non-overlapping.
  for (let i = 1; i < segments.length; i++) {
    assert.ok(segments[i].fromLine > segments[i - 1].toLine, 'segment ranges must not overlap');
  }

  // Per-run active time: only run #1 has an intra-run 60s gap; cross-run time is NOT bridged.
  assert.equal(segments[0].stats.duration_sec, 60);
  assert.equal(segments[1].stats.duration_sec, 0);
  assert.equal(segments[2].stats.duration_sec, 0);

  // Tokens attributed per run: A#1 = 2 lines, B = 1 line, A#2 = 1 line.
  assert.equal(segments[0].stats.models['model-a'].requests, 2);
  assert.equal(segments[1].stats.models['model-a'].requests, 1);
  assert.equal(segments[2].stats.models['model-a'].requests, 1);
});

test('R2. timeline present but line missing timestamp → that line falls back to gitBranch', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const timeline = buildBranchTimeline(readCheckoutEvents(() => INTERLEAVE_REFLOG, 'x'));
  // Non-assistant line, no timestamp, gitBranch = feature/task-9 → used because ms is null.
  const line = { type: 'mode', mode: 'auto', gitBranch: 'feature/task-9' };
  const file = path.join(dir, 'fixture.jsonl');
  fs.writeFileSync(file, JSON.stringify(line), 'utf-8');

  const { segments } = computeDelta(file, 0, timeline);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].branch, 'feature/task-9');
});

test('R3. null timeline → per-line gitBranch (backward compatible)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const file = writeFixture(dir, [
    assistantLine('feature/task-1', 'model-a', usage, '2026-07-03T10:00:00.000Z'),
    assistantLine('feature/task-2', 'model-a', usage, '2026-07-03T10:01:00.000Z'),
  ]);

  const { segments } = computeDelta(file, 0, null);
  assert.deepEqual(segments.map(s => s.branch), ['feature/task-1', 'feature/task-2']);
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node --test test/delta.test.mjs`
Expected: FAIL on R1/R2/R3 (segments still bucketed by min/max branch, so R1 yields 2 merged segments not 3). Existing tests may also error once the import is added but before the rewrite — that is expected.

- [ ] **Step 3: Rewrite `computeDelta` in `lib/delta.mjs`**

Replace the entire file `lib/delta.mjs` with:

```javascript
import fs from 'node:fs';
import { branchAt } from './reflog.mjs';

const IDLE_GAP_SEC = 300;

// Attribute each new transcript line to a branch (reflog timeline when available,
// else the line's own gitBranch), and split the window into contiguous same-branch
// runs. Each maximal run becomes one segment with a disjoint fromLine..toLine range.
export function computeDelta(transcriptPath, fromLine, timeline = null) {
  const content = fs.readFileSync(transcriptPath, 'utf-8');
  const raw = content === '' ? [] : content.split('\n');
  // Claude Code logs one transcript line per content block, so the same assistant
  // message (and its usage) repeats across several lines. Count each message once.
  const countedMessages = new Set();
  const segments = [];
  let run = null;
  let processed = fromLine;
  let lineNo = 0;

  const closeRun = () => {
    if (run) {
      segments.push({ branch: run.branch, fromLine: run.fromLine, toLine: run.toLine, stats: summarize(run.models, run.timestamps) });
      run = null;
    }
  };

  for (const rawLine of raw) {
    lineNo += 1;
    if (lineNo <= fromLine) continue;
    processed = lineNo;
    if (!rawLine.trim()) continue; // blank lines are transparent to runs

    let line;
    try { line = JSON.parse(rawLine); } catch { continue; } // malformed lines transparent

    const ms = line.timestamp ? new Date(line.timestamp).getTime() : null;
    const branch = (timeline && ms != null)
      ? branchAt(timeline, ms)
      : (line.gitBranch || '(unknown)');

    if (!run || run.branch !== branch) {
      closeRun();
      run = { branch, fromLine: lineNo, toLine: lineNo, models: {}, timestamps: [] };
    }
    run.toLine = lineNo;
    if (ms != null) run.timestamps.push(ms);

    if (line.type === 'assistant' && line.message?.usage) {
      const messageKey = line.message.id ?? line.requestId ?? null;
      if (messageKey && countedMessages.has(messageKey)) continue;
      if (messageKey) countedMessages.add(messageKey);

      const model = line.message.model || 'unknown';
      const u = line.message.usage;
      const cacheCreation = u.cache_creation_input_tokens
        || Object.values(u.cache_creation || {}).reduce((a, x) => a + (x || 0), 0);
      const m = (run.models[model] ??= {
        token_input: 0, token_output: 0, token_cache_read: 0, token_cache_creation: 0, requests: 0,
      });
      m.token_input += u.input_tokens || 0;
      m.token_output += u.output_tokens || 0;
      m.token_cache_read += u.cache_read_input_tokens || 0;
      m.token_cache_creation += cacheCreation;
      m.requests += 1;
    }
  }
  closeRun();
  return { nextCursor: processed, segments };
}

function summarize(models, timestamps) {
  timestamps.sort((a, z) => a - z);
  let activeMs = 0;
  for (let i = 1; i < timestamps.length; i++) {
    const gap = timestamps[i] - timestamps[i - 1];
    if (gap > 0 && gap < IDLE_GAP_SEC * 1000) activeMs += gap;
  }
  const totals = Object.values(models).reduce((acc, m) => ({
    token_input: acc.token_input + m.token_input,
    token_output: acc.token_output + m.token_output,
    token_cache: acc.token_cache + m.token_cache_read + m.token_cache_creation,
  }), { token_input: 0, token_output: 0, token_cache: 0 });
  return {
    models,
    token_total: totals.token_input + totals.token_output + totals.token_cache,
    ...totals,
    duration_sec: Math.round(activeMs / 1000),
    started_at: timestamps.length ? new Date(timestamps[0]).toISOString() : null,
    ended_at: timestamps.length ? new Date(timestamps[timestamps.length - 1]).toISOString() : null,
  };
}
```

- [ ] **Step 4: Run the full delta suite to verify all tests pass**

Run: `node --test test/delta.test.mjs`
Expected: PASS — the original 15 tests plus R1, R2, R3. (Existing non-interleaved tests are unaffected because contiguous same-branch lines still collapse to one run.)

- [ ] **Step 5: Commit** (skip if repo not initialized)

```bash
git add lib/delta.mjs test/delta.test.mjs
git commit -m "feat(delta): run-based segmentation from reflog timeline (fixes interleave overlap)"
```

---

### Task 3: `lib/checkpoint.mjs` — build the timeline, return saved tasks

**Files:**
- Modify: `lib/checkpoint.mjs` (build timeline before `computeDelta`; collect `tasks`; return them)
- Test: `test/checkpoint.test.mjs` (append two tests; existing 14 stay green)

**Interfaces:**
- Consumes: `readCheckoutEvents`, `buildBranchTimeline` from `lib/reflog.mjs`; `taskFromBranch`, `TASK_BRANCH_RE` from `lib/git.mjs`; `computeDelta(path, cursor, timeline)` from `lib/delta.mjs`.
- Produces: `runCheckpoint(input, deps) -> { enqueued: number, flush: object | null, tasks: string[] }`. `tasks` is the de-duplicated, ordered list of `task-…` tokens enqueued by this call. `flushQueue` is unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `test/checkpoint.test.mjs` (reuse existing helpers). Add a router `gitImpl` that returns reflog output for `reflog` args and the remote otherwise:

```javascript
import { buildBranchTimeline, readCheckoutEvents } from '../lib/reflog.mjs';

function fakeGitRouter({ remote, reflog }) {
  return (args) => {
    if (args[0] === 'reflog') return reflog;
    return remote; // remote get-url origin, etc.
  };
}

const CP_INTERLEAVE_REFLOG = [
  'e3 HEAD@{2026-07-03T10:04:00+00:00}: checkout: moving from main to feature/task-A',
  'e2 HEAD@{2026-07-03T10:02:00+00:00}: checkout: moving from feature/task-A to main',
  'e1 HEAD@{2026-07-03T10:00:00+00:00}: checkout: moving from main to feature/task-A',
].join('\n');

test('15. runCheckpoint returns saved task tokens', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const transcript = writeTranscript(dir, [
    assistantLine('feature/task-7', 'model-a', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:00:00.000Z'),
  ]);

  const result = await runCheckpoint(
    { session_id: 'sess-15', transcript_path: transcript, cwd: dir },
    { getToken: async () => 'tok', gitImpl: fakeGit('https://host/org/repo.git'), fetchImpl: fakeFetch(200) },
  );

  assert.deepEqual(result.tasks, ['task-7']);
});

test('16. reflog interleave enqueues two disjoint task-A segments, skips main', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  // Lines in time order: A-work, main-work (skipped), A-work — attributed by reflog timestamps.
  const u = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const transcript = writeTranscript(dir, [
    assistantLine('whatever', 'model-a', u, '2026-07-03T10:00:30.000Z'), // → feature/task-A (after 10:00 checkout)
    assistantLine('whatever', 'model-a', u, '2026-07-03T10:02:30.000Z'), // → main (after 10:02 checkout, skipped)
    assistantLine('whatever', 'model-a', u, '2026-07-03T10:04:30.000Z'), // → feature/task-A (after 10:04 checkout)
  ]);

  const captured = [];
  const fetchImpl = async (_url, opts) => { captured.push(JSON.parse(opts.body)); return { status: 503 }; }; // keep files

  await runCheckpoint(
    { session_id: 'sess-16', transcript_path: transcript, cwd: dir },
    { getToken: async () => 'tok', gitImpl: fakeGitRouter({ remote: 'https://host/org/repo.git', reflog: CP_INTERLEAVE_REFLOG }), fetchImpl },
  );

  // main line dropped; both task-A lines enqueued as separate segments (line 2 breaks the run).
  const branches = captured.map(p => p.branch);
  assert.ok(branches.every(b => b === 'feature/task-A'), 'only task-A segments enqueued');
  assert.equal(captured.length, 2, 'two disjoint task-A segments (split by the skipped main line)');
  // Ranges disjoint.
  const ranges = captured.map(p => [p.from_line, p.to_line]).sort((a, b) => a[0] - b[0]);
  assert.ok(ranges[0][1] < ranges[1][0], 'enqueued segment ranges do not overlap');
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node --test test/checkpoint.test.mjs`
Expected: FAIL — test 15 fails (`result.tasks` is `undefined`); test 16 fails (timeline not built, reflog ignored).

- [ ] **Step 3: Modify `runCheckpoint` in `lib/checkpoint.mjs`**

Update the imports at the top of `lib/checkpoint.mjs`:

```javascript
import { git, sanitizeRemote, TASK_BRANCH_RE, taskFromBranch } from './git.mjs';
import { readCheckoutEvents, buildBranchTimeline } from './reflog.mjs';
```

Replace the body of `runCheckpoint` (the exported function) with:

```javascript
export async function runCheckpoint(input, deps = {}) {
  const { session_id, transcript_path, cwd } = input;
  const getToken = deps.getToken ?? _getToken;
  const gitImpl = deps.gitImpl ?? git;
  const computeDelta = deps.computeDelta ?? _computeDelta;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  let token = null;
  try { token = await getToken(); } catch { return { enqueued: 0, flush: null, tasks: [] }; }
  if (!token) return { enqueued: 0, flush: null, tasks: [] };

  let remote;
  try {
    remote = sanitizeRemote(gitImpl(['remote', 'get-url', 'origin'], cwd));
  } catch {
    return { enqueued: 0, flush: null, tasks: [] };
  }

  let timeline = null;
  try { timeline = buildBranchTimeline(readCheckoutEvents(gitImpl, cwd)); } catch { timeline = null; }

  const state = loadState(session_id);
  let delta;
  try { delta = computeDelta(transcript_path, state.cursor, timeline); } catch { return { enqueued: 0, flush: null, tasks: [] }; }
  const { nextCursor, segments } = delta;

  let enqueued = 0;
  const tasks = [];
  for (const seg of segments) {
    if (!TASK_BRANCH_RE.test(seg.branch)) continue;
    if (seg.stats.token_total === 0 && seg.stats.duration_sec === 0) continue;
    enqueue({
      segmentId: `${session_id}:${seg.fromLine}-${seg.toLine}`,
      sessionId: session_id,
      remote,
      branch: seg.branch,
      from_line: seg.fromLine,
      to_line: seg.toLine,
      ...seg.stats,
    });
    enqueued += 1;
    const task = taskFromBranch(seg.branch);
    if (task && !tasks.includes(task)) tasks.push(task);
  }

  if (nextCursor !== state.cursor) {
    state.cursor = nextCursor;
    saveState(session_id, state);
  }

  const flush = await flushQueue(token, { fetchImpl });
  return { enqueued, flush, tasks };
}
```

Leave `flushQueue`, `loadState`, `saveState`, and `enqueue` unchanged.

- [ ] **Step 4: Run the full checkpoint suite to verify all tests pass**

Run: `node --test test/checkpoint.test.mjs`
Expected: PASS — the original 14 plus tests 15 and 16. (Existing tests use `fakeGit`, whose `reflog` output is the remote string → no checkout events → `timeline = null` → gitBranch fallback → unchanged behavior.)

- [ ] **Step 5: Commit** (skip if repo not initialized)

```bash
git add lib/checkpoint.mjs test/checkpoint.test.mjs
git commit -m "feat(checkpoint): attribute via reflog timeline; return saved task tokens"
```

---

### Task 4: `lib/track.mjs` + `scripts/track.mjs` — remove the current-branch gate

**Files:**
- Create: `lib/track.mjs` (testable manual-save orchestration)
- Modify: `scripts/track.mjs` (thin wrapper — mirror `scripts/session-start.mjs`)
- Test: `test/track.test.mjs`

**Interfaces:**
- Consumes: `getToken` (`lib/credentials.mjs`), `runCheckpoint` (`lib/checkpoint.mjs`, returns `{ enqueued, flush, tasks }` from Task 3), `git` + `sanitizeRemote` (`lib/git.mjs`), `findCurrentTranscript` (`lib/transcript.mjs`).
- Produces: `runTrack(cwd, deps = {}) -> Promise<{ ok: boolean, message: string }>`. No dependency on the currently-checked-out branch.

- [ ] **Step 1: Write the failing tests**

Create `test/track.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTrack } from '../lib/track.mjs';

const transcript = { sessionId: 's1', transcriptPath: '/t.jsonl' };

function baseDeps(over = {}) {
  return {
    getToken: async () => 'tok',
    gitImpl: () => 'https://host/org/repo.git',
    findCurrentTranscript: () => transcript,
    runCheckpoint: async () => ({ enqueued: 1, flush: { flushed: 1, failed: 0, rejected: 0 }, tasks: ['task-A'] }),
    ...over,
  };
}

test('runTrack — saves even when HEAD is on a non-task branch (no branch gate)', async () => {
  const r = await runTrack('x', baseDeps());
  assert.equal(r.ok, true);
  assert.match(r.message, /analytics saved/);
  assert.match(r.message, /task-A/);
});

test('runTrack — nothing new to save', async () => {
  const r = await runTrack('x', baseDeps({
    runCheckpoint: async () => ({ enqueued: 0, flush: { flushed: 0 }, tasks: [] }),
  }));
  assert.equal(r.ok, true);
  assert.match(r.message, /nothing new/);
});

test('runTrack — not linked', async () => {
  const r = await runTrack('x', baseDeps({ getToken: async () => null }));
  assert.equal(r.ok, false);
  assert.match(r.message, /not linked/);
});

test('runTrack — server rejected surfaces the reason', async () => {
  const r = await runTrack('x', baseDeps({
    runCheckpoint: async () => ({ enqueued: 1, flush: { flushed: 0, rejected: 1, lastError: 'Branch is not linked to a Beezi ticket.' }, tasks: [] }),
  }));
  assert.equal(r.ok, false);
  assert.match(r.message, /not linked to a Beezi ticket/);
});

test('runTrack — no git origin', async () => {
  const r = await runTrack('x', baseDeps({ gitImpl: () => { throw new Error('no repo'); } }));
  assert.equal(r.ok, false);
  assert.match(r.message, /origin/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/track.test.mjs`
Expected: FAIL — `Cannot find module '../lib/track.mjs'`.

- [ ] **Step 3: Write `lib/track.mjs`**

Create `lib/track.mjs`:

```javascript
import { getToken as _getToken } from './credentials.mjs';
import { runCheckpoint as _runCheckpoint } from './checkpoint.mjs';
import { git as _git, sanitizeRemote } from './git.mjs';
import { findCurrentTranscript as _findCurrentTranscript } from './transcript.mjs';

// Manual save (/beezi:track). Attribution is historical (reflog, inside runCheckpoint),
// so this must NOT gate on the branch currently checked out — otherwise beezi work done
// before switching to a non-task branch would be lost. Returns { ok, message }.
export async function runTrack(cwd, deps = {}) {
  const getToken = deps.getToken ?? _getToken;
  const gitImpl = deps.gitImpl ?? _git;
  const runCheckpoint = deps.runCheckpoint ?? _runCheckpoint;
  const findCurrentTranscript = deps.findCurrentTranscript ?? _findCurrentTranscript;

  try {
    sanitizeRemote(gitImpl(['remote', 'get-url', 'origin'], cwd));
  } catch {
    return { ok: false, message: 'Beezi: this repo has no "origin" remote (or is not a git repo). Nothing tracked.' };
  }

  const token = await getToken().catch(() => null);
  if (!token) return { ok: false, message: 'Beezi: this machine is not linked. Run /beezi:login first.' };

  const transcript = findCurrentTranscript(cwd);
  if (!transcript) return { ok: false, message: 'Beezi: could not find this session’s transcript to track.' };

  const { enqueued, flush, tasks } = await runCheckpoint({
    session_id: transcript.sessionId,
    transcript_path: transcript.transcriptPath,
    cwd,
  });

  if (flush?.failed) {
    return { ok: false, message: 'Beezi: could not reach the server — analytics will be retried automatically.' };
  }
  if (flush?.rejected) {
    return { ok: false, message: `Beezi: ${flush.lastError ?? 'the server rejected this report'}.` };
  }

  const saved = flush?.flushed ?? 0;
  if (enqueued === 0 && saved === 0) {
    return { ok: true, message: '✓ Beezi: nothing new to save — already up to date.' };
  }

  const forTasks = tasks && tasks.length ? ` for ${tasks.join(', ')}` : '';
  return { ok: true, message: `✓ Beezi: analytics saved (${saved} segment${saved === 1 ? '' : 's'})${forTasks}.` };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/track.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Rewrite `scripts/track.mjs` as a thin wrapper**

Replace the entire file `scripts/track.mjs` with:

```javascript
import { runTrack } from '../lib/track.mjs';

runTrack(process.cwd())
  .then((r) => {
    if (r.ok) { console.log(r.message); process.exit(0); }
    console.error(`✗ ${r.message}`);
    process.exit(1);
  })
  .catch((error) => { console.error(`✗ ${error.message}`); process.exit(1); });
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS — all files (`reflog`, `delta`, `checkpoint`, `track`, plus the untouched `git`, `hook-input`, `prune`, `session-start`, `smoke`, `whoami`, `resume-integration`).

- [ ] **Step 7: Commit** (skip if repo not initialized)

```bash
git add lib/track.mjs scripts/track.mjs test/track.test.mjs
git commit -m "fix(track): attribute manual save by history; drop current-branch gate"
```

---

## Self-Review

**Spec coverage:**
- Reflog timeline (`readCheckoutEvents`/`buildBranchTimeline`/`branchAt`) → Task 1. ✅
- Per-line reflog join + contiguous run segmentation + per-run active time + gitBranch fallback → Task 2. ✅
- Checkpoint builds timeline, skips non-task runs, non-overlapping `segmentId`, returns `tasks` → Task 3. ✅
- `/beezi:track` current-branch gate removed, history-based save, new messaging → Task 4. ✅
- Edge cases (reflog throws → null → fallback; missing timestamp → fallback; detached HEAD → skipped; empty reflog → null) → covered by Task 1 tests (null path) + Task 2 R2/R3 + Task 3 existing tests. ✅
- Idempotency/resume unchanged (cursor untouched; `segmentId` scheme intact) → Task 3 keeps `loadState`/`saveState`/`enqueue`. ✅

**Placeholder scan:** No TBD/TODO; every code and test step contains full source. ✅

**Type/name consistency:** `readCheckoutEvents`, `buildBranchTimeline`, `branchAt` (Task 1) are imported verbatim in Tasks 2 and 3. `computeDelta(path, fromLine, timeline)` signature (Task 2) matches the call in Task 3. `runCheckpoint` return `{ enqueued, flush, tasks }` (Task 3) matches destructuring in Task 4. `runTrack(cwd, deps)` (Task 4) matches its tests. ✅

**Scope:** Single subsystem (the analytics plugin's attribution path); four dependent tasks, each independently testable. ✅
