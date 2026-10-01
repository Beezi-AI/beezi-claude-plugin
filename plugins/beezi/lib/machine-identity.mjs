import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { readJson } from './fs-store.mjs';

const PLUGIN_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let cachedVersion;

// The INSTALLED version, from .claude-plugin/plugin.json — the file make-variant.sh rewrites, so a
// dev build reports 0.17.0-dev.4938 rather than package.json's base 0.17.0. Read once per process:
// machineHeaders() runs on every authenticated request.
function pluginVersion() {
  if (cachedVersion !== undefined) return cachedVersion;
  const manifest = readJson(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), null);
  const version = manifest == null || typeof manifest.version !== 'string' ? null : manifest.version;
  cachedVersion = version ? version.slice(0, 255) : null;
  return cachedVersion;
}

// Identifying headers for the portal's linked-machines view (display/bookkeeping
// only — auth stays the bearer token). X-Beezi-Agent picks the tool axis for the
// backfill scope and analytics source — the server defaults an absent header to
// claude-code, but explicit beats implicit. X-Beezi-Plugin-Version is stored on the
// machine row; absent when the manifest cannot be read.
export function machineHeaders(clientId) {
  const headers = {
    'X-Beezi-Agent': 'claude-code',
    'X-Beezi-Host': String(os.hostname()).slice(0, 255),
  };
  if (clientId) headers['X-Beezi-Client'] = clientId;
  const version = pluginVersion();
  if (version) headers['X-Beezi-Plugin-Version'] = version;
  return headers;
}
