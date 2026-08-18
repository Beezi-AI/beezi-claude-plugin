import fs from 'fs';
import path from 'path';
import { getAccessToken as _getAccessToken } from './token.mjs';
import { flushQueue } from './checkpoint.mjs';
import { git as _git, resolveOriginRemote } from './git.mjs';
import { resolveRepoRoot } from './repo-timeline.mjs';
import {
  loadRepoMap,
  saveRepoMap,
  upsertRoot,
  pruneRepoMap,
  originFromGitConfig,
} from './repo-map.mjs';
import { stateDir } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { pruneStale } from './prune.mjs';
import { apiBase, ENDPOINTS } from './config.mjs';
import { resolveFetch } from './fetch-compat.mjs';
import { whoami } from './whoami.mjs';
import { getMachineClientId } from './machine-identity.mjs';
import {
  recordWhoami,
  readTrackingState,
  isLiveTrackingAllowed,
  shouldBackfill,
  TrackingMode,
} from './tracking.mjs';
import { BillingSource, hasCustomGateway } from './billing.mjs';
import {
  readBillingConfig as _readBillingConfig,
  writeBillingConfig as _writeBillingConfig,
  resolveSource as _resolveSource,
  syncBillingSource,
  isStale as _isStale,
} from './billing-config.mjs';

// Resume guard: create cursor=0 ONLY if absent; never reset an existing session's cursor.
// Also records where the session lives (cwd + transcript path) so /beezi:track can find
// the transcript after the session cd's away from its launch directory — the mapping is
// refreshed on every start (resume may happen from a different directory).
export function initSessionState(sessionId, { cwd = null, transcriptPath = null } = {}) {
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = path.join(dir, `${sessionId}.json`);
  const state = readJson(p, { cursor: 0 });
  state.cwd = cwd;
  state.transcriptPath = transcriptPath;
  state.updatedAt = new Date().toISOString();
  writeJsonSecure(p, state);
}

// Pre-warm the persisted repo-map at session start so the checkpoint hot path resolves most dirs
// without shelling git. Resolves the launch cwd's root+origin; when the launch cwd is itself a
// non-repo parent (e.g. a multi-repo workspace folder), shallow-scans its immediate children (one
// level) for a .git and maps each child repo. Best-effort; never throws. Returns the (possibly
// mutated) map plus a dirty flag.
export function discoverRepos(cwd, gitImpl, map, deps = {}) {
  const fsImpl = deps.fs == null ? fs : deps.fs;
  let dirty = false;
  if (!cwd) return { map, dirty };
  const cache = new Map();
  const recordRoot = (root) => {
    if (!root) return;
    let origin = resolveOriginRemote(gitImpl, root);
    if (origin == null) origin = originFromGitConfig(root);
    upsertRoot(map, root, origin);
    dirty = true;
  };

  const launchRoot = resolveRepoRoot(gitImpl, cwd, cache, map);
  if (launchRoot) {
    recordRoot(launchRoot);
  } else {
    let entries;
    try { entries = fsImpl.readdirSync(cwd, { withFileTypes: true }); } catch { entries = []; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(cwd, entry.name);
      try {
        if (!fsImpl.existsSync(path.join(child, '.git'))) continue;
      } catch { continue; }
      const childRoot = resolveRepoRoot(gitImpl, child, cache, map);
      recordRoot(childRoot == null ? child : childRoot);
    }
  }
  return { map, dirty };
}

async function announceRepo(cwd, token, fetchImpl, gitImpl) {
  const remote = resolveOriginRemote(gitImpl, cwd);
  if (!remote) return null; // not a git repo — silent
  try {
    const res = await fetchImpl(`${apiBase()}${ENDPOINTS.reposStatus}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ remote }),
    });
    if (!res.ok) return null;
    const { connected, projectName } = await res.json();
    return connected
      ? `Beezi: repo connected${projectName ? ` to "${projectName}"` : ''}. Task-branch sessions will be tracked.`
      : 'Beezi: this repo is not connected to Beezi. No analytics tracked here.';
  } catch { return null; } // offline — silent
}

// whoami reports invalid for any 401/403, which covers an expired token and a permissions
// or wrong-environment refusal as well as a genuine revocation — too coarse to delete on.
// So this only decides what to *tell* the user; discarding credentials is left to the token
// endpoint naming the grant revoked, or to the user re-running /beezi:login.
// Offline/unknown (null) still reads as fine, so a check we couldn't run stays silent.
// The body is returned alongside the verdict — it carries the tenant's tracking policy.
async function probeToken(token, fetchImpl) {
  const who = await whoami(token, { fetchImpl });
  return { rejected: who != null && who.valid === false, who };
}

// Returns an optional systemMessage string (or null). Never throws for expected failures.
export async function runSessionStart(input, deps = {}) {
  const getAccessToken = deps.getAccessToken == null ? _getAccessToken : deps.getAccessToken;
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const gitImpl = deps.gitImpl == null ? _git : deps.gitImpl;
  const resolveSource = deps.resolveSource == null ? _resolveSource : deps.resolveSource;
  const readBillingConfig = deps.readBillingConfig == null ? _readBillingConfig : deps.readBillingConfig;
  const writeBillingConfig = deps.writeBillingConfig == null ? _writeBillingConfig : deps.writeBillingConfig;
  const isStale = deps.isStale == null ? _isStale : deps.isStale;
  const recordWhoamiImpl = deps.recordWhoamiImpl == null ? recordWhoami : deps.recordWhoamiImpl;

  let token = null;
  try { token = await getAccessToken(); } catch { token = null; }
  if (!token)
    return '⚠ Beezi: this machine is not linked — analytics are NOT being tracked. Run /beezi:login to link it.';

  let probe = await probeToken(token, fetchImpl);
  if (probe.rejected) {
    // The 401 is the server's verdict on the token; expires_at was only ours, and a server that
    // omits expires_in leaves it a guess. Take the server's word and refresh once before
    // declaring the link bad — otherwise a token that died earlier than we estimated is never
    // renewed, and every session reports a rejection that a single refresh would have fixed.
    const refreshed = await getAccessToken({}, { forceRefresh: true }).catch(() => null);
    probe = refreshed ? await probeToken(refreshed, fetchImpl) : { rejected: true, who: null };
    if (!refreshed || probe.rejected) {
      return '⚠ Beezi: this machine’s link was rejected — analytics are NOT being tracked. Run /beezi:login to re-link.';
    }
    token = refreshed;
  }

  // Persist the tenant's tracking policy BEFORE the flush below, so a freshly-disabled tenant
  // never gets one last ungated drain. Bound to this login's client id — a workspace switch
  // must not inherit the previous tenant's flags.
  try {
    let clientId = getMachineClientId();
    if (clientId == null) clientId = probe.who == null ? undefined : probe.who.email;
    recordWhoamiImpl(probe.who, clientId == null ? null : clientId);
  } catch { /* best-effort */ }
  const tracking = readTrackingState();
  const liveAllowed = isLiveTrackingAllowed(tracking);

  initSessionState(input.session_id, { cwd: input.cwd == null ? null : input.cwd, transcriptPath: input.transcript_path == null ? null : input.transcript_path });
  // Independent network I/O on the per-session hot path — flush queued checkpoints
  // and probe repo status concurrently rather than serially. A dark workspace skips the repo
  // probe's promise entirely: "Task-branch sessions will be tracked" would be a lie there.
  const [, systemMessage] = await Promise.all([
    flushQueue(token, { fetchImpl }),
    liveAllowed ? announceRepo(input.cwd, token, fetchImpl, gitImpl) : Promise.resolve(null),
  ]);
  try { pruneStale(); } catch { /* best-effort */ }

  // Pre-warm + self-heal the repo-map: discover this session's repo(s) and drop dead roots.
  try {
    const map = loadRepoMap();
    const { dirty } = discoverRepos(input.cwd, gitImpl, map);
    const removed = pruneRepoMap(map);
    if (dirty || removed > 0) saveRepoMap(map);
  } catch { /* best-effort */ }

  // The user may have switched auth method since the last session (exporting an API key over a
  // subscription login, or back). Env is authoritative, so realign billing.json to it before the
  // staleness check reads it — otherwise the stored source stays wrong until the next
  // /beezi:login or /beezi:refresh. Best-effort: a disk failure must not break session start.
  let billingConfig = null;
  let billingSource = BillingSource.UNKNOWN;
  try {
    billingConfig = readBillingConfig();
    billingSource = resolveSource(billingConfig);
    const synced = syncBillingSource(billingConfig, billingSource);
    if (synced) {
      writeBillingConfig(synced);
      billingConfig = synced;
    }
  } catch { /* best-effort */ }

  let message = systemMessage;
  // Billing nudges are noise for a workspace that reports nothing live.
  if (liveAllowed) {
    if (billingSource === BillingSource.SUBSCRIPTION && isStale(billingConfig)) {
      const nudge = 'Beezi: subscription plan info is missing or stale — run /beezi:refresh to update it.';
      message = message ? `${message}\n${nudge}` : nudge;
    } else if (billingSource === BillingSource.UNKNOWN) {
      // Reported honestly as `unknown` rather than guessed. Only the user can resolve it, and
      // without this they would never learn their usage is landing unattributed. A custom gateway
      // gets its own wording: there the machine is not missing a signal, it has one it cannot
      // interpret — the route may forward this machine's subscription credential or bill the
      // gateway's own — so the nudge names the question the user is being asked to settle.
      const nudge = hasCustomGateway()
        ? 'Beezi: this machine sends Claude Code through a custom API endpoint (gateway), so its billing cannot be read locally — usage is reported as "unknown". Run /beezi:login to say whether your Claude subscription or the gateway pays.'
        : 'Beezi: cannot determine how this machine bills Claude — usage is reported as "unknown". Run /beezi:login to set it.';
      message = message ? `${message}\n${nudge}` : nudge;
    }
  }

  // Tracking-policy messages: tell a dark workspace it is dark, and point at the login flow
  // wherever the one-time history pull has not completed yet (paid tenants included) — the
  // backfill runs as the last step of /beezi:login.
  const mode = tracking == null || tracking.trackingMode == null ? null : tracking.trackingMode;
  let policy = null;
  if (mode === TrackingMode.BACKFILL_ONLY) {
    policy = shouldBackfill(tracking)
      ? 'Beezi: audit mode — new sessions are not tracked. Run /beezi:login to upload your session history, or upgrade your workspace plan to track new sessions.'
      : 'Beezi: audit mode — new sessions are not tracked. Upgrade your workspace plan to start tracking them.';
  } else if (mode === TrackingMode.DISABLED) {
    policy = 'Beezi: analytics are off for this workspace.';
  } else if (shouldBackfill(tracking)) {
    policy = 'Beezi: run /beezi:login once to include your past sessions.';
  }
  if (policy) message = message ? `${message}\n${policy}` : policy;

  return message;
}
