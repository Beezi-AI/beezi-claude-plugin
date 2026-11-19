import fs from 'fs';
import { acquireOwnedLock } from './single-instance-lock.mjs';
import { flushQueue as _flushQueue } from './checkpoint.mjs';
import { UPLOAD_LOCK, HEARTBEAT_MS } from './upload-worker.mjs';
import { queueDir } from './paths.mjs';
import { parseQueueName } from './queue-order.mjs';

// /beezi:sync's pre-drain of the live queue, under the same owned lock `upload` the background
// worker drains under. Two drains in two processes could post a narrow window after the wide one
// containing it, the one order the server's containment supersede cannot dedupe.
//
// Lock order is always `session-audit` then `upload`: the sync already holds `session-audit` when
// it calls this, and nothing here ever takes `session-audit`.

// How long the sync waits for a running worker to finish before it reports `busy`.
export const DRAIN_LOCK_WAIT_MS = 60000;
export const DRAIN_LOCK_POLL_MS = 500;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -> { locked: boolean }. `locked: false` means the lock stayed held for the whole wait and
// NOTHING was flushed: an unlocked drain beside a worker would reopen the double count. A flush
// that throws is swallowed (the caller's coverage check still bounds what it re-sends). Never throws.
export async function drainQueueLocked(session, deps = {}) {
  const acquireLock = deps.acquireLock == null ? acquireOwnedLock : deps.acquireLock;
  const flushQueue = deps.flushQueue == null ? _flushQueue : deps.flushQueue;
  const fetchImpl = deps.fetchImpl;
  const sleep = deps.sleep == null ? defaultSleep : deps.sleep;
  const now = deps.now == null ? Date.now : deps.now;
  const waitMs = deps.waitMs == null ? DRAIN_LOCK_WAIT_MS : deps.waitMs;
  const setIntervalImpl = deps.setIntervalImpl == null ? setInterval : deps.setIntervalImpl;
  const clearIntervalImpl = deps.clearIntervalImpl == null ? clearInterval : deps.clearIntervalImpl;

  const tryAcquire = () => {
    try { return acquireLock(UPLOAD_LOCK); } catch { return null; }
  };

  const started = now();
  let lock = tryAcquire();
  while (lock == null) {
    if (now() - started >= waitMs) return { locked: false };
    try { await sleep(DRAIN_LOCK_POLL_MS); } catch { /* a failed sleep only shortens the wait */ }
    lock = tryAcquire();
  }

  // An offline drain of a full queue (257 files x 3 s) outlives LOCK_STALE_MS; keep the dir fresh
  // so the spawn gate and a second worker never read this holder as dead.
  let heartbeat = null;
  try {
    const held = lock;
    heartbeat = setIntervalImpl(() => {
      try { held.refresh(); } catch { /* best-effort */ }
    }, HEARTBEAT_MS);
    if (heartbeat != null && typeof heartbeat.unref === 'function') heartbeat.unref();
    const options = fetchImpl == null ? {} : { fetchImpl };
    try { await flushQueue(session, options); } catch { /* best-effort; coverage still bounds the sync */ }
  } finally {
    if (heartbeat != null) { try { clearIntervalImpl(heartbeat); } catch { /* best-effort */ } }
    try { lock.release(); } catch { /* best-effort: a leaked lock self-heals after LOCK_STALE_MS */ }
  }
  return { locked: true };
}

// A session id in queue-name form: `:`, `/` and whitespace as `_`, as the queue writer maps them.
export function queueSessionName(sessionId) {
  return String(sessionId).replace(/[:/\s]/g, '_');
}

const AGENT_SCOPE = '_agent-';

// -> Set of queue-name session ids that still have a file in this account's live queue, held
// `__ask` copies and subagent scopes (`<sessionId>_agent-<id>`) included. What a drain left behind:
// a sync must not re-send a wide window of these sessions, or the queued narrow window posted after
// it would count twice. Names outside the queue grammar (`.tmp`, `.corrupt`) name no session. Never throws.
export function queuedSessionNames(key) {
  const held = new Set();
  let names;
  try { names = fs.readdirSync(queueDir(key)); } catch { return held; }
  for (const name of names) {
    const parsed = parseQueueName(name);
    if (parsed == null) continue;
    const agent = parsed.scope.indexOf(AGENT_SCOPE);
    held.add(agent === -1 ? parsed.scope : parsed.scope.slice(0, agent));
  }
  return held;
}
