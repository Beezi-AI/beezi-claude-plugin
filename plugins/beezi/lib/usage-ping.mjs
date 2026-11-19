import fs from 'fs';
import os from 'os';
import { configCandidates } from './claude-account.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { usagePingStateFile, usageSnapshotStateFile } from './paths.mjs';

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

  // Machine-level: the config file is one file, so the mtime gate is asked once, not per account.
  const stateFile = usagePingStateFile();
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
    writeJsonSecure(stateFile, { version: 1, lastSeenConfigMtimeMs: mtimeMs });
  } catch {
    /* best-effort: a failed marker write only costs one redundant check next time */
  }

  // Heavy imports stay off the fast path — reached only when the config file actually changed.
  const sessionsModule = await import('./sessions.mjs');
  const { listAccounts: _listAccounts, AccountStatus } = await import('./accounts.mjs');
  const { allowsLiveFor, readTrackingState } = await import('./tracking.mjs');
  const { readSessionWorkspace, expandTargets, resolveTargets } = await import('./workspace.mjs');
  const listAccounts = deps.listAccounts == null ? _listAccounts : deps.listAccounts;

  // Every gate runs on the account rows, which hold no token, and the hook never reads a
  // credential at all (a read costs a PowerShell start on Windows): what survives the gates is
  // written to the outbox as a snapshot item, and the upload worker posts it with the token it
  // reads once per run.
  let rows = [];
  try {
    rows = await listAccounts();
  } catch {
    return { reported: false, reason: 'no-token' };
  }
  // Rows become recipients only through accountRecipient: a row's own tenantId is the web-side
  // tenant, and expandTargets would follow it unexpanded.
  const accounts = (rows || [])
    .filter((row) => row != null && row.status === AccountStatus.LINKED)
    .map(sessionsModule.accountRecipient);
  if (accounts.length === 0) return { reported: false, reason: 'no-token' };

  // Stamped from the hook's session; the env id covers a caller that does not pass one.
  const sessionId = deps.sessionId == null ? env.CLAUDE_CODE_SESSION_ID : deps.sessionId;
  let workspaceState = null;
  try { workspaceState = sessionId == null ? null : readSessionWorkspace(sessionId); } catch { workspaceState = null; }
  // One clone per target workspace; an account with none left is skipped.
  let targets = expandTargets(accounts, workspaceState);
  if (targets.length === 0) {
    // Pending only while the session awaits a rule; otherwise a Don't track rule or New folders Don't send.
    const pending = accounts.some((s) => resolveTargets(s, workspaceState).pendingAsk);
    return { reported: false, reason: pending ? 'workspace-pending' : 'no-targets' };
  }

  // Each account answers for itself: a dark tenant is dropped before the fan-out, not at the server.
  targets = targets.filter((s) => allowsLiveFor(s, readTrackingState(s.key)));
  if (targets.length === 0) return { reported: false, reason: 'tracking-disabled' };

  // The sample is the usage reading as seen now: the worker posts each stored sample as it was,
  // so refreshes between this ping and the send are not collapsed into one.
  const { readUsageUtilization: _readUsageUtilization } = await import('./usage-utilization.mjs');
  const readUsageUtilization = deps.readUsageUtilization == null ? _readUsageUtilization : deps.readUsageUtilization;
  let sample = null;
  try { sample = readUsageUtilization(); } catch { sample = null; }
  if (!sample) return { reported: false, reason: 'no-utilization' };

  // The marker maybePostUsageSnapshot advances on a confirmed send. A config rewrite that did not
  // move the reading must not wake the worker (and its credential read) for a sample every target
  // already sent, so those targets are dropped here, as the post would skip them there.
  const unsent = targets.filter((s) => !sampleAlreadySent(readJson(usageSnapshotStateFile(s.key)), s.tenantId, sample));
  if (unsent.length === 0) return { reported: false, reason: 'already-sent' };

  // One snapshot item per account, with that account's surviving target workspaces.
  const clonesByKey = new Map();
  for (const s of unsent) {
    if (!clonesByKey.has(s.key)) clonesByKey.set(s.key, []);
    clonesByKey.get(s.key).push(s);
  }
  const { enqueueOutbox, OUTBOX_KINDS } = await import('./outbox.mjs');
  let outboxed = 0;
  for (const [key, clones] of clonesByKey) {
    try {
      enqueueOutbox(key, { kind: OUTBOX_KINDS.SNAPSHOT, tenantId: null, targets: clones.map((s) => s.tenantId), sample });
      outboxed += 1;
    } catch { /* best-effort: the next ping or turn-end writes it again */ }
  }
  if (outboxed === 0) return { reported: false, reason: 'outbox-failed' };

  let spawn = null;
  try {
    const spawnUploadWorker = deps.spawnUploadWorker == null
      ? (await import('./upload-trigger.mjs')).maybeSpawnUploadWorker
      : deps.spawnUploadWorker;
    spawn = spawnUploadWorker();
  } catch { spawn = 'failed'; }
  return { reported: false, reason: 'outboxed', outboxed, spawn };
}

// Same rule as maybePostUsageSnapshot's marker: per workspace when the target has one.
function sampleAlreadySent(state, tenantId, sample) {
  if (state == null) return false;
  const byTenant = state.lastSentByTenant == null ? {} : state.lastSentByTenant;
  const marker = tenantId == null ? state.lastSent : byTenant[tenantId];
  return marker != null && marker.accountUuid === sample.accountUuid && marker.fetchedAtMs === sample.fetchedAtMs;
}
