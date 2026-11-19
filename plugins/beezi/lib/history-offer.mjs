import fs from 'fs';
import crypto from 'crypto';
import { historyOfferFile } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { SOLO_KEY } from './offer-gate.mjs';
import { isMultiTenant, linkedToTenantMs } from './workspace.mjs';
import { usesRules } from './workspace-rules.mjs';
import { planWorkspaceRuns, dontTrackSessionIds, SYNC_MODE } from './session-audit.mjs';
import { sessionFor as _sessionFor } from './sessions.mjs';
import { whoami as _whoami } from './whoami.mjs';
import { TrackingMode } from './tracking.mjs';
import { AnonKind } from './anonymize.mjs';

export { OfferGate, offerTenantKey, isRemembered, offerGate } from './offer-gate.mjs';

const SYNC_COMMAND = '/beezi:sync';
const MAX_FOLDER_NAMES = 3;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// K7 L3/L4 items in order, each with the kind that hides it.
const KIND_ITEMS = [
  [AnonKind.REPOS, 'folder and repository names'],
  [AnonKind.BRANCHES, 'branch names'],
  [AnonKind.HOSTS, 'computer name'],
  [AnonKind.ACCOUNTS, 'account email'],
];
// The hidden name kinds in order; a workspace's one-line summary words each by its kind name, hosts as computer names.
const NAME_KINDS = [AnonKind.REPOS, AnonKind.BRANCHES, AnonKind.HOSTS, AnonKind.ACCOUNTS];
const nameWord = (kind) => (kind === AnonKind.HOSTS ? 'computer names' : kind);

// Where an offer was asked: the login flow, /beezi:sync, or the session-start question.
export const OfferVia = Object.freeze({ LOGIN: 'login', SYNC: 'sync', SESSION: 'session' });

// The runAudit engine an offer was counted with: Audit workspaces take the one-time backfill, the rest sync.
export const OfferEngine = Object.freeze({ SYNC: 'sync', BACKFILL: 'backfill' });

export function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function listText(items) {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function dayLabel(ms, withYear) {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${withYear ? ` ${d.getFullYear()}` : ''}`;
}

function rangeText(firstMs, lastMs) {
  const withYear = new Date(firstMs).getFullYear() !== new Date(lastMs).getFullYear();
  const first = dayLabel(firstMs, withYear);
  const last = dayLabel(lastMs, withYear);
  return first === last ? first : `${first} – ${last}`;
}

// Folders without a recorded name still count as sessions but are left out of H2 and F; none named drops both.
function folderNames(folders) {
  return folders.map((f) => f.name).filter((name) => typeof name === 'string' && name !== '');
}

// H2: up to three names, then +k more for the rest.
function folderLine(names) {
  const more = names.length - MAX_FOLDER_NAMES;
  return `  in ${names.slice(0, MAX_FOLDER_NAMES).join(', ')}${more > 0 ? ` +${more} more` : ''}`;
}

// Hidden items two per line, the odd last one alone.
function pairLines(items) {
  const lines = [];
  for (let i = 0; i < items.length; i += 2) lines.push(`    ◆ ${items.slice(i, i + 2).join(', ')}`);
  return lines;
}

// The K7-C checklist: plain lines with their two- and four-space indents, then the question.
export function offerLines({ count, firstMs, lastMs, folders, kinds, workspace }) {
  const hidden = KIND_ITEMS.filter(([kind]) => kinds.indexOf(kind) !== -1).map(([, item]) => item);
  const notHidden = KIND_ITEMS.filter(([kind]) => kinds.indexOf(kind) === -1).map(([, item]) => item);
  const names = folderNames(folders);
  const span = names.length > 0 ? `${rangeText(firstMs, lastMs)}, ${plural(names.length, 'folder')}` : rangeText(firstMs, lastMs);
  const sessionsOn = kinds.indexOf(AnonKind.SESSIONS) !== -1;
  const lines = [`Beezi found ${plural(count, 'past Claude Code session')} (${span})`];
  if (names.length > 0) lines.push(folderLine(names));
  lines.push('  Sent', '    ✓ dates, duration, models, tokens, cost', '    ✓ tool, skill and MCP names');
  if (notHidden.length > 0) lines.push(`    ✓ ${listText(notHidden)}, as they are`);
  if (!sessionsOn) {
    lines.push('    ✓ session titles (Claude Code uses your first message when a session has no title), error messages (up to 1,000 characters) and subagent task descriptions, as written');
  }
  if (hidden.length > 0) lines.push('  Hidden by your workspace — Beezi gets made-up names', ...pairLines(hidden));
  if (sessionsOn) lines.push('  Never sent', '    ✕ session titles, error messages and task descriptions');
  const question = count === 1 ? `Upload this session to ${workspace}?` : `Upload ${count} sessions to ${workspace}?`;
  return { lines, question };
}

// What a workspace hides, in one phrase for the combined layout.
export function hidesPhrase(kinds) {
  const names = NAME_KINDS.filter((kind) => kinds.indexOf(kind) !== -1).map(nameWord);
  const titles = kinds.indexOf(AnonKind.SESSIONS) !== -1;
  if (names.length === 0) return titles ? 'names as they are, titles never sent' : 'names and titles as they are';
  return `made-up names for ${listText(names)}${titles ? ', titles never sent' : ''}`;
}

// The combined layout's header over the offers' distinct session ids and their widest range.
export function combinedHeader(offers) {
  const count = new Set(offers.flatMap((offer) => offer.sessionIds)).size;
  const firstMs = Math.min(...offers.map((offer) => offer.firstMs));
  const lastMs = Math.max(...offers.map((offer) => offer.lastMs));
  return [
    `Beezi found ${plural(count, 'past Claude Code session')} (${rangeText(firstMs, lastMs)})`,
    '  Always sent: dates, duration, models, tokens, cost, tool, skill and MCP names',
  ];
}

// The no-ask progress line over the workspaces' names.
export function progressLine(n, names) {
  return `Uploading ${plural(n, 'session')} to ${listText(names)}…`;
}

export function noticeLines(workspace, n) {
  return [`${workspace} uploads past sessions without asking, so there's no question.`, progressLine(n, [workspace])];
}

export function uploadedLine(results) {
  const parts = results.map(({ workspace, n }, i) => `${i === 0 ? plural(n, 'session') : n} to ${workspace}`);
  return `✓ Uploaded ${listText(parts)}.`;
}

export function declineLine(audit) {
  return audit
    ? `Your audit reads only past sessions, so it stays empty until you upload. Run ${SYNC_COMMAND} any time.`
    : `Not uploaded. Run ${SYNC_COMMAND} any time to upload them.`;
}

function offerFile(key, tenantKey) {
  return historyOfferFile(key, tenantKey === SOLO_KEY ? null : tenantKey);
}

const digest = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);

// The token of an offer file's session ids alone: the scan's ready token and the compare-and-clear check.
export function idsToken(sessionIds) {
  return digest(sessionIds.join('\n'));
}

// The token an <offer> block's commands carry: its session ids and, after a NUL, the sorted kinds it showed as hidden.
export function offerToken(sessionIds, shownKinds) {
  return digest(`${sessionIds.join('\n')}\0${shownKinds.slice().sort().join(',')}`);
}

// Whether a run of `sessionIds` answered the offer file now on disk: there is none, or it asks only about those sessions.
export function answeredBy(file, sessionIds) {
  return file == null || !Array.isArray(file.sessionIds) || file.sessionIds.every((id) => sessionIds.indexOf(id) !== -1);
}

export function readOffer(key, tenantKey) {
  return readJson(offerFile(key, tenantKey), null);
}

export function writeOffer(key, tenantKey, offer) {
  writeJsonSecure(offerFile(key, tenantKey), offer);
}

export function removeOffer(key, tenantKey) {
  try {
    fs.unlinkSync(offerFile(key, tenantKey));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

// One workspace's runAudit options for an offer's dry run and its Upload replay.
export function offerRunOptions(row, tenantId, via, deps = {}) {
  const planRuns = deps.planWorkspaceRuns == null ? planWorkspaceRuns : deps.planWorkspaceRuns;
  const multi = isMultiTenant(row);
  const options = {
    account: row.key,
    tenantId: multi ? tenantId : null,
    mode: SYNC_MODE,
    liveOnly: true,
    historyCutoffMs: via === OfferVia.SYNC ? null : linkedToTenantMs(row, tenantId, deps),
  };
  if (multi) options.sessionRoutes = planRuns(row).routes;
  else if (usesRules(row)) options.excludedSessionIds = dontTrackSessionIds(planRuns(row));
  return options;
}

// A sync run with candidates that could not learn what the server holds (a run with none never asks).
export function coverageUnknown(result) {
  return result.coverageKnown !== true && result.candidates > 0;
}

// One workspace's runAudit options under `engine`; the backfill engine has no sync mode, live-only stop or cutoff.
export function engineRunOptions(row, tenantId, via, engine, deps = {}) {
  const options = offerRunOptions(row, tenantId, via, deps);
  if (engine === OfferEngine.BACKFILL) {
    delete options.mode;
    delete options.liveOnly;
    delete options.historyCutoffMs;
  }
  return options;
}

// The Upload of a stored or accepted offer: its engine and cutoff and its session ids.
export function replayOptions(row, tenantId, replay, deps = {}) {
  const options = engineRunOptions(row, tenantId, replay.via, replay.engine, deps);
  if (replay.engine !== OfferEngine.BACKFILL) options.historyCutoffMs = replay.historyCutoffMs == null ? null : replay.historyCutoffMs;
  if (replay.override === true) delete options.sessionRoutes;
  options.onlySessionIds = Array.isArray(replay.sessionIds) ? replay.sessionIds : [];
  options.consented = true;
  return options;
}

// The workspace's own whoami, asked once with its header; null when it cannot be asked.
export async function workspaceWhoami(row, tenantId, deps = {}) {
  const sessionFor = deps.sessionFor == null ? _sessionFor : deps.sessionFor;
  const whoami = deps.whoami == null ? _whoami : deps.whoami;
  const live = await sessionFor(row.key).catch(() => null);
  if (live == null) return null;
  return whoami({ ...live, tenantId: isMultiTenant(row) ? tenantId : null }).catch(() => null);
}

// Audit is the workspace's whoami trackingMode; no answer is not Audit.
export function engineOf(who) {
  return who != null && who.valid === true && who.trackingMode === TrackingMode.BACKFILL_ONLY ? OfferEngine.BACKFILL : OfferEngine.SYNC;
}

// Named folders by session count, most first, then by name.
function folderCounts(planned) {
  const counts = new Map();
  for (const s of planned) {
    if (typeof s.folder === 'string' && s.folder !== '') counts.set(s.folder, (counts.get(s.folder) || 0) + 1);
  }
  return Array.from(counts, ([name, sessions]) => ({ name, sessions }))
    .sort((a, b) => b.sessions - a.sessions || (a.name < b.name ? -1 : Number(a.name > b.name)));
}

// What a dry run would send, as the offer file keeps it until a question records its shown kinds; `tenantId` is the real workspace id.
export function offerFromRun(result, { via, engine, tenantId, historyCutoffMs, override, changedAt, nowIso, active }) {
  const planned = result.plannedSessions;
  const starts = planned.map((s) => s.startedAtMs);
  return {
    createdAt: nowIso,
    via,
    engine,
    audit: engine === OfferEngine.BACKFILL,
    tenantId,
    historyCutoffMs: historyCutoffMs == null ? null : historyCutoffMs,
    override,
    changedAt,
    sessionIds: planned.map((s) => s.sessionId),
    firstMs: starts.reduce((a, b) => Math.min(a, b)),
    lastMs: starts.reduce((a, b) => Math.max(a, b)),
    folders: folderCounts(planned),
    active,
  };
}
