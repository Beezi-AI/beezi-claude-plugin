import path from 'path';
import { fileURLToPath } from 'url';
import { readJson } from './fs-store.mjs';
import { claudeHome } from './paths.mjs';
import { compareVersions } from './version-compare.mjs';
import { fetchLatest, updateCommands } from './update-check.mjs';

// /beezi:about — what is installed, whether a newer build is published, when this machine last
// updated it, and how to update. Every fact is best-effort: a missing or unfamiliar file reads as
// "unknown", never as an error, because none of it is needed for the plugin to work.

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

function samePath(a, b, platform) {
  if (typeof a !== 'string' || typeof b !== 'string' || a === '' || b === '') return false;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const left = p.resolve(a), right = p.resolve(b);
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function marketplaceOf(key) {
  const at = key.lastIndexOf('@');
  return at === -1 ? null : key.slice(at + 1);
}

// This copy's install record: the entry whose installPath IS this plugin root, else an entry under
// the same plugin name with the same version (a cache folder Claude Code has since moved). null for
// a copy loaded from a local folder (`--plugin-dir`), which no marketplace installed.
export function findInstall(local, deps = {}) {
  if (local == null) return null;
  const root = deps.pluginRoot == null ? PLUGIN_ROOT : deps.pluginRoot;
  const platform = deps.platform == null ? process.platform : deps.platform;
  const raw = readJson(path.join(claudePluginsDir(deps), 'installed_plugins.json'), null);
  if (raw == null || raw.version !== INSTALLED_FORMAT) return null;
  if (raw.plugins == null || typeof raw.plugins !== 'object') return null;
  let byVersion = null;
  const keys = Object.keys(raw.plugins);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const entries = raw.plugins[key];
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

// `YYYY-MM-DD HH:MM UTC` — fixed, so the output reads the same on every machine and locale.
function formatTime(iso) {
  const ms = Date.parse(typeof iso === 'string' ? iso : '');
  if (Number.isNaN(ms)) return null;
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function latestLine(info) {
  if (info.latest == null) return 'unknown — could not reach the update server';
  const at = formatTime(info.latest.checkedAt);
  if (info.latest.stale) {
    return `${info.latest.version} (could not check now; last seen ${at == null ? 'earlier' : at})`;
  }
  return at == null ? info.latest.version : `${info.latest.version} (checked ${at})`;
}

function lastUpdatedLine(info) {
  if (info.install == null) return 'unknown — not installed from a marketplace (loaded from a local folder)';
  const updated = formatTime(info.install.lastUpdated);
  const installed = formatTime(info.install.installedAt);
  if (updated == null) return installed == null ? 'unknown' : `unknown (first installed ${installed})`;
  return installed == null ? updated : `${updated} (first installed ${installed})`;
}

function updateSteps(info) {
  const lines = [`Update available: ${info.local.version} → ${info.latest.version}. To update:`];
  const where = info.marketplace ? ` from the ${info.marketplace} marketplace` : '';
  lines.push(`  - In Claude Code: run /plugin and update ${info.local.name}${where}.`);
  const commands = updateCommands(info.local.name, info.marketplace);
  if (commands != null) {
    lines.push('  - Or from a terminal:');
    lines.push(`      ${commands[0]}`);
    lines.push(`      ${commands[1]}`);
  }
  lines.push('  Then restart Claude Code to apply it.');
  if (info.autoUpdate === true) {
    lines.push('  Auto-update is on for this marketplace, so Claude Code also installs it on its own at startup.');
  }
  return lines;
}

export function formatAbout(info) {
  if (info == null || info.local == null) {
    return "✗ Beezi: could not read this plugin's version (.claude-plugin/plugin.json).\n";
  }
  const lines = [
    `Beezi plugin — ${info.local.name}`,
    `  Installed version: ${info.local.version}`,
    `  Latest published:  ${latestLine(info)}`,
    `  Last updated here: ${lastUpdatedLine(info)}`,
  ];
  if (info.marketplace) {
    const flag = info.autoUpdate === true ? ' (auto-update on)' : (info.autoUpdate === false ? ' (auto-update off)' : '');
    lines.push(`  Marketplace:       ${info.marketplace}${flag}`);
  }
  lines.push('');
  if (info.status === 'update') {
    updateSteps(info).forEach((line) => lines.push(line));
  } else if (info.status === 'current') {
    lines.push('You have the newest version.');
  } else if (info.status === 'ahead') {
    lines.push(`This build (${info.local.version}) is newer than the published ${info.latest.version}.`);
  } else if (info.status === 'unknown') {
    lines.push(`Could not compare ${info.local.version} with the published ${info.latest.version}.`);
  } else {
    lines.push('Could not check for a newer version. Run /beezi:about again later.');
  }
  return `${lines.join('\n')}\n`;
}
