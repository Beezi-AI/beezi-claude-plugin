import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';
import { resolveFetch } from './fetch-compat.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { pluginsSyncStateFile } from './paths.mjs';
import { getAccessToken as _getAccessToken } from './token.mjs';
import { linkedSessions } from './sessions.mjs';
import { readTrackingState, isLiveTrackingAllowed, isTenantDark } from './tracking.mjs';
import { tenantsOf, isMultiTenant, newFoldersOf } from './workspace.mjs';
import { createRouteContext, routePastSession, rulesOf } from './workspace-rules.mjs';
import { buildPluginSnapshot } from './enabled-plugins.mjs';
import { readInstalledPlugins } from './about.mjs';
import { readProjectCache, liveProjects } from './plugin-projects.mjs';

// Tells Beezi which Claude Code plugins are enabled on this machine. Runs inside the hourly
// detached child (scripts/cost-state-sync.mjs), which the Stop hook and SessionStart spawn.
//
// The body is a FULL snapshot, an empty list included: the server soft-removes whatever this
// machine reported before and no longer does, so "everything switched off" has to be sent too.
//
// Workspace routing is honored the same way session analytics are: a project's plugins (and the
// repo identity that comes with them) go only to the workspaces that folder's analytics go to now,
// and a Don't track folder is never reported. User-scope plugins belong to the machine, not to a
// repo; a multi-workspace account sends them to every workspace it routes anything to, plus every
// workspace that took an earlier snapshot, so a later removal still reaches it.
//
// The route carries the server's live-tracking guard, so a workspace without live tracking is not
// asked at all. A 403 from it is NOT written back to tracking.json the way cost-state-scan does:
// that record also gates the hourly child itself, and an inventory refusal must never switch off
// the cost backfill.

export const STATE_VERSION = 1;

// Just under the hour: the child is spawned once an hour, a little AFTER the gate was stamped, so
// a full hour would skip every other run.
export const DUE_MS = 55 * 60 * 1000;

// No hook budget to protect in the detached child, but the snapshot is one small request.
const UPLOAD_TIMEOUT_MS = 15000;

// byTenant key for the account's default workspace (no X-Beezi-Tenant header).
const DEFAULT_TENANT = '_default';

export function readPluginsSyncState(key, deps = {}) {
  const read = deps.readJsonImpl == null ? readJson : deps.readJsonImpl;
  const raw = read(pluginsSyncStateFile(key), null);
  if (raw == null || raw.version !== STATE_VERSION) return null;
  return raw;
}

function stampFor(state, tenantKey) {
  if (state == null || state.byTenant == null || typeof state.byTenant !== 'object') return null;
  const entry = state.byTenant[tenantKey];
  return entry == null ? null : entry.sentAt;
}

export function isDue(sentAt, nowMs) {
  const at = Date.parse(sentAt == null ? '' : sentAt);
  if (isNaN(at)) return true;
  // A stamp in the future is a clock change, not freshness — do not let it lock the gate shut.
  if (at > nowMs) return true;
  return nowMs - at >= DUE_MS;
}

// Re-reads before merging, so a tenant written by an earlier iteration is never lost.
function markSent(key, tenantKey, nowMs, deps) {
  const write = deps.writeJsonImpl == null ? writeJsonSecure : deps.writeJsonImpl;
  const latest = readPluginsSyncState(key, deps);
  const byTenant = latest != null && latest.byTenant != null && typeof latest.byTenant === 'object' ? latest.byTenant : {};
  try {
    write(pluginsSyncStateFile(key), {
      version: STATE_VERSION,
      byTenant: { ...byTenant, [tenantKey]: { sentAt: new Date(nowMs).toISOString() } },
    });
  } catch { /* best-effort: a lost marker costs one extra small request */ }
}

// Where each recorded project's analytics go now: root → tenant ids ([null] = the one workspace,
// [] = not sent). The same rule, then New folders, resolution a past session from that folder gets.
export function projectRoutes(session, projects, ctx, route = routePastSession) {
  const out = {};
  for (const root of Object.keys(projects == null ? {} : projects)) {
    let ids = [];
    try { ids = route(session, { readCwd: () => root }, ctx).tenantIds; } catch { ids = []; }
    out[root] = Array.isArray(ids) ? ids : [];
  }
  return out;
}

// The workspaces that take this account's snapshot, each with the project roots it may see.
// Any account but a multi-workspace one reports to its default workspace when live tracking is on.
export function targetsFor(session, tracking, routes, state) {
  const roots = Object.keys(routes == null ? {} : routes);
  if (!isMultiTenant(session)) {
    if (!isLiveTrackingAllowed(tracking)) return [];
    return [{ tenantId: null, roots: roots.filter((root) => routes[root].length > 0) }];
  }
  const members = tenantsOf(session).map((t) => t.id);
  const wanted = new Set();
  const want = (id) => { if (members.indexOf(id) !== -1) wanted.add(id); };
  for (const rule of rulesOf(session)) rule.tenantIds.forEach(want);
  newFoldersOf(session).tenantIds.forEach(want);
  for (const root of roots) routes[root].forEach(want);
  const sent = state != null && state.byTenant != null && typeof state.byTenant === 'object' ? state.byTenant : {};
  Object.keys(sent).forEach(want);
  return Array.from(wanted).sort()
    .filter((id) => !isTenantDark(tracking, id))
    .map((id) => ({ tenantId: id, roots: roots.filter((root) => routes[root].indexOf(id) !== -1) }));
}

function pick(projects, roots) {
  const out = {};
  for (const root of roots) out[root] = projects[root];
  return out;
}

// 'sent' (2xx), 'refused' (403 — not this workspace's feature), 'unsupported' (404/405: an API
// that predates the route), 'unlinked' (no token after a forced refresh), or 'failed'.
async function send(session, body, deps) {
  const post = deps.postJsonImpl == null ? postJson : deps.postJsonImpl;
  const getToken = deps.getAccessToken == null ? _getAccessToken : deps.getAccessToken;
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const url = `${apiBase()}${ENDPOINTS.pluginsSync}`;
  const options = { fetchImpl, timeoutMs: UPLOAD_TIMEOUT_MS };
  let res = await post(url, session, body, options);
  if (res != null && res.status === 401) {
    // The server is the authority on a token that merely looks fresh: one forced refresh, one retry.
    const token = await getToken({}, { account: session.key, forceRefresh: true });
    if (token == null) return { outcome: 'unlinked', session };
    session = { ...session, token };
    res = await post(url, session, body, options);
  }
  const status = res == null ? null : res.status;
  if (status != null && status >= 200 && status < 300) return { outcome: 'sent', session };
  if (status === 403) return { outcome: 'refused', session };
  if (status === 404 || status === 405) return { outcome: 'unsupported', session };
  return { outcome: 'failed', session };
}

// Never throws. Returns { results: [{ key, tenantId, outcome }] } for tests and nothing else.
export async function runPluginsSync(deps = {}) {
  const results = [];
  try {
    const getSessions = deps.linkedSessions == null ? linkedSessions : deps.linkedSessions;
    const readTracking = deps.readTrackingState == null ? readTrackingState : deps.readTrackingState;
    const nowMs = deps.now == null ? Date.now() : deps.now();
    const sessions = await getSessions(deps);
    if (sessions.length === 0) return { results };
    const projects = liveProjects(readProjectCache(deps), nowMs);
    // One read of installed_plugins.json for every body this run builds.
    let installed = null;
    try { installed = deps.readInstalledPlugins == null ? readInstalledPlugins(deps) : deps.readInstalledPlugins(); } catch { installed = null; }
    const snapshotDeps = { ...deps, readInstalledPlugins: () => installed };
    const ctx = createRouteContext(deps.loadRepoMap == null ? {} : { loadRepoMapImpl: deps.loadRepoMap });
    const route = deps.routePastSession == null ? routePastSession : deps.routePastSession;
    for (let session of sessions) {
      let tracking = null;
      try { tracking = readTracking(session.key); } catch { tracking = null; }
      const state = readPluginsSyncState(session.key, deps);
      const routes = projectRoutes(session, projects, ctx, route);
      for (const target of targetsFor(session, tracking, routes, state)) {
        const tenantId = target.tenantId;
        const body = { plugins: buildPluginSnapshot(pick(projects, target.roots), snapshotDeps) };
        const tenantKey = tenantId == null ? DEFAULT_TENANT : tenantId;
        if (!isDue(stampFor(state, tenantKey), nowMs)) continue;
        let outcome = 'failed';
        try {
          const sent = await send({ ...session, tenantId }, body, deps);
          outcome = sent.outcome;
          // Keep a refreshed token for this account's next workspace.
          session = { ...session, token: sent.session.token };
        } catch {
          outcome = 'failed';
        }
        results.push({ key: session.key, tenantId, outcome });
        // A failure is retried by the next hourly run; every verdict waits the hour out.
        if (outcome !== 'failed' && outcome !== 'unlinked') markSent(session.key, tenantKey, nowMs, deps);
        if (outcome === 'unlinked' || outcome === 'unsupported') break;
      }
    }
  } catch { /* best-effort: the detached child reports nothing */ }
  return { results };
}
