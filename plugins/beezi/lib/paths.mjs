import crypto from 'crypto';
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

// Where this variant's PUBLISHED marketplace manifest lives, so the plugin can tell whether a
// newer build of itself exists. prod ships the public raw URL; make-variant.sh writes the internal
// one into dev/staging. config.mjs owns the resolution order.
export const ENV_UPDATE_MANIFEST_URL =
  typeof ENV_JSON.updateManifestUrl === 'string' ? ENV_JSON.updateManifestUrl : null;

// '-dev' when namespaced, '' on prod.
export function envSuffix() {
  return BEEZI_ENV ? `-${BEEZI_ENV}` : '';
}

export function beeziHome() {
  return process.env.BEEZI_HOME == null
    ? path.join(os.homedir(), `.beezi${envSuffix()}`)
    : process.env.BEEZI_HOME;
}

// '' for the default home, so existing installs keep their names; '-h<8 hex>' of the resolved
// custom BEEZI_HOME so its credential store, OS-store entries and lock form one namespace that no
// other home can reach. An explicit BEEZI_HOME equal to the default is still the default.
export function homeSuffix() {
  if (process.env.BEEZI_HOME == null) return '';
  const resolved = path.resolve(process.env.BEEZI_HOME);
  if (resolved === path.resolve(os.homedir(), `.beezi${envSuffix()}`)) return '';
  return `-h${crypto.createHash('sha256').update(resolved).digest('hex').slice(0, 8)}`;
}

// OS-store service holding the generation entries ('beezi-credentials-dev-h1a2b3c4d' on a dev
// variant with a custom home). Distinct from the legacy service on every platform: the
// pre-generation plugin's delete keys on that name alone and must not reach the new entries.
export function credentialService() {
  return `beezi-credentials${envSuffix()}${homeSuffix()}`;
}

// The OS-store service the pre-generation plugin wrote, read for migration only.
export function legacyCredentialService() {
  return `beezi-analytics${envSuffix()}`;
}

// Generation store: control.json names the committed generation; gen-<n>.json holds a
// file-backed generation. Root-level like credentials.json — pruneStale() sweeps state/ and queue/.
export function credentialStoreDir() {
  return path.join(beeziHome(), 'credentials');
}

export function credentialControlFile() {
  return path.join(credentialStoreDir(), 'control.json');
}

export function credentialGenerationFile(generation) {
  return path.join(credentialStoreDir(), `gen-${generation}.json`);
}

// The namespace-wide credential lock shared by refresh, login's final commit and logout. Not
// token-refresh.lock: a pre-generation process still running breaks that one by age.
export function credentialLockDir() {
  return path.join(beeziHome(), 'credentials.lock');
}

// Written by the refresh worker under the credential lock, just before it submits a grant, and
// cleared when the attempt settles. A marker left behind by a dead worker is the only evidence
// that a rotating refresh token may have been consumed without its replacement being stored.
export function refreshInflightFile() {
  return path.join(credentialStoreDir(), 'refresh.inflight.json');
}

// Everything the accessor needs to answer without touching a backend: the last non-ready
// reason, the retry backoff for the current generation, and the reauth marker naming the ONE
// generation the provider rejected. Never holds a token.
export function authStateFile() {
  return path.join(credentialStoreDir(), 'auth-state.json');
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

// Last-sent account check-in marker: { version, lastSyncedHash, lastSyncedAt }. Root-level for
// the same pruneStale() reason as the audit ledger and the tracking cache — an expiring marker
// would re-POST the same unchanged account payload on every session start.
// The portal's last answer about this machine's setup token. Root of beeziHome() beside
// billing.json, not under state/: pruneStale() sweeps state/ and queue/, and an expiring answer
// would re-nag a user who already fixed their plan.
export function oauthKeyStatusFile() {
  return path.join(beeziHome(), 'oauth-key-status.json');
}

// Which key fingerprints have already been told that they bill a subscription some earlier sign-in
// established: { version, notified: [ "<prefix>...<last4>:<length>", ... ] }. Root-level for the
// same pruneStale() reason as the others — an expiring marker would re-deliver a notice the user
// has already read and cannot act on from here.
export function keyNoticeFile() {
  return path.join(beeziHome(), 'key-notice.json');
}

// The last reading of the published marketplace manifest: { version, checkedAt, pluginName,
// latestVersion, marketplaceName } — FACTS about the remote, never a verdict. Root-level for the
// same pruneStale() reason as the tracking cache: an expiring reading would re-fetch GitHub on
// every single session start.
export function updateCheckFile() {
  return path.join(beeziHome(), 'update-check.json');
}

// The hourly gate for the background cost-state backfill: { version, attemptedAt, lastScanAt }.
// Root of beeziHome(), NOT state/ — pruneStale() clears that directory after 14 days, and an
// expiring gate would re-run the whole scan on the next Stop hook after a quiet fortnight.
export function costStateSyncFile() {
  return path.join(beeziHome(), 'cost-state-sync.json');
}

export function accountSyncStateFile() {
  return path.join(beeziHome(), 'account-sync.json');
}

// The pre-generation credential file. Read for migration, and still probed as a "linked" hint by
// cost-state-trigger and session-audit; new generations never land here.
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

// Pending diagnostic events awaiting the next drain. Under beeziHome() so a variant never
// mixes its telemetry with another's, and so pruneStale's window applies.
export function telemetryDir() {
  return path.join(beeziHome(), 'telemetry');
}

// Per-machine consent record. Root-level, like the tracking cache: an expiring consent
// record would silently re-ask (or worse, re-enable) after 14 days.
export function telemetryConsentFile() {
  return path.join(beeziHome(), 'telemetry.json');
}

// When the diagnostics worker may next attempt delivery: { version, attempts, nextAttemptAt }.
// Root-level like the consent record — an expiring backoff would turn a rate-limited machine
// into a machine that retries every minute forever.
export function telemetrySendStateFile() {
  return path.join(beeziHome(), 'telemetry-send.json');
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
