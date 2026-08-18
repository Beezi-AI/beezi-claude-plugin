import fs from 'fs';
import os from 'os';
import { configCandidates } from './claude-account.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { usageSnapshotStateFile } from './paths.mjs';

// Standalone capture of the subscription-limit cache, decoupled from runCheckpoint.
//
// Why it exists: the snapshot post used to ride only inside runCheckpoint, which runs at turn end,
// session end, and git Bash commands. Claude Code refreshes `cachedUsageUtilization` on its own
// schedule, so any refresh landing mid-turn — during a long agent run, or between a compaction and
// the next Stop — was simply never observed. Missed observations bias the exhausted-window counts
// DOWNWARD, which is the wrong direction for a check that recommends buying a bigger plan.
//
// This does NOT make the data fresher. Freshness is capped by Claude Code's own refresh schedule;
// we only widen how many of its distinct refreshes we actually see.
//
// Cost discipline: this runs on every prompt. `~/.claude.json` is routinely megabytes, so parsing
// it per prompt is not acceptable. The mtime gate below turns the common case into a single stat()
// — no parse, no token load, no network.

function newestConfigMtimeMs(env, homedir, statFn) {
  let newest = 0;
  for (const p of configCandidates(env, homedir)) {
    try {
      const { mtimeMs } = statFn(p);
      if (mtimeMs > newest) newest = mtimeMs;
    } catch {
      /* absent candidate — the next one may exist */
    }
  }
  return newest;
}

// Best-effort by construction: every failure path returns a reason and never throws, so a hook
// wrapping this can never delay or break a turn.
export async function pingUsageSnapshot(deps = {}) {
  const statFn = deps.statSync == null ? ((p) => fs.statSync(p)) : deps.statSync;
  const env = deps.env == null ? process.env : deps.env;
  const homedir = deps.homedir == null ? os.homedir() : deps.homedir;

  const mtimeMs = newestConfigMtimeMs(env, homedir, statFn);
  if (mtimeMs === 0) return { reported: false, reason: 'no-config' };

  const stateFile = usageSnapshotStateFile();
  const storedState = readJson(stateFile);
  const state = storedState == null ? {} : storedState;
  // The file has not been touched since we last looked, so the cache inside it cannot have moved.
  if (state.lastSeenConfigMtimeMs === mtimeMs) {
    return { reported: false, reason: 'unchanged' };
  }

  // The file moved — but `~/.claude.json` is rewritten for many reasons that have nothing to do
  // with usage, so record the mtime first and let the (account, fetchedAt) marker decide whether
  // anything is actually worth sending.
  try {
    writeJsonSecure(stateFile, { ...state, version: 1, lastSeenConfigMtimeMs: mtimeMs });
  } catch {
    /* best-effort: a failed marker write only costs one redundant check next time */
  }

  // Heavy imports stay off the fast path — reached only when the config file actually changed.
  const { getAccessToken } = await import('./token.mjs');
  const { maybePostUsageSnapshot } = await import('./usage-snapshot-report.mjs');

  let token = null;
  try {
    token = await getAccessToken();
  } catch {
    return { reported: false, reason: 'no-token' };
  }
  if (!token) return { reported: false, reason: 'no-token' };

  try {
    return await maybePostUsageSnapshot(token, deps);
  } catch {
    return { reported: false, reason: 'network' };
  }
}
