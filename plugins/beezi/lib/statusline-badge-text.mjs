import { readJson } from './fs-store.mjs';
import { accountsIndexFile } from './paths.mjs';
import { isMultiTenant, joinTenantNames, readSessionWorkspace, tenantsOf } from './workspace.mjs';
import { routeOfSession, routeTarget } from './route-describe.mjs';
import { readAuthState } from './auth-markers.mjs';
import { AUTH_STATES } from './auth-state.mjs';
import { TrackingMode, isTenantDark, readTrackingState } from './tracking.mjs';

// The auth states a hook last recorded that only a new sign-in clears.
const SIGN_IN_STATES = [AUTH_STATES.REAUTH_REQUIRED, AUTH_STATES.UNLINKED];

// The index read straight from disk: accounts.mjs's readIndex may migrate (credential store spawns).
function linkedAccounts() {
  const raw = readJson(accountsIndexFile(), null);
  if (raw == null || raw.version !== 1 || !Array.isArray(raw.accounts)) return [];
  return raw.accounts.filter((a) => a != null && typeof a.key === 'string' && /^[0-9a-f]{8}$/.test(a.key));
}

function needsSignIn(row) {
  if (row.status === 'revoked') return true;
  const state = readAuthState(row.key);
  return SIGN_IN_STATES.indexOf(state.lastState) !== -1;
}

// An untracked account's name: its one workspace, else its email.
function accountName(row) {
  const tenants = tenantsOf(row) || [];
  if (tenants.length === 1 && tenants[0].name) return tenants[0].name;
  return row.email || row.name || 'an account';
}

// One account's parts: { kind: 'tracked'|'untracked'|'off'|'pending', text, alone? }; [] when its workspaces are unknown.
// `alone` is the whole badge when this is the only part: audit mode or analytics off.
function accountParts(row, state) {
  const route = routeOfSession(row, state);
  if (route.reason.kind === 'unknown') return [];
  if (route.reason.kind === 'pending') return [{ kind: 'pending', text: `? ${accountName(row)}` }];
  if (route.ids.length === 0) return [{ kind: 'untracked', text: `✗ ${accountName(row)}` }];
  const tracking = readTrackingState(row.key);
  if (!isMultiTenant(row)) {
    const mode = tracking == null ? null : tracking.trackingMode;
    if (mode === TrackingMode.BACKFILL_ONLY) return [{ kind: 'off', text: `✗ ${accountName(row)}`, alone: '✗ not tracked (audit mode)' }];
    if (mode === TrackingMode.DISABLED) return [{ kind: 'off', text: `✗ ${accountName(row)}`, alone: '✗ analytics off' }];
    return [{ kind: 'tracked', text: routeTarget(row, route) }];
  }
  // A target that answered TRACKING_DISABLED sends nothing live.
  const live = route.ids.filter((id) => !isTenantDark(tracking, id));
  const dark = route.ids.filter((id) => isTenantDark(tracking, id));
  const darkPart = { kind: 'off', text: `✗ ${joinTenantNames(row, dark)}`, alone: '✗ analytics off' };
  if (live.length === 0) return [darkPart];
  const tracked = { kind: 'tracked', text: joinTenantNames(row, live) };
  return dark.length === 0 ? [tracked] : [tracked, darkPart];
}

// The badge for this render from small local reads only (no git, no network, no spawn); null for no badge.
export function badgeText(payload) {
  try {
    const rows = linkedAccounts();
    if (rows.length === 0) return null;
    if (rows.some(needsSignIn)) return 'Beezi ⚠ sign in: /beezi:login';
    const sessionId = payload == null ? null : payload.session_id;
    const state = readSessionWorkspace(sessionId);
    const parts = [].concat(...rows.map((row) => accountParts(row, state)));
    if (parts.length === 0) return null;
    const tracked = [];
    parts.filter((p) => p.kind === 'tracked').forEach((p) => { if (tracked.indexOf(p.text) === -1) tracked.push(p.text); });
    const others = parts.filter((p) => p.kind !== 'tracked').map((p) => p.text);
    if (tracked.length > 0) return `Beezi → ${tracked.concat(others).join(', ')}`;
    if (parts.length === 1 && parts[0].alone != null) return `Beezi ${parts[0].alone}`;
    if (parts.every((p) => p.kind === 'untracked' || p.kind === 'off')) return 'Beezi ✗ not tracked';
    if (parts.every((p) => p.kind === 'pending')) return 'Beezi ? no rule yet';
    return `Beezi ${others.join(', ')}`;
  } catch {
    return null;
  }
}

// ` · <badge>` after the last non-empty line, trailing whitespace kept; the badge alone for empty output.
export function appendBadge(text, badge) {
  const out = typeof text === 'string' ? text : '';
  if (!badge) return out;
  const body = out.replace(/\s+$/, '');
  if (body === '') return badge;
  return `${body} · ${badge}${out.slice(body.length)}`;
}
