import path from 'path';
import { fileURLToPath } from 'url';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { updateCheckFile } from './paths.mjs';
import { updateManifestUrl } from './config.mjs';
import { getJson } from './http.mjs';
import { isNewer } from './version-compare.mjs';

// Exported so test/update-check.test.mjs seeds cache records with it rather than hard-coding a
// number that a later bump would silently desync.
export const STATE_VERSION = 1;

// How long a fetched manifest reading is trusted. One hour: internal builds publish several
// times a day, so a longer window would hide the very updates this exists to surface.
const FRESH_MS = 60 * 60 * 1000;

// Tighter than postJson's 3s default, same reasoning as oauth-key-status.mjs's 1500ms: this runs
// inline on SessionStart, whose whole budget is 10s. raw.githubusercontent.com is a CDN — an
// answer slower than this is not coming, and the nudge simply waits for the next session.
const FETCH_TIMEOUT_MS = 1500;

const PLUGIN_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// The INSTALLED identity, from .claude-plugin/plugin.json — the file make-variant.sh rewrites.
// Deliberately NOT package.json: make-variant.sh leaves that at the base version, so on a dev
// build package.json says 0.17.0 while the plugin installed is 0.17.0-dev.4938. Comparing against
// package.json would nag every internal machine forever.
export function readLocalPlugin(deps = {}) {
  if (deps.localPlugin != null) return deps.localPlugin;
  const root = deps.pluginRoot == null ? PLUGIN_ROOT : deps.pluginRoot;
  const manifest = readJson(path.join(root, '.claude-plugin', 'plugin.json'), null);
  if (manifest == null) return null;
  const name = typeof manifest.name === 'string' ? manifest.name : null;
  const version = typeof manifest.version === 'string' ? manifest.version : null;
  if (!name || !version) return null;
  return { name: name, version: version };
}

export function readUpdateCheck(deps = {}) {
  const read = deps.readJsonImpl == null ? readJson : deps.readJsonImpl;
  const raw = read(updateCheckFile(), null);
  if (!raw || raw.version !== STATE_VERSION) return null;
  return raw;
}

function writeUpdateCheck(state, deps = {}) {
  const write = deps.writeJsonImpl == null ? writeJsonSecure : deps.writeJsonImpl;
  try {
    write(updateCheckFile(), { version: STATE_VERSION, ...state });
  } catch { /* best-effort */ }
}

// Keyed on time ALONE, and that is safe only because the record holds the remote FACTS and never
// a verdict: an update the user has since installed is caught by re-comparing on read.
function isFresh(cached, nowMs) {
  if (cached == null) return false;
  const at = Date.parse(cached.checkedAt == null ? '' : cached.checkedAt);
  if (Number.isNaN(at)) return false;
  // Second clause: a stamp from the future is a clock change, not a fresh reading.
  return nowMs - at <= FRESH_MS && at <= nowMs;
}

// Matched on plugin.json's OWN name — beezi / beezi-dev / beezi-staging. That is the same string
// sync-to-github.sh copies into the entry it upserts, so the two are in lockstep by construction.
function findEntry(manifest, pluginName) {
  if (manifest == null || typeof manifest !== 'object') return null;
  if (!Array.isArray(manifest.plugins)) return null;
  for (const entry of manifest.plugins) {
    if (entry == null || entry.name !== pluginName) continue;
    if (typeof entry.version !== 'string') return null;
    return {
      latestVersion: entry.version,
      // Exactly what `claude plugin update <plugin>@<marketplace>` wants, and the manifest already
      // carries it — so dev/staging need no config beyond the URL.
      marketplaceName: typeof manifest.name === 'string' ? manifest.name : null,
    };
  }
  return null;
}

async function fetchRemote(pluginName, nowIso, deps) {
  // `=== undefined`, NOT `== null`. Once env.json carries the prod URL, updateManifestUrl() always
  // returns a string, so a `== null` check would leave tests no way to express "no URL configured"
  // — they would silently fall through to the real one and hit the network. An explicit
  // `manifestUrl: null` must mean absent.
  const url = deps.manifestUrl === undefined ? updateManifestUrl() : deps.manifestUrl;
  // No URL is the normal state of an older variant build; a non-https one is a misconfiguration.
  // Neither is an observation about the installed version.
  if (typeof url !== 'string' || url.slice(0, 8) !== 'https://') return null;
  try {
    const body = await getJson(url, { fetchImpl: deps.fetchImpl, timeoutMs: FETCH_TIMEOUT_MS });
    const found = findEntry(body, pluginName);
    if (found == null) return null;
    const record = {
      checkedAt: nowIso,
      pluginName: pluginName,
      latestVersion: found.latestVersion,
      marketplaceName: found.marketplaceName,
    };
    writeUpdateCheck(record, deps);
    return record;
  } catch {
    return null;   // offline, timed out, rate-limited, 404, or a body that is not JSON
  }
}

// Names the exact commands: "update the plugin" is not actionable without knowing which
// marketplace it came from. A manifest with no name leaves no command to name, so the interactive
// menu is offered rather than printing `beezi-dev@undefined`.
export function composeNudge(local, record) {
  const head = `Beezi: a newer ${local.name} is published — ${local.version} → ${record.latestVersion}.`;
  if (!record.marketplaceName) {
    return `${head} Run /plugin to update it, then restart Claude Code to apply it.`;
  }
  return `${head} Run: claude plugin marketplace update ${record.marketplaceName}`
    + `, then claude plugin update ${local.name}@${record.marketplaceName}`
    + ' — then restart Claude Code to apply it.';
}

// The one-line nudge, or null when there is nothing to say. Best-effort by contract: never throws.
export async function checkForUpdate(deps = {}) {
  try {
    const local = readLocalPlugin(deps);
    if (local == null) return null;
    const now = deps.now == null ? new Date() : deps.now;
    let record = readUpdateCheck(deps);
    // A reading about a DIFFERENT plugin name (variant swap under one BEEZI_HOME) says nothing.
    if (record != null && record.pluginName !== local.name) record = null;
    if (!isFresh(record, now.getTime())) {
      record = await fetchRemote(local.name, now.toISOString(), deps);
    }
    if (record == null) return null;
    // Re-decided on every read against the version installed RIGHT NOW, never persisted. A user
    // who took the update sees silence on the very next start, before the cache expires.
    if (!isNewer(record.latestVersion, local.version)) return null;
    return composeNudge(local, record);
  } catch {
    return null;
  }
}
