import fs from 'node:fs';
import path from 'node:path';
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
import { whoami } from './whoami.mjs';
import { BillingSource } from './billing.mjs';
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
  const fsImpl = deps.fs ?? fs;
  let dirty = false;
  if (!cwd) return { map, dirty };
  const cache = new Map();
  const recordRoot = (root) => {
    if (!root) return;
    const origin = resolveOriginRemote(gitImpl, root) ?? originFromGitConfig(root);
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
      recordRoot(resolveRepoRoot(gitImpl, child, cache, map) ?? child);
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
async function isTokenRejected(token, fetchImpl) {
  const who = await whoami(token, { fetchImpl });
  return who?.valid === false;
}

// Returns an optional systemMessage string (or null). Never throws for expected failures.
export async function runSessionStart(input, deps = {}) {
  const getAccessToken = deps.getAccessToken ?? _getAccessToken;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const gitImpl = deps.gitImpl ?? _git;
  const resolveSource = deps.resolveSource ?? _resolveSource;
  const readBillingConfig = deps.readBillingConfig ?? _readBillingConfig;
  const writeBillingConfig = deps.writeBillingConfig ?? _writeBillingConfig;
  const isStale = deps.isStale ?? _isStale;

  let token = null;
  try { token = await getAccessToken(); } catch { token = null; }
  if (!token)
    return '⚠ Beezi: this machine is not linked — analytics are NOT being tracked. Run /beezi:login to link it.';

  if (await isTokenRejected(token, fetchImpl)) {
    // The 401 is the server's verdict on the token; expires_at was only ours, and a server that
    // omits expires_in leaves it a guess. Take the server's word and refresh once before
    // declaring the link bad — otherwise a token that died earlier than we estimated is never
    // renewed, and every session reports a rejection that a single refresh would have fixed.
    const refreshed = await getAccessToken({}, { forceRefresh: true }).catch(() => null);
    if (!refreshed || await isTokenRejected(refreshed, fetchImpl)) {
      return '⚠ Beezi: this machine’s link was rejected — analytics are NOT being tracked. Run /beezi:login to re-link.';
    }
    token = refreshed;
  }

  initSessionState(input.session_id, { cwd: input.cwd ?? null, transcriptPath: input.transcript_path ?? null });
  // Independent network I/O on the per-session hot path — flush queued checkpoints
  // and probe repo status concurrently rather than serially.
  const [, systemMessage] = await Promise.all([
    flushQueue(token, { fetchImpl }),
    announceRepo(input.cwd, token, fetchImpl, gitImpl),
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
  if (billingSource === BillingSource.SUBSCRIPTION && isStale(billingConfig)) {
    const nudge = 'Beezi: subscription plan info is missing or stale — run /beezi:refresh to update it.';
    message = message ? `${message}\n${nudge}` : nudge;
  } else if (billingSource === BillingSource.UNKNOWN) {
    // Reported honestly as `unknown` rather than guessed. Only the user can resolve it, and
    // without this they would never learn their usage is landing unattributed.
    const nudge = 'Beezi: cannot determine how this machine bills Claude — usage is reported as "unknown". Run /beezi:login to set it.';
    message = message ? `${message}\n${nudge}` : nudge;
  }
  return message;
}
