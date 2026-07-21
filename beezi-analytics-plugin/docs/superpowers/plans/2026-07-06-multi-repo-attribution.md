# Multi-Repo Session Attribution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attribute Claude Code token/time analytics to the repo the work actually touched (not the frozen launch dir) and to that repo's own branch, so a session spanning multiple repos emits correct per-repo, per-branch segments.

> **Post-implementation correction (after final whole-branch review):** The `lib/delta.mjs` code shown in Task 3 Step 4 was superseded by two fixes required for REAL Claude Code transcripts, which (a) end with a trailing `\n` and (b) split one assistant message across consecutive lines (thinking/text/tool_use) sharing `message.id` and repeating `usage`. The shipped `lib/delta.mjs` adds: (1) trailing-newline strip before split, so the cursor does not overshoot and skip each window's first line; (2) a pre-pass mapping `message.id → last tool-path signal across its block-lines`, applied to every block-line so a message's tokens bill to the repo its own `tool_use` touched (not the repo active at its first, signal-less block-line). Also: `lib/repo-timeline.mjs` guards non-string `file_path`/`notebook_path`. Tests added: delta `P7` (multi-line message → tool_use repo), `P8` (trailing-newline cursor), checkpoint `18` (realistic multi-line, two-repo, two-window end-to-end). The on-disk source is authoritative; full suite 108/108.

**Architecture:** A new pure `lib/repo-timeline.mjs` infers the active repo per transcript line from tool inputs (file paths + Bash `cd`, last-touch-wins, carried forward across signal-less lines). `lib/delta.mjs` becomes a single ordered walk that resolves each line to `(repoRoot, branch)` — repo via an injected `repoRootOf`, branch via an injected `branchAt` — and emits contiguous non-overlapping runs. `lib/checkpoint.mjs` wires those resolvers with memoized git shell-outs: `rev-parse --show-toplevel` per dir, `remote get-url origin` per root, and `git reflog` (+ `rev-parse --abbrev-ref HEAD` fallback) per root. Branch attribution reuses the reflog timeline from `lib/reflog.mjs`.

**Tech Stack:** Node ESM (`.mjs`), `node --test` runner (no jest), no build step. `git` shelled via injected `gitImpl(args, cwd) -> string`.

## Global Constraints

- ESM only: all source is `.mjs`; `package.json` has `"type": "module"`. No TypeScript.
- No new runtime dependencies. `keytar` stays an optional dependency.
- Test runner is `node --test`; run all with `npm test`, one file with `node --test test/<file>`.
- **`gitImpl` signature is `(args: string[], cwd: string) -> string`** — the working dir is the **second argument**, NOT a `-C` flag. Follow the existing `lib/git.mjs` convention.
- **Attribution model:** repo from tool-path signals (`repoRootOf`), branch from that repo's `git reflog` at the line timestamp, falling back to that repo's current HEAD when the reflog has no checkout events. `line.cwd` and `line.gitBranch` are NOT used for attribution when resolvers are injected (they are frozen at the launch dir/branch).
- **Repo signal rule:** any Read / Edit / Write / NotebookEdit `file_path`, or Bash `cd`/`pushd` target, moves the active repo. **Last touch wins.** The line performing the touch bills to the **new** repo.
- Branch tracked downstream only when it matches `TASK_BRANCH_RE` = `/\/task-[a-zA-Z0-9_-]+/` (from `lib/git.mjs`) — but this plan does **not** add a task-branch filter to checkpoint; it preserves the current "enqueue every branch with work + a resolvable origin" behavior (the server rejects unlinked branches). Branch **correctness** is what changes here.
- `segmentId` format is unchanged: `` `${session_id}:${fromLine}-${toLine}` ``. No payload or server changes. `remote` and `branch` are existing payload fields — this plan only makes them correct.
- Reflog read command is exactly: `git reflog --date=iso-strict -n 1000`.
- The marketplace directory is **not a git repo yet**. Every "Commit" step below is conditional: **do not run `git init` or `git commit` unless the user explicitly asks.** If the repo is not initialized, replace each commit step with "re-run `npm test` and confirm green."
- **Relationship to `2026-07-03-reflog-branch-attribution`:** that plan's Task 1 (`lib/reflog.mjs`) is a shared prerequisite — Task 1 here is identical and idempotent (skip if the file already exists and its tests pass). This plan **supersedes** that plan's Task 2 (delta) and Task 3 (checkpoint), extending single-repo reflog attribution to N repos. That plan's Task 4 (`lib/track.mjs`) is orthogonal and unaffected — `runCheckpoint`'s signature and its `{ enqueued, flush }` return shape are preserved here.

---

### Task 1: `lib/reflog.mjs` — reflog parsing + branch timeline (pure)

Shared prerequisite. **If `lib/reflog.mjs` already exists and `node --test test/reflog.test.mjs` passes, skip this entire task.**

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

// Ascending boundary list, or null when there are no checkout events.
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

- [ ] **Step 5: Commit** (skip unless the user asks — see Global Constraints)

```bash
git add lib/reflog.mjs test/reflog.test.mjs
git commit -m "feat(reflog): parse git reflog into a branch-over-time timeline"
```

---

### Task 2: `lib/repo-timeline.mjs` — per-line repo signal + repo-root resolution

**Files:**
- Create: `lib/repo-timeline.mjs`
- Test: `test/repo-timeline.test.mjs`

**Interfaces:**
- Consumes: injected `gitImpl(args, cwd) -> string`; Node's `node:path`.
- Produces:
  - `extractPathSignal(line, cwd) -> string | null` — the directory implied by the **last** `tool_use` block in `line.message.content` that carries one (Read/Edit/Write/NotebookEdit → `dirname(file_path)` / `dirname(notebook_path)`; Bash → last `cd`/`pushd` target, relative resolved against `cwd`). `null` when no block yields a dir.
  - `resolveRepoRoot(gitImpl, dir, cache) -> string | null` — `git rev-parse --show-toplevel` run in `dir`, trimmed; `null` on throw or empty; memoized in the `Map` `cache` (keyed by `dir`).

- [ ] **Step 1: Write the failing tests**

Create `test/repo-timeline.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPathSignal, resolveRepoRoot } from '../lib/repo-timeline.mjs';

// Build an assistant line whose message.content carries tool_use blocks.
function toolLine(blocks) {
  return { type: 'assistant', message: { model: 'm', content: blocks } };
}
const use = (name, input) => ({ type: 'tool_use', name, input });

test('extractPathSignal — Edit/Write/Read return dirname of file_path', () => {
  assert.equal(extractPathSignal(toolLine([use('Edit', { file_path: '/repo/alpha/src/x.ts' })])), '/repo/alpha/src');
  assert.equal(extractPathSignal(toolLine([use('Write', { file_path: '/repo/beta/y.ts' })])), '/repo/beta');
  assert.equal(extractPathSignal(toolLine([use('Read', { file_path: '/repo/gamma/z.ts' })])), '/repo/gamma');
});

test('extractPathSignal — NotebookEdit uses notebook_path', () => {
  assert.equal(extractPathSignal(toolLine([use('NotebookEdit', { notebook_path: '/repo/nb/a.ipynb' })])), '/repo/nb');
});

test('extractPathSignal — Bash cd target (quoted, absolute)', () => {
  assert.equal(extractPathSignal(toolLine([use('Bash', { command: 'cd "/repo/alpha" && npm test' })])), '/repo/alpha');
});

test('extractPathSignal — Bash multiple cd → last wins', () => {
  assert.equal(extractPathSignal(toolLine([use('Bash', { command: 'cd /repo/a && cd /repo/b && ls' })])), '/repo/b');
});

test('extractPathSignal — Bash relative cd resolved against cwd', () => {
  assert.equal(extractPathSignal(toolLine([use('Bash', { command: 'cd sub && ls' })]), '/repo/alpha'), '/repo/alpha/sub');
});

test('extractPathSignal — Bash without cd → null', () => {
  assert.equal(extractPathSignal(toolLine([use('Bash', { command: 'npm test' })])), null);
});

test('extractPathSignal — multiple tool_use blocks → last block wins', () => {
  const line = toolLine([
    use('Read', { file_path: '/repo/alpha/x.ts' }),
    use('Edit', { file_path: '/repo/beta/y.ts' }),
  ]);
  assert.equal(extractPathSignal(line), '/repo/beta');
});

test('extractPathSignal — no content / no tool_use → null', () => {
  assert.equal(extractPathSignal({ type: 'assistant', message: { model: 'm', usage: {} } }), null);
  assert.equal(extractPathSignal(toolLine([{ type: 'text', text: 'hi' }])), null);
});

test('resolveRepoRoot — trims git output and caches; second call does not re-invoke git', () => {
  let calls = 0;
  const gitImpl = () => { calls += 1; return '/repo/alpha\n'; };
  const cache = new Map();
  assert.equal(resolveRepoRoot(gitImpl, '/repo/alpha/src', cache), '/repo/alpha');
  assert.equal(resolveRepoRoot(gitImpl, '/repo/alpha/src', cache), '/repo/alpha');
  assert.equal(calls, 1, 'result memoized by dir');
});

test('resolveRepoRoot — throw (not a repo) caches null', () => {
  let calls = 0;
  const gitImpl = () => { calls += 1; throw new Error('not a git repository'); };
  const cache = new Map();
  assert.equal(resolveRepoRoot(gitImpl, '/tmp/notrepo', cache), null);
  assert.equal(resolveRepoRoot(gitImpl, '/tmp/notrepo', cache), null);
  assert.equal(calls, 1, 'null result memoized too');
});

test('resolveRepoRoot — null dir returns null without calling git', () => {
  let calls = 0;
  const gitImpl = () => { calls += 1; return 'x'; };
  assert.equal(resolveRepoRoot(gitImpl, null, new Map()), null);
  assert.equal(calls, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/repo-timeline.test.mjs`
Expected: FAIL — `Cannot find module '../lib/repo-timeline.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `lib/repo-timeline.mjs`:

```javascript
import path from 'node:path';

// Match a `cd`/`pushd` (optionally `cd /d`) at a command boundary; capture the target,
// quoted or bare. Global so we can take the LAST match in a compound command.
const CD_RE = /(?:^|&&|;|\|)\s*(?:cd|pushd)\s+(?:\/d\s+)?("[^"]+"|'[^']+'|[^\s;&|]+)/g;

const PATH_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'Write']);
const WIN_DRIVE_RE = /^[a-zA-Z]:[\\/]/;

// Normalize any OS path to forward slashes so signals from different sources
// (transcript file paths, cd targets, session cwd) share one representation —
// keeps repoRootOf cache keys stable and output deterministic across platforms.
// (Using path.posix everywhere avoids win32 path.resolve prepending a drive to a
// drive-less absolute path, which differs from POSIX and breaks determinism.)
function norm(p) {
  return typeof p === 'string' ? p.replace(/\\/g, '/') : p;
}

function isAbsPath(p) {
  return p.startsWith('/') || WIN_DRIVE_RE.test(p);
}

// The directory a single tool_use block implies, or null.
function dirFromToolUse(block, cwd) {
  const { name, input } = block;
  if (!input) return null;
  if (PATH_TOOLS.has(name)) {
    return input.file_path ? path.posix.dirname(norm(input.file_path)) : null;
  }
  if (name === 'NotebookEdit') {
    return input.notebook_path ? path.posix.dirname(norm(input.notebook_path)) : null;
  }
  if (name === 'Bash') {
    return lastCdTarget(input.command, cwd);
  }
  return null;
}

function lastCdTarget(command, cwd) {
  if (typeof command !== 'string') return null;
  let target = null;
  let m;
  CD_RE.lastIndex = 0;
  while ((m = CD_RE.exec(command)) !== null) {
    let t = m[1];
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      t = t.slice(1, -1);
    }
    target = t;
  }
  if (!target || target === '-' || target === '~') return null; // unresolvable targets
  target = norm(target);
  if (isAbsPath(target)) return target;
  return cwd ? path.posix.join(norm(cwd), target) : null;
}

// The active-repo signal for a line: dir of the LAST tool_use block that carries one,
// else null (caller carries the previous active repo forward).
export function extractPathSignal(line, cwd) {
  const content = line?.message?.content;
  if (!Array.isArray(content)) return null;
  let dir = null;
  for (const block of content) {
    if (!block || block.type !== 'tool_use') continue;
    const d = dirFromToolUse(block, cwd);
    if (d) dir = d; // last-touch-wins
  }
  return dir;
}

// git repo root for `dir` (`rev-parse --show-toplevel`), memoized in `cache`.
// Returns null when `dir` is falsy, not in a repo, or git throws.
export function resolveRepoRoot(gitImpl, dir, cache) {
  if (!dir) return null;
  if (cache && cache.has(dir)) return cache.get(dir);
  let root = null;
  try {
    const out = gitImpl(['rev-parse', '--show-toplevel'], dir).trim();
    root = out === '' ? null : out;
  } catch {
    root = null;
  }
  if (cache) cache.set(dir, root);
  return root;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/repo-timeline.test.mjs`
Expected: PASS (11 tests).

Note: the module normalizes all paths to forward slashes and uses `path.posix` (with a drive-letter-aware `isAbsPath`), so `dirname`, absolute-detection, and relative-`cd` joins produce identical forward-slash output on Windows and POSIX. This is why the relative-`cd` test (`cd sub` → `/repo/alpha/sub`) is deterministic — plain `path.resolve` on win32 would instead yield `C:\repo\alpha\sub`.

- [ ] **Step 5: Commit** (skip unless the user asks)

```bash
git add lib/repo-timeline.mjs test/repo-timeline.test.mjs
git commit -m "feat(repo-timeline): infer active repo per line from tool paths + cd"
```

---

### Task 3: `lib/delta.mjs` — resolver-based `(repo, branch)` run segmentation

**Files:**
- Modify: `lib/delta.mjs` (rewrite `computeDelta`; keep `summarize` and `IDLE_GAP_SEC`)
- Modify: `test/delta.test.mjs` (update test 1's segment-identity assertion; rewrite test "O"; add repo/branch resolver tests)

**Interfaces:**
- Consumes: `extractPathSignal` from `lib/repo-timeline.mjs` (Task 2, imported directly — pure).
- Produces: `computeDelta(transcriptPath, fromLine, resolvers = {}) -> { nextCursor: number, segments: Array<{ repoRoot: string|null, branch: string, fromLine: number, toLine: number, stats }> }`.
  - `resolvers = { cwd?: string|null, repoRootOf?: (dir)=>string|null, branchAt?: (root, ms)=>string }`.
  - Defaults: `cwd = null`; `repoRootOf = (dir) => dir` (identity — for pure tests); `branchAt = null` → branch falls back to `line.gitBranch || '(unknown)'` (backward compatibility with resolver-less callers/tests).
  - `segments` ordered by first appearance; `fromLine..toLine` disjoint and non-overlapping. `stats` shape unchanged (`models`, `token_input`, `token_output`, `token_cache`, `token_total`, `duration_sec`, `started_at`, `ended_at`).

- [ ] **Step 1: Update the existing cwd-coupled assertions (they encode the OLD model)**

In `test/delta.test.mjs`, **test 1 ("single-branch token tally")** currently asserts `seg.cwd`. Replace the `computeDelta` call and that assertion so it exercises the new seed + `repoRoot`:

Change:
```javascript
  const { nextCursor, segments } = computeDelta(file, 0);
```
to:
```javascript
  const { nextCursor, segments } = computeDelta(file, 0, { cwd: '/some/path', repoRootOf: (d) => d });
```
Change:
```javascript
  assert.equal(seg.cwd, '/some/path', 'segment carries the cwd it was produced in');
```
to:
```javascript
  assert.equal(seg.repoRoot, '/some/path', 'segment carries the resolved repo root (seeded from cwd)');
```

**Rewrite test "O"** (`'O. two distinct cwds in one transcript → two segments (per-cwd attribution)'`) — it drove repo off `line.cwd`, which is no longer the signal. Replace the ENTIRE test with a tool-path-driven version:

```javascript
test('O. two repos by tool-path signal → two segments (per-repo attribution)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const use = (name, input) => ({ type: 'tool_use', name, input });
  const toolAssistant = (fileDir, usage, ts) => ({
    type: 'assistant',
    gitBranch: 'launch-branch', // frozen launch branch — must NOT drive attribution
    timestamp: ts,
    message: {
      model: 'model-a',
      usage,
      content: [use('Edit', { file_path: `${fileDir}/file.ts` })],
    },
  });

  const file = writeFixture(dir, [
    toolAssistant('/repo/alpha', { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:00:00.000Z'),
    toolAssistant('/repo/beta',  { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:01:00.000Z'),
  ]);

  // Identity repoRootOf: the signal dir IS the root. Branch from a stub keyed on root.
  const { segments } = computeDelta(file, 0, {
    cwd: '/repo/alpha',
    repoRootOf: (d) => d,
    branchAt: (root) => (root === '/repo/beta' ? 'feature/task-beta' : 'feature/task-alpha'),
  });

  assert.equal(segments.length, 2, 'one segment per distinct repo root');

  const alpha = segments.find((s) => s.repoRoot === '/repo/alpha');
  const beta = segments.find((s) => s.repoRoot === '/repo/beta');
  assert.ok(alpha, 'segment for /repo/alpha must exist');
  assert.ok(beta, 'segment for /repo/beta must exist');
  assert.equal(alpha.branch, 'feature/task-alpha');
  assert.equal(beta.branch, 'feature/task-beta');
  assert.equal(alpha.stats.token_input, 100);
  assert.equal(beta.stats.token_input, 200);
});
```

- [ ] **Step 2: Add the new resolver behavior tests**

Append to `test/delta.test.mjs`:

```javascript
// Helpers for repo-signal fixtures.
const _use = (name, input) => ({ type: 'tool_use', name, input });
function repoLine(fileDir, usage, ts) {
  return {
    type: 'assistant',
    gitBranch: 'frozen', // frozen launch branch — ignored when branchAt is provided
    timestamp: ts,
    message: { model: 'model-a', usage, content: [_use('Edit', { file_path: `${fileDir}/f.ts` })] },
  };
}
function textLine(usage, ts) {
  // Assistant tokens with NO tool_use → no path signal → carry-forward.
  return { type: 'assistant', gitBranch: 'frozen', timestamp: ts, message: { model: 'model-a', usage } };
}
const U = (i) => ({ input_tokens: i, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });

test('P1. repoA → repoB → repoA interleave → three disjoint contiguous segments', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = writeFixture(dir, [
    repoLine('/repo/a', U(10), '2024-01-01T10:00:00.000Z'), // → a
    repoLine('/repo/b', U(20), '2024-01-01T10:01:00.000Z'), // → b
    repoLine('/repo/a', U(30), '2024-01-01T10:02:00.000Z'), // → a again
  ]);

  const { segments } = computeDelta(file, 0, {
    cwd: '/repo/a',
    repoRootOf: (d) => d,
    branchAt: (root) => `branch-of:${root}`,
  });

  assert.deepEqual(segments.map((s) => s.repoRoot), ['/repo/a', '/repo/b', '/repo/a']);
  assert.deepEqual(segments.map((s) => [s.fromLine, s.toLine]), [[1, 1], [2, 2], [3, 3]]);
  for (let i = 1; i < segments.length; i++) {
    assert.ok(segments[i].fromLine > segments[i - 1].toLine, 'segment ranges must not overlap');
  }
  assert.equal(segments[0].stats.token_input, 10);
  assert.equal(segments[1].stats.token_input, 20);
  assert.equal(segments[2].stats.token_input, 30);
});

test('P2. carry-forward — a text-only line keeps the previous repo', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = writeFixture(dir, [
    repoLine('/repo/b', U(10), '2024-01-01T10:00:00.000Z'), // → b
    textLine(U(5), '2024-01-01T10:00:30.000Z'),             // no signal → still b
    repoLine('/repo/b', U(7), '2024-01-01T10:01:00.000Z'),  // → b
  ]);

  const { segments } = computeDelta(file, 0, {
    cwd: '/repo/a', // seed differs, but the first line switches to b
    repoRootOf: (d) => d,
    branchAt: () => 'feature/task-b',
  });

  assert.equal(segments.length, 1, 'all three lines belong to one contiguous repo/branch run');
  assert.equal(segments[0].repoRoot, '/repo/b');
  assert.equal(segments[0].stats.token_input, 22, '10 + 5 (carried) + 7');
});

test('P3. last-touch tie-break — the Edit line itself bills to the new repo', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = writeFixture(dir, [
    textLine(U(3), '2024-01-01T10:00:00.000Z'),            // seed repo /repo/a
    repoLine('/repo/b', U(9), '2024-01-01T10:00:30.000Z'), // touches b → this line is b
  ]);

  const { segments } = computeDelta(file, 0, {
    cwd: '/repo/a',
    repoRootOf: (d) => d,
    branchAt: (root) => `b:${root}`,
  });

  const a = segments.find((s) => s.repoRoot === '/repo/a');
  const b = segments.find((s) => s.repoRoot === '/repo/b');
  assert.equal(a.stats.token_input, 3, 'pre-touch text billed to seed repo');
  assert.equal(b.stats.token_input, 9, 'the touching line billed to the new repo');
});

test('P4. Read moves attribution (any-touch rule)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const readLine = {
    type: 'assistant', gitBranch: 'frozen', timestamp: '2024-01-01T10:00:00.000Z',
    message: { model: 'model-a', usage: U(4), content: [_use('Read', { file_path: '/repo/b/x.ts' })] },
  };
  const file = writeFixture(dir, [readLine]);

  const { segments } = computeDelta(file, 0, { cwd: '/repo/a', repoRootOf: (d) => d, branchAt: () => 'x' });
  assert.equal(segments[0].repoRoot, '/repo/b', 'reading a repo-B file switches attribution to B');
});

test('P5. branchAt drives branch; frozen gitBranch is ignored when provided', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = writeFixture(dir, [repoLine('/repo/a', U(1), '2024-01-01T10:00:00.000Z')]);
  const { segments } = computeDelta(file, 0, {
    cwd: '/repo/a', repoRootOf: (d) => d,
    branchAt: (root, ms) => (ms === Date.parse('2024-01-01T10:00:00.000Z') ? 'feature/task-Z' : 'wrong'),
  });
  assert.equal(segments[0].branch, 'feature/task-Z');
});

test('P6. unresolvable signal → carry forward, not a switch to null', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = writeFixture(dir, [
    repoLine('/repo/a', U(2), '2024-01-01T10:00:00.000Z'),      // → a
    repoLine('/not/a/repo', U(2), '2024-01-01T10:01:00.000Z'),  // repoRootOf returns null → carry a
  ]);

  const { segments } = computeDelta(file, 0, {
    cwd: '/repo/a',
    repoRootOf: (d) => (d.startsWith('/repo/') ? d : null),
    branchAt: () => 'feature/task-a',
  });

  assert.equal(segments.length, 1, 'null-root line carried forward into repo a run');
  assert.equal(segments[0].repoRoot, '/repo/a');
  assert.equal(segments[0].stats.token_input, 4);
});
```

- [ ] **Step 3: Run the delta suite to confirm the NEW tests fail and understand breakage**

Run: `node --test test/delta.test.mjs`
Expected: FAIL on O/P1–P6 (`computeDelta` ignores the resolvers arg today and segments have `cwd`, not `repoRoot`). The resolver-less tests (2–15, N, 9, etc.) should still be green because they pass no resolvers.

- [ ] **Step 4: Rewrite `computeDelta` in `lib/delta.mjs`**

Replace the entire file `lib/delta.mjs` with:

```javascript
import fs from 'node:fs';
import { extractPathSignal } from './repo-timeline.mjs';

const IDLE_GAP_SEC = 300;

// Attribute each new transcript line to (repoRoot, branch): repo from tool-path signals
// (carried forward across signal-less lines, last-touch-wins), branch from the injected
// branchAt (per-repo reflog in production). Split the window into contiguous same-(repo,
// branch) runs; each maximal run becomes one segment with a disjoint fromLine..toLine range.
export function computeDelta(transcriptPath, fromLine, resolvers = {}) {
  const cwd = resolvers.cwd ?? null;
  const repoRootOf = resolvers.repoRootOf ?? ((dir) => dir);
  const branchAt = resolvers.branchAt ?? null;

  const content = fs.readFileSync(transcriptPath, 'utf-8');
  const raw = content === '' ? [] : content.split('\n');
  // Claude Code logs one transcript line per content block, so the same assistant
  // message (and its usage) repeats across several lines. Count each message once.
  const countedMessages = new Set();
  const segments = [];
  let run = null;
  let processed = fromLine;
  let lineNo = 0;
  let activeRoot = cwd != null ? repoRootOf(cwd) : null;

  const closeRun = () => {
    if (run) {
      segments.push({
        repoRoot: run.repoRoot,
        branch: run.branch,
        fromLine: run.fromLine,
        toLine: run.toLine,
        stats: summarize(run.models, run.timestamps),
      });
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

    const sigDir = extractPathSignal(line, cwd);
    if (sigDir) {
      const sigRoot = repoRootOf(sigDir);
      if (sigRoot) activeRoot = sigRoot; // last-touch-wins; unresolvable → carry forward
    }

    const ms = line.timestamp ? new Date(line.timestamp).getTime() : null;
    const branch = branchAt
      ? branchAt(activeRoot, ms)
      : (line.gitBranch || '(unknown)');

    if (!run || run.repoRoot !== activeRoot || run.branch !== branch) {
      closeRun();
      run = { repoRoot: activeRoot, branch, fromLine: lineNo, toLine: lineNo, models: {}, timestamps: [] };
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

- [ ] **Step 5: Run the full delta suite to verify all tests pass**

Run: `node --test test/delta.test.mjs`
Expected: PASS — updated test 1, rewritten O, new P1–P6, and every resolver-less test (2–15, N, etc.). Resolver-less tests still pass because `branchAt` defaults to `null` → `line.gitBranch` fallback, and with no tool_use content `activeRoot` stays at the (null) seed, so segments keep their branches and token math.

- [ ] **Step 6: Commit** (skip unless the user asks)

```bash
git add lib/delta.mjs test/delta.test.mjs
git commit -m "feat(delta): resolver-based (repo,branch) run segmentation"
```

---

### Task 4: `lib/checkpoint.mjs` — wire per-repo resolvers with memoized git

**Files:**
- Modify: `lib/checkpoint.mjs` (build `repoRootOf` / `branchAt` / per-root remote; resolve remote by `seg.repoRoot`)
- Modify: `test/checkpoint.test.mjs` (replace git fakes with routers; update the attribution-dependent tests; add multi-repo + reflog + no-origin tests)

**Interfaces:**
- Consumes: `readCheckoutEvents`, `buildBranchTimeline`, `branchAt as branchAtReflog` from `lib/reflog.mjs`; `resolveRepoRoot` from `lib/repo-timeline.mjs`; `git`, `sanitizeRemote` from `lib/git.mjs`; `computeDelta(path, cursor, resolvers)` from `lib/delta.mjs`.
- Produces: `runCheckpoint(input, deps) -> { enqueued: number, flush: object | null }` (unchanged shape). `flushQueue` unchanged.

- [ ] **Step 1: Replace the shared git fakes and add router helpers in `test/checkpoint.test.mjs`**

The old `fakeGit`/`fakeGitByCwd` returned the remote string for **every** git call — which now poisons `rev-parse --show-toplevel`, `reflog`, and `rev-parse --abbrev-ref HEAD` for any test that asserts a branch or remote. **Keep `fakeGit`** — tests 1, 2, 7, 12, 13 still reference it and stay green (they either never reach branch/remote resolution, or `gitImpl` throws for all calls). **Remove only `fakeGitByCwd`** (it has no remaining references), and ADD the router helpers below.

Remove:
```javascript
// Resolves a different remote per cwd; throws for any cwd not in the map.
function fakeGitByCwd(remoteByCwd) {
  return (_args, cwd) => {
    if (cwd in remoteByCwd) return remoteByCwd[cwd];
    throw new Error(`no remote for ${cwd}`);
  };
}
```

Add (near the top of the file, after `writeTranscript`):
```javascript
// Single-repo router: repo root is identity (the cwd passed to rev-parse), no reflog
// events (empty), current HEAD = `branch`, origin = `remote`.
function fakeGitRepo(branch, remote, reflog = '') {
  return (args, cwd) => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return cwd;
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return branch;
    if (args[0] === 'reflog') return reflog;
    if (args[0] === 'remote') return remote;
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

// Multi-repo router: `spec` maps a repo root → { branch, remote, reflog? }.
// rev-parse --show-toplevel is identity (dir passed IS the root); other calls look up by root.
function fakeGitByRoot(spec) {
  return (args, cwd) => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return cwd;
    const entry = spec[cwd];
    if (!entry) throw new Error(`no repo for ${cwd}`);
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return entry.branch;
    if (args[0] === 'reflog') return entry.reflog ?? '';
    if (args[0] === 'remote') {
      if (entry.remote == null) throw new Error(`no origin for ${cwd}`);
      return entry.remote;
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

// Build an assistant line whose tool_use touches a file in `repoDir` (the repo-signal source).
function repoAssistantLine(repoDir, branchIgnored, model, usage, timestamp) {
  return {
    type: 'assistant',
    gitBranch: branchIgnored,
    timestamp,
    message: { model, usage, content: [{ type: 'tool_use', name: 'Edit', input: { file_path: `${repoDir}/f.ts` } }] },
  };
}
```

- [ ] **Step 2: Update the attribution-dependent existing tests to the routers**

These tests assert an enqueued branch/remote, so they must use a router (HEAD supplies the branch). Make exactly these `gitImpl:` substitutions (leave everything else in each test unchanged):

- **Test 3** — both `runCheckpoint` calls: replace
  `gitImpl: fakeGit('https://host/org/repo.git'),`
  with
  `gitImpl: fakeGitRepo('feature/task-1', 'https://host/org/repo.git'),`
- **Test 4** — replace with `gitImpl: fakeGitRepo('main', 'https://host/org/repo.git'),`
- **Test 5** — in `deps`, replace with `gitImpl: fakeGitRepo('feature/task-1', 'https://host/org/repo.git'),`
- **Test 6** — in `deps`, replace with `gitImpl: fakeGitRepo('feature/task-1', 'https://host/org/repo.git'),`
- **Test 8** — replace with `gitImpl: fakeGitRepo('feature/task-1', 'https://user:pw@host/org/repo.git'),`
- **Test 14** — in both `deps` and `recordingDeps`, replace with `gitImpl: fakeGitRepo('feature/task-14', 'https://host/org/repo.git'),`

Tests **1, 2, 7, 12, 13** need no change: test 1 (no token) and 12 (getToken throws) and 13 (missing transcript) never reach git resolution; test 2 (`gitImpl` throws for everything) → `repoRootOf` returns null → branch `(unknown)` → segment skipped, cursor still advances (assertions still hold); test 7 (zero-work line) is skipped for zero work regardless of branch. Tests **9, 10, 11** exercise `flushQueue` directly and are untouched.

- [ ] **Step 3: Rewrite the per-cwd tests (15, 16, 17) as per-repo tests**

Tests 15–17 encoded the OLD `line.cwd` attribution and the `seg.cwd || cwd` fallback. Replace all three with the following (repo now comes from tool paths; there is no hook-cwd remote fallback):

```javascript
// ─── test 15: two repos by tool-path signal → each segment gets its own remote ──

test('15. two repos touched in one session → each segment resolves its own repo remote', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const u = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const transcript = writeTranscript(dir, [
    repoAssistantLine('/repo/alpha', 'frozen', 'model-a', u, '2024-01-01T10:00:00.000Z'),
    repoAssistantLine('/repo/beta', 'frozen', 'model-a', { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:01:00.000Z'),
  ]);

  const captured = [];
  await runCheckpoint(
    { session_id: 'sess-15', transcript_path: transcript, cwd: '/repo/alpha' },
    {
      getToken: async () => 'tok',
      gitImpl: fakeGitByRoot({
        '/repo/alpha': { branch: 'feature/task-a', remote: 'https://host/org/alpha.git' },
        '/repo/beta': { branch: 'feature/task-b', remote: 'https://host/org/beta.git' },
      }),
      fetchImpl: async (_url, opts) => { captured.push(JSON.parse(opts.body)); return { status: 503 }; },
    },
  );

  assert.equal(captured.length, 2, 'one segment per repo');
  const alpha = captured.find((p) => p.remote === 'https://host/org/alpha.git');
  const beta = captured.find((p) => p.remote === 'https://host/org/beta.git');
  assert.ok(alpha, 'alpha segment resolved its own remote');
  assert.ok(beta, 'beta segment resolved its own remote');
  assert.equal(alpha.branch, 'feature/task-a');
  assert.equal(beta.branch, 'feature/task-b');
  assert.equal(alpha.token_total, 150);
  assert.equal(beta.token_total, 220);
});

// ─── test 16: reflog interleave within ONE repo → branch by timestamp ───────────

test('16. reflog interleave within a repo → branch attributed by line timestamp', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const CP_REFLOG = [
    'e3 HEAD@{2026-07-03T10:04:00+00:00}: checkout: moving from main to feature/task-A',
    'e2 HEAD@{2026-07-03T10:02:00+00:00}: checkout: moving from feature/task-A to main',
    'e1 HEAD@{2026-07-03T10:00:00+00:00}: checkout: moving from main to feature/task-A',
  ].join('\n');

  const u = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const transcript = writeTranscript(dir, [
    repoAssistantLine('/repo/x', 'frozen', 'model-a', u, '2026-07-03T10:00:30.000Z'), // → feature/task-A
    repoAssistantLine('/repo/x', 'frozen', 'model-a', u, '2026-07-03T10:02:30.000Z'), // → main
    repoAssistantLine('/repo/x', 'frozen', 'model-a', u, '2026-07-03T10:04:30.000Z'), // → feature/task-A
  ]);

  const captured = [];
  await runCheckpoint(
    { session_id: 'sess-16', transcript_path: transcript, cwd: '/repo/x' },
    {
      getToken: async () => 'tok',
      gitImpl: fakeGitByRoot({ '/repo/x': { branch: 'IGNORED-HEAD', remote: 'https://host/org/x.git', reflog: CP_REFLOG } }),
      fetchImpl: async (_url, opts) => { captured.push(JSON.parse(opts.body)); return { status: 503 }; },
    },
  );

  const branches = captured.map((p) => p.branch);
  assert.deepEqual(branches, ['feature/task-A', 'main', 'feature/task-A'], 'reflog timestamps drive branch, not HEAD');
  // Disjoint ranges across the three runs.
  const ranges = captured.map((p) => [p.from_line, p.to_line]);
  assert.deepEqual(ranges, [[1, 1], [2, 2], [3, 3]]);
});

// ─── test 17: repo with no origin → its segment is skipped ──────────────────────

test('17. repo without an origin remote → segment skipped, cursor still advances', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const u = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const transcript = writeTranscript(dir, [
    repoAssistantLine('/repo/noorigin', 'frozen', 'model-a', u, '2024-01-01T10:00:00.000Z'),
  ]);

  let fetchCalled = false;
  await runCheckpoint(
    { session_id: 'sess-17', transcript_path: transcript, cwd: '/repo/noorigin' },
    {
      getToken: async () => 'tok',
      gitImpl: fakeGitByRoot({ '/repo/noorigin': { branch: 'feature/task-a', remote: null } }),
      fetchImpl: async () => { fetchCalled = true; return { status: 200 }; },
    },
  );

  assert.equal(readQueue(dir).length, 0, 'no queue file when origin cannot be resolved');
  assert.equal(fetchCalled, false, 'fetch not called');
  const state = readState(dir, 'sess-17');
  assert.ok(state, 'state file exists');
  assert.equal(state.cursor, 1, 'cursor advanced past the skipped segment');
});
```

- [ ] **Step 4: Run the checkpoint suite to confirm the intended failures**

Run: `node --test test/checkpoint.test.mjs`
Expected: FAIL on 3–8, 14–17 (current `runCheckpoint` still resolves remote from `seg.cwd || cwd` and ignores repo/reflog resolvers). Tests 1, 2, 7, 9–13 pass.

- [ ] **Step 5: Rewrite `runCheckpoint` in `lib/checkpoint.mjs`**

Update the imports at the top of `lib/checkpoint.mjs`. Replace:
```javascript
import { git, sanitizeRemote } from './git.mjs';
```
with:
```javascript
import { git, sanitizeRemote } from './git.mjs';
import { readCheckoutEvents, buildBranchTimeline, branchAt as branchAtReflog } from './reflog.mjs';
import { resolveRepoRoot } from './repo-timeline.mjs';
```

Replace the exported `runCheckpoint` function (lines 34–88 of the current file — from `export async function runCheckpoint` down to its closing `}`, i.e. everything before `export async function flushQueue`) with:

```javascript
// Returns { enqueued, flush } — flush is the flushQueue summary (or null when it never ran).
export async function runCheckpoint(input, deps = {}) {
  const { session_id, transcript_path, cwd } = input;
  const getToken = deps.getToken ?? _getToken;
  const gitImpl = deps.gitImpl ?? git;
  const computeDelta = deps.computeDelta ?? _computeDelta;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  const billingSource = detectBillingSource();
  const sessionName = sessionNameFrom(transcript_path);

  let token = null;
  try { token = await getToken(); } catch { return { enqueued: 0, flush: null }; }
  if (!token) return { enqueued: 0, flush: null };

  // Memoized git shell-outs for this checkpoint: dir→root, root→remote, root→reflog/HEAD.
  const rootCache = new Map();
  const remoteCache = new Map();
  const timelineCache = new Map();

  const repoRootOf = (dir) => resolveRepoRoot(gitImpl, dir, rootCache);

  const branchOf = (root, ms) => {
    if (!root) return '(unknown)';
    let entry = timelineCache.get(root);
    if (!entry) {
      let timeline = null;
      let headBranch = '(unknown)';
      try { timeline = buildBranchTimeline(readCheckoutEvents(gitImpl, root)); } catch { timeline = null; }
      if (!timeline) {
        try { headBranch = gitImpl(['rev-parse', '--abbrev-ref', 'HEAD'], root).trim(); } catch { headBranch = '(unknown)'; }
      }
      entry = { timeline, headBranch };
      timelineCache.set(root, entry);
    }
    return (entry.timeline && ms != null) ? branchAtReflog(entry.timeline, ms) : entry.headBranch;
  };

  const resolveRemote = (root) => {
    if (!root) return null;
    if (remoteCache.has(root)) return remoteCache.get(root);
    let r = null;
    try { r = sanitizeRemote(gitImpl(['remote', 'get-url', 'origin'], root)); } catch { r = null; }
    remoteCache.set(root, r);
    return r;
  };

  const state = loadState(session_id);
  let delta;
  try {
    delta = computeDelta(transcript_path, state.cursor, { cwd, repoRootOf, branchAt: branchOf });
  } catch {
    return { enqueued: 0, flush: null };
  }
  const { nextCursor, segments } = delta;

  let enqueued = 0;
  for (const seg of segments) {
    if (seg.stats.token_total === 0 && seg.stats.duration_sec === 0) continue;
    const remote = resolveRemote(seg.repoRoot);
    if (!remote) continue;
    enqueue({
      segmentId: `${session_id}:${seg.fromLine}-${seg.toLine}`,
      sessionId: session_id,
      remote,
      branch: seg.branch,
      from_line: seg.fromLine,
      to_line: seg.toLine,
      billing_source: billingSource,
      session_name: sessionName,
      ...seg.stats,
    });
    enqueued += 1;
  }

  if (nextCursor !== state.cursor) {
    state.cursor = nextCursor;
    saveState(session_id, state);
  }

  const flush = await flushQueue(token, { fetchImpl });
  return { enqueued, flush };
}
```

Leave `flushQueue`, `loadState`, `saveState`, and `enqueue` unchanged.

- [ ] **Step 6: Run the checkpoint suite to verify all tests pass**

Run: `node --test test/checkpoint.test.mjs`
Expected: PASS — original 1–14 (updated via routers) plus new 15, 16, 17.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS across all files (`reflog`, `repo-timeline`, `delta`, `checkpoint`, and the untouched `git`, `hook-input`, `prune`, `session-name`, `session-start`, `smoke`, `whoami`, `billing`, `resume-integration`). `resume-integration.test.mjs` needs **no change**: its `fakeGit` returns the remote string for every git call, so the whole (single-repo, no-tool-path) session resolves to one constant `repoRoot`+`branch` → one contiguous run; those tests assert only `from_line`/`to_line`/`token_total` (never `branch` or `remote`), which the run logic preserves.

- [ ] **Step 8: Commit** (skip unless the user asks)

```bash
git add lib/checkpoint.mjs test/checkpoint.test.mjs
git commit -m "feat(checkpoint): attribute each segment to its real repo + per-repo branch"
```

---

## Self-Review

**Spec coverage:**
- Per-line repo signal from tool paths + `cd`, last-touch-wins, carry-forward → `lib/repo-timeline.mjs` (Task 2) + delta walk (Task 3). ✅
- Repo root resolution + memoization → `resolveRepoRoot` (Task 2), `rootCache` (Task 4). ✅
- Per-repo branch via reflog with current-HEAD fallback → `branchOf` closure (Task 4), reusing `lib/reflog.mjs` (Task 1). ✅
- Disjoint contiguous `(repo, branch)` runs → `computeDelta` run logic (Task 3), asserted in P1/16. ✅
- Correct per-segment `remote` (by repoRoot) → `resolveRemote(seg.repoRoot)` (Task 4), asserted in 15. ✅
- No payload/server change; `segmentId` scheme intact → Task 4 keeps the enqueue shape. ✅
- Edge cases: non-repo dir → carry forward (P6); unparseable `cd` → null (repo-timeline tests); no-origin repo skipped (17); git throws → skip/`(unknown)` (checkpoint test 2). ✅
- Idempotency/resume: cursor untouched; carry-forward re-seeds from launch repo per window (spec "Idempotency" section) → `loadState`/`saveState` unchanged (Task 4). ✅ (Resume-window carry-forward is the documented conservative fallback, not persisted — flagged in the spec.)

**Placeholder scan:** No TBD/TODO; every code and test step contains full source or an exact line-level substitution. ✅

**Type/name consistency:** `extractPathSignal(line, cwd)` and `resolveRepoRoot(gitImpl, dir, cache)` (Task 2) are imported verbatim in Tasks 3/4. `computeDelta(path, fromLine, { cwd, repoRootOf, branchAt })` (Task 3) matches the call in Task 4. Segment field is `repoRoot` everywhere (delta output, checkpoint `seg.repoRoot`, tests). `branchAt` from reflog is imported as `branchAtReflog` in checkpoint to avoid clashing with the resolver key `branchAt`. `runCheckpoint` returns `{ enqueued, flush }` — matching the untouched `scripts/*.mjs` callers and the orthogonal `lib/track.mjs`. ✅

**Scope:** Single subsystem (the analytics attribution path); four dependent tasks (Task 1 a possibly-already-done prerequisite), each independently testable. ✅

**Cross-plan note:** If `2026-07-03-reflog-branch-attribution` is implemented first, its delta/checkpoint rewrites are replaced by Tasks 3–4 here (this plan's delta subsumes the reflog-only `timeline` param via the `branchAt` resolver). Do not run both delta rewrites; run Task 1 once, then this plan's Tasks 2–4. `lib/track.mjs` from that plan remains valid.
```
