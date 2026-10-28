import path from 'path';
import { fileURLToPath } from 'url';
import { readJson } from './fs-store.mjs';
import { claudeHome } from './paths.mjs';
import { compareVersions } from './version-compare.mjs';
import { fetchLatest } from './update-check.mjs';

// What /beezi:status and /beezi:release-notes show about the plugin: what is installed, whether a
// newer build is published, and when this machine last updated it. Every fact is best-effort: a
// missing or unfamiliar file reads as "unknown", never as an error, because none of it is needed
// for the plugin to work.

const PLUGIN_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// The user asked right now, outside any hook budget — a slow CDN gets longer than the 1.5s the
// SessionStart nudge allows.
const ABOUT_FETCH_TIMEOUT_MS = 5000;

// installed_plugins.json is Claude Code's own record, not a documented interface. Only the layout
// seen in the wild is trusted: { version: 2, plugins: { "<name>@<marketplace>": [ { scope,
// installPath, version, installedAt, lastUpdated } ] } }. Anything else reads as "unknown".
const INSTALLED_FORMAT = 2;

function claudePluginsDir(deps) {
  return path.join(deps.claudeHomeDir == null ? claudeHome() : deps.claudeHomeDir, 'plugins');
}

export function samePath(a, b, platform) {
  if (typeof a !== 'string' || typeof b !== 'string' || a === '' || b === '') return false;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const left = p.resolve(a), right = p.resolve(b);
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function marketplaceOf(key) {
  const at = key.lastIndexOf('@');
  return at === -1 ? null : key.slice(at + 1);
}

// The `plugins` map of installed_plugins.json ({ "<name>@<marketplace>": [entry, ...] }), or null
// when the file is missing, unreadable or in a layout we do not trust.
export function readInstalledPlugins(deps = {}) {
  const raw = readJson(path.join(claudePluginsDir(deps), 'installed_plugins.json'), null);
  if (raw == null || raw.version !== INSTALLED_FORMAT) return null;
  if (raw.plugins == null || typeof raw.plugins !== 'object' || Array.isArray(raw.plugins)) return null;
  return raw.plugins;
}

// This copy's install record: the entry whose installPath IS this plugin root, else an entry under
// the same plugin name with the same version (a cache folder Claude Code has since moved). null for
// a copy loaded from a local folder (`--plugin-dir`), which no marketplace installed.
export function findInstall(local, deps = {}) {
  if (local == null) return null;
  const root = deps.pluginRoot == null ? PLUGIN_ROOT : deps.pluginRoot;
  const platform = deps.platform == null ? process.platform : deps.platform;
  const plugins = readInstalledPlugins(deps);
  if (plugins == null) return null;
  let byVersion = null;
  const keys = Object.keys(plugins);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const entries = plugins[key];
    if (!Array.isArray(entries)) continue;
    for (let j = 0; j < entries.length; j++) {
      const entry = entries[j];
      if (entry == null || typeof entry !== 'object') continue;
      const found = {
        key: key,
        marketplace: marketplaceOf(key),
        scope: typeof entry.scope === 'string' ? entry.scope : null,
        installedAt: typeof entry.installedAt === 'string' ? entry.installedAt : null,
        lastUpdated: typeof entry.lastUpdated === 'string' ? entry.lastUpdated : null,
      };
      if (samePath(entry.installPath, root, platform)) return found;
      if (byVersion == null && key.indexOf(`${local.name}@`) === 0 && entry.version === local.version) {
        byVersion = found;
      }
    }
  }
  return byVersion;
}

// true / false from known_marketplaces.json, null when the marketplace or the flag is not there.
export function marketplaceAutoUpdate(marketplace, deps = {}) {
  if (!marketplace) return null;
  const raw = readJson(path.join(claudePluginsDir(deps), 'known_marketplaces.json'), null);
  if (raw == null || typeof raw !== 'object') return null;
  const entry = raw[marketplace];
  if (entry == null || typeof entry.autoUpdate !== 'boolean') return null;
  return entry.autoUpdate;
}

// 'update' | 'current' | 'ahead' | 'unknown' (versions not comparable) | 'unchecked' (no reading)
function versionStatus(local, record) {
  if (record == null) return 'unchecked';
  const order = compareVersions(record.latestVersion, local.version);
  if (order === 1) return 'update';
  if (order === 0) return 'current';
  if (order === -1) return 'ahead';
  return 'unknown';
}

export async function aboutPlugin(deps = {}) {
  const fetchDeps = deps.timeoutMs == null ? { ...deps, timeoutMs: ABOUT_FETCH_TIMEOUT_MS } : deps;
  const latest = await fetchLatest(fetchDeps);
  const local = latest.local;
  if (local == null) return { local: null };
  const install = findInstall(local, deps);
  const record = latest.record;
  // The install record names the marketplace even offline; the manifest is the fallback for a
  // local-folder copy.
  const marketplace = install != null && install.marketplace
    ? install.marketplace
    : (record != null && record.marketplaceName ? record.marketplaceName : null);
  return {
    local: local,
    install: install,
    marketplace: marketplace,
    // Only for a marketplace install: a local-folder copy is never auto-updated, whatever the
    // marketplace of the same name is set to.
    autoUpdate: install == null ? null : marketplaceAutoUpdate(marketplace, deps),
    latest: record == null
      ? null
      : { version: record.latestVersion, checkedAt: record.checkedAt, stale: latest.stale },
    status: versionStatus(local, record),
  };
}
