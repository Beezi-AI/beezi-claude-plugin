// /beezi:sync runs one audit per account x workspace. A `busy` run means another sync holds the
// machine-wide `session-audit` lock, or a background upload held the `upload` lock through the
// whole bounded wait (DRAIN_LOCK_WAIT_MS). Both locks live under BEEZI_HOME, not per account or
// workspace, so every run after it would wait just as long and end just as busy: N workspaces
// would cost N x 60 s. The loop stops at the first one, which has already printed the busy line.

export function isBusy(result) {
  return result != null && result.reason === 'busy';
}

// Runs `runOne(item, index)` in order and stops after the first run whose result is busy.
// -> true when it stopped on busy, false when every item ran.
export async function eachUntilBusy(items, runOne) {
  for (let i = 0; i < items.length; i += 1) {
    if (isBusy(await runOne(items[i], i))) return true;
  }
  return false;
}
