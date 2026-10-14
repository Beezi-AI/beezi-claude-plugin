import { getDefaultKey, listAccounts } from '../lib/accounts.mjs';
import { accountHealth } from '../lib/me.mjs';
import { currentSessionWorkspace, isMultiTenant, isSingleTenant, newFoldersOf, roleLabel, tenantById, tenantsOf } from '../lib/workspace.mjs';
import { createRouteContext, routeForDir, routeKeyForDir, rulesOf, rulesTableLines, shortLabel } from '../lib/workspace-rules.mjs';
import { readBillingConfig } from '../lib/billing-config.mjs';
import { BillingSource } from '../lib/billing.mjs';
import { isLiveTrackingAllowed, readTrackingState } from '../lib/tracking.mjs';
import { isCorrelationGranted, isTelemetryGranted, readConsent } from '../lib/telemetry-consent.mjs';
import { statuslineInstalled } from '../lib/statusline-install.mjs';
import { UserError, friendlyMessage } from '../lib/friendly-error.mjs';

const LABEL_WIDTH = 16;

function field(label, value) {
  return `  ${label.padEnd(LABEL_WIDTH)}${value}`;
}

function names(row, ids) {
  return ids.map((id) => {
    const t = tenantById(row, id);
    return t != null && t.name ? t.name : id;
  }).join(', ');
}

function newFoldersLabel(row) {
  const newFolders = newFoldersOf(row);
  if (newFolders.mode === 'send') return `Send to ${names(row, newFolders.tenantIds)}`;
  return newFolders.mode === 'none' ? 'Don\'t send' : 'Ask me';
}

// Where this folder's analytics go: its rule, else New folders.
function thisFolder(row, dir, ctx) {
  const key = routeKeyForDir(dir, ctx);
  if (key == null) return null;
  const place = shortLabel(key);
  const route = routeForDir(row, dir, ctx);
  if (route != null) return `${place} → ${route.tenantIds.length === 0 ? 'not tracked' : names(row, route.tenantIds)}`;
  const newFolders = newFoldersOf(row);
  if (newFolders.mode === 'send') return `${place} → ${names(row, newFolders.tenantIds)} (new folder default)`;
  if (newFolders.mode === 'none') return `${place} → not uploaded (new folders: don't send)`;
  return `${place} → no rule yet (asks at the next session start)`;
}

function rulesCount(n) {
  if (n === 0) return 'none yet';
  return n === 1 ? '1 repo/folder' : `${n} repos/folders`;
}

// This folder's status for a one-workspace account: not tracked (with its rule) or tracked.
// Skipped entirely when live tracking is off (audit mode or disabled): "→ tracked" would be wrong there.
function thisFolderSingle(row, dir, ctx) {
  if (!isLiveTrackingAllowed(readTrackingState(row.key))) return null;
  const key = routeKeyForDir(dir, ctx);
  if (key == null) return null;
  const place = shortLabel(key);
  const route = routeForDir(row, dir, ctx);
  if (route != null && route.tenantIds.length === 0) return `${place} → not tracked (R${route.index})`;
  return `${place} → tracked`;
}

// correlate, on (correlation never answered), anonymous (correlation declined) or off.
function crashMode() {
  if (!isTelemetryGranted()) return 'off';
  if (isCorrelationGranted()) return 'correlate';
  const consent = readConsent();
  return consent != null && consent.correlation === 'denied' ? 'anonymous' : 'on';
}

// accountHealth's lines folded into one: "Beezi: " dropped, sentences joined.
function signInField(lines) {
  const text = lines.map((l) => l.trim()).join(' ').replace(/^Beezi: /, '');
  return field('Sign-in', text.charAt(0).toUpperCase() + text.slice(1));
}

async function screen() {
  const machine = [
    field('Crash reports', crashMode() === 'off' ? 'Off' : 'On'),
    field('Status line', statuslineInstalled() ? 'On' : 'Off'),
  ];
  const accounts = await listAccounts();
  if (accounts.length === 0) {
    console.log(['Beezi · not linked — run /beezi:login'].concat(machine).join('\n'));
    return;
  }
  // Health checks refresh each account's workspaces, so the index is read again after.
  const health = {};
  await Promise.all(accounts.map(async (a) => {
    try {
      health[a.key] = await accountHealth(a);
    } catch (error) {
      health[a.key] = { ok: false, lines: [friendlyMessage(error)] };
    }
  }));
  const rows = await listAccounts();
  const def = await getDefaultKey();
  const state = currentSessionWorkspace();
  const dir = state != null && state.cwd != null ? state.cwd : process.cwd();
  const ctx = createRouteContext();
  const several = rows.length > 1;
  const out = [];
  rows.forEach((row, i) => {
    if (several && i > 0) out.push('');
    out.push(`Beezi · ${row.email || row.name || 'linked account'}${several && row.key === def ? ' (default)' : ''}`);
    const h = health[row.key];
    if (h != null && !h.ok && h.lines.length > 0) out.push(signInField(h.lines));
    if (isMultiTenant(row)) {
      const here = thisFolder(row, dir, ctx);
      if (here != null) out.push(field('This folder', here));
      out.push(field('Rules', rulesCount(rulesOf(row).length)));
      out.push(field('New folders', newFoldersLabel(row)));
      return;
    }
    if (!isSingleTenant(row)) return;
    const here = thisFolderSingle(row, dir, ctx);
    if (here != null) out.push(field('This folder', here));
    const ruleCount = rulesOf(row).length;
    if (ruleCount > 0) out.push(field('Rules', rulesCount(ruleCount)));
  });
  if (several) out.push('', 'This machine');
  console.log(out.concat(machine).join('\n'));
}

// Known workspace count; 0 when unknown.
function workspaceCount(row) {
  const tenants = tenantsOf(row);
  return tenants == null ? 0 : tenants.length;
}

// For the command's routing only; never shown.
async function keys() {
  const accounts = await listAccounts();
  const def = await getDefaultKey();
  const menu = [];
  if (accounts.some((a) => workspaceCount(a) >= 1)) menu.push('Rules');
  if (accounts.some((a) => isMultiTenant(a))) menu.push('New folders');
  menu.push('Account', 'Crash reports & status line');
  console.log(`menu=${menu.join('|')}`);
  for (const a of accounts) {
    console.log(`account=${a.key} default=${a.key === def ? 'yes' : 'no'} multi=${isMultiTenant(a) ? 'yes' : 'no'} workspaces=${workspaceCount(a)} status=${a.status || 'linked'} email=${a.email || 'unknown'}`);
  }
  console.log(`crash=${crashMode()} statusline=${statuslineInstalled() ? 'on' : 'off'}`);
}

const PLAN_LABELS = { pro: 'Pro', max_5x: 'Max 5x', max_20x: 'Max 20x', team: 'Team', enterprise: 'Enterprise', api_key: 'API key', gateway: 'Billed by your gateway' };

function claudePlan() {
  const config = readBillingConfig();
  if (config == null) return 'not captured yet — /beezi:settings refresh';
  if (config.source === BillingSource.ANTHROPIC_API_KEY) return 'API key';
  if (config.source === BillingSource.THIRD_PARTY) return 'Third-party provider';
  if (config.plan != null && PLAN_LABELS[config.plan] != null) return PLAN_LABELS[config.plan];
  return config.plan ? String(config.plan) : 'unknown — /beezi:settings refresh';
}

function capitalize(text) {
  const t = String(text);
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

function workspaceList(row) {
  const tenants = tenantsOf(row) || [];
  return tenants.map((t) => {
    const bits = [roleLabel(t), t.tier ? `${capitalize(t.tier)} plan` : ''].filter((b) => b);
    return `${t.name || t.id}${bits.length ? ` (${bits.join(', ')})` : ''}`;
  }).join(', ');
}

function currentDir() {
  const state = currentSessionWorkspace();
  return state != null && state.cwd != null ? state.cwd : process.cwd();
}

function heading(section, row, several) {
  return several ? `${section} · ${row.email || row.name || row.key}` : section;
}

const NEW_FOLDERS_TEXT = {
  ask: 'Ask me — Beezi asks once per repo or folder, when a session starts there',
  none: 'Don\'t send — nothing from a repo or folder with no rule is uploaded',
};

async function rulesSection() {
  const rows = await listAccounts();
  if (rows.length === 0) return ['Beezi · not linked — run /beezi:login'];
  return rulesTableLines(rows, currentDir(), createRouteContext());
}

async function newFoldersSection() {
  const rows = (await listAccounts()).filter((row) => isMultiTenant(row));
  if (rows.length === 0) return ['New folders applies only to an account in several workspaces.'];
  const dir = currentDir();
  const ctx = createRouteContext();
  const out = [];
  rows.forEach((row, i) => {
    if (i > 0) out.push('');
    out.push(heading('New folders', row, rows.length > 1));
    const nf = newFoldersOf(row);
    out.push(field('Setting', nf.mode === 'send' ? `Send to ${names(row, nf.tenantIds)}` : NEW_FOLDERS_TEXT[nf.mode]));
    out.push(field('Workspaces', workspaceList(row)));
    const here = thisFolder(row, dir, ctx);
    if (here != null) out.push(field('This folder', here));
  });
  return out;
}

async function accountSection() {
  const accounts = await listAccounts();
  const machine = ['This machine', field('Claude plan', claudePlan())];
  if (accounts.length === 0) return ['Beezi · not linked — run /beezi:login', ''].concat(machine);
  const health = {};
  await Promise.all(accounts.map(async (a) => {
    try {
      health[a.key] = await accountHealth(a);
    } catch (error) {
      health[a.key] = { ok: false, lines: [friendlyMessage(error)] };
    }
  }));
  const rows = await listAccounts();
  const def = await getDefaultKey();
  const several = rows.length > 1;
  const out = [];
  rows.forEach((row) => {
    out.push(`Account · ${row.email || row.name || row.key}${several && row.key === def ? ' (default)' : ''}`);
    const h = health[row.key];
    if (h != null && !h.ok && h.lines.length > 0) out.push(signInField(h.lines));
    else out.push(field('Sign-in', 'OK'));
    const tenants = tenantsOf(row) || [];
    if (tenants.length > 0) out.push(field(tenants.length > 1 ? 'Workspaces' : 'Workspace', workspaceList(row)));
    if (several) out.push(field('Analytics reads', row.key === def ? 'yes (default account)' : 'no'));
    out.push('');
  });
  return out.concat(machine);
}

function crashText(mode) {
  if (mode === 'correlate') return 'On, with an installation ID so support can find your reports';
  if (mode === 'anonymous' || mode === 'on') return 'On, anonymous';
  return 'Off';
}

function privacySection() {
  return [
    field('Crash reports', crashText(crashMode())),
    field('Status line', statuslineInstalled() ? 'On — records the live plan usage Claude Code shows' : 'Off'),
  ];
}

async function allSections() {
  const parts = [
    ['Rules', await rulesSection()],
    ['New folders', await newFoldersSection()],
    ['Account', await accountSection()],
    ['Crash reports & status line', privacySection()],
  ];
  const out = [];
  parts.forEach(([title, lines], i) => {
    if (i > 0) out.push('');
    out.push(`## ${title}`, '');
    // The heading already names the section.
    out.push(...(lines[0] === title ? lines.slice(1) : lines));
  });
  return out;
}

const SECTIONS = {
  rules: rulesSection,
  'new-folders': newFoldersSection,
  account: accountSection,
  privacy: privacySection,
  all: allSections,
};

async function main() {
  const cmd = process.argv[2];
  if (cmd == null) { await screen(); return; }
  if (cmd === 'keys') { await keys(); return; }
  if (SECTIONS[cmd] != null) {
    console.log((await SECTIONS[cmd]()).join('\n'));
    return;
  }
  throw new UserError('Usage: settings.mjs [keys | rules | new-folders | account | privacy | all]');
}

main().catch((error) => {
  console.error(`\n✗ ${friendlyMessage(error)}`);
  process.exit(1);
});
