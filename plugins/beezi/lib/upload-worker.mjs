import fs from 'fs';
import os from 'os';
import path from 'path';
import { accountsRoot, uploadWorkerFile } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { acquireOwnedLock } from './single-instance-lock.mjs';
import { AUTH_STATES } from './auth-state.mjs';

// The background uploader: one process per Beezi home drains every linked account's queue under
// the owned lock `upload` (<home>/upload.lock), so hooks only enqueue and hand off.
//
// Everything heavy (checkpoint.mjs for flushQueue, token.mjs and sessions.mjs for credentials,
// outbox-delivery.mjs and the snapshot/binding posts) is imported lazily inside runUploadWorker. The spawn gate (upload-trigger.mjs) imports this module
// on every hook for the status and queue helpers, and checkpoint.mjs imports the gate: a static
// import of checkpoint.mjs here would make that a cycle and load the whole reporting path into
// a gate that only needs a few stat calls.

export const UPLOAD_LOCK = 'upload';
// The lock dir's mtime is touched this often. Far inside LOCK_STALE_MS (10 min), so a live
// worker is never mistaken for a dead one by the spawn gate or by a second worker.
export const HEARTBEAT_MS = 60000;
// Passes in a row that moved nothing before the worker gives up as `stalled`.
export const MAX_IDLE_PASSES = 3;
export const IDLE_PASS_SLEEP_MS = 5000;
// After a stalled, tracking-disabled, no-accounts, crashed or watchdog-cut run the gate does not respawn for this long:
// otherwise an offline machine or a revoked account would pay a credential read every 30 s.
export const STALLED_RETRY_MS = 5 * 60 * 1000;
// Default run length when the caller gives no deadline; the entrypoint's watchdog is 5 min.
export const WORKER_RUN_MS = 270000;
// After the batch route failed and the single-route fallback delivered (an older server), the
// worker posts one by one for this long before it tries batches again.
export const BATCH_UNSUPPORTED_MS = 24 * 60 * 60 * 1000;
// While another process refreshes a token, the sessions are resolved again after this wait, up to AUTH_RESOLVES times in all.
export const AUTH_RETRY_MS = 2000;
const AUTH_RESOLVES = 3;

const STATUS_VERSION = 1;
// A crash (a throw out of the run, an uncaught error in the entrypoint) and a watchdog cut-off
// back off too: whatever broke this run would break the next one, and a respawn every 30 s would
// repeat it on every turn.
const RETRY_OUTCOMES = ['stalled', 'tracking-disabled', 'no-accounts', 'crash', 'watchdog'];
const ACCOUNT_KEY = /^[0-9a-f]{8}$/;

// `{}` when missing or unreadable. Never throws.
export function readUploadStatus() {
  const value = readJson(uploadWorkerFile(), null);
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

// Read-merge-write. A trigger and a worker writing at the same instant can drop one field; the
// worst cases are one extra spawn or one 30 s delay, both harmless. Never throws.
export function writeUploadStatus(patch) {
  try {
    writeJsonSecure(uploadWorkerFile(), Object.assign({}, readUploadStatus(), patch, { version: STATUS_VERSION }));
    return true;
  } catch {
    return false;
  }
}

// The status patch a finished run records: the run's own finally and the entrypoint's crash and
// watchdog exits (scripts/upload-worker.mjs) both write this, so every outcome in RETRY_OUTCOMES
// sets the gate's backoff the same way.
export function workerExitStatus(outcome, at) {
  return {
    state: 'idle',
    lastRunAt: at,
    outcome,
    retryAfterAt: RETRY_OUTCOMES.indexOf(outcome) !== -1 ? at + STALLED_RETRY_MS : null,
  };
}

// Every queued report or outbox item a worker could post: <home>/accounts/*/queue/*.json and
// <home>/accounts/*/outbox/*.json, minus held `__ask` queue files (they wait on a workspace
// choice, not on the network) and anything not newer than `newerThanMs`. The `.json` suffix test
// also drops `.tmp` writes in progress, `.corrupt` quarantines and claimed outbox `.sending`
// files. Outbox entries carry `outbox: true`. Sync and never throws: the spawn gate runs it on
// every hook.
export function postableQueueFiles(newerThanMs = 0) {
  const out = [];
  let keys;
  try { keys = fs.readdirSync(accountsRoot()); } catch { return out; }
  for (const key of keys) {
    if (!ACCOUNT_KEY.test(key)) continue;
    for (const sub of ['queue', 'outbox']) {
      const dir = path.join(accountsRoot(), key, sub);
      let names;
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        if (sub === 'queue' && name.endsWith('__ask.json')) continue;
        let mtimeMs;
        try { mtimeMs = fs.statSync(path.join(dir, name)).mtimeMs; } catch { continue; }
        if (mtimeMs <= newerThanMs) continue;
        out.push(sub === 'outbox' ? { key, name, mtimeMs, outbox: true } : { key, name, mtimeMs });
      }
    }
  }
  return out;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function count(results, field) {
  let total = 0;
  for (const r of results) {
    const n = r == null ? 0 : Number(r[field]);
    if (n > 0) total += n;
  }
  return total;
}

async function loadModules() {
  const checkpoint = await import('./checkpoint.mjs');
  const token = await import('./token.mjs');
  const sessions = await import('./sessions.mjs');
  const accounts = await import('./accounts.mjs');
  const delivery = await import('./outbox-delivery.mjs');
  const snapshots = await import('./usage-snapshot-report.mjs');
  const binding = await import('./installation-binding.mjs');
  const settingsEnv = await import('./claude-settings-env.mjs');
  return {
    flushQueue: checkpoint.flushQueue,
    postBudgetMs: checkpoint.POST_BUDGET_MS,
    getAuthentication: token.getAuthentication,
    interactiveWaitMs: token.INTERACTIVE_REFRESH_WAIT_MS,
    linkedSessions: sessions.linkedSessions,
    diagnosticsSession: sessions.diagnosticsSession,
    getDefaultKey: accounts.getDefaultKey,
    deliverOutbox: delivery.deliverOutbox,
    drainStatuslineSnapshots: snapshots.drainStatuslineSnapshots,
    bindInstallationIfNeeded: binding.bindInstallationIfNeeded,
    resolveEnv: () => settingsEnv.oauthTokenEnvWithOsProbe(process.env),
  };
}

// Drains the queue in passes until it is empty, then exits. Each pass, per account: flushQueue,
// then deliverOutbox (lib/outbox-delivery.mjs); then one statusline drain across every account's
// snapshot targets, and (first pass only) the installation binding. Returns
// { outcome: 'busy'|'no-accounts'|'auth-busy'|'empty'|'stalled'|'tracking-disabled'|'lock-lost'|'deadline', passes, flushed }.
// A throw inside the run still releases the lock and records `crash` before it propagates.
export async function runUploadWorker(deps = {}) {
  const acquireLock = deps.acquireLock == null ? acquireOwnedLock : deps.acquireLock;
  const onLock = deps.onLock == null ? (() => {}) : deps.onLock;
  const setPriority = deps.setPriority == null ? os.setPriority : deps.setPriority;
  const now = deps.now == null ? Date.now : deps.now;
  const deadline = deps.deadline == null ? now() + WORKER_RUN_MS : deps.deadline;
  const sleep = deps.sleep == null ? defaultSleep : deps.sleep;
  const setIntervalImpl = deps.setIntervalImpl == null ? setInterval : deps.setIntervalImpl;
  const clearIntervalImpl = deps.clearIntervalImpl == null ? clearInterval : deps.clearIntervalImpl;
  const postableFiles = deps.postableFiles == null ? postableQueueFiles : deps.postableFiles;

  let lock = acquireLock(UPLOAD_LOCK);
  // Another worker (or /beezi:sync) is sending. Its status is the truth; do not touch it.
  if (lock == null) return { outcome: 'busy', passes: 0, flushed: 0 };
  onLock(lock);

  // Below-normal priority so a long drain never competes with the user's editor or build.
  try { setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best-effort */ }

  let mods = null;
  let passes = 0;
  let flushed = 0;
  let progressTotal = 0;
  let outcome = null;
  // Once per run, across the re-acquire rounds below.
  let bindingTried = false;
  let envResolved = false;
  let envValue = null;
  // Batches unless a fallback in an earlier run marked the server as one without the batch route.
  // Read once per run (re-acquire rounds keep it); BEEZI_NO_BATCH=1 is honored inside flushQueue.
  const batchUnsupportedUntil = Number(readUploadStatus().batchUnsupportedUntil);
  let batching = !(batchUnsupportedUntil > now());

  for (;;) {
    let lockLost = false;
    let heartbeat = null;
    let lastPassStart = null;
    let roundOutcome = null;
    try {
      writeUploadStatus({ state: 'running', pid: process.pid, startedAt: now() });
      const held = lock;
      heartbeat = setIntervalImpl(() => {
        let ok = false;
        try { ok = held.refresh(); } catch { ok = false; }
        if (!ok) lockLost = true;
      }, HEARTBEAT_MS);
      // The worker's own watchdog and in-flight requests keep it alive; the heartbeat must not.
      if (heartbeat != null && typeof heartbeat.unref === 'function') heartbeat.unref();

      if (mods == null) mods = await loadModules();
      const flushQueue = deps.flushQueue == null ? mods.flushQueue : deps.flushQueue;
      const linkedSessions = deps.linkedSessions == null ? mods.linkedSessions : deps.linkedSessions;
      const getAuthentication = deps.getAuthentication == null ? mods.getAuthentication : deps.getAuthentication;
      const deliverOutbox = deps.deliverOutbox == null ? mods.deliverOutbox : deps.deliverOutbox;
      const drainStatuslineSnapshots = deps.drainStatuslineSnapshots == null ? mods.drainStatuslineSnapshots : deps.drainStatuslineSnapshots;
      const bindInstallationIfNeeded = deps.bindInstallationIfNeeded == null ? mods.bindInstallationIfNeeded : deps.bindInstallationIfNeeded;
      const getDefaultKey = deps.getDefaultKey == null ? mods.getDefaultKey : deps.getDefaultKey;
      const resolveEnv = deps.resolveEnv == null ? mods.resolveEnv : deps.resolveEnv;
      const postBudgetMs = mods.postBudgetMs;

      // Nobody is waiting on this process, so credential reads get the interactive caps: the
      // longer store-read timeout and a refresh that may wait on another holder's lock.
      let refreshSeen = false;
      const interactiveAuth = async (d, o) => {
        const auth = await getAuthentication(d, Object.assign({}, o, { waitMs: mods.interactiveWaitMs }));
        if (auth != null && auth.authState === AUTH_STATES.REFRESHING) refreshSeen = true;
        return auth;
      };
      // The env snapshot posts stamp their identity with: resolved once per run, and only when a
      // snapshot is sent (the OS probe may start a process). Held in memory, never written.
      const getEnv = () => {
        if (!envResolved) {
          envValue = resolveEnv();
          envResolved = true;
        }
        return envValue;
      };
      let sessions = [];
      for (let resolves = 1; ; resolves += 1) {
        refreshSeen = false;
        try {
          sessions = await linkedSessions({ getAuthentication: interactiveAuth });
        } catch { sessions = []; }
        sessions = (Array.isArray(sessions) ? sessions : []).filter((s) => s != null && s.token);
        if (sessions.length > 0 || !refreshSeen || resolves >= AUTH_RESOLVES) break;
        await sleep(AUTH_RETRY_MS);
      }

      if (sessions.length === 0) {
        roundOutcome = refreshSeen ? 'auth-busy' : 'no-accounts';
      } else {
        let idlePasses = 0;
        for (;;) {
          const passStart = now();
          if (lockLost) { roundOutcome = 'lock-lost'; break; }
          if (passStart + postBudgetMs > deadline) { roundOutcome = 'deadline'; break; }
          passes += 1;
          lastPassStart = passStart;
          const results = [];
          const outboxResults = [];
          const drainTargets = [];
          // Per account: the queued reports first, then the outbox (errors, timelines, snapshot).
          for (const session of sessions) {
            let r;
            try { r = await flushQueue(session, { deadline, batch: batching }); } catch { r = { failed: 1 }; }
            results.push(r == null ? {} : r);
            let o;
            try {
              o = await deliverOutbox(session, { deadline, postBudgetMs, getAuthentication: interactiveAuth, getEnv });
            } catch { o = { failed: 1 }; }
            o = o == null ? {} : o;
            outboxResults.push(o);
            if (Array.isArray(o.drainTargets)) for (const target of o.drainTargets) drainTargets.push(target);
          }
          // The batch route was not understood and the single route then delivered: an older
          // server. Remember it for BATCH_UNSUPPORTED_MS and post one by one for the rest of the
          // run. Recorded before any stop below, so a pass that drains everything still saves it.
          if (batching && results.some((r) => r.batchFallbackDelivered === true)) {
            writeUploadStatus({ batchUnsupportedUntil: now() + BATCH_UNSUPPORTED_MS });
            batching = false;
          }
          // The statusline backlog goes out once, to every account's snapshot targets together:
          // a row clears only after every recipient it was given settled it.
          if (drainTargets.length > 0 && now() + postBudgetMs <= deadline) {
            try { await drainStatuslineSnapshots(drainTargets, { env: getEnv() }); } catch { /* best-effort */ }
          }
          // Associates this machine's installation ID with the diagnostics account, once per run.
          if (!bindingTried) {
            bindingTried = true;
            try {
              let defaultKey = null;
              try { defaultKey = await getDefaultKey(); } catch { defaultKey = null; }
              await bindInstallationIfNeeded(mods.diagnosticsSession(sessions, defaultKey));
            } catch { /* best-effort: the next run tries again */ }
          }
          const progress = count(results, 'flushed') + count(results, 'rejected')
            + count(results, 'expired') + count(results, 'quarantined')
            + count(outboxResults, 'sent') + count(outboxResults, 'dropped');
          flushed += count(results, 'flushed');
          progressTotal += progress;

          // Only the queue flush knows the workspace is dark; outbox results never decide this.
          if (results.every((r) => r.trackingDisabled === true)) { roundOutcome = 'tracking-disabled'; break; }
          if (count(results, 'failed') + count(results, 'deferred') + count(outboxResults, 'failed') === 0) {
            // Nothing left that this pass saw. Re-scan for files a hook enqueued meanwhile.
            if (postableFiles(passStart).length === 0) { roundOutcome = 'empty'; break; }
            if (progress > 0) { idlePasses = 0; continue; }
          } else if (progress > 0) {
            idlePasses = 0;
            continue;
          }
          // A pass that moved nothing: offline, 401, a held file rewritten in place. Back off,
          // and give up after MAX_IDLE_PASSES so the machine is not polled forever.
          idlePasses += 1;
          if (idlePasses >= MAX_IDLE_PASSES) { roundOutcome = 'stalled'; break; }
          await sleep(IDLE_PASS_SLEEP_MS);
        }
      }
      // A deadline hit after passes that moved nothing is a stall, so the gate backs off too.
      if (roundOutcome === 'deadline' && passes > 0 && progressTotal === 0) roundOutcome = 'stalled';
    } finally {
      if (heartbeat != null) { try { clearIntervalImpl(heartbeat); } catch { /* best-effort */ } }
      try { lock.release(); } catch { /* best-effort: a leaked lock self-heals after LOCK_STALE_MS */ }
      writeUploadStatus(workerExitStatus(roundOutcome == null ? 'crash' : roundOutcome, now()));
    }
    outcome = roundOutcome;

    // A hook that enqueued between the last re-scan and the release saw the lock held and did not
    // spawn; its file is older than lastRunAt, so the gate would skip it too. Pick it up here.
    // The cutoff is the last pass's start, the same one that re-scan used.
    if (outcome !== 'empty' || lastPassStart == null) break;
    if (postableFiles(lastPassStart).length === 0) break;
    if (now() + mods.postBudgetMs > deadline) break;
    const next = acquireLock(UPLOAD_LOCK);
    if (next == null) break;
    lock = next;
    onLock(lock);
  }
  return { outcome, passes, flushed };
}
