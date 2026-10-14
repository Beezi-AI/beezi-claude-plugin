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
  let at = 0;
  let lo = 0;
  let hi = timeline.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (timeline[mid].ms <= ms) {
      at = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return timeline[at].branch;
}
