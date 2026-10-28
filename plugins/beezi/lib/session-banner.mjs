import { isMultiTenant, joinTenantNames, tenantsOf } from './workspace.mjs';
import { routeOfSession, routeText } from './route-describe.mjs';
import { TrackingMode, isTenantDark } from './tracking.mjs';

const RULES = '/beezi:settings rules';

// How the banner names an account: its email, else its name, else its key.
export function accountLabel(row) {
  return row.email || row.name || row.key;
}

// "workspace Acme", "workspaces Acme and Northwind", "workspaces Acme, Northwind and 3 more"; null when unknown.
export function workspacesText(row) {
  const tenants = tenantsOf(row);
  if (tenants == null || tenants.length === 0) return row.tenantName ? `workspace ${row.tenantName}` : null;
  const ids = tenants.map((t) => t.id);
  if (ids.length === 1) return `workspace ${joinTenantNames(row, ids)}`;
  if (ids.length <= 3) return `workspaces ${joinTenantNames(row, ids)}`;
  const [first, second] = ids.map((id) => joinTenantNames(row, [id]));
  return `workspaces ${first}, ${second} and ${ids.length - 2} more`;
}

// Why a tracked route still sends nothing live: a one-workspace account's audit or off mode, or a multi-workspace target that answered TRACKING_DISABLED.
export function liveOffNote(row, tracking, route) {
  if (route.ids.length === 0) return null;
  if (isMultiTenant(row)) {
    const dark = route.ids.filter((id) => isTenantDark(tracking, id));
    return dark.length === 0 ? null : `analytics are off in ${joinTenantNames(row, dark)}`;
  }
  const mode = tracking == null ? null : tracking.trackingMode;
  if (mode === TrackingMode.BACKFILL_ONLY) return 'new sessions are not tracked (audit mode)';
  if (mode === TrackingMode.DISABLED) return 'analytics are off for this workspace';
  return null;
}

function placeName(place) {
  return place.kind === 'outside' ? 'Sessions outside a project' : place.short;
}

// The note ends the line with a period in both banner forms.
function routeWithNote(row, route, tracking) {
  const off = liveOffNote(row, tracking, route);
  return off == null ? routeText(row, route) : `${routeText(row, route)}, but ${off}.`;
}

function oneAccount(row, { state, place, trackingByKey, asking, unconnected }) {
  const workspaces = workspacesText(row);
  const lines = [`Beezi ✓ ${accountLabel(row)}${workspaces == null ? '' : `, ${workspaces}`}`];
  let last = `Change with ${RULES}`;
  if (place != null) {
    const route = routeOfSession(row, state, place);
    const where = placeName(place);
    if (unconnected.has(row.key)) {
      lines.push(`  ${where} isn't connected to a Beezi project, so nothing is tracked here.`);
    } else if (route.reason.kind === 'pending') {
      lines.push(`  ${where} ${place.kind === 'outside' ? 'have' : 'has'} no rule yet. Nothing is sent until you choose where it goes.`);
      last = asking ? 'Beezi asks you now.' : `Choose with ${RULES}`;
    } else if (route.reason.kind !== 'unknown' && route.ids.length === 0) {
      lines.push(`  ${where} ${routeText(row, route)}. Nothing from this session is sent.`);
      // "again" only undoes a rule; New folders set to Don't send was never tracked here.
      last = route.reason.kind === 'rule' ? `Track it again with ${RULES}` : `Track it with ${RULES}`;
    } else if (route.reason.kind !== 'unknown') {
      lines.push(`  ${where} ${routeWithNote(row, route, trackingByKey.get(row.key))}`);
    }
  }
  lines.push(`  ${last}`);
  return lines.join('\n');
}

function severalAccounts(rows, { state, place, trackingByKey, asking, unconnected }) {
  const labels = rows.map(accountLabel);
  const lines = [];
  let last = `Change with ${RULES}`;
  if (place == null) {
    lines.push(`Beezi ✓ ${rows.length} accounts: ${labels.length < 2 ? labels.join('') : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`}`);
  } else {
    lines.push(`Beezi ✓ ${rows.length} accounts. ${place.kind === 'outside' ? 'Outside a project' : `In ${place.short}`}:`);
    const width = Math.max(...labels.map((l) => l.length));
    let pending = false;
    rows.forEach((row, i) => {
      const route = routeOfSession(row, state, place);
      if (unconnected.has(row.key)) {
        lines.push(`  ${labels[i].padEnd(width)}  → not tracked (this repo isn't connected to a Beezi project)`);
        return;
      }
      if (route.reason.kind === 'pending') pending = true;
      lines.push(`  ${labels[i].padEnd(width)}  ${routeWithNote(row, route, trackingByKey.get(row.key))}`);
    });
    if (pending) last = asking ? 'Beezi asks you now.' : `Choose with ${RULES}`;
  }
  lines.push(`  ${last}`);
  return lines.join('\n');
}

// The session-start banner for the signed-in accounts, or null when none is signed in.
// `place` is placeOfDir(cwd) (null: unknown cwd),
// `asking` whether this start asks about a place with no rule, `unconnected` the keys of accounts whose platform workspace has this repo unconnected.
export function buildBanner({ sessions, state = null, place = null, trackingByKey = new Map(), asking = false, unconnected = new Set() }) {
  if (!Array.isArray(sessions) || sessions.length === 0) return null;
  const opts = { state, place, trackingByKey, asking, unconnected };
  return sessions.length === 1 ? oneAccount(sessions[0], opts) : severalAccounts(sessions, opts);
}
