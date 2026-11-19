import fs from 'fs';
import { setupListingFile } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { readSessionWorkspace } from './workspace.mjs';
import { createRouteContext, routeForDir, routeKeyForDir, shortLabel } from './workspace-rules.mjs';
import { firstRecordedCwd, listAllTranscripts } from './transcript-index.mjs';
import { runAudit as _runAudit, AuditReason, createRunCache } from './session-audit.mjs';
import {
  OfferEngine, OfferGate, OfferVia, coverageUnknown, engineOf, engineRunOptions, offerGate, offerTenantKey, workspaceWhoami,
} from './history-offer.mjs';
import { offerTenantIds, offerTrackingOff } from './history-trigger.mjs';
import { readTrackingState } from './tracking.mjs';
import { readDeclinedIds } from './offer-declines.mjs';
import { pastSessionsFor } from './anonymization.mjs';
import { OFFER_COVERAGE_NOTE, StopStatus, freshOf, printStop, workspaceName } from './history-summary.mjs';

// The setup listing's places: what the past-sessions upload would send, grouped by the repo or folder it ran in.

const OPEN_GATES = [OfferGate.SCAN, OfferGate.READY];
// Rules are not applied to the count, so no route plan is needed.
const NO_ROUTES = () => ({ routes: new Map() });
// A match or label holding a control character could forge a machine line, so listings leave such a place out.
export const UNSAFE_LINE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// A match or label holding " <word>=" could be read as one of the T line's fields, so the setup listing leaves it out.
const FIELD_LIKE = / [\w-]+=/;
export const SETUP_BUSY_WAIT_MS = 60000;
export const SETUP_BUSY_POLL_MS = 2000;
const SETUP_BUSY_MAX_SLEEPS = SETUP_BUSY_WAIT_MS / SETUP_BUSY_POLL_MS;

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// runAudit run again every poll while it answers busy, under one deadline and sleep count shared by every call.
export function retryWhileBusy(runAuditImpl, deps) {
  const runAudit = runAuditImpl == null ? _runAudit : runAuditImpl;
  const now = deps.now == null ? Date.now : deps.now;
  const sleep = deps.sleep == null ? sleepFor : deps.sleep;
  let firstAttempt = null;
  let sleeps = 0;
  return async (runDeps, options) => {
    if (firstAttempt == null) firstAttempt = now();
    for (;;) {
      const result = await runAudit(runDeps, options);
      if (result.reason !== AuditReason.BUSY || now() - firstAttempt >= SETUP_BUSY_WAIT_MS || sleeps >= SETUP_BUSY_MAX_SLEEPS) return result;
      sleeps += 1;
      await sleep(SETUP_BUSY_POLL_MS);
    }
  };
}

// The workspaces whose past-session offer gate is open: the ones the upload may count and send to.
export function openTenantIds(row) {
  const tracking = readTrackingState(row.key);
  return offerTenantIds(row)
    .filter((tenantId) => OPEN_GATES.indexOf(offerGate(row, tenantId, { trackingOff: offerTrackingOff(row, tracking, tenantId) })) !== -1);
}

// One workspace's dry run without routes or Don't-track exclusions, less declined sessions; null after printing a failed count.
async function plannedFor(row, tenantId, runCache, deps) {
  const who = await workspaceWhoami(row, tenantId, deps);
  const engine = engineOf(who);
  const options = engineRunOptions(row, tenantId, OfferVia.LOGIN, engine, { ...deps, planWorkspaceRuns: NO_ROUTES });
  delete options.sessionRoutes;
  delete options.excludedSessionIds;
  const result = await deps.runAudit({ runCache, whoamiImpl: async () => who }, { ...options, dryRun: true });
  if (result.reason != null || result.halt != null) {
    const stop = printStop(result, { via: OfferVia.LOGIN, workspace: workspaceName(row, tenantId), dryRun: true });
    return stop === StopStatus.FAILED ? null : [];
  }
  if (engine === OfferEngine.SYNC && coverageUnknown(result)) {
    console.log(OFFER_COVERAGE_NOTE);
    return null;
  }
  const declined = readDeclinedIds(row.key, offerTenantKey(row, tenantId), pastSessionsFor(freshOf(row, who), tenantId).changedAt);
  return result.plannedSessions.filter((s) => !declined.has(s.sessionId));
}

// sessionId → startedAtMs over every workspace the upload could send to; null when one could not count.
async function plannedSessions(row, deps) {
  const runCache = createRunCache();
  const runAudit = retryWhileBusy(deps.runAudit, deps);
  const planned = new Map();
  for (const tenantId of openTenantIds(row)) {
    const sessions = await plannedFor(row, tenantId, runCache, { ...deps, runAudit });
    if (sessions == null) return null;
    for (const s of sessions) if (!planned.has(s.sessionId)) planned.set(s.sessionId, s.startedAtMs);
  }
  return planned;
}

function sessionDir(entry) {
  const state = readSessionWorkspace(entry.sessionId);
  return state != null && typeof state.cwd === 'string' && state.cwd !== '' ? state.cwd : firstRecordedCwd(entry.transcriptPath);
}

const listable = (text) => !UNSAFE_LINE.test(text) && !FIELD_LIKE.test(text);

// The listing's sessions among `ids` (byId → { key, dir }) and noFolder; not indexed (Cowork) or unsafe names are in neither.
function listedSessions(ids, ctx) {
  const byId = new Map();
  let noFolder = 0;
  for (const entry of listAllTranscripts()) {
    if (!ids.has(entry.sessionId)) continue;
    const dir = sessionDir(entry);
    const key = dir == null ? null : routeKeyForDir(dir, ctx);
    if (key == null) noFolder += 1;
    else if (listable(key.match) && listable(key.label)) byId.set(entry.sessionId, { key, dir });
  }
  return { byId, noFolder };
}

// Whether two rules' workspaces agree: both no rule, or the same ids.
function sameRoute(a, b) {
  if (a == null || b == null) return a == null && b == null;
  return a.slice().sort().join(',') === b.slice().sort().join(',');
}

const outsideLast = (place) => (place.kind === 'outside' ? 1 : 0);

function byListOrder(a, b) {
  return outsideLast(a) - outsideLast(b) || b.sessions - a.sessions || (a.label < b.label ? -1 : Number(a.label > b.label));
}

// Places with an upload-eligible session, most sessions first, outside last; `tracked` is the rule's workspaces, null for no rule or disagreeing rules.
export async function setupPlaces(row, deps = {}) {
  const planned = await plannedSessions(row, deps);
  if (planned == null) return null;
  const ctx = createRouteContext();
  const listed = listedSessions(planned, ctx);
  const byKey = new Map();
  const starts = [];
  for (const [sessionId, { key, dir }] of listed.byId) {
    const id = `${key.kind}\n${key.match}`;
    const rule = routeForDir(row, dir, ctx);
    const tracked = rule == null ? null : rule.tenantIds;
    let place = byKey.get(id);
    if (place == null) {
      place = { kind: key.kind, match: key.match, short: shortLabel(key), label: key.label, sessions: 0, tracked };
      byKey.set(id, place);
    } else if (!sameRoute(place.tracked, tracked)) {
      place.tracked = null;
    }
    place.sessions += 1;
    starts.push(planned.get(sessionId));
  }
  return {
    places: Array.from(byKey.values()).sort(byListOrder),
    sessionIds: Array.from(listed.byId.keys()),
    firstMs: starts.length === 0 ? null : starts.reduce((a, b) => Math.min(a, b)),
    lastMs: starts.length === 0 ? null : starts.reduce((a, b) => Math.max(a, b)),
    noFolder: listed.noFolder,
  };
}

// Saves what the listing showed: its session ids and each workspace's hidden kinds, unanswered.
export function saveSetupListing(key, sessionIds, kinds, nowIso = new Date().toISOString()) {
  writeJsonSecure(setupListingFile(key), { version: 1, listedAt: nowIso, answeredAt: null, sessionIds, kinds });
}

// Marks the saved listing answered; nothing when there is none.
export function markSetupListingAnswered(key, nowIso = new Date().toISOString()) {
  const listing = readJson(setupListingFile(key), null);
  if (listing != null) writeJsonSecure(setupListingFile(key), { ...listing, answeredAt: nowIso });
}

// The saved listing once its question was answered, else null.
export function answeredSetupListing(key) {
  const listing = readJson(setupListingFile(key), null);
  if (listing == null || listing.version !== 1 || typeof listing.answeredAt !== 'string' || !Array.isArray(listing.sessionIds)) return null;
  return { sessionIds: listing.sessionIds, kinds: listing.kinds != null && typeof listing.kinds === 'object' ? listing.kinds : {} };
}

export function removeSetupListing(key) {
  try {
    fs.unlinkSync(setupListingFile(key));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
