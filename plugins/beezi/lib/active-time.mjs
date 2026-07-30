// Active time is a UNION of wall-clock intervals, never a sum. A session's main thread and its
// subagents describe the SAME stretch of clock: the parent blocks on the Task tool_use while its
// agents run, and parallel agents overlap each other. Adding their durations bills one second once
// per agent — six agents fanned out over 520s of wall clock reported 2204s.
//
// Every interval is a half-open [startMs, endMs) pair, ascending and disjoint once merged.

// Coverage is persisted in per-session state on disk, so a pathological session (thousands of idle
// gaps) must not grow it without bound. Dropping the OLDEST entries is safe: activity only moves
// forward in wall clock, so entries this far back can no longer overlap an incoming window.
const MAX_COVERED_INTERVALS = 512;

// Consecutive timestamps closer together than the idle gap describe one continuous run of work.
// Gaps at or beyond the threshold are idle and contribute nothing — the same rule the scalar
// duration used, so a transcript with no overlapping sibling totals exactly what it did before.
export function buildActiveIntervals(timestamps, idleGapMs) {
  const sorted = [...timestamps].sort((a, z) => a - z);
  const out = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const gap = cur - prev;
    if (gap <= 0 || gap >= idleGapMs) continue;
    const last = out[out.length - 1];
    if (last && last[1] >= prev) last[1] = Math.max(last[1], cur);
    else out.push([prev, cur]);
  }
  return out;
}

// Normalize any interval list into ascending, disjoint coverage. Touching intervals coalesce.
export function mergeIntervals(intervals) {
  const sorted = intervals.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

// The parts of `intervals` that `covered` does not already account for. `covered` must be merged.
// Both sides are ascending, so the cursor into `covered` only ever moves forward.
export function subtractIntervals(intervals, covered) {
  const own = mergeIntervals(intervals);
  if (covered.length === 0) return own;

  const out = [];
  let ci = 0;
  for (const [start, end] of own) {
    let s = start;
    while (ci < covered.length && covered[ci][1] <= s) ci++;
    for (let k = ci; k < covered.length && s < end && covered[k][0] < end; k++) {
      const [cs, ce] = covered[k];
      if (cs > s) out.push([s, Math.min(cs, end)]);
      if (ce > s) s = ce;
    }
    if (s < end) out.push([s, end]);
  }
  return out;
}

export function totalMs(intervals) {
  return intervals.reduce((acc, [s, e]) => acc + Math.max(0, e - s), 0);
}

// Fold new intervals into existing coverage, bounded for on-disk storage.
export function claimIntervals(covered, intervals) {
  const merged = mergeIntervals([...covered, ...intervals]);
  return merged.length > MAX_COVERED_INTERVALS ? merged.slice(-MAX_COVERED_INTERVALS) : merged;
}
