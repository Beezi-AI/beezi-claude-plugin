import { readJson, writeJsonSecure } from './fs-store.mjs';
import { pluginProjectsFile } from './paths.mjs';
import { loadRepoMap, resolveRemoteOffline } from './repo-map.mjs';
import { readProjectEnabled } from './enabled-plugins.mjs';

// The project-scope half of the plugin snapshot. Project settings live next to the code, and the
// hourly sender runs in a detached child with no cwd — so the Stop hook, which does know where the
// user is working, writes down what it saw and the child reads it back.
//
// Only the repo identity leaves the machine (a canonical remote, or `local:<folder>`); the folder
// path is the local cache key and nothing more.

export const STATE_VERSION = 1;

// Rewrite an unchanged entry at most this often: seenAt only has to be fresh enough for pruning.
export const REFRESH_MS = 60 * 60 * 1000;

// A project nobody opened for this long drops out of the snapshot, and the server soft-removes it.
export const PRUNE_MS = 30 * 24 * 60 * 60 * 1000;

export function readProjectCache(deps = {}) {
  const read = deps.readJsonImpl == null ? readJson : deps.readJsonImpl;
  const raw = read(pluginProjectsFile(), null);
  if (raw == null || raw.version !== STATE_VERSION) return {};
  return raw.projects != null && typeof raw.projects === 'object' && !Array.isArray(raw.projects) ? raw.projects : {};
}

function stampMs(value) {
  const at = Date.parse(value == null ? '' : value);
  return isNaN(at) ? null : at;
}

function isStale(entry, nowMs, maxAgeMs) {
  const at = stampMs(entry == null ? null : entry.seenAt);
  // A stamp in the future is a clock change, not freshness.
  return at == null || at > nowMs || nowMs - at >= maxAgeMs;
}

// The projects still worth reporting: everything seen within PRUNE_MS.
export function liveProjects(projects, nowMs) {
  const out = {};
  for (const root of Object.keys(projects == null ? {} : projects)) {
    if (!isStale(projects[root], nowMs, PRUNE_MS)) out[root] = projects[root];
  }
  return out;
}

function sameList(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Called from the Stop hook. Cheap by design: a few existsSync calls up to the repo root, and a
// write only when the enabled set changed or the entry is an hour old. Never throws.
export function recordProjectPlugins(cwd, deps = {}) {
  try {
    const nowMs = deps.now == null ? Date.now() : deps.now();
    const found = (deps.readProjectEnabled == null ? readProjectEnabled : deps.readProjectEnabled)(cwd, deps);
    if (found == null) return { recorded: false, reason: 'no-project-settings' };
    const projects = readProjectCache(deps);
    const prior = projects[found.root];
    const empty = found.project.length === 0 && found.local.length === 0;
    if (empty && prior == null) return { recorded: false, reason: 'nothing-enabled' };
    if (prior != null && sameList(prior.project, found.project) && sameList(prior.local, found.local)
      && !isStale(prior, nowMs, REFRESH_MS)) {
      return { recorded: false, reason: 'unchanged' };
    }
    const next = liveProjects(projects, nowMs);
    if (empty) {
      // Nothing enabled any more: forgetting the project is what tells the server to remove it.
      delete next[found.root];
    } else {
      const resolveRepo = deps.resolveRepo == null ? ((root) => resolveRemoteOffline(root, loadRepoMap())) : deps.resolveRepo;
      let repo = null;
      try { repo = resolveRepo(found.root); } catch { repo = null; }
      if (repo == null && prior != null && typeof prior.repo === 'string') repo = prior.repo;
      next[found.root] = { repo, project: found.project, local: found.local, seenAt: new Date(nowMs).toISOString() };
    }
    const write = deps.writeJsonImpl == null ? writeJsonSecure : deps.writeJsonImpl;
    write(pluginProjectsFile(), { version: STATE_VERSION, projects: next });
    return { recorded: true };
  } catch {
    return { recorded: false, reason: 'error' };
  }
}
