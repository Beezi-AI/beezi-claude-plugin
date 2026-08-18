import os from 'os';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

// Baked environment identity: scripts/make-variant.sh writes env.json into dev/staging variants;
// the prod plugin ships { "name": "" }. Missing or unreadable reads as prod.
function readEnvJson() {
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'env.json');
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}
const ENV_JSON = readEnvJson();

// Namespace for every machine-local artifact: state dir and OS credential entry alike.
// BEEZI_ENV overrides for local development; otherwise the identity is baked into the variant,
// so simultaneously installed variants never share tokens, queue or state. This is the only
// switch: nothing keyed off it may be namespaced independently.
export const BEEZI_ENV =
  process.env.BEEZI_ENV == null
    ? (typeof ENV_JSON.name === 'string' ? ENV_JSON.name : '')
    : process.env.BEEZI_ENV;

// This variant's default API base; config.mjs owns the resolution order.
export const ENV_API_BASE = typeof ENV_JSON.apiBase === 'string' ? ENV_JSON.apiBase : null;

// '-dev' when namespaced, '' on prod.
export function envSuffix() {
  return BEEZI_ENV ? `-${BEEZI_ENV}` : '';
}

export function beeziHome() {
  return process.env.BEEZI_HOME == null
    ? path.join(os.homedir(), `.beezi${envSuffix()}`)
    : process.env.BEEZI_HOME;
}

export function queueDir() {
  return path.join(beeziHome(), 'queue');
}

export function stateDir() {
  return path.join(beeziHome(), 'state');
}

// Persisted known-repo-root map (dir→root resolution cache/seed). One JSON for the machine.
export function repoMapFile() {
  return path.join(beeziHome(), 'repo-map.json');
}

// Durable "already imported" ledger for /beezi:import. Deliberately at the beeziHome() ROOT and
// not under state/ or queue/: pruneStale() deletes 14-day-old files in both of those, so a marker
// living there would expire and make every old session look importable again on the next run.
export function auditLedgerFile() {
  return path.join(beeziHome(), 'audit-ledger.json');
}

// Cached tenant tracking state (whoami's trackingMode/tier/backfillCompleted). Root-level for
// the same pruneStale() reason as the audit ledger — an expiring gate would silently re-enable
// tracking for dark-mode tenants.
export function trackingStateFile() {
  return path.join(beeziHome(), 'tracking.json');
}

export function credentialsFile() {
  return path.join(beeziHome(), 'credentials.json');
}

export function billingConfigFile() {
  return path.join(beeziHome(), 'billing.json');
}

// Last-sent usage-snapshot marker: { version, lastSent: { accountUuid, fetchedAtMs } }.
export function usageSnapshotStateFile() {
  return path.join(beeziHome(), 'usage-snapshot.json');
}

// Rate-limit observations captured by the status line, awaiting the next drain. Separate from
// usage-snapshot.json because the status line writes it on render and must never contend with
// the reporting path's own markers.
export function statuslineUsageFile() {
  return path.join(beeziHome(), 'statusline-usage.json');
}

// Claude Code's config root — `~/.claude`, relocatable via CLAUDE_CONFIG_DIR. Single source
// for the dirs the plugin reads out of Claude Code (transcripts, live session store).
export function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function claudeProjectsDir() {
  return path.join(claudeHome(), 'projects');
}

export function claudeSessionsDir() {
  return path.join(claudeHome(), 'sessions');
}
