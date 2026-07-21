# Reflog-Joined Branch Attribution — Design

Date: 2026-07-03
Component: `beezi-analytics-plugin`
Status: Approved for planning

## Problem

The plugin reports Claude Code token/time analytics per Beezi task branch (`.../task-<id>`).
Attribution today comes from the transcript's per-line `gitBranch` stamp, bucketed in
`computeDelta` (`lib/delta.mjs`) into **one segment per branch** using the min/max line
number seen for that branch.

Two defects follow when branches interleave inside a single checkpoint window
(user works A → switches to B → returns to A, or A → non-beezi → A):

1. **Overlapping segment ranges.** Segment A becomes `fromLine=1..toLine=15` while B is
   `6..10`. Token *sums* stay correct (bucketed), but the `segmentId`
   (`session:fromLine-toLine`, the server's idempotency key) ranges overlap and mislead.
2. **Active-time double count.** A's idle-gap bridging can count wall-clock seconds that
   actually belong to B, so the same seconds are attributed to two tasks.

A third defect exists in the **manual save path**: `/beezi:track` (`scripts/track.mjs`)
refuses to run when the branch *currently checked out* is not a task branch — it calls
`taskFromBranch(currentBranch)` and `fail()`s **before** `runCheckpoint`. So if a user does
work on `feat/task-A`, switches to `main`, then runs `/beezi:track`, the un-checkpointed
task-A tokens are dropped by that command. (SessionEnd and commit-triggered PostToolUse
checkpoints do *not* have this gate and already capture the work.)

## Goals

- Attribute each transcript line to the branch that was actually checked out **at that
  line's timestamp**, using `git reflog` as the authoritative branch-over-time timeline.
- Emit **contiguous, non-overlapping** segments; each maximal same-branch run is its own
  segment.
- Compute active time **within** each run so no wall-clock second is attributed to two tasks.
- Skip runs whose branch is not a `.../task-<id>` branch.
- Remove the current-branch gate from `/beezi:track` so manual save attributes by history,
  not by the branch HEAD happens to sit on.

## Non-goals

- No new payload fields. The server contract (`POST /sessions/report`) and `segmentId`
  scheme are unchanged. This is **re-attribution only** — commits/diffs are **not** captured.
- No change to the queue/flush, resume/cursor, credentials, or repo-status logic.

## Approach

Chosen: **reflog-joined attribution** (over the simpler transcript-`gitBranch`
run-segmentation). The branch *source* becomes reflog; the run-segmentation and per-run
active-time machinery are new but shared regardless of source.

Because both the transcript timestamps and the reflog timestamps come from the **same
machine's clock**, the join is a second-resolution lookup on a single clock — no
cross-machine skew.

## Architecture

### New module: `lib/reflog.mjs` (pure; injected `git`)

```
readCheckoutEvents(gitImpl, cwd) -> [{ ms, from, to }]     // ascending by ms
buildBranchTimeline(events) -> [{ ms, branch }] | null      // null when events is empty
branchAt(timeline, ms) -> branch
```

- `readCheckoutEvents` runs `git reflog --date=iso-strict -n 1000` in `cwd` and parses lines
  matching:
  `/HEAD@\{([^}]+)\}:\s*checkout:\s*moving from (\S+) to (\S+)/`
  Each match → `{ ms: Date.parse(dateStr), from, to }`. `iso-strict` yields
  `2026-07-03T10:05:00+00:00`, which `Date.parse` handles reliably. Non-checkout entries
  (commit/reset/rebase) are ignored — they do not change the branch *name*. Result sorted
  ascending by `ms`.
- `buildBranchTimeline(events)`:
  - If events exist: first boundary is `{ ms: -Infinity, branch: events[0].from }` (the
    branch active before the earliest recorded checkout, i.e. at session start), then one
    boundary `{ ms: e.ms, branch: e.to }` per event.
  - **If events is empty: return `null`.** No checkout ever occurred, so the transcript's
    per-line `gitBranch` already matches reality; the caller passes `null` to `computeDelta`,
    which falls back to `gitBranch`. This keeps the feature purely additive — reflog changes
    attribution *only* when real checkout events exist — and needs no `git rev-parse` /
    `currentBranch` lookup.
- `branchAt(timeline, ms)`: returns the branch of the **last** boundary whose `ms ≤ ms`.
  A non-null timeline always carries the `-Infinity` sentinel, so any timestamp resolves.
  Tie rule: a line whose timestamp equals a checkout second is attributed to the **new**
  branch (`≤`).

### Changed: `lib/delta.mjs`

`computeDelta(transcriptPath, fromLine, timeline)` gains the `timeline` param and switches
from per-branch buckets to **ordered runs**:

- Walk new lines (`lineNo > fromLine`), advancing `processed = lineNo`.
- Blank / JSON-unparseable lines are transparent: skip without opening/closing/altering the
  current run (but `processed` still advances).
- For a parsed content line:
  - `lineMs = line.timestamp ? Date.parse(line.timestamp) : null`.
  - `branch = (timeline && lineMs != null) ? branchAt(timeline, lineMs) : (line.gitBranch || '(unknown)')`.
    This is the **fallback**: when reflog is unavailable (`timeline === null`) or a line has
    no timestamp, attribution degrades to the existing `line.gitBranch` behavior.
  - If `branch !== currentRun.branch`, close `currentRun` and open a new run
    `{ branch, fromLine: lineNo, toLine: lineNo, models: {}, timestamps: [] }`.
  - `currentRun.toLine = lineNo`; push `lineMs` (if present) to `currentRun.timestamps`.
  - Assistant-usage accumulation and **global** message dedup (`countedMessages` keyed on
    `message.id`/`requestId`) are unchanged; a message's tokens land in whichever run is
    active at its first counted content-block line.
- Return `{ nextCursor: processed, segments }` where `segments` is the ordered run list, each
  summarized by the existing `summarize(models, timestamps)` (active time = sum of
  intra-run gaps `< IDLE_GAP_SEC`).

Runs partition the consecutive content lines of the window, so their `fromLine..toLine`
ranges are **disjoint and non-overlapping**.

### Changed: `lib/checkpoint.mjs`

Before calling `computeDelta`, build the timeline:

```
let timeline = null;
try {
  timeline = buildBranchTimeline(readCheckoutEvents(gitImpl, cwd));
} catch { timeline = null; }   // degrade to gitBranch fallback
delta = computeDelta(transcript_path, state.cursor, timeline);
```

- `readCheckoutEvents` is called with the injected `gitImpl`, so tests control reflog output.
  A `gitImpl` that returns no parseable checkout lines yields `timeline = null` (gitBranch
  fallback) — which is why the existing checkpoint tests, whose `gitImpl` returns the remote
  string for every call, keep passing unchanged.
- The per-run skip logic is unchanged in intent: `if (!TASK_BRANCH_RE.test(seg.branch)) continue;`
  and `if (seg.stats.token_total === 0 && seg.stats.duration_sec === 0) continue;`.
- `segmentId` remains `` `${session_id}:${seg.fromLine}-${seg.toLine}` `` — now guaranteed
  non-overlapping.
- `runCheckpoint` additionally returns the **set of task tokens saved** (derived from the
  emitted task segments via `taskFromBranch(seg.branch)`), e.g.
  `{ enqueued, flush, tasks: ['task-A'] }`, for the manual-save message. `tasks` is a
  de-duplicated, ordered list.

### Changed: `scripts/track.mjs` (Section 5 — manual save)

- **Remove** the `currentBranch` / `taskFromBranch` refusal. Retain only: not-a-git-repo
  (via `git remote get-url origin` throwing), no-`origin`, not-linked, no-transcript.
- Run `runCheckpoint` unconditionally; reflog attributes the delta.
- Message no longer references the current branch:
  - Saved something → `✓ Beezi: analytics saved (${saved} segment${s}) for ${tasks.join(', ')}.`
  - Delta held only non-beezi/no new work → `✓ Beezi: nothing new to save — already up to date.`
  - Transient/permanent server failures reported as today (`flush.failed` / `flush.rejected`).

## Data flow (checkpoint)

```
hook input {session_id, transcript_path, cwd}
  -> token + origin remote guards
  -> reflog: readCheckoutEvents -> buildBranchTimeline -> timeline (or null)
  -> computeDelta(transcript, cursor, timeline)
       -> per-line branchAt(timeline, ts) (fallback gitBranch)
       -> ordered contiguous runs -> segments
  -> per segment: skip non-task / empty; enqueue {segmentId, branch, from_line, to_line, ...stats}
  -> advance cursor; flushQueue
```

## Edge cases

- **`git reflog` throws / not a repo** → `timeline = null` → every line falls back to
  `line.gitBranch` = exactly today's behavior. Never crash, never lose tracking.
- **Line missing `timestamp`** → that line falls back to its own `line.gitBranch`.
- **Detached-HEAD checkout** (`to` is a SHA) → branch = SHA → fails `TASK_BRANCH_RE` →
  skipped. Detached *now* with no events → `currentBranch` returns `HEAD` → skipped.
- **Line timestamp before earliest event** → resolved by the `-Infinity` sentinel to
  `events[0].from` (session-start branch).
- **Reflog has zero checkout events** → `timeline = null` → per-line `gitBranch` fallback →
  outcome identical to today. (Distinct from "no checkouts *during* the session but a prior
  checkout exists" — there events are non-empty and the sentinel resolves every line to the
  session-start branch.)
- **Reflog larger than 1000 HEAD-moves** → capped by `-n 1000` (far beyond any session);
  if the cap ever truncated the session-start checkout, early lines fall back to
  `gitBranch`.

## Idempotency / resume

Unchanged. The cursor advances monotonically; each line is classified exactly once, at the
first checkpoint that sees it, against a reflog that only grows — so a line's branch
classification is stable across checkpoints and resumes. `segmentId` ranges are now
non-overlapping, strengthening the server's upsert-by-`segmentId` contract.

## Testing

- **`test/reflog.test.mjs`** (new):
  - Parse a multi-entry `git reflog --date=iso-strict` sample (checkout + commit + reset
    interleaved) → only checkout events, ascending.
  - `buildBranchTimeline` sentinel = first event's `from`; boundaries ordered.
  - `branchAt` boundary/tie behavior; timestamp before first event → session-start branch.
  - No events → `buildBranchTimeline` returns `null`. Detached (`to` = SHA) preserved as SHA.
- **`test/delta.test.mjs`** (extend):
  - A → B → A interleave yields three runs; emitted task segments have **non-overlapping**
    `fromLine..toLine`; per-run active time excludes the other run's span.
  - `timeline = null` → falls back to `line.gitBranch` (existing assertions stay green).
  - Message dedup across a run boundary counts tokens once.
- **`test/resume-integration.test.mjs`** (extend): a manual-save-style checkpoint while the
  timeline's latest boundary is a non-task branch still saves the earlier task run;
  `segmentId` ranges disjoint.
- **`test/checkpoint.test.mjs`** (extend if present): `runCheckpoint` returns `tasks`.

## Backward compatibility

- `computeDelta` signature gains a third param; the sole caller (`checkpoint.mjs`) is updated.
  Passing `timeline = null` reproduces prior behavior, so existing tests remain valid.
- No server-side change. No payload change. No state-file format change.

## Risks

- **Second-resolution ties** at a checkout boundary can misassign a line landing in the exact
  checkout second; bounded to one line, single clock, acceptable.
- **Reflog expiry** (`gc.reflogExpire`, default 90d) is irrelevant within a session window.
- **`git switch` vs `git checkout`** both log `checkout: moving from … to …`; covered.
  Worktrees have independent HEAD logs — out of scope (each worktree is its own `cwd`/session).
```
