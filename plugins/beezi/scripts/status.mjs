import { getDefaultKey, listAccounts } from '../lib/accounts.mjs';
import { accountHealth } from '../lib/me.mjs';
import { currentSessionWorkspace, roleLabel, tenantsOf } from '../lib/workspace.mjs';
import { createRouteContext } from '../lib/workspace-rules.mjs';
import { placeOfDir, routeOfDir, routeText } from '../lib/route-describe.mjs';
import { claudePlan, crashMode } from '../lib/machine-settings.mjs';
import { statuslineInstalled } from '../lib/statusline-install.mjs';
import { badgeEnabled } from '../lib/statusline-badge.mjs';
import { liveOffNote } from '../lib/session-banner.mjs';
import { readTrackingState } from '../lib/tracking.mjs';
import { aboutPlugin } from '../lib/about.mjs';
import { updateCommands } from '../lib/update-check.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';
import { isEntryScript } from '../lib/entry-script.mjs';

// /beezi:status — one read-only screen: sign-in, workspaces, where this folder goes, plan, machine, plugin version
// and how to update it.

const LABEL_WIDTH = 14;
const PLACE_LABELS = { repo: 'This repo', folder: 'This folder', outside: 'Here' };

function field(label, value) {
  return `  ${label.padEnd(LABEL_WIDTH)}${value}`;
}

function currentDir() {
  try {
    const state = currentSessionWorkspace();
    if (state != null && state.cwd != null) return state.cwd;
  } catch { /* no session state: this process's folder */ }
  return process.cwd();
}

// Everything the screen shows, loaded once: health checks and the update check run side by side.
export async function loadStatus(deps = {}) {
  const health = deps.accountHealth == null ? accountHealth : deps.accountHealth;
  const about = deps.aboutPlugin == null ? aboutPlugin : deps.aboutPlugin;
  const accounts = await listAccounts();
  const checks = {};
  const [plugin] = await Promise.all([
    about().catch(() => null),
    ...accounts.map(async (a) => {
      try {
        checks[a.key] = await health(a);
      } catch (error) {
        checks[a.key] = { ok: false, lines: [friendlyMessage(error)] };
      }
    }),
  ]);
  // Health checks refresh each account's workspaces, so the index is read again after.
  const rows = accounts.length > 0 ? await listAccounts() : accounts;
  const tracking = {};
  rows.forEach((row) => { tracking[row.key] = readTrackingState(row.key); });
  return {
    rows,
    health: checks,
    tracking,
    def: await getDefaultKey(),
    dir: deps.dir == null ? currentDir() : deps.dir,
    ctx: createRouteContext(),
    plugin,
    machine: { statusline: statuslineInstalled(), badge: badgeEnabled(), crash: crashMode(), plan: claudePlan() },
  };
}

function accountLine(row, check, tag) {
  const who = `${row.email || row.name || 'linked account'}${tag}`;
  if (check == null || check.ok) return `✓ ${who}, signed in`;
  const text = (check.lines || []).map((l) => l.trim()).filter((l) => l).join(' ').replace(/^Beezi: /, '');
  return `⚠ ${who}: ${text || 'could not check the sign-in'}`;
}

function workspaceField(row) {
  const tenants = tenantsOf(row) || [];
  if (tenants.length === 0) return field('Workspace', 'not known yet — start a new session');
  const names = tenants.map((t) => {
    const role = roleLabel(t);
    return `${t.name || t.id}${role ? ` (${role})` : ''}`;
  });
  return field(tenants.length > 1 ? 'Workspaces' : 'Workspace', names.join(', '));
}

// "labacus-suite → Acme (default)" under its place's label, with the banner's note when nothing goes live; null when the place or the workspaces are unknown.
function placeField(row, dir, ctx, tracking) {
  let place = null;
  let route = null;
  try {
    place = placeOfDir(dir, ctx);
    if (place != null) route = routeOfDir(row, dir, ctx);
  } catch {
    return null;
  }
  if (place == null || route == null || route.reason.kind === 'unknown') return null;
  const where = place.kind === 'outside' ? 'sessions outside a project' : place.short;
  const off = liveOffNote(row, tracking, route);
  return field(PLACE_LABELS[place.kind] || 'Here', `${where} ${routeText(row, route)}${off == null ? '' : `, but ${off}`}`);
}

// `YYYY-MM-DD HH:MM UTC` — fixed, so the output reads the same on every machine and locale.
function formatTime(iso) {
  const ms = Date.parse(typeof iso === 'string' ? iso : '');
  if (Number.isNaN(ms)) return null;
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function pluginText(info) {
  if (info == null || info.local == null) return 'unknown (could not read its version)';
  const version = info.local.version;
  const latest = info.latest;
  if (info.status === 'update' && latest != null) {
    const seen = latest.stale ? ` (could not check now; last seen ${formatTime(latest.checkedAt) || 'earlier'})` : '';
    return `${version}. Update available: ${latest.version}${seen}`;
  }
  if (latest == null || latest.stale) return `${version} (could not check for updates)`;
  if (info.status === 'current') return `${version}, the newest`;
  if (info.status === 'ahead') return `${version}, newer than the published ${latest.version}`;
  return `${version} (could not compare it with the published ${latest.version})`;
}

function updatedText(install) {
  if (install == null) return 'unknown — loaded from a local folder, not a marketplace';
  const updated = formatTime(install.lastUpdated);
  const installed = formatTime(install.installedAt);
  if (updated == null) return installed == null ? 'unknown' : `unknown (first installed ${installed})`;
  return installed == null ? updated : `${updated} (first installed ${installed})`;
}

// The Plugin line, then when this machine last updated it and from which marketplace.
export function pluginLines(info) {
  const lines = [field('Plugin', pluginText(info))];
  if (info == null || info.local == null) return lines;
  lines.push(field('Updated here', updatedText(info.install)));
  if (info.marketplace) {
    const flag = info.autoUpdate === true ? ' (auto-update on)' : (info.autoUpdate === false ? ' (auto-update off)' : '');
    lines.push(field('Marketplace', `${info.marketplace}${flag}`));
  }
  return lines;
}

// How to update, only when a newer version is out: the same /plugin and terminal steps as the SessionStart notice.
export function updateSteps(info) {
  if (info == null || info.local == null || info.status !== 'update' || info.latest == null) return [];
  const where = info.marketplace ? ` from the ${info.marketplace} marketplace` : '';
  const lines = [`To update to ${info.latest.version}:`, `  - In Claude Code: run /plugin and update ${info.local.name}${where}.`];
  const commands = updateCommands(info.local.name, info.marketplace);
  if (commands != null) lines.push('  - Or from a terminal:', `      ${commands[0]}`, `      ${commands[1]}`);
  lines.push('  Then restart Claude Code to apply it.');
  if (info.autoUpdate === true) {
    lines.push('  Auto-update is on for this marketplace, so Claude Code also installs it on its own at startup.');
  }
  return lines;
}

function machineLines(view) {
  const m = view.machine;
  const statusline = !m.statusline ? 'off' : (m.badge ? 'on with the Beezi badge' : 'on');
  return [
    field('Claude plan', m.plan),
    field('This machine', `status line ${statusline}, crash reports ${m.crash === 'off' ? 'off' : 'on'}`),
    ...pluginLines(view.plugin),
  ];
}

export function formatStatus(view) {
  const out = ['Beezi'];
  const several = view.rows.length > 1;
  if (view.rows.length === 0) out.push(field('Account', 'not linked — run /beezi:login'));
  view.rows.forEach((row, i) => {
    if (i > 0) out.push('');
    out.push(field('Account', accountLine(row, view.health[row.key], several && row.key === view.def ? ' (default)' : '')));
    out.push(workspaceField(row));
    const here = placeField(row, view.dir, view.ctx, view.tracking == null ? null : view.tracking[row.key]);
    if (here != null) out.push(here);
  });
  if (several) out.push('');
  out.push(...machineLines(view), '');
  const steps = updateSteps(view.plugin);
  if (steps.length > 0) out.push(...steps, '');
  out.push('Change settings with /beezi:settings');
  return `${out.join('\n')}\n`;
}

async function main() {
  process.stdout.write(formatStatus(await loadStatus()));
}

// Tests import the formatters, so main runs only when this file is the entry script.
if (isEntryScript(import.meta.url)) {
  main().catch((error) => {
    console.error(`✗ ${friendlyMessage(error)}`);
    process.exit(1);
  });
}
