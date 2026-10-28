import fs from 'fs';
import os from 'os';
import path from 'path';
import { readJson } from './fs-store.mjs';
import { settingsCandidates } from './claude-settings-env.mjs';
import { normPath } from './repo-map.mjs';
import { readInstalledPlugins, marketplaceOf, samePath } from './about.mjs';

// Which Claude Code plugins are switched on, read from the same files Claude Code reads:
// `enabledPlugins: { "<name>@<marketplace>": true | false }` in the user settings
// (`~/.claude/settings.json`, then `settings.local.json`) and in a project's `.claude/settings.json`
// (scope `project`) and `.claude/settings.local.json` (scope `local`). Only `true` counts as enabled.
//
// Best-effort by contract, like every reader of Claude Code's own files: a missing, malformed or
// unreadable file is "nothing enabled there", never an error — this runs on the Stop hook.

export const PluginScope = Object.freeze({ USER: 'user', PROJECT: 'project', LOCAL: 'local' });

// The server whitelists this charset and these lengths. An entry outside them would 400 the whole
// snapshot, so it is dropped here instead.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_NAME = 214;
const MAX_VERSION = 64;
const MAX_REPO = 512;
export const MAX_SNAPSHOT_PLUGINS = 500;

// Guards against a pathological path depth, as findRepoRootByWalk does.
const MAX_WALK = 64;

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

function fold(p) {
  return CASE_INSENSITIVE ? p.toLowerCase() : p;
}

function readEnabledMap(file, deps) {
  const read = deps.readJsonImpl == null ? readJson : deps.readJsonImpl;
  const cfg = read(file, null);
  if (cfg == null || typeof cfg !== 'object') return null;
  const map = cfg.enabledPlugins;
  if (map == null || typeof map !== 'object' || Array.isArray(map)) return null;
  return map;
}

function enabledKeys(map) {
  if (map == null) return [];
  return Object.keys(map).filter((k) => map[k] === true).sort();
}

// User scope, merged the way Claude Code merges it: settings.local.json overrides settings.json key
// by key, so a `false` there switches off a plugin the shared file enables.
export function readUserEnabled(deps = {}) {
  const env = deps.env == null ? process.env : deps.env;
  const homedir = deps.homedir == null ? os.homedir() : deps.homedir;
  let merged = {};
  for (const file of settingsCandidates(env, homedir)) {
    const map = readEnabledMap(file, deps);
    if (map != null) merged = { ...merged, ...map };
  }
  return enabledKeys(merged);
}

// The project settings that apply in `cwd`: the nearest folder at or above it that has a
// `.claude/settings.json` or `.claude/settings.local.json`. The walk ends at the repo root (the
// first folder with a .git entry) and never reaches the home folder, whose `.claude` is user scope.
//
// Returns { root, project: [keys], local: [keys] } or null when no project settings apply.
export function readProjectEnabled(cwd, deps = {}) {
  const exists = deps.exists == null ? ((p) => fs.existsSync(p)) : deps.exists;
  const homedir = deps.homedir == null ? os.homedir() : deps.homedir;
  const env = deps.env == null ? process.env : deps.env;
  const configDir = env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CONFIG_DIR : path.join(homedir, '.claude');
  const home = normPath(homedir);
  const userDir = normPath(configDir);
  let d = normPath(cwd);
  if (!d) return null;
  try {
    for (let i = 0; i < MAX_WALK; i++) {
      if (home && fold(d) === fold(home)) return null;
      const dotClaude = path.join(d, '.claude');
      const isUserDir = userDir && fold(normPath(dotClaude)) === fold(userDir);
      if (!isUserDir) {
        const shared = path.join(dotClaude, 'settings.json');
        const local = path.join(dotClaude, 'settings.local.json');
        const hasShared = exists(shared);
        const hasLocal = exists(local);
        if (hasShared || hasLocal) {
          return {
            root: d,
            project: hasShared ? enabledKeys(readEnabledMap(shared, deps)) : [],
            local: hasLocal ? enabledKeys(readEnabledMap(local, deps)) : [],
          };
        }
      }
      if (exists(path.join(d, '.git'))) return null;
      const parent = normPath(path.dirname(d));
      if (!parent || parent === d) return null;
      d = parent;
    }
  } catch {
    return null;
  }
  return null;
}

// "<name>@<marketplace>" split on the LAST @, or null when either half breaks the server's rules.
export function parsePluginKey(key) {
  if (typeof key !== 'string') return null;
  const marketplace = marketplaceOf(key);
  if (marketplace == null) return null;
  const name = key.slice(0, key.length - marketplace.length - 1);
  if (!NAME_RE.test(name) || name.length > MAX_NAME) return null;
  if (!NAME_RE.test(marketplace) || marketplace.length > MAX_NAME) return null;
  return { name, marketplace };
}

// The installed version for a key in a scope: the install record of that scope (for a project or
// local scope, the one whose projectPath is `root`), else the user install, else any install.
export function versionFor(installed, key, scope, root, platform = process.platform) {
  if (installed == null) return null;
  const entries = installed[key];
  if (!Array.isArray(entries)) return null;
  const valid = entries.filter((e) => e != null && typeof e === 'object' && typeof e.version === 'string' && e.version !== '');
  const match = (e) => e.scope === scope && (scope === PluginScope.USER || samePath(e.projectPath, root, platform));
  let pick = valid.find(match);
  if (pick == null) pick = valid.find((e) => e.scope === PluginScope.USER);
  if (pick == null) pick = valid[0];
  if (pick == null || pick.version.length > MAX_VERSION) return null;
  return pick.version;
}

// The wire snapshot: user scope from the settings files, project scopes from the projects the Stop
// hook recorded (lib/plugin-projects.mjs). Deduped on (plugin, scope, repo) — two checkouts of one
// repo are one project to the server — and capped at the server's limit.
export function buildPluginSnapshot(projects, deps = {}) {
  const platform = deps.platform == null ? process.platform : deps.platform;
  let installed = null;
  try {
    installed = deps.readInstalledPlugins == null ? readInstalledPlugins(deps) : deps.readInstalledPlugins();
  } catch { installed = null; }
  const out = [];
  const seen = new Set();
  const add = (key, scope, root, repo) => {
    if (out.length >= MAX_SNAPSHOT_PLUGINS) return;
    const parsed = parsePluginKey(key);
    if (parsed == null) return;
    const repoValue = repo == null || repo === '' ? null : repo;
    if (repoValue != null && repoValue.length > MAX_REPO) return;
    const id = `${parsed.name}@${parsed.marketplace}|${scope}|${repoValue == null ? '' : repoValue}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({
      name: parsed.name,
      marketplace: parsed.marketplace,
      version: versionFor(installed, key, scope, root, platform),
      scope,
      repo: repoValue,
    });
  };
  for (const key of readUserEnabled(deps)) add(key, PluginScope.USER, null, null);
  const roots = projects == null ? [] : Object.keys(projects).sort();
  for (const root of roots) {
    const entry = projects[root];
    if (entry == null || typeof entry !== 'object') continue;
    const repo = typeof entry.repo === 'string' ? entry.repo : null;
    // A project scope without a repo identity cannot be told apart from another one server-side.
    if (repo == null) continue;
    for (const key of Array.isArray(entry.project) ? entry.project : []) add(key, PluginScope.PROJECT, root, repo);
    for (const key of Array.isArray(entry.local) ? entry.local : []) add(key, PluginScope.LOCAL, root, repo);
  }
  return out;
}
