import {
  AccountStatus, listAccounts as _listAccounts, noteScanRetry, recordOfferReady, recordOfferSettled,
} from '../lib/accounts.mjs';
import { runAudit as _runAudit, planWorkspaceRuns as _planWorkspaceRuns } from '../lib/session-audit.mjs';
import {
  OfferVia, engineOf, engineRunOptions, offerFromRun, idsToken, workspaceWhoami,
  writeOffer as _writeOffer,
} from '../lib/history-offer.mjs';
import { classifyRun } from '../lib/pending-history-run.mjs';
import {
  RunOutcome, HISTORY_BUSY_RETRY_MS, HISTORY_REFUSED_RETRY_MS, HISTORY_WATCHDOG_MS,
} from '../lib/pending-history.mjs';
import { readDeclinedIds } from '../lib/offer-declines.mjs';
import { isRemembered, offerStateOf } from '../lib/offer-gate.mjs';
import { pastSessionsFor } from '../lib/anonymization.mjs';
import { readTrackingState as _readTrackingState } from '../lib/tracking.mjs';
import { recordIssue as _recordIssue } from '../lib/telemetry.mjs';
import { DIAGNOSTIC_CODES, DIAGNOSTIC_SOURCES } from '../lib/telemetry-codes.mjs';
import { tenantsOf } from '../lib/workspace.mjs';
import { createRouteContext, routeForDir } from '../lib/workspace-rules.mjs';
import {
  listAllTranscripts as _listAllTranscripts, firstRecordedCwd as _firstRecordedCwd,
} from '../lib/transcript-index.mjs';
import { workspacesAt } from '../lib/history-trigger.mjs';
import { isEntryScript } from '../lib/entry-script.mjs';
import { exitClean } from '../lib/shutdown.mjs';

// Detached: dry-runs each workspace waiting at SCAN and stores its offer or settles it. Spawned by SessionStart and rule writes.
const RETRY_AFTER_MS = Object.freeze({ [RunOutcome.BUSY]: HISTORY_BUSY_RETRY_MS, [RunOutcome.REFUSED]: HISTORY_REFUSED_RETRY_MS });

// Whether a session's directory falls under a re-opened place, matched as a rule for that place would match it.
// Transcripts are listed on first use.
function placeTester(row, deps = {}) {
  const listAllTranscripts = deps.listAllTranscripts == null ? _listAllTranscripts : deps.listAllTranscripts;
  const firstRecordedCwd = deps.firstRecordedCwd == null ? _firstRecordedCwd : deps.firstRecordedCwd;
  const ctx = createRouteContext();
  let paths = null;
  const cwds = new Map();
  const cwdOf = (sessionId) => {
    if (!cwds.has(sessionId)) {
      if (paths == null) paths = new Map(listAllTranscripts().map((e) => [e.sessionId, e.transcriptPath]));
      const transcriptPath = paths.get(sessionId);
      cwds.set(sessionId, transcriptPath == null ? null : firstRecordedCwd(transcriptPath));
    }
    return cwds.get(sessionId);
  };
  return (sessionId, place) => {
    const cwd = cwdOf(sessionId);
    const probe = { tenants: tenantsOf(row), workspaceRules: [{ kind: place.kind, match: place.match, tenantIds: [] }] };
    return cwd != null && routeForDir(probe, cwd, ctx) != null;
  };
}

function reaches(sessionId, route, place, inPlace) {
  if (place.kind === 'new-folders') return route.source === 'new-folders';
  if (route.key != null && route.key.kind === place.kind && route.key.match === place.match) return true;
  return inPlace(sessionId, place);
}

// A re-open after a remembered decline or settle lists only the re-opened places' sessions; null lists every session.
export function reopenedSessionIds(routes, offerState, changedAt, inPlace) {
  const reopen = Array.isArray(offerState.reopen) ? offerState.reopen : [];
  if (reopen.length === 0) return null;
  if (!isRemembered(offerState.declined, changedAt) && !isRemembered(offerState.settled, changedAt)) return null;
  return [...routes]
    .filter(([sessionId, route]) => reopen.some((place) => reaches(sessionId, route, place, inPlace)))
    .map(([sessionId]) => sessionId);
}

// A stored retry time still ahead holds the workspace back; noteOfferScan clears it on the workspaces it hands this worker.
function retryPending(row, tenantId, nowMs) {
  return Date.parse(offerStateOf(row, tenantId).retryAt) > nowMs;
}

async function scanWorkspace(row, { tenantId, tenantKey }, { plan, inPlace, nowMs }, deps) {
  const runAudit = deps.runAudit == null ? _runAudit : deps.runAudit;
  const writeOffer = deps.writeOffer == null ? _writeOffer : deps.writeOffer;
  const who = await workspaceWhoami(row, tenantId, deps);
  const engine = engineOf(who);
  const options = engineRunOptions(row, tenantId, OfferVia.SESSION, engine, { planWorkspaceRuns: () => plan });
  const { changedAt } = pastSessionsFor(row, tenantId);
  const offerState = offerStateOf(row, tenantId);
  const onlySessionIds = reopenedSessionIds(plan.routes, offerState, changedAt, inPlace);
  if (onlySessionIds != null) options.onlySessionIds = onlySessionIds;
  const result = await runAudit({ whoamiImpl: async () => who }, { ...options, dryRun: true });
  const outcome = classifyRun(result, false, engine);
  // Busy and refused runs come back after their retry; failed or uncounted runs after the hourly scan.
  if (RETRY_AFTER_MS[outcome] != null) await noteScanRetry(row.key, tenantKey, new Date(nowMs + RETRY_AFTER_MS[outcome]).toISOString());
  if (outcome !== RunOutcome.CLEAN) return;
  const declined = readDeclinedIds(row.key, tenantKey, changedAt);
  const plannedSessions = result.plannedSessions.filter((s) => !declined.has(s.sessionId));
  // Nothing to offer settles the workspace but leaves any offer file: it may be a question still waiting for its answer.
  if (plannedSessions.length === 0) {
    if (result.active === 0) await recordOfferSettled(row.key, tenantKey, { changedAt, handled: offerState.reopen });
    return;
  }
  const offer = offerFromRun({ ...result, plannedSessions }, {
    via: OfferVia.SESSION, engine, tenantId, historyCutoffMs: options.historyCutoffMs, override: false, changedAt,
    nowIso: new Date(nowMs).toISOString(), active: result.active,
  });
  writeOffer(row.key, tenantKey, offer);
  await recordOfferReady(row.key, tenantKey, { changedAt, token: idsToken(offer.sessionIds) });
}

// Each of the account's workspaces still at SCAN, one at a time; transcripts are planned once for all of them.
export async function runHistoryScan(key, deps = {}) {
  const listAccounts = deps.listAccounts == null ? _listAccounts : deps.listAccounts;
  const readTrackingState = deps.readTrackingState == null ? _readTrackingState : deps.readTrackingState;
  const planWorkspaceRuns = deps.planWorkspaceRuns == null ? _planWorkspaceRuns : deps.planWorkspaceRuns;
  const recordIssue = deps.recordIssue == null ? _recordIssue : deps.recordIssue;
  const row = (await listAccounts()).find((a) => a.key === key && a.status === AccountStatus.LINKED);
  if (row == null) return;
  const nowMs = deps.now == null ? Date.now() : deps.now();
  const waiting = (await workspacesAt(row, readTrackingState(key), 'SCAN')).filter((w) => !retryPending(row, w.tenantId, nowMs));
  if (waiting.length === 0) return;
  const shared = { plan: planWorkspaceRuns(row), inPlace: placeTester(row, deps), nowMs };
  for (const workspace of waiting) {
    try {
      await scanWorkspace(row, workspace, shared, deps);
    } catch (error) {
      recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH, source: DIAGNOSTIC_SOURCES.BACKFILL, error });
    }
  }
}

function main() {
  let finished = false;
  let watchdog = null;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(watchdog);
    exitClean(0);
  };
  watchdog = setTimeout(finish, HISTORY_WATCHDOG_MS);
  process.on('uncaughtException', finish);
  process.on('unhandledRejection', finish);
  const at = process.argv.indexOf('--account');
  const key = at === -1 ? null : process.argv[at + 1];
  (key == null ? Promise.resolve() : runHistoryScan(key)).then(finish, finish);
}

if (isEntryScript(import.meta.url)) main();
