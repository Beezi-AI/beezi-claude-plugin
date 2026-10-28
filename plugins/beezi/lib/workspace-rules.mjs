import os from 'os';
import { loadRepoMap, normPath, pathHasPrefix, resolveRepoForRouting } from './repo-map.mjs';
import { canonicalRemote } from './git.mjs';
import { isMultiTenant, isSingleTenant, joinTenantNames, tenantsOf, resolveTargets, readSessionWorkspace, newFoldersOf, initSessionWorkspace } from './workspace.mjs';
import { firstRecordedCwd, listAllTranscripts } from './transcript-index.mjs';
// route-describe imports this module too; its functions are only called inside function bodies.
import { defaultRoute, kindWords, placeOfDir, routeOfDir, routeTarget } from './route-describe.mjs';
import { loadLedger, isImported } from './audit-ledger.mjs';
import { isLiveTrackingAllowed, readTrackingState } from './tracking.mjs';

// Copied from session-audit.mjs so planning skips what the backfill skips.
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const ACTIVE_SESSION_WINDOW_MS = 30 * 60 * 1000;
// The re-pick pass lists places with sessions from the last 30 days, as Codex's upload window does.
const REVIEW_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const OUTSIDE_LABEL = 'outside a project';

function stringIds(value) {
  return Array.isArray(value) ? value.filter((id) => typeof id === 'string' && id !== '') : null;
}

// The key of every home (or above), / or temp directory: one askable place with its own rule.
export function outsideKey() {
  return { kind: 'outside', match: 'outside', label: OUTSIDE_LABEL };
}

function normalizeRule(raw, index) {
  if (raw == null || typeof raw !== 'object') return null;
  if (raw.kind === 'outside') {
    const ids = stringIds(raw.tenantIds);
    if (ids == null) return null;
    return { index, ...outsideKey(), tenantIds: ids, createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null };
  }
  if ((raw.kind !== 'repo' && raw.kind !== 'folder') || typeof raw.match !== 'string' || raw.match === '') return null;
  const tenantIds = stringIds(raw.tenantIds);
  if (tenantIds == null) return null;
  return {
    index,
    kind: raw.kind,
    match: raw.match,
    label: typeof raw.label === 'string' && raw.label !== '' ? raw.label : raw.match,
    tenantIds,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
  };
}

// The account's rules; `index` is the 1-based position in the stored list, so dropped entries leave gaps.
export function rulesOf(row) {
  if (row == null || !Array.isArray(row.workspaceRules)) return [];
  const out = [];
  row.workspaceRules.forEach((raw, i) => {
    const rule = normalizeRule(raw, i + 1);
    if (rule != null) out.push(rule);
  });
  return out;
}

// Whether a row's rules can route anything: always for multi-workspace, else only with at least one rule.
export function usesRules(row) {
  return isMultiTenant(row) || (isSingleTenant(row) && rulesOf(row).length > 0);
}

// One repo map load and one key per directory for a whole pass.
export function createRouteContext({ loadRepoMapImpl = loadRepoMap } = {}) {
  let map = null;
  return {
    map() {
      if (map == null) {
        try { map = loadRepoMapImpl(); } catch { map = null; }
        if (map == null) map = { version: 1, roots: {} };
      }
      return map;
    },
    keyCache: new Map(),
  };
}

function homePath() {
  return normPath(os.homedir());
}

const TEMP_ROOTS = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders'];

// `/`, a drive root, home or a folder above it would catch every session by prefix, and temp dirs hold throwaway sessions: these key as `outside`.
function isUnsafeKeyPath(p) {
  const n = normPath(p);
  if (n == null || n === '/' || /^[a-z]:\/?$/i.test(n)) return true;
  const temps = TEMP_ROOTS.concat([normPath(os.tmpdir())]);
  if (temps.some((t) => t != null && pathHasPrefix(n, t))) return true;
  const home = homePath();
  // Home inside it: home itself or an ancestor such as /Users.
  return home != null && pathHasPrefix(home, n);
}

export function displayPath(p) {
  const home = homePath();
  return home != null && pathHasPrefix(p, home) ? `~${p.slice(home.length)}` : p;
}

// The key a rule for this directory would use: its repo's canonical remote, else its repo root or the folder itself; home (or above), / and temp are `outside`; null only without a directory.
export function routeKeyForDir(dir, ctx) {
  const d = normPath(dir);
  if (d == null) return null;
  if (isUnsafeKeyPath(d)) return outsideKey();
  const context = ctx == null ? createRouteContext() : ctx;
  if (context.keyCache.has(d)) return context.keyCache.get(d);
  const found = resolveRepoForRouting(d, context.map());
  // A repo rooted at home (dotfiles) would key every session under it, so it counts as no repo.
  const inRepo = found.root != null && !isUnsafeKeyPath(found.root);
  const canon = inRepo ? canonicalRemote(found.remote) : null;
  let key;
  if (canon != null) {
    key = { kind: 'repo', match: canon, label: canon };
  } else {
    const folder = inRepo ? normPath(found.root) : d;
    key = { kind: 'folder', match: folder, label: displayPath(folder) };
  }
  context.keyCache.set(d, key);
  return key;
}

// A rule's short name: a repo's last path segment, a folder's basename, or "outside a project".
export function shortLabel(rule) {
  if (rule == null) return '';
  if (rule.kind === 'outside') return OUTSIDE_LABEL;
  const match = typeof rule.match === 'string' ? rule.match : '';
  const parts = match.replace(/\\/g, '/').split('/').filter((p) => p !== '');
  if (parts.length > 0) return parts[parts.length - 1];
  return typeof rule.label === 'string' && rule.label !== '' ? rule.label : match;
}

// The rule this directory follows: the repo rule for its remote, else the longest folder prefix, else (home or above, / or temp only) the outside rule; tenantIds limited to current workspaces.
export function routeForDir(row, dir, ctx) {
  const rules = rulesOf(row);
  const tenants = tenantsOf(row);
  if (rules.length === 0 || tenants == null || tenants.length === 0) return null;
  const d = normPath(dir);
  if (d == null) return null;
  const members = tenants.map((t) => t.id);
  // A rule whose workspaces the account has all left is skipped; one stored with [] still matches.
  const usable = (rule) => {
    const ids = rule.tenantIds.filter((id) => members.indexOf(id) !== -1);
    return rule.tenantIds.length === 0 || ids.length > 0 ? ids : null;
  };
  const toRoute = (rule, ids) => ({ index: rule.index, kind: rule.kind, match: rule.match, label: rule.label, tenantIds: ids });
  const repoRules = rules.filter((r) => r.kind === 'repo');
  if (repoRules.length > 0) {
    const key = routeKeyForDir(d, ctx);
    if (key != null && key.kind === 'repo') {
      for (const rule of repoRules) {
        if (rule.match.toLowerCase() !== key.match) continue;
        const ids = usable(rule);
        if (ids != null) return toRoute(rule, ids);
      }
    }
  }
  const folders = rules
    .filter((r) => r.kind === 'folder' && pathHasPrefix(d, r.match))
    .sort((a, b) => normPath(b.match).length - normPath(a.match).length);
  for (const rule of folders) {
    const ids = usable(rule);
    if (ids != null) return toRoute(rule, ids);
  }
  // Never a catch-all: only directories no repo or folder rule could key reach it.
  if (!isUnsafeKeyPath(d)) return null;
  for (const rule of rules.filter((r) => r.kind === 'outside')) {
    const ids = usable(rule);
    if (ids != null) return toRoute(rule, ids);
  }
  return null;
}

// Binds each row whose rules can route (null unbinds) for cwd on the session and records cwd; the saved state, or null when none qualify.
export function bindSessionRoutes(sessionId, cwd, rows, ctx) {
  const context = ctx == null ? createRouteContext() : ctx;
  const routes = {};
  let any = false;
  for (const row of rows) {
    if (!usesRules(row)) continue;
    any = true;
    routes[row.key] = routeForDir(row, cwd, context);
  }
  if (!any) return null;
  return initSessionWorkspace(sessionId, { cwd, routes });
}

// A past session's workspaces: the rule for its directory now, else New folders; source is 'single'|'rule'|'new-folders'|'none'|'pending'.
// `key` is the directory's route key when the account has rules and the directory is known, else null.
export function routePastSession(row, { state = null, readCwd = null } = {}, ctx) {
  if (!usesRules(row)) return { tenantIds: [null], source: 'single', pending: false, key: null };
  if (isSingleTenant(row)) {
    const context = ctx == null ? createRouteContext() : ctx;
    const known = state != null && typeof state.cwd === 'string' && state.cwd !== '';
    const cwd = known ? state.cwd : (typeof readCwd === 'function' ? readCwd() : null);
    const key = cwd == null ? null : routeKeyForDir(cwd, context);
    // A bound [] route stays honored (e.g. the clone was later deleted and the directory no longer
    // keys to the same rule) as long as its rule is still stored — the same test resolveTargets uses.
    const bound = state != null && state.route ? state.route[row.key] : null;
    if (bound != null && Array.isArray(bound.tenantIds) && bound.tenantIds.length === 0
      && rulesOf(row).some((r) => r.kind === bound.kind && r.match === bound.match && r.tenantIds.length === 0)) {
      return { tenantIds: [], source: 'rule', pending: false, key };
    }
    const rule = routeForDir(row, cwd, context);
    if (rule != null && rule.tenantIds.length === 0) return { tenantIds: [], source: 'rule', pending: false, key };
    return { tenantIds: [null], source: 'single', pending: false, key: null };
  }
  let key = null;
  if (rulesOf(row).length > 0) {
    const context = ctx == null ? createRouteContext() : ctx;
    const known = state != null && typeof state.cwd === 'string' && state.cwd !== '';
    const cwd = known ? state.cwd : (typeof readCwd === 'function' ? readCwd() : null);
    key = cwd == null ? null : routeKeyForDir(cwd, context);
    const rule = routeForDir(row, cwd, context);
    if (rule != null) {
      const tenantIds = resolveTargets(row, { route: { [row.key]: rule } }).targets;
      return { tenantIds, source: 'rule', pending: false, key };
    }
  }
  const fallback = resolveTargets(row, null);
  return { tenantIds: fallback.targets, source: fallback.source, pending: fallback.pendingAsk, key };
}

function safeReadState(readState, sessionId) {
  try { return readState(sessionId); } catch { return null; }
}

// sessionId → routePastSession result for every transcript entry; readState(sessionId), readCwd(transcriptPath).
export function planSessionRoutes(row, entries, ctx, { readState = readSessionWorkspace, readCwd = firstRecordedCwd } = {}) {
  const context = ctx == null ? createRouteContext() : ctx;
  const needsState = usesRules(row);
  const routes = new Map();
  for (const entry of entries || []) {
    if (entry == null || entry.sessionId == null) continue;
    const state = needsState ? safeReadState(readState, entry.sessionId) : null;
    const route = routePastSession(row, { sessionId: entry.sessionId, state, readCwd: () => readCwd(entry.transcriptPath) }, context);
    routes.set(entry.sessionId, route);
  }
  return routes;
}

// The one "waiting" test, shared by `routes` and the backfill seal hold so a pull is held only for what `routes` asks about: New folders is Ask me, settled, readable, pending, and in no workspace's ledger.
// Map<sessionId, key> plus `noDirectory` (waiting with no recorded directory); `routes` option reuses planSessionRoutes results.
export function waitingRoutes(row, entries, ctx, {
  liveSessionId = null,
  now = Date.now,
  loadLedgerImpl = loadLedger,
  readState = readSessionWorkspace,
  readCwd = firstRecordedCwd,
  routes = null,
} = {}) {
  const waiting = new Map();
  waiting.noDirectory = 0;
  if (!isMultiTenant(row) || newFoldersOf(row).mode !== 'ask') return waiting;
  const context = ctx == null ? createRouteContext() : ctx;
  const identity = row.clientId == null ? null : row.clientId;
  const ledgers = tenantsOf(row).map((t) => loadLedgerImpl(row.key, identity, t.id));
  const nowMs = typeof now === 'function' ? now() : now;
  for (const entry of entries || []) {
    if (entry == null || entry.sessionId == null) continue;
    if (liveSessionId != null && entry.sessionId === liveSessionId) continue;
    if (nowMs - entry.mtimeMs < ACTIVE_SESSION_WINDOW_MS) continue;
    if (entry.size > MAX_TRANSCRIPT_BYTES) continue;
    if (ledgers.some((ledger) => isImported(ledger, entry.sessionId))) continue;
    let cwd = null;
    let cwdRead = false;
    const cwdOnce = () => {
      if (!cwdRead) { cwdRead = true; cwd = readCwd(entry.transcriptPath); }
      return cwd;
    };
    let state;
    const stateOnce = () => {
      if (state === undefined) state = safeReadState(readState, entry.sessionId);
      return state;
    };
    const route = routes != null && routes.has(entry.sessionId)
      ? routes.get(entry.sessionId)
      : routePastSession(row, { sessionId: entry.sessionId, state: stateOnce(), readCwd: cwdOnce }, context);
    if (route.source !== 'pending') continue;
    let key = route.key;
    if (key == null) {
      const known = stateOnce();
      const dir = known != null && typeof known.cwd === 'string' && known.cwd !== '' ? known.cwd : cwdOnce();
      key = dir == null ? null : routeKeyForDir(dir, context);
    }
    if (key == null) { waiting.noDirectory += 1; continue; }
    waiting.set(entry.sessionId, key);
  }
  return waiting;
}

// Repos/folders (and `outside`) whose waiting past sessions (see waitingRoutes) have no rule, most sessions first.
// Returns [{kind, match, label, sessions (count)}]; the array's `noDirectory` counts sessions with no recorded directory.
export function planUnruledRoutes(row, entries, ctx, options = {}) {
  const waiting = waitingRoutes(row, entries, ctx, options);
  const groups = [];
  groups.noDirectory = waiting.noDirectory;
  const byKey = new Map();
  for (const key of waiting.values()) {
    const id = `${key.kind}\n${key.match}`;
    let group = byKey.get(id);
    if (group == null) {
      group = { kind: key.kind, match: key.match, label: key.label, sessions: 0 };
      byKey.set(id, group);
      groups.push(group);
    }
    group.sessions += 1;
  }
  groups.sort((a, b) => b.sessions - a.sessions || (a.label < b.label ? -1 : (a.label > b.label ? 1 : 0)));
  return groups;
}

// The re-pick pass's places: the rule or rule-less place of every recent session (no ledger filter, most sessions first), then stored rules with none.
// Returns [{kind, match, label, sessions}].
export function planReviewPlaces(row, entries, ctx, {
  liveSessionId = null,
  now = Date.now,
  readState = readSessionWorkspace,
  readCwd = firstRecordedCwd,
} = {}) {
  const context = ctx == null ? createRouteContext() : ctx;
  const nowMs = typeof now === 'function' ? now() : now;
  const places = [];
  const byKey = new Map();
  const add = (key, n) => {
    const id = `${key.kind}\n${key.match}`;
    let place = byKey.get(id);
    if (place == null) {
      place = { kind: key.kind, match: key.match, label: key.label, sessions: 0 };
      byKey.set(id, place);
      places.push(place);
    }
    place.sessions += n;
  };
  for (const entry of entries || []) {
    if (entry == null || entry.sessionId == null) continue;
    if (liveSessionId != null && entry.sessionId === liveSessionId) continue;
    if (nowMs - entry.mtimeMs < ACTIVE_SESSION_WINDOW_MS) continue;
    if (nowMs - entry.mtimeMs > REVIEW_WINDOW_MS) continue;
    if (entry.size > MAX_TRANSCRIPT_BYTES) continue;
    const state = safeReadState(readState, entry.sessionId);
    const dir = state != null && typeof state.cwd === 'string' && state.cwd !== '' ? state.cwd : readCwd(entry.transcriptPath);
    if (dir == null) continue;
    const key = routeForDir(row, dir, context) || routeKeyForDir(dir, context);
    if (key != null) add(key, 1);
  }
  places.sort((a, b) => b.sessions - a.sessions || (a.label < b.label ? -1 : (a.label > b.label ? 1 : 0)));
  for (const rule of rulesOf(row)) add(rule, 0);
  return places;
}

// Where a place sends today: its rule (unless every workspace it names was left), else New folders, else under Ask me the one workspace the account had before the new ones, else pending.
export function placeNow(row, place, newIds) {
  const members = (tenantsOf(row) || []).map((t) => t.id);
  for (const rule of rulesOf(row)) {
    if (rule.kind !== place.kind || rule.match !== place.match) continue;
    const ids = rule.tenantIds.filter((id) => members.indexOf(id) !== -1);
    if (rule.tenantIds.length === 0 || ids.length > 0) return { ids, pending: false };
  }
  const newFolders = newFoldersOf(row);
  if (newFolders.mode === 'send') return { ids: newFolders.tenantIds, pending: false };
  if (newFolders.mode === 'none') return { ids: [], pending: false };
  const before = members.filter((id) => newIds.indexOf(id) === -1);
  return before.length === 1 ? { ids: before, pending: false } : { ids: [], pending: true };
}

// Under Ask me, the rules that keep rule-less places (a rule naming only left workspaces counts as none) sending where they send now; pending places get none.
export function keepCurrentRules(row, places, newIds) {
  if (newIds.length === 0 || newFoldersOf(row).mode !== 'ask') return [];
  const members = (tenantsOf(row) || []).map((t) => t.id);
  const live = (r) => r.tenantIds.length === 0 || r.tenantIds.some((id) => members.indexOf(id) !== -1);
  const stored = rulesOf(row);
  const out = [];
  for (const place of places) {
    if (stored.some((r) => r.kind === place.kind && r.match === place.match && live(r))) continue;
    const now = placeNow(row, place, newIds);
    if (now.pending || now.ids.length === 0) continue;
    out.push({ kind: place.kind, match: place.match, label: place.label, tenantIds: now.ids });
  }
  return out;
}

const cell = (text) => String(text).replace(/\|/g, '\\|');
// An empty cell stays one space wide, so the header's unnamed column reads `| |`.
const tableRow = (cells) => `|${cells.map((c) => (c === '' ? ' ' : ` ${cell(c)} `)).join('|')}|`;
const sessionsText = (n) => `${n} session${n === 1 ? '' : 's'}`;
const HERE_MARK = '← you\'re here';

function samePlace(rule, place) {
  if (rule.kind !== place.kind) return false;
  if (rule.kind === 'repo') return String(rule.match).toLowerCase() === String(place.match).toLowerCase();
  return rule.kind === 'outside' || normPath(rule.match) === normPath(place.match);
}

// Last-30-days sessions from planReviewPlaces: { rules: Map<index, n>, default: n }; a place equal to a stored rule counts for it, the rest for Default.
export function ruleSessionCounts(row, places) {
  const stored = rulesOf(row);
  const counts = { rules: new Map(stored.map((r) => [r.index, 0])), default: 0 };
  for (const place of places) {
    const rule = stored.find((r) => samePlace(r, place));
    if (rule == null) counts.default += place.sessions;
    else counts.rules.set(rule.index, counts.rules.get(rule.index) + place.sessions);
  }
  return counts;
}

// "You're in **labacus-suite**, a git repo at ~/work/labacus-suite." and why its analytics go where they go.
export function hereSentences(row, place, route) {
  const at = place.path == null ? '' : ` at ${place.path}`;
  const first = place.kind === 'outside'
    ? 'You\'re outside a project folder (home, / or a temp folder).'
    : `You're in **${place.short}**, ${kindWords(place)}${at}.`;
  return [first, whySentence(row, route)];
}

function whySentence(row, route) {
  const reason = route.reason;
  const to = routeTarget(row, route);
  // Audit mode or disabled: a one-workspace account sends no new sessions, whatever the default says.
  if (isSingleTenant(row) && route.ids.length > 0 && !isLiveTrackingAllowed(readTrackingState(row.key))) {
    return 'Live tracking is off for this workspace, so new sessions are not sent; these rules apply when history is uploaded.';
  }
  if (reason.kind === 'pending') return 'It has no rule yet. Beezi asks where its analytics go when a session starts here.';
  if (reason.kind === 'rule') {
    const wider = reason.own === false;
    const name = wider ? `Rule R${reason.index} for ${reason.short} covers it` : `Rule R${reason.index}`;
    if (route.ids.length === 0) return wider ? `${name}: nothing is sent.` : `${name} stops tracking it: nothing is sent.`;
    return wider ? `${name} and sends its analytics to ${to}.` : `${name} sends its analytics to ${to}.`;
  }
  if (!isMultiTenant(row)) return `Its sessions send analytics to ${to}, the default for every repo and folder.`;
  return route.ids.length === 0
    ? 'It has no rule of its own, and the default is Don\'t send: nothing is sent.'
    : `It has no rule of its own, so the default applies: analytics go to ${to}.`;
}

// Where Default sends: the one workspace, New folders' workspaces, "not tracked" or "ask me".
export function defaultTarget(row) {
  const route = defaultRoute(row);
  return route.reason.kind === 'pending' ? 'ask me' : routeTarget(row, route);
}

// The user-facing rules table, as lines: accounts with known workspaces, no machine fields.
// options: `entries` (transcripts; default every one on this machine) and planReviewPlaces' own options.
export function rulesTableLines(rows, dir, ctx, options = {}) {
  const known = rows.filter((row) => isMultiTenant(row) || isSingleTenant(row));
  if (known.length === 0) return ['Rules need the account\'s workspaces, which are not known yet. Start a new session and try again.'];
  const { entries = null, ...planOptions } = options;
  const transcripts = entries == null ? listAllTranscripts() : entries;
  const context = ctx == null ? createRouteContext() : ctx;
  const place = placeOfDir(dir, context);
  const out = [];
  known.forEach((row, i) => {
    if (known.length > 1) {
      if (i > 0) out.push('');
      out.push(`**${row.email || row.name || row.key}**`, '');
    }
    const route = place == null ? null : routeOfDir(row, dir, context);
    if (route != null) out.push(...hereSentences(row, place, route), '');
    const hereRule = route != null && route.reason.kind === 'rule' ? route.reason.index : null;
    const mark = (isHere) => (route == null ? [] : [isHere ? HERE_MARK : '']);
    const counts = ruleSessionCounts(row, planReviewPlaces(row, transcripts, context, planOptions));
    const header = ['Rule', 'Repo or folder', 'Path or remote', 'Sends to', 'Last 30 days'].concat(route == null ? [] : ['']);
    out.push(tableRow(header), `|${header.map(() => '---').join('|')}|`);
    for (const r of rulesOf(row)) {
      const where = r.kind === 'outside' ? 'home, / or temp folders' : r.label;
      const sends = r.tenantIds.length === 0 ? 'not tracked' : joinTenantNames(row, r.tenantIds);
      out.push(tableRow([`R${r.index}`, shortLabel(r), where, sends, sessionsText(counts.rules.get(r.index))].concat(mark(hereRule === r.index))));
    }
    const scope = isMultiTenant(row) ? 'new repos and folders' : 'every repo and folder';
    out.push(tableRow(['Default', scope, '', defaultTarget(row), sessionsText(counts.default)].concat(mark(hereRule == null))));
  });
  return out;
}
