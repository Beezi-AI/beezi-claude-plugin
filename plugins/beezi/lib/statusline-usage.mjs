import { readJson, writeJsonSecure } from './fs-store.mjs';
import { statuslineUsageFile } from './paths.mjs';
import { readClaudeAccount as _readClaudeAccount } from './claude-account.mjs';

// Claude Code hands the status-line command its LIVE rate-limit state on stdin (2.1.80+):
//
//   "rate_limits": { "five_hour": { "used_percentage": 23.5, "resets_at": 1738425600 }, ... }
//
// This is strictly better than the `cachedUsageUtilization` blob in ~/.claude.json, which is a
// cache Claude Code refreshes on its own schedule and was measured two days stale. Nothing is
// fetched here and no token is touched — Claude Code already made the request and is handing us
// the answer, so the capture never leaves the user's machine until the normal reporting path
// posts it.
//
// The status line renders constantly, so this module NEVER does network or spawns anything. It
// records to a small local file; the existing hook path drains it.

// Percentage-point move that is worth another row. Utilization creeps up with every request, so
// recording each render would be thousands of rows a day describing one slow climb.
const MATERIAL_DELTA_PCT = 5;
// Even an unchanged reading earns a row this often. With only the delta gate, a slow climb
// leaves multi-hour gaps that read as "not tracking"; the floor bounds the gap at 15 minutes.
// Renders only happen while Claude Code is active, so a floor row is always a live observation.
const RECORD_FLOOR_MS = 15 * 60 * 1000;
// Hard ceiling on unposted rows, so a machine that never reaches the drain path cannot grow the
// file without bound. Oldest are dropped: the newest observations are the ones still actionable.
const MAX_PENDING = 40;

function readWindow(node) {
  if (!node || typeof node !== 'object') return null;
  const pct = typeof node.used_percentage === 'number' ? node.used_percentage : null;
  // Unix epoch SECONDS here, unlike the ISO strings the ~/.claude.json cache carries.
  const resetsAt = typeof node.resets_at === 'number' ? node.resets_at : null;
  if (pct === null && resetsAt === null) return null;
  return { pct, resetsAt };
}

// A row earns its place when the window rolled over, when utilization climbed materially, or when
// it hit the ceiling — the exact transitions the plan-fit check reasons about.
function isMaterial(next, last) {
  if (!next) return false;
  if (!last) return true;
  if (next.resetsAt !== last.resetsAt) return true;
  if (next.pct === null) return false;
  if (next.pct >= 100 && (last.pct == null ? 0 : last.pct) < 100) return true;
  return Math.abs(next.pct - (last.pct == null ? 0 : last.pct)) >= MATERIAL_DELTA_PCT;
}

// WHOSE limits a row measured, captured when it is recorded. Rows wait here until a hook drains
// them — possibly after the user switched accounts, or switched between subscriptions of one login
// (same uuid and email, different organization) — and the drain stamping the identity in force THEN
// put one subscription's limits on the other. ~/.claude.json's oauthAccount is the login the
// running Claude Code uses (CLAUDE_CONFIG_DIR included, which the status-line command inherits).
//
// Stored under its own key, never as wire fields: the drain maps it explicitly, and only when no
// setup token is in force — a row carrying `account_uuid` would be spread straight onto the wire,
// past the suppression, and any unknown key would be refused by the API's whitelist.
function recordedAccount(readAccount) {
  let account = null;
  try { account = readAccount(); } catch { account = null; }
  if (account == null) return null;
  const out = {
    uuid: account.accountUuid == null ? null : account.accountUuid,
    email: account.email == null ? null : account.email,
    organizationUuid: account.organizationUuid == null ? null : account.organizationUuid,
    organizationName: account.organizationName == null ? null : account.organizationName,
  };
  if (out.uuid == null && out.email == null && out.organizationUuid == null) return null;
  return out;
}

const epochToIso = (seconds) =>
  typeof seconds === 'number' ? new Date(seconds * 1000).toISOString() : null;

// Returns { recorded } — recorded is true when this render produced a new pending row.
export function recordStatuslineUsage(payload, deps = {}) {
  const now = deps.now == null ? () => new Date() : deps.now;
  const readAccount = deps.readClaudeAccount == null ? _readClaudeAccount : deps.readClaudeAccount;
  const limits = payload == null ? undefined : payload.rate_limits;
  const fiveHour = readWindow(limits == null ? undefined : limits.five_hour);
  const sevenDay = readWindow(limits == null ? undefined : limits.seven_day);
  if (!fiveHour && !sevenDay) return { recorded: false, reason: 'no-rate-limits' };

  const file = statuslineUsageFile();
  let state = readJson(file);
  if (state == null) state = {};
  if (!isMaterial(fiveHour, state.lastFiveHour) && !isMaterial(sevenDay, state.lastSevenDay)) {
    const lastRecordedMs = Date.parse(state.lastRecordedAt == null ? '' : state.lastRecordedAt) || 0;
    if (now().getTime() - lastRecordedMs < RECORD_FLOOR_MS) {
      return { recorded: false, reason: 'immaterial' };
    }
  }

  // fetched_at is genuinely "now": unlike the cache, the status line reports what Claude Code
  // holds at render time, so the observation is current by construction.
  const pending = Array.isArray(state.pending) ? state.pending : [];
  const row = {
    fetched_at: now().toISOString(),
    five_hour_pct: fiveHour == null || fiveHour.pct == null ? null : fiveHour.pct,
    five_hour_resets_at: epochToIso(fiveHour == null || fiveHour.resetsAt == null ? null : fiveHour.resetsAt),
    seven_day_pct: sevenDay == null || sevenDay.pct == null ? null : sevenDay.pct,
    seven_day_resets_at: epochToIso(sevenDay == null || sevenDay.resetsAt == null ? null : sevenDay.resetsAt),
  };
  // Read only here, past the materiality gate: the status line renders constantly and
  // ~/.claude.json is not small, so an immaterial render never opens it.
  const account = recordedAccount(readAccount);
  if (account != null) row.account = account;
  pending.push(row);

  writeJsonSecure(file, {
    version: 1,
    lastFiveHour: fiveHour == null ? (state.lastFiveHour == null ? null : state.lastFiveHour) : fiveHour,
    lastSevenDay: sevenDay == null ? (state.lastSevenDay == null ? null : state.lastSevenDay) : sevenDay,
    lastRecordedAt: now().toISOString(),
    pending: pending.slice(-MAX_PENDING),
  });
  return { recorded: true };
}

export function readPendingStatuslineUsage() {
  let state = readJson(statuslineUsageFile());
  if (state == null) state = {};
  return Array.isArray(state.pending) ? state.pending : [];
}

// Drops the rows that were confirmed stored, leaving anything the status line appended in the
// meantime untouched — the drain and the recorder run in different processes.
export function clearPendingStatuslineUsage(count) {
  const file = statuslineUsageFile();
  let state = readJson(file);
  if (state == null) state = {};
  const pending = Array.isArray(state.pending) ? state.pending : [];
  writeJsonSecure(file, { ...state, version: 1, pending: pending.slice(count) });
}
