import os from 'os';
import path from 'path';
import {
  AccountStatus, getDefaultKey, listAccounts, markTenantsReviewed, parseAccountFlag, removeWorkspaceRule, setNewFolders, setWorkspaceRule,
} from '../lib/accounts.mjs';
import { resolveSessionId } from '../lib/permission-mode-store.mjs';
import {
  findSessionWorkspaceByCwd,
  initSessionWorkspace,
  isMultiTenant,
  isSingleTenant,
  joinTenantNames,
  listSessionWorkspaces,
  newFoldersOf,
  newTenantsOf,
  readSessionWorkspace,
  recordReadTenant,
  recordSessionRoute,
  resolveTargets,
  resolveTenantRef,
  roleLabel,
  tenantById,
  tenantsOf,
} from '../lib/workspace.mjs';
import { releaseHeldQueue } from '../lib/workspace-queue.mjs';
import { pluginRoot } from '../lib/workspace-prompt.mjs';
import {
  createRouteContext, keepCurrentRules, outsideKey, placeNow, planReviewPlaces, planUnruledRoutes, routeForDir, routeKeyForDir, rulesOf, rulesTableLines, shortLabel,
} from '../lib/workspace-rules.mjs';
import { canonicalRemote } from '../lib/git.mjs';
import { normPath, pathHasPrefix } from '../lib/repo-map.mjs';
import { listAllTranscripts } from '../lib/transcript-index.mjs';
import { UserError, friendlyMessage } from '../lib/friendly-error.mjs';
import { sessionFor } from '../lib/sessions.mjs';
import { syncAccountIfNeeded } from '../lib/account-sync.mjs';
import { fetchOauthKeyStatus } from '../lib/oauth-key-status.mjs';
import { recordResolvedKeyData } from '../lib/plan-writeback.mjs';
import { oauthTokenEnvWithOsProbe } from '../lib/claude-settings-env.mjs';
import { startHistoryWorker, takeDeferFlag } from '../lib/history-trigger.mjs';

const USAGE = 'Usage: workspace.mjs rules [--table] [--session <id>] [--account <ref>]'
  + ' | rule add (--current | --repo <url> | --folder <path> | --outside) (<id|name|n>… | none) [--session <id>] [--account <ref>]'
  + ' | rule set <n> (<id|name|n>… | none) [--account <ref>]'
  + ' | rule remove <n> [--account <ref>]'
  + ' | rule add-all (<id|name|n>… | none) [--session <id>] [--account <ref>]'
  + ' | routes [--session <id>] [--account <ref>]'
  + ' | joined [add-all | done | pick (--repo <url> | --folder <path> | --outside) <id|name|n>] [--session <id>] [--account <ref>]'
  + ' | new-folders [ask | send <id|name|n>… | none] [--session <id>] [--account <ref>]'
  + ' | read <id|name|n> [--session <id>] [--account <ref>]';
const NOT_LINKED = 'Beezi: this machine is not linked. Run /beezi:login to link an account.';
const TARGET_FLAGS = ['--current', '--repo', '--folder', '--outside'];
// Printed commands spell the script path out: tool output does not expand ${CLAUDE_PLUGIN_ROOT}.
const SCRIPT = `node "${pluginRoot()}/scripts/workspace.mjs"`;

const deferText = (flags) => (flags.deferUpload ? ' --defer-upload' : '');

// Starts the history upload a write just requested, unless the calling flow uploads next.
async function afterRuleWrite(key, flags) {
  if (!flags.deferUpload) await startHistoryWorker(key);
}

function parseSessionFlag(argv) {
  const rest = [];
  let session = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--session') {
      session = argv[++i];
      if (session == null || !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(session)) throw new UserError('--session needs a Claude Code session id.');
      continue;
    }
    rest.push(argv[i]);
  }
  return { session, rest };
}

// --session, then the id Claude Code exports, then the newest session recorded for this directory.
function resolveSession(flag) {
  if (flag != null) return { sessionId: flag, state: readSessionWorkspace(flag) };
  const fromEnv = resolveSessionId();
  if (fromEnv != null) return { sessionId: fromEnv, state: readSessionWorkspace(fromEnv) };
  const byCwd = findSessionWorkspaceByCwd(process.cwd());
  return byCwd == null ? { sessionId: null, state: null } : byCwd;
}

function accountLabel(row) {
  if (row.email) return row.email;
  return row.name ? row.name : row.key;
}

// --account, then the default, then the only linked account.
async function resolveAccount(key) {
  const accounts = await listAccounts();
  const linked = accounts.filter((a) => a.status === AccountStatus.LINKED);
  if (accounts.length === 0) throw new UserError('This machine is not linked. Run /beezi:login to link an account.');
  let chosen = key;
  if (chosen == null) chosen = await getDefaultKey();
  if (chosen == null && linked.length === 1) chosen = linked[0].key;
  if (chosen == null) throw new UserError('Several accounts are linked and none is the default. Pass --account <ref> (see /beezi:settings account).');
  const row = accounts.find((a) => a.key === chosen);
  if (row == null) throw new UserError('No such linked account.');
  return row;
}

// --account's row, else every linked account.
async function selectedRows(account) {
  return account == null
    ? (await listAccounts()).filter((a) => a.status === AccountStatus.LINKED)
    : [await resolveAccount(account)];
}

function choiceDir(state) {
  return state != null && state.cwd != null ? state.cwd : process.cwd();
}

function tenantName(row, id) {
  const t = tenantById(row, id);
  return t != null && t.name ? t.name : id;
}

function tenantNames(row, ids) {
  return ids.map((id) => tenantName(row, id)).join(', ');
}

function sendList(row, ids) {
  return ids.length === 0 ? 'not tracked' : tenantNames(row, ids);
}

function idList(ids) {
  return ids.length === 0 ? 'none' : ids.join(',');
}

function sessionsCount(n) {
  return `${n} session${n === 1 ? '' : 's'}`;
}

function newFoldersLabel(row) {
  const newFolders = newFoldersOf(row);
  if (newFolders.mode === 'send') return `Send to ${tenantNames(row, newFolders.tenantIds)}`;
  return newFolders.mode === 'none' ? 'Don\'t send' : 'Ask me';
}

// A rule's place in a sentence: its short name, or "sessions outside a project".
function placeOf(key) {
  return key.kind === 'outside' ? 'sessions outside a project' : shortLabel(key);
}

function ruleDone(row, key, tenantIds, changed) {
  const now = changed ? 'now ' : '';
  if (tenantIds.length > 0) return `✓ Analytics for ${placeOf(key)} ${now}go to ${tenantNames(row, tenantIds)}.`;
  return `✓ ${key.kind === 'outside' ? 'Sessions outside a project are' : `${placeOf(key)} is`} ${now}not tracked.`;
}

function requireMulti(row) {
  if (!isMultiTenant(row)) {
    throw new UserError(`${accountLabel(row)} has one workspace (or its workspaces are not known yet), so there is nothing to choose.`);
  }
}

// Same refusal as requireMulti, but only for workspaces that aren't known yet: a one-workspace account may still pass none.
function requireKnownWorkspaces(row) {
  const tenants = tenantsOf(row);
  if (tenants == null || tenants.length === 0) {
    throw new UserError(`${accountLabel(row)}'s workspaces are not known yet. Start a new Claude Code session, then try again.`);
  }
}

// A one-workspace account's rule refs may only be `none`: there is nothing else to choose.
function requireNoneForSingle(row, refs) {
  if (!isSingleTenant(row)) return;
  const values = refValues(refs);
  if (values.length === 1 && values[0].toLowerCase() === 'none') return;
  throw new UserError(`${accountLabel(row)} has one workspace, so a rule can only stop tracking a repo or folder. Pass none.`);
}

// The workspaces to offer, one line each; role= is last and may be empty.
function printWorkspaces(row) {
  for (const t of tenantsOf(row)) console.log(`W. ${t.name ? t.name : t.id} account=${row.key} tenant=${t.id} role=${roleLabel(t)}`);
}

// The tenant-scoped check-in and key status a session holds back until it knows where it sends.
async function checkIn(row, tenantId) {
  try {
    const live = await sessionFor(row.key);
    if (live == null) return;
    const session = { ...live, tenantId };
    const env = oauthTokenEnvWithOsProbe(process.env);
    await syncAccountIfNeeded(session, { force: true, via: 'workspace' }, { env });
    const keyStatus = await fetchOauthKeyStatus(session, { env, refresh: true });
    if (keyStatus != null && keyStatus.known && keyStatus.subscriptionPlan != null && row.key === await getDefaultKey()) {
      recordResolvedKeyData(keyStatus);
    }
  } catch (error) {
    console.error(`Beezi: workspace check-in skipped (${friendlyMessage(error)}).`);
  }
}

function refValues(refs) {
  const values = [];
  for (const ref of refs) for (const part of String(ref).split(',')) if (part.trim() !== '') values.push(part.trim());
  return values;
}

// Ids/names/positions (comma lists too) in row order; `none` anywhere wins and means send nowhere.
function selection(row, refs) {
  const values = refValues(refs);
  if (values.length === 0) throw new UserError(USAGE);
  if (values.some((v) => v.toLowerCase() === 'none')) return [];
  const picked = values.map((v) => resolveTenantRef(row, v));
  return tenantsOf(row).map((t) => t.id).filter((id) => picked.indexOf(id) !== -1);
}

function homeDir() {
  return normPath(os.homedir());
}

// `/`, a drive root, home or a folder above it (e.g. /Users): a folder rule there would catch every session.
function isHomeOrRoot(p) {
  const home = homeDir();
  return p === '/' || /^[a-z]:\/?$/i.test(p) || (home != null && pathHasPrefix(home, p));
}

function displayPath(p) {
  const home = homeDir();
  return home != null && pathHasPrefix(p, home) ? `~${p.slice(home.length)}` : p;
}

// Binds open sessions whose directory now routes to one of `indices`: the current one always, others when unbound or bound to that rule.
// Each bound session's held reports are released, and each workspace it newly sends to gets one check-in.
async function bindOpenSessions(row, indices, current, ctx) {
  const checkedIn = [];
  const target = (dir) => {
    const route = dir == null ? null : routeForDir(row, dir, ctx);
    return route != null && indices.indexOf(route.index) !== -1 ? route : null;
  };
  const bind = async (sid, prior, route, dir) => {
    const before = resolveTargets(row, prior).targets;
    // Records the directory too, so a session with no state yet can be found by folder later.
    initSessionWorkspace(sid, { cwd: dir, routes: { [row.key]: route } });
    releaseHeldQueue(row, sid);
    for (const id of resolveTargets(row, readSessionWorkspace(sid)).targets) {
      if (before.indexOf(id) !== -1 || checkedIn.indexOf(id) !== -1) continue;
      checkedIn.push(id);
      await checkIn(row, id);
    }
  };
  if (current.sessionId != null) {
    const dir = choiceDir(current.state);
    const route = target(dir);
    if (route != null) await bind(current.sessionId, current.state, route, dir);
  }
  for (const entry of listSessionWorkspaces()) {
    if (entry.sessionId === current.sessionId) continue;
    const route = target(entry.state.cwd);
    if (route == null) continue;
    const bound = entry.state.route[row.key];
    if (bound != null && (bound.kind !== route.kind || bound.match !== route.match)) continue;
    await bind(entry.sessionId, entry.state, route, entry.state.cwd);
  }
}

// A rule or place in a machine line: its short name, then its full label in parentheses (none for outside).
function labeled(key) {
  return key.kind === 'outside' ? shortLabel(key) : `${shortLabel(key)} (${key.label})`;
}

function printRulesTable(rows, dir, ctx) {
  console.log(rulesTableLines(rows, dir, ctx).join('\n'));
}

async function rules(argv) {
  const { session, rest: afterSession } = parseSessionFlag(argv);
  const { account, rest: afterAccount } = await parseAccountFlag(afterSession);
  const table = afterAccount.indexOf('--table') !== -1;
  const rest = afterAccount.filter((a) => a !== '--table');
  if (rest.length !== 0) throw new UserError(USAGE);
  const rows = await selectedRows(account);
  if (rows.length === 0) {
    console.log(NOT_LINKED);
    return;
  }
  const dir = choiceDir(resolveSession(session).state);
  const ctx = createRouteContext();
  if (table) {
    printRulesTable(rows, dir, ctx);
    return;
  }
  for (const row of rows) {
    const tenants = tenantsOf(row);
    if (tenants == null || tenants.length === 0) {
      console.log(`${accountLabel(row)}: workspaces not known yet; rules do not apply account=${row.key}`);
      continue;
    }
    if (isSingleTenant(row)) {
      const stored = rulesOf(row);
      console.log(`${accountLabel(row)}: ${stored.length} rule(s) account=${row.key} workspaces=1`);
      for (const r of stored) {
        console.log(`R${r.index}. ${labeled(r)} → ${r.tenantIds.length === 0 ? 'not tracked' : 'tracked'} account=${row.key} rule=${r.index} kind=${r.kind} tenants=${idList(r.tenantIds)} match=${r.match}`);
      }
      const key = routeKeyForDir(dir, ctx);
      if (key == null) {
        console.log(`here: none account=${row.key}`);
        continue;
      }
      const route = routeForDir(row, dir, ctx);
      console.log(`here: ${labeled(key)} → ${route == null ? 'no rule' : `R${route.index}`} account=${row.key} rule=${route == null ? 'none' : route.index} kind=${key.kind} match=${key.match}`);
      continue;
    }
    const stored = rulesOf(row);
    console.log(`${accountLabel(row)}: ${stored.length} rule(s) account=${row.key}`);
    printWorkspaces(row);
    for (const r of stored) {
      console.log(`R${r.index}. ${labeled(r)} → ${sendList(row, r.tenantIds)} account=${row.key} rule=${r.index} kind=${r.kind} tenants=${idList(r.tenantIds)} match=${r.match}`);
    }
    const key = routeKeyForDir(dir, ctx);
    if (key == null) {
      console.log(`here: none account=${row.key}`);
      continue;
    }
    const route = routeForDir(row, dir, ctx);
    console.log(`here: ${labeled(key)} → ${route == null ? 'no rule' : `R${route.index}`} account=${row.key} rule=${route == null ? 'none' : route.index} kind=${key.kind} match=${key.match}`);
  }
}

// The rule's key from --current (the session's directory; home, / and temp give `outside`), --repo, --folder or --outside.
function ruleKey(target, dir, ctx) {
  if (target.flag === '--outside') return outsideKey();
  if (target.flag === '--current') {
    const key = routeKeyForDir(dir, ctx);
    if (key == null) throw new UserError('No folder is known for this session. Pass --repo <url>, --folder <path> or --outside.');
    return key;
  }
  if (target.flag === '--repo') {
    const canon = canonicalRemote(target.value);
    if (canon == null) throw new UserError(`"${target.value}" is not a repository remote URL.`);
    return { kind: 'repo', match: canon, label: canon };
  }
  const raw = target.value === '~' || target.value.indexOf('~/') === 0 ? path.join(os.homedir(), target.value.slice(1)) : target.value;
  const folder = normPath(path.resolve(raw));
  if (folder == null || isHomeOrRoot(folder)) {
    throw new UserError('A folder rule can\'t be your home folder, a folder above it, or /: it would catch every session. Use --outside for sessions there.');
  }
  return { kind: 'folder', match: folder, label: displayPath(folder) };
}

function findRule(row, ref) {
  const n = Number(String(ref).replace(/^R/i, ''));
  const found = rulesOf(row).find((r) => r.index === n);
  if (found == null) throw new UserError(`There is no rule ${ref}. Run /beezi:settings rules to list them.`);
  return found;
}

// Pulls the one --current/--repo/--folder/--outside flag out of argv; returns it (or null) plus the remaining refs.
function ruleTarget(argv) {
  let target = null;
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (TARGET_FLAGS.indexOf(arg) === -1) {
      rest.push(arg);
      continue;
    }
    if (target != null) throw new UserError('Pass only one of --current, --repo <url>, --folder <path> or --outside.');
    const bare = arg === '--current' || arg === '--outside';
    const value = bare ? null : argv[++i];
    if (!bare && (value == null || value.trim() === '')) throw new UserError(`${arg} needs a value.`);
    target = { flag: arg, value };
  }
  return { target, rest };
}

async function ruleAdd(argv, flags = { deferUpload: false }) {
  const { session, rest: afterSession } = parseSessionFlag(argv);
  const { account, rest } = await parseAccountFlag(afterSession);
  const { target, rest: refs } = ruleTarget(rest);
  if (target == null || refs.length === 0) throw new UserError(USAGE);
  const row = await resolveAccount(account);
  requireKnownWorkspaces(row);
  requireNoneForSingle(row, refs);
  const current = resolveSession(session);
  const ctx = createRouteContext();
  const key = ruleKey(target, choiceDir(current.state), ctx);
  const tenantIds = selection(row, refs);
  const n = (await setWorkspaceRule(row.key, { kind: key.kind, match: key.match, label: key.label, tenantIds })).index;
  console.log(ruleDone(row, key, tenantIds, false));
  await bindOpenSessions(await resolveAccount(row.key), [n], current, ctx);
  await afterRuleWrite(row.key, flags);
  console.log(`rule=${n}`);
}

async function ruleSet(argv, flags = { deferUpload: false }) {
  const { session, rest: afterSession } = parseSessionFlag(argv);
  const { account, rest } = await parseAccountFlag(afterSession);
  if (rest.length < 2) throw new UserError(USAGE);
  const row = await resolveAccount(account);
  requireKnownWorkspaces(row);
  const found = findRule(row, rest[0]);
  requireNoneForSingle(row, rest.slice(1));
  const tenantIds = selection(row, rest.slice(1));
  await setWorkspaceRule(row.key, { kind: found.kind, match: found.match, label: found.label, tenantIds });
  console.log(ruleDone(row, found, tenantIds, true));
  await bindOpenSessions(await resolveAccount(row.key), [found.index], resolveSession(session), createRouteContext());
  await afterRuleWrite(row.key, flags);
  console.log(`rule=${found.index}`);
}

async function ruleRemove(argv, flags = { deferUpload: false }) {
  const { account, rest } = await parseAccountFlag(argv);
  if (rest.length !== 1) throw new UserError(USAGE);
  const row = await resolveAccount(account);
  const removed = await removeWorkspaceRule(row.key, String(rest[0]).replace(/^R/i, ''));
  if (isSingleTenant(row)) {
    console.log(`✓ Removed the rule for ${placeOf(removed)}. Beezi tracks it again unless another rule covers it.`);
  } else {
    console.log(`✓ Removed the rule for ${placeOf(removed)}. New sessions there follow New folders (${newFoldersLabel(row)}).`);
  }
  await afterRuleWrite(row.key, flags);
  console.log(`removed=${removed.index}`);
  // Sessions bound to the removed rule keep their state until something re-binds them: re-route each to whatever still applies.
  if (isSingleTenant(row)) {
    const fresh = await resolveAccount(row.key);
    const ctx = createRouteContext();
    for (const entry of listSessionWorkspaces()) {
      const bound = entry.state.route[row.key];
      if (bound == null || bound.kind !== removed.kind || bound.match !== removed.match) continue;
      recordSessionRoute(entry.sessionId, row.key, routeForDir(fresh, entry.state.cwd, ctx));
    }
  }
}

// One rule per repo or folder that `routes` lists, all sending to the same workspaces.
async function ruleAddAll(argv, flags = { deferUpload: false }) {
  const { session, rest: afterSession } = parseSessionFlag(argv);
  const { account, rest } = await parseAccountFlag(afterSession);
  if (rest.length === 0) throw new UserError(USAGE);
  const row = await resolveAccount(account);
  requireMulti(row);
  const tenantIds = selection(row, rest);
  const current = resolveSession(session);
  const ctx = createRouteContext();
  const groups = planUnruledRoutes(row, listAllTranscripts(), ctx, { liveSessionId: current.sessionId });
  const added = [];
  for (const g of groups) {
    added.push((await setWorkspaceRule(row.key, { kind: g.kind, match: g.match, label: g.label, tenantIds })).index);
  }
  const n = added.length;
  if (n === 0) {
    console.log('✓ No repos or folders are waiting for a rule.');
  } else {
    const those = n === 1 ? 'that repo or folder' : 'those repos and folders';
    const where = tenantIds.length === 0 ? `${those} ${n === 1 ? 'is' : 'are'} not tracked` : `analytics for ${those} go to ${tenantNames(row, tenantIds)}`;
    console.log(`✓ Added ${n} rule${n === 1 ? '' : 's'}: ${where}.`);
    await bindOpenSessions(await resolveAccount(row.key), added, current, ctx);
  }
  await afterRuleWrite(row.key, flags);
  console.log(`rules-added=${n}`);
}

async function rule(argv, flags = { deferUpload: false }) {
  const [sub, ...rest] = argv;
  if (sub === 'add') { await ruleAdd(rest, flags); return; }
  if (sub === 'set') { await ruleSet(rest, flags); return; }
  if (sub === 'remove') { await ruleRemove(rest, flags); return; }
  if (sub === 'add-all') { await ruleAddAll(rest, flags); return; }
  throw new UserError(USAGE);
}

// The rule-add target flag for a place; single quotes keep $, backticks, " and \ in the match literal.
function ruleTargetFlag(place) {
  return place.kind === 'outside' ? '--outside' : `--${place.kind} '${place.match.replace(/'/g, "'\\''")}'`;
}

// Past sessions waiting under New folders = Ask me, grouped by repo or folder, for the planning questions.
async function routes(argv, flags = { deferUpload: false }) {
  const { session, rest: afterSession } = parseSessionFlag(argv);
  const { account, rest } = await parseAccountFlag(afterSession);
  if (rest.length !== 0) throw new UserError(USAGE);
  const rows = await selectedRows(account);
  const { sessionId } = resolveSession(session);
  const ctx = createRouteContext();
  let entries = null;
  let total = 0;
  for (const row of rows) {
    if (row.status !== AccountStatus.LINKED || !isMultiTenant(row) || newFoldersOf(row).mode !== 'ask') continue;
    if (entries == null) entries = listAllTranscripts();
    const groups = planUnruledRoutes(row, entries, ctx, { liveSessionId: sessionId });
    if (groups.length > 0) {
      const count = groups.reduce((sum, g) => sum + g.sessions, 0);
      const places = groups.length === 1 ? '1 repo or folder has' : `${groups.length} repos or folders have`;
      console.log(`${accountLabel(row)}: ${places} past sessions with no rule (${sessionsCount(count)}) account=${row.key}`);
      printWorkspaces(row);
      for (const g of groups) {
        total += 1;
        console.log(`P${total}. ${labeled(g)}, ${sessionsCount(g.sessions)} account=${row.key} kind=${g.kind} match=${g.match}`);
        const where = ruleTargetFlag(g);
        console.log(`P${total}-command=${SCRIPT} rule add ${where} --account ${row.key}${deferText(flags)} <tenants>`);
      }
      console.log(`all-command=${SCRIPT} rule add-all --account ${row.key}${deferText(flags)} <tenants>`);
    }
    const lost = groups.noDirectory;
    if (lost > 0) {
      console.log(lost === 1
        ? '1 other past session has no recorded folder and is not sent.'
        : `${lost} other past sessions have no recorded folder and are not sent.`);
    }
  }
  console.log(`routes=${total}`);
}

// A match or label holding a control character could forge a machine line, so `joined` leaves such a place out.
const UNSAFE_LINE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

// Accounts that joined a workspace since their last re-pick here: every place to re-pick, with where it sends now (login Step 4a, /beezi:sync Step 1).
async function joined(argv, flags = { deferUpload: false }) {
  const [sub, ...after] = argv;
  if (sub === 'add-all') { await joinedAddAll(after, flags); return; }
  if (sub === 'pick') { await joinedPick(after, flags); return; }
  if (sub === 'done') { await joinedDone(after, flags); return; }
  const { session, rest: afterSession } = parseSessionFlag(argv);
  const { account, rest } = await parseAccountFlag(afterSession);
  if (rest.length !== 0) throw new UserError(USAGE);
  const rows = await selectedRows(account);
  const { sessionId } = resolveSession(session);
  const ctx = createRouteContext();
  let entries = null;
  let total = 0;
  for (const row of rows) {
    if (row.status !== AccountStatus.LINKED) continue;
    const newIds = newTenantsOf(row);
    if (newIds.length === 0) continue;
    if (entries == null) entries = listAllTranscripts();
    const places = planReviewPlaces(row, entries, ctx, { liveSessionId: sessionId })
      .filter((place) => !UNSAFE_LINE.test(place.match) && !UNSAFE_LINE.test(place.label));
    if (places.length === 0) continue;
    const count = places.length === 1 ? '1 repo or folder' : `${places.length} repos or folders`;
    console.log(`${accountLabel(row)}: you joined ${joinTenantNames(row, newIds)} — ${count} to review account=${row.key} new=${newIds.join(',')}`);
    for (const t of tenantsOf(row)) {
      console.log(`W. ${t.name ? t.name : t.id} account=${row.key} tenant=${t.id} new=${newIds.indexOf(t.id) === -1 ? 'no' : 'yes'} role=${roleLabel(t)}`);
    }
    for (const place of places) {
      total += 1;
      const now = placeNow(row, place, newIds);
      const where = now.pending ? 'no rule yet' : sendList(row, now.ids);
      console.log(`J${total}. ${labeled(place)}, ${sessionsCount(place.sessions)}, now: ${where} account=${row.key} kind=${place.kind} match=${place.match} now=${now.pending ? 'pending' : idList(now.ids)}`);
      console.log(`J${total}-command=${SCRIPT} joined pick ${ruleTargetFlag(place)} --account ${row.key}${deferText(flags)} <tenant>`);
    }
    console.log(`add-all-command=${SCRIPT} joined add-all --account ${row.key}${deferText(flags)}`);
    console.log(`done-command=${SCRIPT} joined done --account ${row.key}${deferText(flags)}`);
  }
  console.log(`joined=${total}`);
}

// A place's current targets (none if pending) plus addIds, kept to current members and order; add-all pre-filters empty/pending places.
function extendedTenantIds(row, place, addIds, newIds) {
  const members = tenantsOf(row).map((t) => t.id);
  const now = placeNow(row, place, newIds);
  const base = now.pending ? [] : now.ids;
  return members.filter((id) => base.indexOf(id) !== -1 || addIds.indexOf(id) !== -1);
}

// Adds one newly-joined workspace to one place, extending its current targets; the caller marks the join reviewed via `joined done`.
async function joinedPick(argv, flags = { deferUpload: false }) {
  const { session, rest: afterSession } = parseSessionFlag(argv);
  const { account, rest: afterAccount } = await parseAccountFlag(afterSession);
  const { target, rest } = ruleTarget(afterAccount);
  if (target == null || target.flag === '--current' || rest.length !== 1) throw new UserError(USAGE);
  const row = await resolveAccount(account);
  requireMulti(row);
  const newIds = newTenantsOf(row);
  const current = resolveSession(session);
  const ctx = createRouteContext();
  const key = ruleKey(target, choiceDir(current.state), ctx);
  const tenantId = resolveTenantRef(row, rest[0]);
  const tenantIds = extendedTenantIds(row, key, [tenantId], newIds);
  const n = (await setWorkspaceRule(row.key, { kind: key.kind, match: key.match, label: key.label, tenantIds })).index;
  await bindOpenSessions(await resolveAccount(row.key), [n], current, ctx);
  await afterRuleWrite(row.key, flags);
  console.log(`rule=${n}`);
}

// Adds the new workspaces to every listed place that already sends somewhere; Don't-track and no-rule-yet places stay as they are. Then marks the join reviewed.
async function joinedAddAll(argv, flags = { deferUpload: false }) {
  const { session, rest: afterSession } = parseSessionFlag(argv);
  const { account, rest } = await parseAccountFlag(afterSession);
  if (rest.length !== 0) throw new UserError(USAGE);
  const row = await resolveAccount(account);
  requireMulti(row);
  const newIds = newTenantsOf(row);
  if (newIds.length === 0) {
    console.log('✓ No new workspaces are waiting for a review.');
    console.log('rules-added=0');
    return;
  }
  const current = resolveSession(session);
  const ctx = createRouteContext();
  const added = [];
  for (const place of planReviewPlaces(row, listAllTranscripts(), ctx, { liveSessionId: current.sessionId })) {
    const now = placeNow(row, place, newIds);
    if (now.pending || now.ids.length === 0) continue;
    const tenantIds = extendedTenantIds(row, place, newIds, newIds);
    added.push((await setWorkspaceRule(row.key, { kind: place.kind, match: place.match, label: place.label, tenantIds })).index);
  }
  await markTenantsReviewed(row.key, newIds);
  const n = added.length;
  const names = joinTenantNames(row, newIds);
  console.log(n === 0
    ? `✓ Nothing to add: no repo or folder sends anywhere yet. ${names} won't be asked about again.`
    : `✓ ${names} now ${newIds.length === 1 ? 'gets' : 'get'} analytics from ${n === 1 ? '1 repo or folder' : `${n} repos and folders`}.`);
  if (n > 0) {
    await bindOpenSessions(await resolveAccount(row.key), added, current, ctx);
    await afterRuleWrite(row.key, flags);
  }
  console.log(`rules-added=${n}`);
}

// Keeps rule-less places sending where they send now (Ask me only), then marks the account's new workspaces reviewed.
async function joinedDone(argv, flags = { deferUpload: false }) {
  const { session, rest: afterSession } = parseSessionFlag(argv);
  const { account, rest } = await parseAccountFlag(afterSession);
  if (rest.length !== 0) throw new UserError(USAGE);
  const row = await resolveAccount(account);
  const newIds = newTenantsOf(row);
  const current = resolveSession(session);
  const ctx = createRouteContext();
  let toKeep = [];
  if (newIds.length > 0 && newFoldersOf(row).mode === 'ask') {
    const places = planReviewPlaces(row, listAllTranscripts(), ctx, { liveSessionId: current.sessionId })
      .filter((place) => !UNSAFE_LINE.test(place.match) && !UNSAFE_LINE.test(place.label));
    toKeep = keepCurrentRules(row, places, newIds);
  }
  const kept = [];
  for (const rule of toKeep) kept.push((await setWorkspaceRule(row.key, rule)).index);
  await markTenantsReviewed(row.key, newIds);
  console.log(newIds.length === 0 ? '✓ No new workspaces were waiting for a review.' : `✓ Done reviewing ${joinTenantNames(row, newIds)}.`);
  console.log(`reviewed=${idList(newIds)}`);
  if (kept.length > 0) {
    await bindOpenSessions(await resolveAccount(row.key), kept, current, ctx);
    await afterRuleWrite(row.key, flags);
  }
  console.log(`kept=${kept.length}`);
}

async function newFolders(argv, flags = { deferUpload: false }) {
  const { session, rest: afterSession } = parseSessionFlag(argv);
  const { account, rest } = await parseAccountFlag(afterSession);
  const row = await resolveAccount(account);
  if (rest.length === 0) {
    if (!isMultiTenant(row)) {
      console.log(`new-folders=n/a multi=no account=${row.key}`);
      return;
    }
    const several = (await listAccounts()).length > 1;
    const newFoldersNow = newFoldersOf(row);
    console.log(`New folders${several ? ` (${accountLabel(row)})` : ''}: ${newFoldersLabel(row)}`);
    printWorkspaces(row);
    console.log(`new-folders=${newFoldersNow.mode} set=${newFoldersNow.set ? 'yes' : 'no'} multi=yes account=${row.key}`);
    return;
  }
  requireMulti(row);
  const mode = String(rest[0]).toLowerCase();
  if ((mode !== 'ask' && mode !== 'send' && mode !== 'none') || (mode !== 'send' && rest.length > 1)) throw new UserError(USAGE);
  const tenantIds = mode === 'send' ? selection(row, rest.slice(1)) : [];
  if (mode === 'send' && tenantIds.length === 0) throw new UserError('Send needs at least one workspace; use none to send nowhere.');
  const current = resolveSession(session);
  const before = resolveTargets(row, current.state);
  await setNewFolders(row.key, { mode, tenantIds });
  if (mode === 'ask') console.log('✓ New folders: Ask me — Beezi asks once per repo or folder.');
  else if (mode === 'send') console.log(`✓ New folders: analytics go to ${tenantNames(row, tenantIds)}.`);
  else console.log('✓ New folders: not uploaded.');
  // A session here with no rule follows the new setting now: its held reports go out and new workspaces check in.
  if (current.sessionId != null && before.rule == null) {
    const fresh = await resolveAccount(row.key);
    releaseHeldQueue(fresh, current.sessionId);
    for (const id of resolveTargets(fresh, current.state).targets) {
      if (before.targets.indexOf(id) === -1) await checkIn(fresh, id);
    }
  }
  await afterRuleWrite(row.key, flags);
  console.log(`new-folders=${mode}`);
}

async function read(argv) {
  const { session, rest: afterSession } = parseSessionFlag(argv);
  const { account, rest } = await parseAccountFlag(afterSession);
  if (rest.length !== 1) throw new UserError(USAGE);
  const row = await resolveAccount(account);
  const tenantId = resolveTenantRef(row, rest[0]);
  const { sessionId } = resolveSession(session);
  if (sessionId == null || recordReadTenant(sessionId, row.key, tenantId) == null) {
    throw new UserError('No Claude Code session found. Run this inside a Claude Code session or pass --session <id>.');
  }
  console.log(`✓ Reading from ${tenantName(row, tenantId)} in this session.`);
  console.log(`read=${tenantId}`);
}

async function main() {
  const { deferUpload, argv: args } = takeDeferFlag(process.argv.slice(2));
  const flags = { deferUpload };
  const [cmd, ...argv] = args;
  if (cmd === 'rules') { await rules(argv); return; }
  if (cmd === 'rule') { await rule(argv, flags); return; }
  if (cmd === 'routes') { await routes(argv, flags); return; }
  if (cmd === 'joined') { await joined(argv, flags); return; }
  if (cmd === 'new-folders') { await newFolders(argv, flags); return; }
  if (cmd === 'read') { await read(argv); return; }
  throw new UserError(cmd == null ? USAGE : `Unknown command "${cmd}". ${USAGE}`);
}

main().catch((error) => {
  console.error(`\n✗ ${friendlyMessage(error)}`);
  process.exit(1);
});
