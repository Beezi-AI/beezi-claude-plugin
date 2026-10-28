import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { getDefaultKey, listAccounts, parseAccountFlag } from '../lib/accounts.mjs';
import { accountHealth } from '../lib/me.mjs';
import { currentSessionWorkspace, isMultiTenant, isSingleTenant, joinTenantNames, newFoldersOf, roleLabel, tenantById, tenantsOf } from '../lib/workspace.mjs';
import { createRouteContext, defaultTarget, rulesOf, rulesTableLines, shortLabel } from '../lib/workspace-rules.mjs';
import { kindWords, placeOfDir, routeOfDir, routeTarget, routeText } from '../lib/route-describe.mjs';
import { resolveSessionId } from '../lib/permission-mode-store.mjs';
import { isLiveTrackingAllowed, readTrackingState } from '../lib/tracking.mjs';
import { claudePlan, crashMode } from '../lib/machine-settings.mjs';
import { badgeEnabled, setBadgeEnabled } from '../lib/statusline-badge.mjs';
import { installStatusline, statuslineInstalled, uninstallStatusline } from '../lib/statusline-install.mjs';
import { UserError, friendlyMessage } from '../lib/friendly-error.mjs';
import { isEntryScript } from '../lib/entry-script.mjs';
import { newFolders as printNewFoldersListing, rules as printRulesListing } from './workspace.mjs';
import { setTelemetry } from './telemetry.mjs';

const LABEL_WIDTH = 16;
// The Rules preview's label column: "You're here" and two spaces.
const PREVIEW_WIDTH = 13;
const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const USAGE = 'Usage: settings.mjs [rules | new-folders | account | privacy | all | keys]'
  + ' | refresh [--account <ref>] | set [crash=<correlate|on|off|anonymous>] [statusline=<on|off>] [badge=<on|off>]';
const CRASH_MODES = ['correlate', 'on', 'off', 'anonymous'];
const SET_NAMES = ['crash', 'statusline', 'badge'];
// key-resolve statuses whose answer is the local capture (settings.md, Refresh Step 2).
const CAPTURE_STATUSES = ['no_key', 'not_linked'];

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

// "labacus-suite → Acme (default)": where this folder's analytics go, and why.
function thisFolder(row, dir, ctx) {
  const place = placeOfDir(dir, ctx);
  return place == null ? null : `${place.short} ${routeText(row, routeOfDir(row, dir, ctx))}`;
}

function rulesCount(n) {
  if (n === 0) return 'none yet';
  return n === 1 ? '1 repo/folder' : `${n} repos/folders`;
}

// Skipped for a one-workspace account when live tracking is off (audit mode or disabled): "→ Acme" would be wrong there.
function hereShown(row) {
  return !isSingleTenant(row) || isLiveTrackingAllowed(readTrackingState(row.key));
}

// accountHealth's lines folded into one: "Beezi: " dropped, sentences joined.
function signInField(lines) {
  const text = lines.map((l) => l.trim()).join(' ').replace(/^Beezi: /, '');
  return field('Sign-in', text.charAt(0).toUpperCase() + text.slice(1));
}

function currentDir() {
  const state = currentSessionWorkspace();
  return state != null && state.cwd != null ? state.cwd : process.cwd();
}

// Everything the sections read, loaded once; health checks only when a section shows sign-in.
async function loadView(withHealth) {
  const accounts = await listAccounts();
  const health = {};
  if (withHealth) {
    await Promise.all(accounts.map(async (a) => {
      try {
        health[a.key] = await accountHealth(a);
      } catch (error) {
        health[a.key] = { ok: false, lines: [friendlyMessage(error)] };
      }
    }));
  }
  // Health checks refresh each account's workspaces, so the index is read again after.
  const rows = withHealth && accounts.length > 0 ? await listAccounts() : accounts;
  return { rows, health, def: await getDefaultKey(), dir: currentDir(), ctx: createRouteContext(), liveSessionId: resolveSessionId() };
}

function screen(view) {
  const machine = [
    field('Crash reports', crashMode() === 'off' ? 'Off' : 'On'),
    field('Status line', statuslineInstalled() ? 'On' : 'Off'),
  ];
  const { rows, health, def, dir, ctx } = view;
  if (rows.length === 0) return ['Beezi · not linked — run /beezi:login'].concat(machine);
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
    const here = hereShown(row) ? thisFolder(row, dir, ctx) : null;
    if (here != null) out.push(field('This folder', here));
    const ruleCount = rulesOf(row).length;
    if (ruleCount > 0) out.push(field('Rules', rulesCount(ruleCount)));
  });
  if (several) out.push('', 'This machine');
  return out.concat(machine);
}

// Known workspace count; 0 when unknown.
function workspaceCount(row) {
  const tenants = tenantsOf(row);
  return tenants == null ? 0 : tenants.length;
}

// The sections that apply here, in menu order.
function menuLabels(rows) {
  const menu = [];
  if (rows.some((a) => workspaceCount(a) >= 1)) menu.push('Rules');
  if (rows.some((a) => isMultiTenant(a))) menu.push('New folders');
  menu.push('Account', 'Crash reports & status line');
  return menu;
}

function statuslineWords() {
  if (!statuslineInstalled()) return 'status line off';
  return badgeEnabled() ? 'status line on with badge' : 'status line on';
}

// One menu option label per `menu=` label, in order, each with its current state when one account decides it.
export function menuLabelLines(view) {
  const { rows, dir, ctx } = view;
  return menuLabels(rows).map((label) => {
    if (label === 'Rules') {
      const ruled = rows.filter((a) => workspaceCount(a) >= 1);
      if (ruled.length !== 1 || !hereShown(ruled[0]) || placeOfDir(dir, ctx) == null) return label;
      return `Rules: here → ${routeTarget(ruled[0], routeOfDir(ruled[0], dir, ctx))}`;
    }
    if (label === 'New folders') {
      const multi = rows.filter((a) => isMultiTenant(a));
      if (multi.length !== 1) return label;
      const nf = newFoldersOf(multi[0]);
      if (nf.mode === 'send') return `New folders: send to ${joinTenantNames(multi[0], nf.tenantIds)}`;
      return nf.mode === 'none' ? 'New folders: don\'t send' : 'New folders: ask me';
    }
    if (label === 'Account') {
      if (rows.length === 0) return label;
      return rows.length === 1 ? `Account: ${rows[0].email || rows[0].name || rows[0].key}` : `Account: ${rows.length} linked`;
    }
    return `Crash reports ${crashMode() === 'off' ? 'off' : 'on'}, ${statuslineWords()}`;
  });
}

// For the command's routing only; never shown. `badge` adds the badge state for the views (`keys` stays as the wizard parses it).
function keyLines(view, badge = false) {
  const { rows, def } = view;
  const out = [`menu=${menuLabels(rows).join('|')}`];
  for (const a of rows) {
    out.push(`account=${a.key} default=${a.key === def ? 'yes' : 'no'} multi=${isMultiTenant(a) ? 'yes' : 'no'} workspaces=${workspaceCount(a)} status=${a.status || 'linked'} email=${a.email || 'unknown'}`);
  }
  const machine = `crash=${crashMode()} statusline=${statuslineInstalled() ? 'on' : 'off'}`;
  out.push(badge ? `${machine} badge=${badgeEnabled() ? 'on' : 'off'}` : machine);
  return out;
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

function heading(section, row, several) {
  return several ? `${section} · ${row.email || row.name || row.key}` : section;
}

const NEW_FOLDERS_TEXT = {
  ask: 'Ask me — Beezi asks once per repo or folder, when a session starts there',
  none: 'Don\'t send — nothing from a repo or folder with no rule is sent',
};

function rulesSection(view) {
  if (view.rows.length === 0) return ['Beezi · not linked — run /beezi:login'];
  return rulesTableLines(view.rows, view.dir, view.ctx, { liveSessionId: view.liveSessionId });
}

const previewLine = (label, text) => `${label.padEnd(PREVIEW_WIDTH)}${text}`;

function defaultPreview(row) {
  if (!isMultiTenant(row)) return `every repo and folder → ${defaultTarget(row)}`;
  if (newFoldersOf(row).mode === 'ask') return 'Beezi asks for each new repo or folder';
  return `new repos and folders → ${defaultTarget(row)}`;
}

// One aligned line per rule: "R1  api      → Acme, Northwind".
function rulesPreview(row) {
  const stored = rulesOf(row);
  if (stored.length === 0) return [previewLine('Rules', 'none yet')];
  const ids = stored.map((r) => `R${r.index}`);
  const shorts = stored.map((r) => shortLabel(r));
  const idWidth = Math.max(...ids.map((t) => t.length)) + 2;
  const shortWidth = Math.max(...shorts.map((t) => t.length)) + 2;
  return stored.map((r, i) => {
    const to = r.tenantIds.length === 0 ? 'not tracked' : joinTenantNames(row, r.tenantIds);
    return previewLine(i === 0 ? 'Rules' : '', `${ids[i].padEnd(idWidth)}${shorts[i].padEnd(shortWidth)}→ ${to}`);
  });
}

function herePreview(row, dir, ctx) {
  if (!hereShown(row)) return [];
  const place = placeOfDir(dir, ctx);
  if (place == null) return [];
  const where = place.kind === 'outside' ? 'outside a project folder' : `${place.short} (${place.kind === 'repo' ? 'git repo' : 'folder'})`;
  return ['', previewLine('You\'re here', where), previewLine('', routeText(row, routeOfDir(row, dir, ctx)))];
}

// The menu's compact Rules preview: per account, its default, its rules and where this folder goes.
export function rulesPreviewLines(rows, dir, ctx) {
  const known = rows.filter((row) => isMultiTenant(row) || isSingleTenant(row));
  if (rows.length === 0) return ['Beezi · not linked — run /beezi:login'];
  if (known.length === 0) return ['Rules need the account\'s workspaces, which are not known yet. Start a new session and try again.'];
  const out = [];
  known.forEach((row, i) => {
    if (i > 0) out.push('');
    if (known.length > 1) out.push(row.email || row.name || row.key);
    out.push(previewLine('By default', defaultPreview(row)), ...rulesPreview(row), ...herePreview(row, dir, ctx));
  });
  return out;
}

const CARD_FOOTER = {
  repo: ['The rule follows the repo, so every', 'clone of it stops sending too.'],
  folder: ['The rule covers this folder and', 'everything inside it.'],
  outside: ['The rule covers every session in your', 'home folder, / or a temp folder.'],
};

// The `<here-card>` preview: where this folder is, where it sends now, and for one workspace what Don't track changes.
export function hereCardLines(row, dir, ctx) {
  if (!hereShown(row)) return null;
  const place = placeOfDir(dir, ctx);
  if (place == null) return null;
  const route = routeOfDir(row, dir, ctx);
  const out = ['● You\'re here', `  ${place.kind === 'outside' ? 'outside a project folder' : `${place.short}, ${kindWords(place)}`}`];
  if (place.path != null) out.push(`  ${place.path}`);
  if (place.remote != null) out.push(`  ${place.remote}`);
  out.push('', `Now     ${routeText(row, route)}`);
  if (isSingleTenant(row) && route.ids.length > 0) out.push('After   → not tracked (new rule)', '', ...CARD_FOOTER[place.kind]);
  return out;
}

function newFoldersSection(view) {
  const rows = view.rows.filter((row) => isMultiTenant(row));
  if (rows.length === 0) return ['New folders applies only to an account in several workspaces.'];
  const out = [];
  rows.forEach((row, i) => {
    if (i > 0) out.push('');
    out.push(heading('New folders', row, rows.length > 1));
    const nf = newFoldersOf(row);
    out.push(field('Setting', nf.mode === 'send' ? `Send to ${names(row, nf.tenantIds)}` : NEW_FOLDERS_TEXT[nf.mode]));
    out.push(field('Workspaces', workspaceList(row)));
    const here = thisFolder(row, view.dir, view.ctx);
    if (here != null) out.push(field('This folder', here));
  });
  return out;
}

function accountSection(view) {
  const { rows, health, def } = view;
  const machine = ['This machine', field('Claude plan', claudePlan())];
  if (rows.length === 0) return ['Beezi · not linked — run /beezi:login', ''].concat(machine);
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

function statuslineText() {
  if (!statuslineInstalled()) return 'Off';
  return `${badgeEnabled() ? 'On, with the Beezi badge' : 'On'} — records the live plan usage Claude Code shows`;
}

function privacySection() {
  return [
    field('Crash reports', crashText(crashMode())),
    field('Status line', statuslineText()),
  ];
}

// One block per section, keyed by its menu label; the menu's previews show Rules compact instead of the table.
function sectionBlocks(view, preview = false) {
  return [
    ['Rules', preview ? rulesPreviewLines(view.rows, view.dir, view.ctx) : rulesSection(view)],
    ['New folders', newFoldersSection(view)],
    ['Account', accountSection(view)],
    ['Crash reports & status line', privacySection()],
  ].map(([title, lines]) => [title, lines[0] === title ? lines.slice(1) : lines]);
}

function allSections(view) {
  const out = [];
  sectionBlocks(view).forEach(([title, lines], i) => {
    if (i > 0) out.push('');
    // The heading already names the section.
    out.push(`## ${title}`, '', ...lines);
  });
  return out;
}

function block(tag, lines) {
  console.log([`<${tag}>`, ...lines, `</${tag.split(' ')[0]}>`].join('\n'));
}

// The command's one read call: what to show, the routing keys, and every listing the next question needs.
// listings: 'rules' and/or 'new-folders' blocks per account; previews: one block per menu section;
// labels: the menu's option labels; hereCards: one card per Rules account.
const VIEWS = {
  menu: { show: screen, health: true, listings: ['rules', 'new-folders'], previews: true, labels: true, hereCards: true },
  rules: { show: rulesSection, health: false, listings: ['rules'], hereCards: true },
  'new-folders': { show: newFoldersSection, health: false, listings: ['new-folders'] },
  account: { show: accountSection, health: true, listings: [] },
  privacy: { show: privacySection, health: false, listings: [] },
  all: { show: allSections, health: true, listings: [] },
};

async function printView(spec) {
  const view = await loadView(spec.health);
  block('show', spec.show(view));
  block('keys', keyLines(view, true));
  if (spec.labels) block('labels', menuLabelLines(view));
  const ruled = view.rows.filter((r) => workspaceCount(r) >= 1);
  if (spec.listings.indexOf('rules') !== -1) {
    for (const row of ruled) {
      console.log(`<rules account="${row.key}">`);
      await printRulesListing(['--account', row.key]);
      console.log('</rules>');
    }
  }
  if (spec.hereCards) {
    for (const row of ruled) {
      const card = hereCardLines(row, view.dir, view.ctx);
      if (card != null) block(`here-card account="${row.key}"`, card);
    }
  }
  if (spec.listings.indexOf('new-folders') !== -1) {
    for (const row of view.rows.filter((r) => isMultiTenant(r))) {
      console.log(`<new-folders account="${row.key}">`);
      await printNewFoldersListing(['--account', row.key]);
      console.log('</new-folders>');
    }
  }
  if (spec.previews) {
    const menu = menuLabels(view.rows);
    for (const [title, lines] of sectionBlocks(view, true)) {
      if (menu.indexOf(title) !== -1) block(`preview section="${title}"`, lines);
    }
  }
}

function runScript(script, args) {
  const result = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, script)].concat(args), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error != null) throw result.error;
  return { code: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

// Refresh Step 1 (key-resolve status) and, when its status sends there, Step 2 (local capture), in one call.
export async function refresh(argv, run = runScript) {
  const { account, rest } = await parseAccountFlag(argv);
  if (rest.length !== 0) throw new UserError(USAGE);
  const accountArgs = account == null ? [] : ['--account', account];
  const status = run('key-resolve.mjs', ['status'].concat(accountArgs));
  if (status.code !== 0) throw new UserError(status.stderr.replace(/^✗ /, '') || 'Could not read the key status.');
  block('key-status', [status.stdout]);
  let parsed = null;
  try { parsed = JSON.parse(status.stdout); } catch { parsed = null; }
  if (parsed == null || CAPTURE_STATUSES.indexOf(parsed.status) === -1) return;
  const capture = run('billing-capture.mjs', ['--from-claude', '--via', 'refresh'].concat(accountArgs));
  block('capture', [capture.code === 0 ? capture.stdout : capture.stderr]);
}

// `crash=<mode>`, `statusline=<on|off>` and/or `badge=<on|off>`: every change in one call, each result line printed.
function set(argv) {
  const wanted = {};
  for (const arg of argv) {
    const at = arg.indexOf('=');
    const name = at === -1 ? arg : arg.slice(0, at);
    if (SET_NAMES.indexOf(name) === -1 || at === -1 || wanted[name] != null) throw new UserError(USAGE);
    wanted[name] = arg.slice(at + 1);
  }
  if (Object.keys(wanted).length === 0) throw new UserError(USAGE);
  if (wanted.crash != null && CRASH_MODES.indexOf(wanted.crash) === -1) throw new UserError(USAGE);
  for (const name of ['statusline', 'badge']) {
    if (wanted[name] != null && wanted[name] !== 'on' && wanted[name] !== 'off') throw new UserError(USAGE);
  }
  if (wanted.crash != null) console.log(setTelemetry(wanted.crash));
  // The badge lives in the status line, so badge=on installs it first when it is not there.
  if (wanted.statusline != null || (wanted.badge === 'on' && !statuslineInstalled())) {
    const { ok, message } = wanted.statusline === 'off' ? uninstallStatusline() : installStatusline();
    console.log(`${ok ? '✓' : '✗'} ${message}`);
    if (!ok) { process.exitCode = 1; return; }
  }
  if (wanted.badge == null) return;
  setBadgeEnabled(wanted.badge === 'on');
  console.log(wanted.badge === 'on' ? '✓ Beezi badge on: the status line ends with where this folder\'s analytics go.' : '✓ Beezi badge off.');
}

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  if (cmd === 'keys') { console.log(keyLines({ rows: await listAccounts(), def: await getDefaultKey() }).join('\n')); return; }
  if (cmd === 'refresh') { await refresh(argv); return; }
  if (cmd === 'set') { set(argv); return; }
  const view = cmd == null ? 'menu' : cmd;
  if (!Object.prototype.hasOwnProperty.call(VIEWS, view) || argv.length !== 0) throw new UserError(USAGE);
  const spec = VIEWS[view];
  await printView(spec);
}

// Tests import refresh, so main runs only when this file is the entry script.
if (isEntryScript(import.meta.url)) {
  main().catch((error) => {
    console.error(`\n✗ ${friendlyMessage(error)}`);
    process.exit(1);
  });
}
