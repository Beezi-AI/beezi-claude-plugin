import fs from 'fs';
import path from 'path';
import { computeDelta as _computeDelta } from './delta.mjs';
import { getAccessToken as _getAccessToken } from './token.mjs';
import { linkedSessions as _linkedSessions, diagnosticsSession } from './sessions.mjs';
import { getDefaultKey, listAccounts as _listAccounts, AccountStatus } from './accounts.mjs';
import { queueDir, stateDir } from './paths.mjs';
import { git, currentBranch, resolveOriginRemote } from './git.mjs';
import { readCheckoutEvents, buildBranchTimeline, branchAt as branchAtReflog } from './reflog.mjs';
import { resolveRepoRoot } from './repo-timeline.mjs';
import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';
import { resolveFetch } from './fetch-compat.mjs';
import { postSessionError } from './session-error-report.mjs';
import { recordIssue, rememberClaudeCodeVersion } from './telemetry.mjs';
import { bindInstallationIfNeeded } from './installation-binding.mjs';
import { DIAGNOSTIC_CODES, DIAGNOSTIC_SOURCES } from './telemetry-codes.mjs';
import { computeSessionTimeline, postSessionTimeline } from './session-timeline.mjs';
import { isApiKeyBillingEvidence } from './billing.mjs';
import {
  readBillingConfig,
  writeBillingConfig,
  resolveBilling,
  recordApiKeyEvidence,
} from './billing-config.mjs';
import { resolveSessionName } from './session-name.mjs';
import { readJson, readJsonSalvaged, writeJsonSecure } from './fs-store.mjs';
import {
  listSubagentTranscripts,
  buildTaskDescriptionMap,
  createWorkflowNameResolver,
} from './subagents.mjs';
import { claimIntervals, mergeIntervals, subtractIntervals, totalMs } from './active-time.mjs';
import { loadRepoMap, saveRepoMap, upsertRoot, knownOrigin, originFromGitConfig } from './repo-map.mjs';
import { claudeMdLines } from './claude-md.mjs';
import { allowsLiveFor, isLiveTrackingAllowed, isTenantDark, markTenantDark, markTrackingDisabled, readTrackingState } from './tracking.mjs';
import { readUsageUtilization as _readUsageUtilization } from './usage-utilization.mjs';
import { readClaudeAccount as _readClaudeAccount } from './claude-account.mjs';
import { buildIdentityStamp } from './identity-stamp.mjs';
import { oauthTokenEnvWithOsProbe } from './claude-settings-env.mjs';
import {
  maybePostUsageSnapshot as _maybePostUsageSnapshot,
  drainStatuslineSnapshots as _drainStatuslineSnapshots,
} from './usage-snapshot-report.mjs';
import { readSessionWorkspace, resolveTargets, tenantsOf, isMultiTenant, QUEUE_HOLD_MS } from './workspace.mjs';
import { enqueue, enqueueHeld, unwrapQueueFile, releaseHeldFile } from './workspace-queue.mjs';
import { bindSessionRoutes, usesRules } from './workspace-rules.mjs';

function loadState(id) {
  return readJson(path.join(stateDir(), `${id}.json`), {
    cursor: 0,
    sentSessionName: null,
    anchor: null,
  });
}

function saveState(id, state) {
  writeJsonSecure(path.join(stateDir(), `${id}.json`), state);
}

// The identity half of a stamp — which account a payload belongs to. Kept per session in its state
// file so the session's later reports, and any backfill/sync of its transcript, name the
// subscription it STARTED on rather than whichever login is current when they run.
const IDENTITY_KEYS = [
  'account_uuid', 'account_email', 'account_org_uuid', 'account_org_name',
  'oauth_key_prefix', 'oauth_key_last4', 'oauth_key_length',
];

function pickIdentity(source, keys) {
  const out = {};
  if (source == null || typeof source !== 'object') return out;
  for (const key of keys) {
    if (source[key] != null) out[key] = source[key];
  }
  return out;
}

function namesAccount(identity) {
  return identity.account_uuid != null || identity.account_email != null || identity.oauth_key_prefix != null;
}

// Fills only what the recorded identity lacks, and only from the SAME account: a live stamp that
// names a different uuid or email is a login switch, which must not move the session.
function completeIdentity(recorded, live) {
  const sameUuid = recorded.account_uuid == null || live.account_uuid == null
    || recorded.account_uuid === live.account_uuid;
  const sameEmail = recorded.account_email == null || live.account_email == null
    || recorded.account_email === live.account_email;
  if (!sameUuid || !sameEmail) return recorded;
  // An org that changed under the same login is exactly the switch this guards against.
  if (recorded.account_org_uuid != null && live.account_org_uuid != null
    && recorded.account_org_uuid !== live.account_org_uuid) return recorded;
  const merged = Object.assign({}, recorded);
  for (const key of IDENTITY_KEYS) {
    if (merged[key] == null && live[key] != null) merged[key] = live[key];
  }
  return merged;
}

// Which identity this checkpoint stamps for the session:
//   - one recorded for it (a live run saved it) — always, live or audit; a live run may only
//     complete it from the same account;
//   - live, nothing recorded: the live login, which becomes the record;
//   - audit (backfill/sync), nothing recorded: the identity the last live payload carried (the
//     rename anchor, which pre-identity plugin versions left behind), else — a transcript the
//     plugin never saw live — the CURRENT login, organization included: the account the user is
//     backfilling or syncing from. The server links a session to its subscription once, so that
//     first attribution is the one that stays.
export function resolveSessionIdentity(state, liveStamp, audit) {
  const live = pickIdentity(liveStamp, IDENTITY_KEYS);
  const recorded = pickIdentity(state == null ? null : state.identity, IDENTITY_KEYS);
  if (namesAccount(recorded)) {
    const identity = audit ? recorded : completeIdentity(recorded, live);
    const changed = IDENTITY_KEYS.some((key) => identity[key] !== recorded[key]);
    return { identity, record: changed ? identity : null };
  }
  if (!audit) return { identity: live, record: namesAccount(live) ? live : null };
  const anchored = pickIdentity(state == null ? null : state.anchor, IDENTITY_KEYS);
  if (namesAccount(anchored)) return { identity: anchored, record: null };
  return { identity: live, record: null };
}

export { enqueue, unwrapQueueFile };

const FLUSH_COUNTERS = ['flushed', 'rejected', 'failed', 'expired', 'salvaged', 'quarantined', 'workspacePending'];

// Sums one flush result per account into the single summary older call sites still read.
export function mergeFlushResults(list) {
  const merged = { flushed: 0, rejected: 0, failed: 0, expired: 0, salvaged: 0, quarantined: 0, workspacePending: 0, trackingDisabled: false, lastError: null };
  for (const r of list) {
    if (r == null) continue;
    for (const c of FLUSH_COUNTERS) merged[c] += r[c] == null ? 0 : r[c];
    if (r.trackingDisabled) merged.trackingDisabled = true;
    if (r.lastError) merged.lastError = r.lastError;
  }
  return merged;
}

// Stand-in "remote" for work with no git origin behind it — a directory that isn't a repo, or a
// repo with no origin. Only the folder name travels, never the path around it, and the `local:`
// prefix keeps it from ever canonicalizing onto a real remote server-side.
function localRemote(dir) {
  if (!dir) return null;
  const name = path.basename(dir);
  return name ? `local:${name}` : null;
}

// Server-side DTO caps. One over-long field 400s the whole request (and on the batch route the
// whole 50-session chunk), so clamp at the source. `remote` is deliberately NOT clamped: a
// truncated remote would fabricate a bogus repo key — let it be rejected honestly.
const clamp = (value, max) =>
  typeof value === 'string' && value.length > max ? value.slice(0, max) : value;
const BRANCH_MAX = 255;
const AGENT_NAME_MAX = 200;
const AGENT_TYPE_MAX = 100;

// The machine's IANA timezone (e.g. Europe/Kyiv). Snapshotted per checkpoint so the server can
// bucket this session's activity in the user's local time even if they later travel. Null when
// the runtime can't resolve one — the field is then omitted from the payload.
function detectTimezone() {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return timeZone == null ? null : timeZone;
  } catch {
    return null;
  }
}

// `deps` holds substitutable implementations (test seams); `options` holds caller-driven execution
// modes. Keeping them separate stops a behavior flag from masquerading as an injectable.
// Returns { enqueued, flush, flushes, sessionErrors, skipped, gated } — flush merges the per-account
// flushQueue summaries in `flushes` (null when the flush never ran); sessionErrors is populated only
// under options.collectSessionErrors. `options.sessions` overrides the linked-account lookup.
//
// The bulk import (/beezi:import) drives this same function per past session, which is why three
// options exist to redirect its side effects: `sink` (payloads to the caller instead of the disk
// queue), `skipFlush` (no per-session HTTP), `collectSessionErrors` (buffer API-error reports
// instead of POSTing them one at a time). All default to today's hook behavior.
//
// `startCursor` (/beezi:sync) replaces the whole locally-tracked read position with the server's
// own coverage — see the three reads it overrides below.
export async function runCheckpoint(input, deps = {}, options = {}) {
  const { session_id, transcript_path, cwd } = input;
  const gitImpl = deps.runCache != null ? deps.runCache.git : (deps.gitImpl == null ? git : deps.gitImpl);
  const computeDelta = deps.computeDelta == null ? _computeDelta : deps.computeDelta;
  // The audit run's per-session memo: one read and parse per file for the delta, the Task map and the timeline.
  const transcriptMemo = deps.transcriptMemo == null ? null : deps.transcriptMemo;
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const collectedErrors = [];
  const empty = (extra) => ({ enqueued: 0, flush: null, flushes: [], sessionErrors: collectedErrors, ...(extra || {}) });
  let sessions;
  try {
    sessions = options.sessions == null ? await (deps.linkedSessions == null ? _linkedSessions : deps.linkedSessions)(deps) : options.sessions;
  } catch { sessions = []; }
  sessions = sessions || [];
  // A temporarily unreadable/refreshing credential must not lose this delta: queue for every
  // linked account, and defer only the network work until its token is usable again.
  let recipients = sessions;
  if (options.sessions == null) {
    const rows = await (deps.listAccounts == null ? _listAccounts : deps.listAccounts)(deps).catch(() => []);
    const byKey = new Map(sessions.map((session) => [session.key, session]));
    for (const row of rows) {
      if (row.status === AccountStatus.LINKED && !byKey.has(row.key)) byKey.set(row.key, row);
    }
    recipients = [...byKey.values()];
  }
  if (recipients.length === 0) return empty();

  // Diagnostics use the machine-wide anonymous worker; only identity correlation is authenticated.
  // The audit run binds once for all its checkpoints, so each of them skips it.
  if (options.skipInstallationBinding !== true) {
    let defaultKey = null;
    try { defaultKey = await getDefaultKey(); } catch { /* best-effort */ }
    const diag = diagnosticsSession(sessions, defaultKey);
    try { await bindInstallationIfNeeded(diag, { postJsonImpl: deps.postJsonImpl }); } catch { /* best-effort */ }
  }
  try { rememberClaudeCodeVersion(transcript_path); } catch { /* best-effort */ }
  // One read per checkpoint; a tenant set on caller-supplied sessions (sync --tenant) wins. Account
  // rows carry the web-side tenantId, which must never be followed.
  let workspaceState = null;
  try { workspaceState = readSessionWorkspace(session_id); } catch { /* best-effort */ }
  // A live session whose SessionStart saw no multi-workspace account (a login mid-session) is bound from here, so a rule or flush can find it.
  if (workspaceState == null && options.sessions == null && recipients.some(usesRules)) {
    try { workspaceState = bindSessionRoutes(session_id, cwd || process.cwd(), recipients); } catch { /* best-effort */ }
  }
  const skipGate = options.skipLiveTrackingGate === true;
  // Why accounts were left with nothing to send: a Don't track rule or New folders Don't send (policy), or tracking off (dark).
  let policyGated = false;
  let darkGated = false;
  // Per account: live targets (dark ones dropped) plus every workspace held until a rule answers.
  const plans = recipients.map((s) => {
    const tracking = readTrackingState(s.key);
    const multi = isMultiTenant(s);
    if (options.sessions != null && typeof s.tenantId === 'string' && s.tenantId !== '') {
      return { session: s, multi, targets: skipGate || allowsLiveFor(s, tracking) ? [s.tenantId] : [], hold: [] };
    }
    const r = resolveTargets(s, workspaceState);
    const targets = skipGate ? r.targets : r.targets.filter((t) => allowsLiveFor({ ...s, tenantId: t }, tracking));
    const hold = r.pendingAsk ? r.askTenants.filter((t) => !isTenantDark(tracking, t)) : [];
    if (targets.length === 0 && hold.length === 0) {
      if ((r.source === 'rule' || r.source === 'none') && r.targets.length === 0 && !r.pendingAsk) policyGated = true;
      else darkGated = true;
    }
    return { session: s, multi, targets, hold };
  }).filter((p) => p.targets.length > 0 || p.hold.length > 0);
  if (plans.length === 0) {
    if (policyGated && darkGated) return empty({ gated: true, reason: 'no-targets-or-dark' });
    return empty(policyGated ? { gated: true, reason: 'no-targets' } : { gated: true });
  }
  // One clone per target; `senders` keeps tokenless ones so the snapshot drain waits for them.
  const senders = [];
  for (const p of plans) for (const t of p.targets) senders.push({ ...p.session, tenantId: t });
  const liveSenders = senders.filter((s) => s.token);
  // Fan each payload into every target file, plus one held copy while the session awaits a rule.
  const emit = options.sink == null
    ? (payload) => {
      for (const p of plans) {
        for (const t of p.targets) enqueue(p.session.key, payload, t, { multi: p.multi });
        if (p.hold.length > 0) enqueueHeld(p.session.key, payload, p.hold);
      }
    }
    : options.sink;
  const resolvedSessionName = resolveSessionName(session_id, transcript_path);

  // Memoized git shell-outs for this checkpoint: dir→root, root→remote, root→reflog/HEAD.
  const rootCache = new Map();
  const remoteCache = new Map();
  const timelineCache = new Map();
  const claudeMdCache = new Map();

  // Persisted known-root map: seeds resolution (prefix match) and gets refreshed with any root→origin
  // we learn this checkpoint. A best-effort hint — a load failure yields an empty map, not a throw.
  const map = loadRepoMap();
  let mapDirty = false;

  const repoRootOf = (dir) => resolveRepoRoot(gitImpl, dir, rootCache, map, deps.runCache == null ? null : deps.runCache.gitRoots);

  const branchOf = (root, ms) => {
    if (!root) return '(unknown)';
    let entry = timelineCache.get(root);
    if (!entry) {
      let timeline = null;
      let headBranch = '(unknown)';
      try { timeline = buildBranchTimeline(readCheckoutEvents(gitImpl, root)); } catch { /* no reflog */ }
      // Always resolve current HEAD too: it's the fallback for any line lacking a
      // timestamp even when a reflog timeline exists (otherwise those bill to '(unknown)').
      try { headBranch = currentBranch(root, gitImpl) || '(unknown)'; } catch { /* keep '(unknown)' */ }
      entry = { timeline, headBranch };
      timelineCache.set(root, entry);
    }
    return (entry.timeline && ms != null) ? branchAtReflog(entry.timeline, ms) : entry.headBranch;
  };

  const resolveRemote = (root) => {
    if (!root) return null;
    if (remoteCache.has(root)) return remoteCache.get(root);
    // git first (authoritative), then a git-free .git/config parse (rescues dubious-ownership), then
    // the persisted map (rescues a fully-blocked git binary). Remember any origin we learn.
    let r = resolveOriginRemote(gitImpl, root);
    if (!r) r = originFromGitConfig(root);
    if (!r) r = knownOrigin(root, map);
    if (r) { upsertRoot(map, root, r); mapDirty = true; }
    remoteCache.set(root, r);
    return r;
  };

  // Read per root, not per segment: repo-hopping splits one window into several segments against
  // the same checkout, and the file cannot change meaningfully inside a single checkpoint.
  const resolveClaudeMdLines = (root) => {
    if (!root) return null;
    if (claudeMdCache.has(root)) return claudeMdCache.get(root);
    const lines = claudeMdLines(root);
    claudeMdCache.set(root, lines);
    return lines;
  };

  // Why segments did not become reports. A caller that gets zero reports cannot otherwise tell a
  // session that genuinely holds no usage (a transcript with no assistant tokens — nothing to
  // upload, and nothing wrong) from one we dropped for a reason worth reporting. Only the
  // problem cases are counted: "no usage" is the absence of all of them.
  const skipped = { noRemote: 0, emitFailed: 0, deltaFailed: false };
  const emptyResult = empty({ skipped });
  const state = loadState(session_id);
  // The server is the authority on what actually landed: a local cursor can sit at EOF while the
  // upload was lost, and a re-linked or fresh machine has no state at all. Null = trust local state.
  const startCursor = options.startCursor == null ? null : options.startCursor;
  const cursor = startCursor == null ? state.cursor : startCursor;
  // When the session file is unreadable (name resolves to null), keep the last name we sent
  // rather than overwriting the stored name with null.
  const sessionName =
    resolvedSessionName != null ? resolvedSessionName
    : state.sentSessionName != null ? state.sentSessionName
    : null;
  let delta;
  try {
    delta = computeDelta(transcript_path, cursor, transcriptMemo == null
      ? { cwd, repoRootOf, branchAt: branchOf }
      : { cwd, repoRootOf, branchAt: branchOf, readRecords: transcriptMemo.main });
  } catch {
    skipped.deltaFailed = true;
    return emptyResult;
  }
  const { nextCursor, segments, apiErrorEvents = [] } = delta;

  // Billing is resolved HERE, after the delta, not before it: a credit-balance error in this
  // window is proof the session bills an API key, and that proof has to be in hand before the
  // segments it belongs to are stamped. Persisted so later sessions resolve correctly too —
  // the switch that produced it is invisible to process.env.
  //
  // Historical transcripts must not rewrite this machine's CURRENT billing state: an API-key
  // error from months ago is not evidence about today, and stamping it would flip the live
  // billing source for the next 24h. persistState:false is the audit run.
  let billingConfig = readBillingConfig();
  if (options.persistState !== false && isApiKeyBillingEvidence(apiErrorEvents)) {
    const recorded = recordApiKeyEvidence(billingConfig);
    if (recorded) {
      try { writeBillingConfig(recorded); } catch { /* best-effort */ }
      billingConfig = recorded;
    }
  }
  // Resolved HERE, above resolveBilling, and used for the identity stamp below too: both readings
  // must come from ONE env. resolveBilling's `env` parameter defaults to oauthTokenEnv(process.env),
  // so omitting it silently computed a SECOND, un-probed env — the source could then disagree with
  // the fingerprint stamped ten lines further down. Passing it explicitly closes that.
  //
  // Why the probing variant: Claude Code 2.1.251 deletes CLAUDE_CODE_OAUTH_TOKEN from every child
  // environment it builds, so a hook never inherits it however the user set it — process.env alone
  // cannot answer here. The chain is process.env → user settings file → OS persistent environment.
  //
  // WHAT THIS COSTS, HONESTLY. This is the PostToolUse-Bash hook: a FRESH PROCESS on every Bash
  // tool call. os-env-token's cache is per process, so it amortizes nothing across calls — the
  // price below is paid once per Bash command, not once per session.
  //
  // Measured on Windows 11 after os-env-token learned to tell "reg ran and found nothing"
  // (authoritative — no PowerShell) from "reg could not execute" (fall back):
  //   token present in User scope, one `reg query` hit ......... 38ms median (34.8-46.0, n=8)
  //   no token set, two `reg query` misses, no PowerShell ............... ~56ms
  //   PowerShell fallback, only when reg cannot execute at all .......... ~261ms
  // (the previous no-token behaviour, which always spawned PowerShell, was ~316ms). macOS is one
  // ~10ms `launchctl getenv`; Linux has no OS-level persistent env store and spawns nothing at all.
  //
  // The 38ms is the figure to trust for this call site: it was taken at the ENTRYPOINT, spawning
  // `node scripts/checkpoint.mjs` end to end (822ms with the probe firing vs 783ms with a token
  // pre-set in process.env so it is skipped). That the entrypoint delta matches ONE isolated probe
  // is also the evidence that the module-level cache holds here — no call site double-probes.
  //
  // And it is only paid when the two cheap tiers came up empty, so a machine whose token is
  // exported or sits in settings.json never probes.
  //
  // That is accepted, with eyes open, as the price of a correct identity stamp: this is the path
  // the fingerprint has to reach, and a setup-token machine that skips it reports usage no account
  // can be resolved for. The alternative — SessionStart probing once and persisting the
  // fingerprint under BEEZI_HOME for the hook to read — was considered and DEFERRED: it adds a
  // cache that can outlive a rotated token and go quietly wrong, which is a worse failure than
  // milliseconds. Do not build it here without deciding how it is invalidated.
  //
  // An INJECTED deps.env is trusted verbatim — it describes a machine under test, and a
  // developer's own settings file (or registry) must not leak into it.
  // Only the probe seam is forwarded, never the whole deps bag: os-env-token turns its own cache
  // off when it sees an injected env/platform/run, and checkpoint's deps carry neither meaning.
  const env = deps.env == null
    ? oauthTokenEnvWithOsProbe(process.env, { osEnvOauthToken: deps.osEnvOauthToken })
    : deps.env;
  const billingFields = resolveBilling(billingConfig, env);

  // Subscription-usage stamp: account-level utilization correlated onto every payload of this
  // checkpoint. Keys are omitted (not null) when unknown. usage_account_uuid is the CACHE's own
  // account — after a switch it names the previous account until Claude Code refetches, which is
  // the truth about whose numbers these are; account_uuid is who is logged in NOW.
  const readUtilization = deps.readUsageUtilization == null ? _readUsageUtilization : deps.readUsageUtilization;
  const readAccount = deps.readClaudeAccount == null ? _readClaudeAccount : deps.readClaudeAccount;
  let utilization = null;
  try { utilization = readUtilization(); } catch { utilization = null; }
  let claudeAccount = null;
  try { claudeAccount = readAccount(); } catch { claudeAccount = null; }
  // Identity stamp: which vendor account this session runs under, in every shape it can prove —
  // the uuid and its organization (one login can hold several subscriptions), the email, and the
  // setup-token fingerprint for CI machines that expose nothing else. The live login outranks the
  // machine-wide billing.json, so a session that outlives an account switch keeps stamping its own.
  // The server's ingest links the session to its account with whichever arrives.
  //
  // Built by the shared builder, NOT inline, because the usage-snapshot report has to send the
  // identical stamp: it posts to a different route that resolves an account the same way, and two
  // builders reading the same sources in a different order would land this machine's sessions and
  // its limits data on two different accounts. See lib/identity-stamp.mjs.
  // `env` was resolved above the billing block so both readings share one answer — see there.
  const sessionIdentity = resolveSessionIdentity(
    state,
    buildIdentityStamp(claudeAccount, billingConfig, env),
    options.persistState === false,
  );
  const usageStamp = {
    ...sessionIdentity.identity,
    ...(utilization
      ? {
          usage_five_hour_pct: utilization.fiveHourPct,
          usage_seven_day_pct: utilization.sevenDayPct,
          usage_fetched_at: new Date(utilization.fetchedAtMs).toISOString(),
          ...(utilization.accountUuid ? { usage_account_uuid: utilization.accountUuid } : {}),
        }
      : {}),
  };

  let enqueued = 0;
  // The last enqueued payload becomes the "anchor" we can replay to push a later rename.
  let lastPayload = null;
  const timezone = detectTimezone();

  // Wall clock already billed for this session, as merged [startMs, endMs) intervals. The main
  // transcript and every subagent transcript cover the SAME stretch of clock — the parent blocks on
  // the Task tool_use while its agents run, and parallel agents overlap each other — so a segment
  // may only bill the part no earlier segment claimed. Summing them instead multiplied a session's
  // reported time by roughly (1 + number of parallel agents). Persisted across checkpoints because
  // a subagent's lines can land in a later window than the main lines covering the same minutes.
  // Under startCursor the emitted window is disjoint in line space from what the server holds, so its
  // clock is time the server never billed. Seeding from local state would zero the duration on a
  // re-send whose narrow rows then get superseded away — the time would vanish from the aggregate.
  const seedIntervals = startCursor == null && Array.isArray(state.coveredIntervals) ? state.coveredIntervals : [];
  let covered = mergeIntervals(seedIntervals);
  let coveredDirty = false;

  const enqueueSegments = (segs, segmentScope, extra = null, { includeContext = true } = {}) => {
    // Range of the dropped segments so far, folded into the next payload we do send — the cursor
    // consumes them either way, and a line in no payload is a hole coverage can never step over.
    // Per call: the main transcript and each subagent file number their lines independently.
    let carryFrom = null;
    for (const seg of segs) {
      // Main-transcript segments run through here first and so keep their full span; subagents bill
      // only the residual. Deterministic, and it puts the time on the thread that was blocked for
      // the whole fan-out. A computeDelta without interval tracking (an injected double) keeps its
      // own scalar rather than silently zeroing.
      const intervals = Array.isArray(seg.activeIntervals) ? seg.activeIntervals : null;
      const durationSec = intervals
        ? Math.round(totalMs(subtractIntervals(intervals, covered)) / 1000)
        : seg.stats.duration_sec;
      if (seg.stats.token_total === 0 && durationSec === 0) {
        if (carryFrom == null) carryFrom = seg.fromLine;
        continue;
      }
      const resolvedRemote = resolveRemote(seg.repoRoot);
      const remote = resolvedRemote == null ? localRemote(seg.repoRoot == null ? cwd : seg.repoRoot) : resolvedRemote;
      // Nothing left to name the work by — only reachable when the session has no cwd either.
      if (!remote) {
        if (carryFrom == null) carryFrom = seg.fromLine;
        skipped.noRemote += 1;
        continue;
      }
      // Widens the claimed span only; every stat below stays this segment's own.
      const fromLine = carryFrom == null ? seg.fromLine : Math.min(carryFrom, seg.fromLine);
      // A single write failure must not abort the window (which would leave the cursor
      // unadvanced and re-process everything forever) — skip that segment and continue.
      // A subagent's context window is not the session's — its context fields never ship.
      const { context_peak_tokens, context_final_tokens, context_final_model, ...statsSansContext } = seg.stats;
      const stats = includeContext ? seg.stats : statsSansContext;
      // Reported off the segment's own repo root, so a session that spans repositories describes
      // the CLAUDE.md each part of it actually ran under.
      const mdLines = resolveClaudeMdLines(seg.repoRoot);
      try {
        const payload = {
          segmentId: `${segmentScope}:${fromLine}-${seg.toLine}`,
          sessionId: session_id,
          remote,
          branch: clamp(seg.branch, BRANCH_MAX),
          from_line: fromLine,
          to_line: seg.toLine,
          ...billingFields,
          ...usageStamp,
          session_name: sessionName,
          ...(timezone ? { timezone } : {}),
          ...(mdLines != null ? { claude_md_lines: mdLines } : {}),
          ...(extra || {}),
          ...stats,
          duration_sec: durationSec,
        };
        emit(payload);
        carryFrom = null;
        // Claim only what actually reached the queue: a failed write must not swallow the window
        // for every later segment too.
        if (intervals != null && intervals.length) {
          covered = claimIntervals(covered, intervals);
          coveredDirty = true;
        }
        lastPayload = payload;
        enqueued += 1;
      } catch {
        carryFrom = fromLine;
        skipped.emitFailed += 1; /* keep going; the cursor still advances below */
      }
    }
  };
  enqueueSegments(segments, session_id);

  // Subagent turns live in <transcriptDir>/<sessionId>/subagents/agent-*.jsonl and never
  // appear in the main transcript, so each agent file gets its own delta window with its
  // own cursor. Line numbers are per-file: scope the segmentId by agent id so they can't
  // collide with main-transcript segments (or each other) on the server upsert.
  // Restarted from 0 under startCursor: there is no per-agent coverage to resume from, and a full
  // re-send is the WIDE direction, which the server's containment supersede absorbs.
  const agentCursors = startCursor != null || state.agentCursors == null ? {} : state.agentCursors;
  let agentCursorsDirty = false;
  // Each subagent's display name is the `description` of the Task block that spawned it; join via
  // the meta.json toolUseId. Built once here (single main-transcript scan) for all subagents.
  const taskDescriptions = buildTaskDescriptionMap(transcript_path, { transcriptMemo });
  const workflowNameOf = createWorkflowNameResolver(transcript_path, session_id);
  const agentTranscripts = transcriptMemo == null
    ? listSubagentTranscripts(transcript_path, session_id)
    : transcriptMemo.subagents(transcript_path, session_id);
  for (const { agentId, path: agentPath, workflowId, agentType, spawnDepth, toolUseId } of agentTranscripts) {
    const agentFrom = agentCursors[agentId] == null ? 0 : agentCursors[agentId];
    let agentDelta;
    try {
      // The memo parses the whole agent file and keeps its timestamps for the timeline's span.
      agentDelta = computeDelta(agentPath, agentFrom, transcriptMemo == null
        ? { cwd, repoRootOf, branchAt: branchOf }
        : { cwd, repoRootOf, branchAt: branchOf, readRecords: transcriptMemo.agent });
    } catch { continue; }
    const taskDescription = toolUseId ? taskDescriptions.get(toolUseId) : null;
    // A workflow agent has no spawning Task block, so its run's state file names it instead.
    const workflowName = workflowNameOf(workflowId, agentId);
    enqueueSegments(agentDelta.segments, `${session_id}:${agentId}`, {
      is_subagent: true,
      agent_id: agentId,
      agent_type: clamp(agentType, AGENT_TYPE_MAX),
      agent_name: workflowName != null
        ? clamp(workflowName, AGENT_NAME_MAX)
        : (toolUseId ? clamp(taskDescription == null ? null : taskDescription, AGENT_NAME_MAX) : null),
      spawn_depth: spawnDepth,
    }, { includeContext: false });
    // A subagent that dies on an API error never ends the main turn, so no StopFailure fires
    // for it — its transcript is the only place that failure is recorded.
    apiErrorEvents.push(...(agentDelta.apiErrorEvents == null ? [] : agentDelta.apiErrorEvents));
    if (agentDelta.nextCursor !== agentFrom) {
      agentCursors[agentId] = agentDelta.nextCursor;
      agentCursorsDirty = true;
    }
  }

  // postSessionError swallows its own failures (never rejects), so an error-report
  // problem can't break the checkpoint — no wrapper needed. This is also the safety net for
  // a StopFailure hook that never fired: the server keys on session+error+minute and both
  // paths stamp the transcript line's timestamp, so the two collapse onto one row.
  for (const event of apiErrorEvents) {
    const errorPayload = {
      sessionId: session_id,
      error: event.error,
      errorDetails: null,
      lastAssistantMessage: event.text,
      occurredAt: event.occurredAt == null ? new Date().toISOString() : event.occurredAt,
    };
    // The audit run buffers these instead: one awaited POST per event across hundreds of
    // sessions is minutes of dead time, and follow-ups only make sense for sessions the server
    // accepted — the backfill route dedupes via its upsert keys, so ordering is about
    // attribution, not skip-existing (the old batch route's premise is gone).
    if (options.collectSessionErrors) {
      collectedErrors.push(errorPayload);
      continue;
    }
    await Promise.all(liveSenders.map((s) => postSessionError(errorPayload, s, { fetchImpl })));
  }

  let stateDirty = false;

  // The activity timeline is whole-session, so it's re-derived from the full transcript and shipped
  // only at turn-ends (Stop / SessionEnd) — not on the frequent PostToolUse:Bash path. Skip the POST
  // when the derived content is identical to the last one we sent (a Stop with no new activity), so
  // we don't re-upsert the same growing jsonb every turn. Best-effort: a failure must never break the
  // checkpoint.
  if (options.emitTimeline) {
    try {
      const timeline = computeSessionTimeline(transcript_path, session_id);
      if (timeline && (timeline.periods.length > 0 || timeline.subagents.length > 0 || timeline.plan_events.length > 0)) {
        // The sender list is part of the signature so a newly answered workspace still gets the timeline.
        const senderSig = senders.map((s) => `${s.key}:${s.tenantId}`).sort().join(',');
        const sig = `${JSON.stringify(timeline.periods)}|${JSON.stringify(timeline.subagents)}|${JSON.stringify(timeline.plan_events)}|${senderSig}`;
        if (sig !== state.sentTimelineSig) {
          const results = await Promise.all(
            liveSenders.map((s) => postSessionTimeline({ sessionId: session_id, ...timeline }, s, { fetchImpl })),
          );
          // Only remember the signature once every account confirmed, so a failed post retries next turn.
          const reported = results.length === senders.length && results.every((r) => r.reported);
          if (reported) {
            state.sentTimelineSig = sig;
            stateDirty = true;
          }
        }
      }
    } catch { /* best-effort */ }

    // Fleet utilization snapshot — deduped by (account, fetchedAt); best-effort like the
    // timeline. StopFailure also runs with emitTimeline, so a turn that died on a rate-limit
    // error still ships its snapshot — the moment it matters most.
    // `env` is forwarded, not left to default: both callees build the same identity stamp this
    // checkpoint's session reports carry, and the token behind it may live in Claude Code's
    // settings file or the OS environment, where a bare process.env cannot see it. Without this
    // the two would report different identities from the same machine, in the same second.
    const postSnapshot = deps.maybePostUsageSnapshot == null ? _maybePostUsageSnapshot : deps.maybePostUsageSnapshot;
    // One after another: the per-account snapshot state is read-modify-write.
    for (const s of liveSenders) {
      try { await postSnapshot(s, { fetchImpl, env }); } catch { /* best-effort */ }
    }
    // Live rate-limit rows the status line recorded between hooks — the observations no
    // hook was running to see.
    const drainSnapshots = deps.drainStatuslineSnapshots == null ? _drainStatuslineSnapshots : deps.drainStatuslineSnapshots;
    try { await drainSnapshots(senders, { fetchImpl, env }); } catch { /* best-effort */ }
  }

  // Claude Code renames a session after the first prompt. The new name normally rides on the
  // next billable segment (each report re-reads it), but a session whose rename lands with no
  // further activity would keep the first-prompt title forever. So: remember the anchor segment
  // and the name we last sent; when the name changes but no new segment carried it, replay the
  // anchor with the corrected name. The server upserts by segmentId (idempotent tokens/cost) and
  // takes the latest non-null session_name, so this only fixes the name.
  if (enqueued > 0) {
    state.anchor = lastPayload;
    state.sentSessionName = sessionName;
    stateDirty = true;
  } else if (sessionName != null && sessionName !== state.sentSessionName && state.anchor) {
    try {
      emit({ ...state.anchor, session_name: sessionName });
      state.sentSessionName = sessionName;
      stateDirty = true;
    } catch { /* best-effort; retry next checkpoint */ }
  }

  if (nextCursor !== state.cursor) {
    state.cursor = nextCursor;
    stateDirty = true;
  }
  // Recorded only once the session has actually reported under it: a checkpoint that sent nothing
  // has attributed nothing yet, so a login switch before the first report should still win.
  if (sessionIdentity.record != null && enqueued > 0) {
    state.identity = sessionIdentity.record;
    stateDirty = true;
  }
  if (agentCursorsDirty) {
    state.agentCursors = agentCursors;
    stateDirty = true;
  }
  if (coveredDirty) {
    state.coveredIntervals = covered;
    stateDirty = true;
  }
  // Remember where this session lives. The session's cwd drifts (cd, worktree switches)
  // while Claude Code keys the transcript dir by the LAUNCH cwd, so later commands can't
  // rely on process.cwd() to find the transcript — they read this mapping instead. Only
  // recorded once the transcript has content, so an empty session writes no state.
  if (nextCursor > 0 && (state.cwd !== cwd || state.transcriptPath !== transcript_path)) {
    state.cwd = cwd == null ? null : cwd;
    state.transcriptPath = transcript_path;
    state.updatedAt = new Date().toISOString();
    stateDirty = true;
  }
  // The import never persists the cursor. It builds payloads first and delivers them afterwards,
  // so advancing the cursor here would consume a session's lines before the server ever accepted
  // them: a failed delivery leaves the session unledgered AND unreadable, and the re-run finds
  // nothing left to send. Not advancing costs nothing — segmentIds are deterministic, so if that
  // session is later resumed live its hooks re-report the same ids and the server upserts.
  if (stateDirty && options.persistState !== false) {
    try { saveState(session_id, state); } catch { /* best-effort */ }
  }
  if (mapDirty) {
    try { saveRepoMap(map); } catch { /* best-effort */ }
  }

  // The import owns its own batched delivery, so it must not drain the live queue per session —
  // that would add unrelated HTTP calls mid-import and muddy its summary.
  const flushes = options.skipFlush
    ? []
    : await Promise.all(plans.filter((p) => p.session.token).map(async ({ session: s }) => ({ key: s.key, email: s.email, tenantName: s.tenantName, ...(await flushQueue(s, { fetchImpl })) })));
  const flush = options.skipFlush ? null : mergeFlushResults(flushes);
  return { enqueued, flush, flushes, sessionErrors: collectedErrors, skipped };
}

// Once tracking is off, queued reports are held for this long: a tenant that converts to paid
// inside the window flushes them normally on its first live session; after it they expire.
export { QUEUE_HOLD_MS };

// Expire queue files older than the hold window. Only meaningful while tracking is off — a
// live-mode queue drains through flushing, not expiry.
function sweepHeldQueue(dir, result, now = Date.now()) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      if (now - fs.statSync(filePath).mtimeMs > QUEUE_HOLD_MS) {
        fs.unlinkSync(filePath);
        result.expired += 1;
      }
    } catch { /* best-effort */ }
  }
}

// Returns { flushed, rejected, failed, expired, workspacePending, trackingDisabled, lastError } —
// flushed = accepted (2xx), rejected = permanently declined by the server (4xx, e.g. branch not
// linked), failed = transient or reversible (5xx/network/code-less 403, file kept for retry),
// expired = held files past the 3-day window, workspacePending = held until a rule or New folders
// picks a workspace, trackingDisabled = the server said the workspace is dark (audit mode) and the flush stopped.
export async function flushQueue(session, deps = {}) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const getAccessToken = deps.getAccessToken == null ? _getAccessToken : deps.getAccessToken;
  const result = { flushed: 0, rejected: 0, failed: 0, expired: 0, salvaged: 0, quarantined: 0, workspacePending: 0, trackingDisabled: false, lastError: null };
  const dir = queueDir(session.key);
  const tenants = tenantsOf(session);
  const multiTenant = isMultiTenant(session);
  const workspaceCache = new Map();
  const workspaceOf = (sessionId) => {
    if (!workspaceCache.has(sessionId)) {
      let state = null;
      try { state = readSessionWorkspace(sessionId); } catch { /* unreadable = unanswered */ }
      workspaceCache.set(sessionId, state);
    }
    return workspaceCache.get(sessionId);
  };
  const isMember = (tenantId) => tenants != null && tenants.some((t) => t.id === tenantId);

  // Dark workspace: no readdir-and-post loop, just the hold-window sweep. Files stay for
  // QUEUE_HOLD_MS in case the tenant converts to paid, then expire. Several workspaces go dark per tenant below.
  const trackingState = readTrackingState(session.key);
  const darkThisFlush = new Set();
  if (!multiTenant && !isLiveTrackingAllowed(trackingState)) {
    result.trackingDisabled = true;
    sweepHeldQueue(dir, result);
    return result;
  }

  // A 401 is authentication, not a verdict on the payload, so it must not count as a permanent
  // rejection — that would delete queued analytics that were never actually refused. Renew once
  // for the whole flush and retry; if renewal fails, keep every file for the next attempt.
  let current = session;
  let renewed = false;
  const renewToken = async () => {
    if (renewed) return null;
    renewed = true;
    const next = await getAccessToken({}, { account: session.key, forceRefresh: true }).catch(() => null);
    if (next && next !== current.token) { current = { ...current, token: next }; return current; }
    return null;
  };

  const reportUrl = `${apiBase()}${ENDPOINTS.sessionsReport}`;

  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return result;
  }

  for (const file of files) {
    // Only queued payloads. Skips the `.tmp` of a writer that died mid-write and the `.corrupt`
    // files quarantined below, neither of which is ever postable; pruneStale expires both.
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(dir, file);
    const { value, salvaged } = readJsonSalvaged(filePath);
    const entry = unwrapQueueFile(value);
    const payload = entry.payload;
    // Nothing recoverable, or what came back is not a postable payload. Quarantine rather than
    // `continue`: an unparseable file used to be re-read on every flush forever, invisibly, and
    // the session's analytics were lost without a signal. A cleanly parsed payload is posted
    // exactly as before — the server stays the judge of its contents.
    if (payload == null || (salvaged && payload.segmentId == null)) {
      result.quarantined += 1;
      recordIssue({ code: DIAGNOSTIC_CODES.QUEUE_FILE_QUARANTINED, source: DIAGNOSTIC_SOURCES.CHECKPOINT });
      try { fs.renameSync(filePath, `${filePath}.corrupt`); } catch { /* best-effort */ }
      continue;
    }
    if (salvaged) result.salvaged += 1;

    let mtimeMs = null;
    const ageMs = () => {
      if (mtimeMs == null) {
        try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch { mtimeMs = Date.now(); }
      }
      return Date.now() - mtimeMs;
    };
    // Past the hold window a multi-workspace retry expires instead of failing forever.
    const failOrExpire = () => {
      if (multiTenant && ageMs() > QUEUE_HOLD_MS) {
        try { fs.unlinkSync(filePath); result.expired += 1; return; } catch { /* counted failed */ }
      }
      result.failed += 1;
    };

    // A held or unstamped file is expanded into per-tenant copies, which this same pass posts.
    if (multiTenant && (entry.hold != null || entry.tenantId == null)) {
      let released;
      // A corrupt held file must not break the whole flush.
      try { released = releaseHeldFile(filePath, session, workspaceOf(payload.sessionId)); } catch { result.failed += 1; continue; }
      files.push(...released.written);
      if (released.expired) result.expired += 1;
      else if (!released.deleted) result.workspacePending += 1;
      continue;
    }
    // A held file on a now single-workspace account waits out the hold window.
    if (entry.hold != null) {
      if (ageMs() <= QUEUE_HOLD_MS) {
        result.workspacePending += 1;
      } else {
        try { fs.unlinkSync(filePath); result.expired += 1; } catch { /* best-effort */ }
      }
      continue;
    }

    // A stamp for a workspace the account has left is held for it, never re-routed; old servers send no header.
    if (entry.tenantId != null && tenants != null && !isMember(entry.tenantId)) {
      if (ageMs() <= QUEUE_HOLD_MS) {
        result.workspacePending += 1;
      } else {
        try { fs.unlinkSync(filePath); result.expired += 1; } catch { /* best-effort */ }
      }
      continue;
    }
    // One or unknown workspaces post headerless, whatever the file was stamped with.
    const tenantId = multiTenant ? entry.tenantId : null;
    // A dark tenant's reports are dropped, not retried.
    if (multiTenant && (darkThisFlush.has(tenantId) || isTenantDark(trackingState, tenantId))) {
      try { fs.unlinkSync(filePath); result.rejected += 1; } catch { /* best-effort */ }
      continue;
    }

    try {
      let res = await postJson(reportUrl, { ...current, tenantId }, payload, { fetchImpl });
      // 401 only: a 403 is authenticated-but-not-permitted, which no new token resolves.
      if (res.status === 401) {
        const next = await renewToken();
        if (next) res = await postJson(reportUrl, { ...next, tenantId }, payload, { fetchImpl });
      }
      if (res.status >= 200 && res.status < 300) {
        result.flushed += 1;
        fs.unlinkSync(filePath);
      } else if (res.status === 401) {
        // Still unauthenticated after a renewal attempt — keep the file; the payload was
        // never judged, and re-linking should let it through later.
        failOrExpire();
        result.lastError = `HTTP ${res.status}`;
      } else if (res.status === 403) {
        // Branch on the machine-readable code, never the message. TRACKING_DISABLED = the
        // workspace is in audit mode: record it, stop the storm, and HOLD the files — they
        // flush if the tenant converts within the window, and expire after it. A code-less 403
        // (seat revoked, deactivated user) is reversible: keep the file, count it failed. With several
        // workspaces only that tenant goes dark: its files are dropped and the account keeps flushing.
        let body = null;
        try { body = await res.json(); } catch { /* non-JSON body */ }
        if (body != null && body.code === 'TRACKING_DISABLED' && multiTenant) {
          try { markTenantDark(session.key, tenantId); } catch { /* best-effort */ }
          darkThisFlush.add(tenantId);
          result.rejected += 1;
          result.lastError = body.message == null ? 'HTTP 403' : body.message;
          try { fs.unlinkSync(filePath); } catch { /* best-effort */ }
          continue;
        }
        if (body != null && body.code === 'TRACKING_DISABLED') {
          try { markTrackingDisabled(session.key, body.message == null ? null : body.message); } catch { /* best-effort */ }
          result.trackingDisabled = true;
          result.lastError = body.message == null ? 'HTTP 403' : body.message;
          sweepHeldQueue(dir, result);
          break;
        }
        failOrExpire();
        result.lastError = body == null || body.message == null ? `HTTP ${res.status}` : body.message;
      } else if (res.status < 500) {
        // Permanent rejection — drop the file, but remember why.
        result.rejected += 1;
        try {
          const body = await res.json();
          result.lastError = body == null || body.message == null ? `HTTP ${res.status}` : body.message;
        } catch {
          result.lastError = `HTTP ${res.status}`;
        }
        fs.unlinkSync(filePath);
      } else {
        failOrExpire(); // keep for retry
        recordIssue({ code: DIAGNOSTIC_CODES.QUEUE_FLUSH_HTTP_ERROR, source: DIAGNOSTIC_SOURCES.CHECKPOINT, httpStatus: res.status });
      }
    } catch {
      failOrExpire(); // keep file for retry on network error / throw
    }
  }

  return result;
}
