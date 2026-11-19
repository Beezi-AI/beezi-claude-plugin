import {
  OUTBOX_KINDS,
  listOutbox as _listOutbox,
  claimOutbox as _claimOutbox,
  finishOutbox as _finishOutbox,
  enqueueOutbox as _enqueueOutbox,
  keepSnapshotClaim,
} from './outbox.mjs';
import { postSessionError as _postSessionError } from './session-error-report.mjs';
import { postSessionTimeline as _postSessionTimeline } from './session-timeline.mjs';
import { maybePostUsageSnapshot as _maybePostUsageSnapshot } from './usage-snapshot-report.mjs';
import { getAuthentication as _getAuthentication } from './token.mjs';
import { oauthTokenEnvWithOsProbe } from './claude-settings-env.mjs';

// Sends one account's outbox (lib/outbox.mjs): session errors, session timelines and the usage
// snapshot the hooks wrote instead of posting. Runs in the upload worker only, with the token the
// worker read once for this run. Each item is claimed by rename first, so a hook rewriting it
// mid-send writes a fresh file that survives and goes out next pass.
//
// Outcome per item, from the post helpers' { reported, status, reason }:
//   2xx                                  → sent, removed
//   4xx other than 401/408/429           → dropped (refused for good), removed
//   401                                  → one forced token renewal per call, resend; still 401 → kept
//   408, 429, 5xx, network, no token     → kept
// A 401, 408 or 429 never deletes an item.

// The longest one POST may take (postJson's default timeout), as checkpoint's POST_BUDGET_MS.
// Not imported from checkpoint.mjs: this module stays off the hook path's import graph.
export const OUTBOX_POST_BUDGET_MS = 3000;

// 'sent' | 'dropped' | 'auth' | 'retry'
function verdictOf(r) {
  if (r == null) return 'retry';
  const status = Number(r.status);
  if (r.reported === true || (status >= 200 && status < 300)) return 'sent';
  if (status === 401) return 'auth';
  if (status === 408 || status === 429) return 'retry';
  if (status >= 400 && status < 500) return 'dropped';
  // maybePostUsageSnapshot: this exact sample already went out, or there is nothing to send.
  if (r.reason === 'already-sent' || r.reason === 'no-utilization') return 'sent';
  // A payload the helpers refuse before any request can never be sent.
  if (r.reason === 'missing-fields') return 'dropped';
  return 'retry';
}

function samplesOf(item) {
  if (!Array.isArray(item.samples)) return [];
  return item.samples.filter((s) => s != null && typeof s === 'object' && !Array.isArray(s));
}

function targetsOf(item) {
  if (!Array.isArray(item.targets)) return [];
  return item.targets.filter((t) => t === null || (typeof t === 'string' && t !== ''));
}

// deliverOutbox(session, deps) -> { sent, dropped, failed, drainTargets }
// `drainTargets` are the snapshot target clones (current token) of every snapshot this call
// claimed, delivered or not. The caller drains the statusline backlog once across all accounts' targets: a drain
// clears a row once every recipient it was given settled it, so a per-account drain would clear
// rows the next account never received.
export async function deliverOutbox(session, deps = {}) {
  const listOutbox = deps.listOutbox == null ? _listOutbox : deps.listOutbox;
  const claimOutbox = deps.claimOutbox == null ? _claimOutbox : deps.claimOutbox;
  const finishOutbox = deps.finishOutbox == null ? _finishOutbox : deps.finishOutbox;
  const enqueueOutbox = deps.enqueueOutbox == null ? _enqueueOutbox : deps.enqueueOutbox;
  const postSessionError = deps.postSessionError == null ? _postSessionError : deps.postSessionError;
  const postSessionTimeline = deps.postSessionTimeline == null ? _postSessionTimeline : deps.postSessionTimeline;
  const maybePostUsageSnapshot = deps.maybePostUsageSnapshot == null ? _maybePostUsageSnapshot : deps.maybePostUsageSnapshot;
  const getAuthentication = deps.getAuthentication == null ? _getAuthentication : deps.getAuthentication;
  const now = deps.now == null ? Date.now : deps.now;
  const deadline = deps.deadline == null ? null : deps.deadline;
  const postBudgetMs = deps.postBudgetMs == null ? OUTBOX_POST_BUDGET_MS : deps.postBudgetMs;
  const fetchImpl = deps.fetchImpl;
  const pastDeadline = () => deadline != null && now() + postBudgetMs > deadline;

  // The env snapshot posts stamp their identity with: resolved at most once, and only when a
  // snapshot is actually sent (the OS probe may start a process). Never read from or written to
  // a file. The worker passes its own once-per-run getter.
  let envResolved = false;
  let envValue = null;
  const getEnv = () => {
    if (deps.getEnv != null) return deps.getEnv();
    if (!envResolved) {
      envValue = deps.env == null ? oauthTokenEnvWithOsProbe(process.env) : deps.env;
      envResolved = true;
    }
    return envValue;
  };

  const result = { sent: 0, dropped: 0, failed: 0, drainTargets: [] };
  if (session == null || session.key == null) return result;
  const items = listOutbox(session.key);
  // Nothing can be sent without a token: leave every item where it is, unclaimed.
  if (!session.token) {
    result.failed = items.length;
    return result;
  }

  // As flushQueue: a 401 is authentication, not a verdict on the payload. Renew once for the
  // whole call; when renewal yields no new token, every 401 item is kept for a later run.
  let current = session;
  let renewed = false;
  const renewToken = async () => {
    if (renewed) return null;
    renewed = true;
    let auth = null;
    try {
      auth = await getAuthentication({}, { account: session.key, forceRefresh: true });
    } catch {
      auth = null;
    }
    const next = auth != null && auth.authState === 'ready' ? auth.accessToken : null;
    if (next && next !== current.token) {
      current = Object.assign({}, current, { token: next });
      return current;
    }
    return null;
  };

  // One send with the current token, plus one resend after a successful renewal on 401.
  const send = async (post) => {
    let r;
    try { r = await post(current); } catch { r = null; }
    let verdict = verdictOf(r);
    if (verdict === 'auth') {
      if (pastDeadline()) return 'retry';
      const next = await renewToken();
      if (next != null) {
        try { r = await post(next); } catch { r = null; }
        verdict = verdictOf(r);
      }
      if (verdict === 'auth') verdict = 'retry';
    }
    return verdict;
  };

  // Every target clone gets every stored sample, oldest first. The first retryable failure stops
  // the item: the rest would most likely time out the same way, and the whole item is kept.
  const postSamples = async (targets, samples) => {
    if (targets.length === 0 || samples.length === 0) return 'sent';
    const env = getEnv();
    let anySent = false;
    let anyDropped = false;
    for (const tenantId of targets) {
      for (const sample of samples) {
        if (pastDeadline()) return 'retry';
        const verdict = await send((s) => maybePostUsageSnapshot(
          Object.assign({}, s, { tenantId }),
          { env, utilization: sample, fetchImpl },
        ));
        if (verdict === 'retry') return 'retry';
        if (verdict === 'sent') anySent = true;
        else anyDropped = true;
      }
    }
    return anyDropped && !anySent ? 'dropped' : 'sent';
  };

  // The targets join the drain whatever this item's outcome, as runCheckpoint drained to every
  // sender: leaving out an account whose snapshot failed would let the others settle, and so
  // clear, rows it never received. The drain's own settle rule keeps rows a failing recipient
  // did not take. Built after the posts, so a renewed token is used.
  const sendSnapshot = async (item) => {
    const targets = targetsOf(item);
    const verdict = await postSamples(targets, samplesOf(item));
    for (const tenantId of targets) result.drainTargets.push(Object.assign({}, current, { tenantId }));
    return verdict;
  };

  // An undelivered snapshot merges into a newer snapshot.json rather than being dropped by it
  // (lib/outbox.mjs keepSnapshotClaim, shared with pruneStale).
  const keepSnapshot = (claimed, filePath, item) => {
    keepSnapshotClaim(session.key, claimed, filePath, item, { enqueueOutbox, finishOutbox });
  };

  for (let i = 0; i < items.length; i += 1) {
    // Never start an item the run's deadline cannot cover: an abandoned claim waits an hour for prune.
    if (pastDeadline()) {
      result.failed += items.length - i;
      break;
    }
    const entry = items[i];
    const claimed = claimOutbox(entry.filePath);
    if (claimed == null) continue; // delivered or claimed by someone else meanwhile
    const item = entry.item;

    let verdict;
    if (item.kind === OUTBOX_KINDS.SNAPSHOT) {
      verdict = await sendSnapshot(item);
    } else {
      const post = item.kind === OUTBOX_KINDS.ERROR ? postSessionError : postSessionTimeline;
      verdict = await send((s) => post(item.payload, Object.assign({}, s, { tenantId: item.tenantId }), { fetchImpl }));
    }

    if (verdict === 'retry') {
      result.failed += 1;
      if (item.kind === OUTBOX_KINDS.SNAPSHOT) keepSnapshot(claimed, entry.filePath, item);
      else finishOutbox(claimed, entry.filePath, false);
    } else {
      result[verdict] += 1;
      finishOutbox(claimed, entry.filePath, true);
    }
  }
  return result;
}
