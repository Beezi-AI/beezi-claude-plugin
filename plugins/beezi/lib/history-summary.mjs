import { runAudit as _runAudit, AuditReason } from './session-audit.mjs';
import { BackfillHalt } from './audit-flush.mjs';
import { describeAccount, markOfferAsked, recordOfferSettled, recordOfferRescan, requestConsentedHistory, settlePendingHistory } from './accounts.mjs';
import {
  OfferEngine, OfferVia, offerTenantKey, offerLines, readOffer, writeOffer, removeOffer, offerToken, offerFromRun,
  engineRunOptions, replayOptions, coverageUnknown, workspaceWhoami, engineOf, plural, answeredBy,
  hidesPhrase, combinedHeader, noticeLines, progressLine, listText, uploadedLine as uploadedTotalsLine,
} from './history-offer.mjs';
import { classifyRun, runWithProgress, workspaceName } from './pending-history-run.mjs';
import { createProgressWriter as _createProgressWriter, readProgress as _readProgress, isLive, markReported } from './upload-progress.mjs';
import { followUploads, plainLine, doneLine, REST_LINE } from './upload-progress-view.mjs';
import { RunOutcome, pendingHistoryOf } from './pending-history.mjs';
import { readDeclinedIds, rememberDeclined, forgetDeclined } from './offer-declines.mjs';
import { newFoldersOf } from './workspace.mjs';
import { anonymizationFor, kindsOf, pastSessionsFor } from './anonymization.mjs';
import { ANON_KINDS } from './anonymize.mjs';
import { pluginRoot } from './paths.mjs';
import { SOLO_KEY, offerStateOf, OfferMode, offerMode } from './offer-gate.mjs';
import { friendlyMessage } from './friendly-error.mjs';
import { oneLine } from './one-line.mjs';
import { isBusy } from './sync-loop.mjs';

// The per-workspace count, the output of an account's offers, and the accept of a printed offer, shared by backfill.mjs, sync.mjs and history.mjs.

export const CHANGED_LINE = 'Beezi: these past sessions changed after the question was shown, so nothing was uploaded. Run /beezi:sync to see them again.';
const COVERAGE_NOTE = '  Note: Beezi could not confirm what it already has, so this run resumed from local progress only.';
export const OFFER_COVERAGE_NOTE = '  Note: Beezi could not confirm what it already has, so it could not count past sessions. Nothing was uploaded; run /beezi:sync to try again.';
// The <ask> question, with "too" only when no-ask workspaces of the same account block uploaded first (R16).
const askQuestion = (afterUploads) => `Upload your past sessions to these workspaces${afterUploads ? ' too' : ''}?`;
// Ask-first workspaces per <ask> block, as the join picker splits its questions.
const ASK_PART_SIZE = 3;
const NO_ASK_GROUP = '  Uploading without a question — these workspaces chose that';
const ASK_GROUP = '  Asks you first';
// A followed upload's plain lines stop here: the tool call that runs the script times out.
const FOLLOW_CAP_MS = 100000;

export const StopStatus = Object.freeze({ NONE: 'none', DONE: 'done', FAILED: 'failed' });

// Printed commands spell the script path out: tool output does not expand ${CLAUDE_PLUGIN_ROOT}.
export const scriptCommand = (name) => `node "${pluginRoot()}/scripts/${name}"`;

// The upload-command of a script's printed offer, before its --offer token.
export const acceptPrefix = (script, row) => (tenantKey) => `${scriptCommand(script)} --account ${row.key} --accept ${tenantKey}`;

export function printProgress({ processed, total }) {
  console.log(`Beezi: ${processed}/${total} sessions read…`);
}

// A foreground upload through deps.runAudit that prints its progress and writes the record of `target` = { tenantId, workspace };
// it prints its own result, so the record finishes reported (the card and the prompt hook never repeat it).
export function foregroundRun(deps = {}) {
  const runAudit = deps.runAudit == null ? _runAudit : deps.runAudit;
  const createWriter = deps.createProgressWriter == null ? _createProgressWriter : deps.createProgressWriter;
  return (options, target, engine) => runWithProgress(
    runAudit, { onProgress: printProgress }, options, createWriter({ key: options.account, ...target }), { engine, reported: true },
  );
}

// Follows the upload writing `tenantKey`'s record from `sinceMs` with a plain line per change, then its done line (marking
// it reported), the cap line, or REST_LINE when the run left the rest to the worker. deps: log, follow, read, now, sleep.
export async function followRecord(row, tenantKey, sinceMs, deps = {}) {
  const log = deps.log == null ? console.log : deps.log;
  const follow = deps.follow == null ? followUploads : deps.follow;
  const read = deps.read == null ? _readProgress : deps.read;
  const now = deps.now == null ? Date.now : deps.now;
  const sleep = deps.sleep == null ? (ms) => new Promise((resolve) => setTimeout(resolve, ms)) : deps.sleep;
  const workspace = workspaceName(row, tenantIdOfKey(tenantKey));
  let last = null;
  const { timedOut, stopped } = await follow({
    key: row.key,
    tenantIds: [tenantKey],
    sinceMs,
    capMs: FOLLOW_CAP_MS,
    onUpdate: (record) => {
      last = record;
      log(plainLine(record));
    },
    onDone: (record) => {
      log(doneLine(record));
      // A failed mark only risks the next session start repeating this line.
      try { markReported(row.key, tenantKey); } catch {}
    },
    read,
    now,
    sleep,
  });
  if (stopped) log(REST_LINE);
  else if (timedOut) {
    log(last == null
      ? REST_LINE
      : `✓ ${last.processed} of ${last.total} past sessions uploaded to ${workspace}; the rest keeps uploading in the background`);
  }
}

// A /beezi:sync run that met another run's lock follows that run while it writes this workspace's live record; false
// when there is none, so the busy line is printed instead.
async function followRunning(row, tenantKey, deps) {
  const read = deps.read == null ? _readProgress : deps.read;
  const now = deps.now == null ? Date.now : deps.now;
  const record = read(row.key, tenantKey);
  if (record == null || !isLive(record, now())) return false;
  await followRecord(row, tenantKey, Date.parse(record.startedAt), deps);
  return true;
}

// A summary's last line: the ask-first workspaces asked, then the no-ask workspaces noticed (R9).
export function printCounts({ offers, notices }) {
  console.log(`offers=${offers} notices=${notices}`);
}

// The value after `name`, or null when the flag is absent.
export function flagValue(args, name) {
  const at = args.indexOf(name);
  return at === -1 || at + 1 >= args.length ? null : args[at + 1];
}

// The workspace a tenant key stands for; 'solo' (an account with no workspace list or id) stands for none.
export function tenantIdOfKey(tenantKey) {
  return tenantKey === SOLO_KEY ? null : tenantKey;
}

export { workspaceName };

export function nothingLine(row, tenantId) {
  return `Beezi: nothing to upload for ${workspaceName(row, tenantId)}. Run /beezi:sync to check again.`;
}

// An upload answers only the question it was shown with: the token must match the stored offer's sessions and shown kinds.
export function matchesShown(offer, token) {
  return token != null && token === offerToken(offer.sessionIds, shownKindsOf(offer));
}

// The kinds an offer's question hid; a file that does not record them counts as all five hidden.
export function shownKindsOf(file) {
  return Array.isArray(file.shownKinds) ? file.shownKinds : ANON_KINDS.slice();
}

// The choice stamp an offer was counted under, the fresh whoami's when its run had one (F4 (#21)); else the cached row's.
export function offerChangedAt(row, tenantId, offer) {
  return offer == null || offer.changedAt === undefined ? pastSessionsFor(row, tenantId).changedAt : offer.changedAt;
}

// Writes the shown offer and remembers it as declined until an Upload answers it; the token its commands carry.
async function recordAsked(row, tenantId, offer) {
  const tenantKey = offerTenantKey(row, tenantId);
  const changedAt = offerChangedAt(row, tenantId, offer);
  writeOffer(row.key, tenantKey, offer);
  await markOfferAsked(row.key, tenantKey, changedAt);
  rememberDeclined(row.key, tenantKey, offer.sessionIds, changedAt);
  return offerToken(offer.sessionIds, offer.shownKinds);
}

// Records the shown offer as asked and prints it with `uploadPrefix --offer <token>`; no `checklist` drops the K7 lines.
async function askOffer(row, tenantId, offer, uploadPrefix, checklist) {
  const token = await recordAsked(row, tenantId, offer);
  printOfferBlock(row, tenantId, offer, `${uploadPrefix} --offer ${token}`, token, checklist);
}

// Owes the workspace the offer's sessions for the history worker; true when an entry holds them.
export function oweUpload(row, tenantId, offer) {
  return requestConsentedHistory(row.key, tenantId, new Date().toISOString(), offer);
}

export function backgroundLine(row, tenantIds, n) {
  const names = listText(tenantIds.map((id) => workspaceName(row, id)));
  return `✓ Beezi: uploading ${plural(n, 'past session')} to ${names} in the background. You'll see the result when your next session starts.`;
}

// Sessions a rule routes, then the rest by New folders; a zero clause is dropped and null means print nothing.
export function routeSummary(row, plan) {
  const ruled = plan.counts.rule;
  const rest = plan.counts['new-folders'] + plan.counts.none + plan.counts.pending;
  const clauses = [];
  if (ruled > 0) clauses.push(`${plural(ruled, 'past session')} ${ruled === 1 ? 'follows' : 'follow'} your rules`);
  if (rest > 0) {
    // The first printed clause names the sessions.
    const lead = clauses.length === 0 ? plural(rest, 'past session') : String(rest);
    const newFolders = newFoldersOf(row);
    if (newFolders.mode === 'send') {
      const names = newFolders.tenantIds.map((id) => workspaceName(row, id)).join(', ');
      clauses.push(`${lead} in new folders ${rest === 1 ? 'goes' : 'go'} to ${names}`);
    } else if (newFolders.mode === 'none') {
      clauses.push(`${lead} in new folders ${rest === 1 ? 'is' : 'are'} not sent`);
    } else {
      clauses.push(`${lead} in repos or folders with no rule ${rest === 1 ? 'is' : 'are'} not sent this time`);
    }
  }
  return clauses.length === 0 ? null : `Beezi (${describeAccount(row)}): ${clauses.join('; ')}.`;
}

// The K7 lines for the offer's shown kinds and the workspace name, and its question.
function checklistOf(row, tenantId, offer) {
  return offerLines({
    count: offer.sessionIds.length,
    firstMs: offer.firstMs,
    lastMs: offer.lastMs,
    folders: offer.folders,
    kinds: offer.shownKinds,
    workspace: workspaceName(row, tenantId),
  });
}

function declineCommand(row, tenantKey, audit, token) {
  return `${scriptCommand('history.mjs')} decline --account ${row.key} --tenant ${tenantKey}${audit ? ' --audit' : ''} --offer ${token}`;
}

const printLines = (lines) => lines.forEach((line) => console.log(line));

// One <offer> block: the K7 lines unless `checklist` is false, then the question and both commands.
function printOfferBlock(row, tenantId, offer, uploadCommand, token, checklist) {
  const tenantKey = offerTenantKey(row, tenantId);
  const audit = offer.audit === true;
  const { lines, question } = checklistOf(row, tenantId, offer);
  const decline = declineCommand(row, tenantKey, audit, token);
  printLines([
    `<offer account="${row.key}" tenant="${tenantKey}" audit="${audit ? 'yes' : 'no'}">`,
    ...(checklist ? lines : []),
    `question=${question}`,
    `upload-command=${uploadCommand}`,
    `decline-command=${decline}`,
    '</offer>',
  ]);
}

// One <notice> block: the K7 lines, then who chose the upload and its progress line in place of the question.
function printNoticeBlock(row, tenantId, offer) {
  printLines([
    `<notice account="${row.key}" tenant="${offerTenantKey(row, tenantId)}">`,
    ...checklistOf(row, tenantId, offer).lines,
    ...noticeLines(workspaceName(row, tenantId), offer.sessionIds.length),
    '</notice>',
  ]);
}

// A workspace's line in the combined layout and its <ask> option, after the name.
const describeOffer = (offer) => `${plural(offer.sessionIds.length, 'session')} · ${hidesPhrase(offer.shownKinds)}`;

// The combined <offers> block of several workspaces (R1, R2), then the progress line of the no-ask ones.
function printCombined(row, noAsk, ask) {
  const line = (mark) => (c) => `    ${mark} ${workspaceName(row, c.tenantId)} · ${describeOffer(c.offer)}`;
  const lines = [`<offers account="${row.key}">`, ...combinedHeader(noAsk.concat(ask).map((c) => c.offer))];
  if (noAsk.length > 0) lines.push(NO_ASK_GROUP, ...noAsk.map(line('✓')));
  if (ask.length > 0) lines.push(ASK_GROUP, ...ask.map(line('?')));
  lines.push('</offers>');
  if (noAsk.length > 0) {
    const total = noAsk.reduce((n, c) => n + c.offer.sessionIds.length, 0);
    lines.push(progressLine(total, noAsk.map((c) => workspaceName(row, c.tenantId))));
  }
  printLines(lines);
}

// Each ask-first workspace's option label: its name, then " (2)", " (3)" … on a name repeated within the account (R20).
function askLabels(row, ask) {
  const seen = new Map();
  return ask.map((c) => {
    const name = workspaceName(row, c.tenantId);
    const n = (seen.get(name) || 0) + 1;
    seen.set(name, n);
    return n === 1 ? name : `${name} (${n})`;
  });
}

// One <ask> block of at most ASK_PART_SIZE ask-first workspaces per multi-select question, each recorded as asked;
// `onPrinted(n)` after each block with its workspace count.
async function printAskParts(row, ask, uploadPrefix, afterUploads, onPrinted) {
  const labels = askLabels(row, ask);
  const parts = Math.ceil(ask.length / ASK_PART_SIZE);
  for (let part = 0; part < parts; part += 1) {
    const lines = [`<ask account="${row.key}" part="${part + 1}" parts="${parts}">`, `question=${askQuestion(afterUploads)}`];
    const end = Math.min(ask.length, (part + 1) * ASK_PART_SIZE);
    for (let i = part * ASK_PART_SIZE; i < end; i += 1) {
      const c = ask[i];
      const tenantKey = offerTenantKey(row, c.tenantId);
      const token = await recordAsked(row, c.tenantId, c.offer);
      lines.push(
        `workspace=${labels[i]}`,
        `description=${describeOffer(c.offer)}`,
        `upload-command=${uploadPrefix(tenantKey)} --offer ${token}`,
        `decline-command=${declineCommand(row, tenantKey, c.offer.audit === true, token)}`,
      );
    }
    lines.push('</ask>');
    printLines(lines);
    onPrinted(end - part * ASK_PART_SIZE);
  }
}

function failed(message) {
  console.error(`✗ ${message}`);
  return StopStatus.FAILED;
}

const exitStatus = (stop) => (stop === StopStatus.FAILED ? 1 : 0);

// The line for a run that stopped before uploading, and what it means; NONE when the run went ahead.
export function printStop(result, { via, workspace, dryRun = false }) {
  if (result.reason === AuditReason.BUSY) {
    console.log('Beezi: another session sync is running. Try again after it finishes.');
    return StopStatus.FAILED;
  }
  if (result.reason === AuditReason.AUTH_UNAVAILABLE) return failed('Beezi: authentication is temporarily unavailable. Try /beezi:sync again.');
  if (result.reason === AuditReason.NO_ACCOUNT) return failed('Beezi: that account is not linked or its link expired. Run /beezi:login and sign in as it.');
  if (result.reason === AuditReason.WORKSPACE_REQUIRED) {
    return failed('Beezi: this account belongs to several workspaces and none was picked for this run. Check where analytics go with /beezi:settings, then run /beezi:sync again.');
  }
  if (result.reason === AuditReason.ALREADY_COMPLETED || result.halt === BackfillHalt.ALREADY_COMPLETED) {
    console.log('✓ Beezi already has the history for this workspace — the one-time import has been used and cannot run again.');
    if (result.upgradeAdvised) {
      console.log('  Your audit snapshot is complete. To keep tracking new sessions and unlock live analytics, upgrade your workspace plan in the Beezi portal.');
    }
    return StopStatus.DONE;
  }
  if (result.reason === AuditReason.AUDIT_ONLY) {
    if (via === OfferVia.SYNC) {
      console.log(`Beezi: analytics are off for ${workspace}, so past sessions cannot be uploaded there. A workspace admin can turn them on in the Beezi portal.`);
    }
    return StopStatus.DONE;
  }
  if (result.halt === BackfillHalt.NOT_ALLOWED) return failed('Beezi: uploads are disabled for this workspace — the audit period has ended.');
  if (result.halt === BackfillHalt.UNSUPPORTED_SERVER) return failed('Beezi: this portal does not support /beezi:sync yet — try again after the next portal update.');
  if (result.halt === BackfillHalt.FORBIDDEN) {
    return failed(
      `Beezi: the server refused the upload (${result.lastError == null ? 'forbidden' : result.lastError}). ` +
        'Check your seat with your workspace admin, then try again.',
    );
  }
  if (result.halt === BackfillHalt.ANONYMIZATION_KEY_MISSING) {
    console.error(`Beezi: ${workspace} hides some names, but this machine has no valid key for it yet, so nothing was uploaded. Start a new Claude Code session to refresh it, then run /beezi:sync.`);
    return StopStatus.FAILED;
  }
  if (result.halt === BackfillHalt.ANONYMIZATION_UNKNOWN) {
    return failed(`Beezi: could not check which names ${workspace} hides, so nothing was uploaded. Run /beezi:sync again later.`);
  }
  if (dryRun && (result.reason != null || result.halt != null)) {
    console.error(`Beezi: could not count past sessions for ${workspace} (${result.reason == null ? result.halt : result.reason}). Run /beezi:sync to try again.`);
    return StopStatus.FAILED;
  }
  return StopStatus.NONE;
}

// Sessions a sync run held back because the live queue still holds their reports: re-sending them now could count them twice.
function printPendingLive(result) {
  if (!(result.pendingLive > 0)) return;
  console.log(
    `Beezi: ${plural(result.pendingLive, 'session')} still ${result.pendingLive === 1 ? 'has' : 'have'} live uploads pending ` +
      'and will be included on the next /beezi:sync.',
  );
}

// The sessions an upload left out, one line each.
function printLeftOut(result, engine) {
  if (engine === OfferEngine.BACKFILL && result.empty > 0) {
    console.log(`  ${plural(result.empty, 'session')} held no usage data (no assistant tokens recorded) — nothing to upload.`);
  }
  if (result.noRemote > 0) {
    console.log(
      `  ${plural(result.noRemote, 'session')} could not be matched to a repository — not uploaded. ` +
        'Their transcripts record no working directory.',
    );
  }
  if (result.emitFailed > 0) console.log(`  ${plural(result.emitFailed, 'session')} failed while being prepared — not uploaded.`);
  if (result.unreadable > 0) console.log(`  ${plural(result.unreadable, 'session')} could not be read — not uploaded.`);
}

// The headline of an upload that went ahead, with what the server did with it.
function uploadedLine(result, engine) {
  const parts = [`✓ Beezi: uploaded ${plural(result.sessionsImported, 'session')} (${plural(result.reportsStored, 'report')} stored).`];
  if (result.alreadyImported > 0) parts.push(`${result.alreadyImported} were already uploaded.`);
  if (engine !== OfferEngine.BACKFILL && result.empty > 0) parts.push(`${result.empty} were already up to date.`);
  if (result.costStateSessions > 0) parts.push(`${plural(result.costStateSessions, 'session')} used Claude's own cost record for their totals.`);
  if (result.costStateOnlySessions > 0) {
    parts.push(`${plural(result.costStateOnlySessions, 'session')} had only that record (no repository, billing or timeline detail for those).`);
  }
  // Server-side skips already include the errored items; report the errors, not both numbers.
  if (result.itemErrors > 0) parts.push(`${plural(result.itemErrors, 'report')} skipped — their repository is not connected to Beezi.`);
  if (result.sessionsRejected > 0) parts.push(`${plural(result.sessionsRejected, 'session')} were rejected by the server and will not be retried.`);
  if (result.costStatesUnsupported && result.costStatesFailed > 0) {
    parts.push(`${plural(result.costStatesFailed, 'session')} could not be uploaded — this Beezi server does not accept Claude cost records yet. They are kept for the next run.`);
  } else if (result.costStatesUnsupported) {
    parts.push("This Beezi server does not accept Claude cost records yet, so totals use Beezi's own tally.");
  } else if (result.costStatesFailed > 0) {
    parts.push(`${plural(result.costStatesFailed, 'session')} could not be delivered — run /beezi:sync again to retry them.`);
  }
  if (result.reportsFailed > 0 || result.unattributed > 0 || result.permanentRejections > 0) {
    const lastError = oneLine(result.lastError);
    const reason = lastError == null ? '' : ` (last error: ${lastError})`;
    parts.push(`${plural(result.reportsFailed, 'report')} could not be delivered${reason} — run /beezi:sync again to retry them.`);
  }
  return parts.join(' ');
}

// The line of an upload that stopped before the server took anything; the exit status.
function printStopped(result) {
  const reason = oneLine(result.lastError);
  if (result.costStatesUnsupported) {
    return exitStatus(failed(
      'Beezi: upload stopped — this Beezi server does not accept Claude cost records yet. ' +
        'Nothing was uploaded and nothing was lost; run /beezi:sync again after the portal update.',
    ));
  }
  return exitStatus(failed(
    `Beezi: upload stopped — could not reach the server (${reason == null ? 'unknown error' : reason}). ` +
      'Run /beezi:sync again to continue where it left off.',
  ));
}

// One accepted offer's upload, printed after its stop line if any; the exit status.
function printUploadResult(result, engine, { via, workspace }) {
  const stop = printStop(result, { via, workspace });
  if (stop !== StopStatus.NONE) return exitStatus(stop);
  if (result.coworkWarnings > 0) console.log('Beezi: some Cowork cache data could not be read; run /beezi:sync again to retry.');
  if (result.scanned === 0) {
    console.log('✓ Beezi: no past Claude Code sessions found to upload.');
    return 0;
  }
  // Without a trusted coverage answer the run fell back to local cursors, which a wiped or re-linked ~/.beezi does not have.
  if (engine !== OfferEngine.BACKFILL && coverageUnknown(result)) console.log(COVERAGE_NOTE);
  printPendingLive(result);
  if (result.candidates === 0) {
    if (result.pendingLive > 0) return 0;
    console.log(`✓ Beezi: nothing new to upload${result.alreadyImported > 0 ? ` (${plural(result.alreadyImported, 'session')} already uploaded)` : ''}.`);
    return 0;
  }
  if ((result.reportsFailed > 0 || result.costStatesFailed > 0) && result.sessionsImported === 0) return printStopped(result);
  console.log(uploadedLine(result, engine));
  printLeftOut(result, engine);
  if (result.plannedReports > result.reportsStored + result.reportsSkipped) {
    console.log(`  Note: ${plural(result.plannedReports, 'report')} sent, ${result.reportsStored} stored and ${result.reportsSkipped} skipped by the server.`);
  }
  if (result.timelines > 0) console.log(`  ${plural(result.timelines, 'session timeline')} attached.`);
  // timelinesDropped is a subset of the offered-minus-attached gap, so one stanza covers both.
  const notAttached = result.timelinesOffered - result.timelines;
  if (notAttached > 0) {
    console.log(
      `  ${plural(notAttached, 'session timeline')} could not be attached` +
        (result.timelinesDropped > 0 ? ' (the server did not accept them)' : '') +
        ' — the usage itself was uploaded.',
    );
  }
  if (engine === OfferEngine.BACKFILL && !result.followupsAllowed) console.log('  Rate-limit events are not collected in audit mode.');
  console.log('  Plan and billing details reflect your current setup, not the plan you were on at the time.');
  return 0;
}

// /beezi:sync's answer when a workspace has nothing to offer, and how many sessions are still open.
function printNothingNew(active) {
  console.log('✓ Beezi: nothing new to upload.');
  if (active > 0) {
    console.log(`  ${plural(active, 'session')} ${active === 1 ? 'is' : 'are'} still open. Run /beezi:sync again after ${active === 1 ? 'it finishes' : 'they finish'}.`);
  }
}

// A workspace's no-ask choice from its fresh whoami alone (R17): no answer, or any choice but upload, asks first.
export function freshMode(who, tenantId) {
  return who != null && who.valid === true ? offerMode(who, tenantId) : OfferMode.ASK;
}

// The fresh whoami when there is one, else the cached row.
export const freshOf = (row, who) => (who != null && who.valid === true ? who : row);

// One workspace's dry run under its engine, with ctx = { via, override, planRuns, runCache }. Settles a workspace with
// nothing left to offer, or prints why it could not count; { offer, mode, status, who }, with offer null when there is none.
// An override (R6) always asks; no-ask comes from the fresh whoami (R17), Audit workspaces included, and /beezi:sync
// asks first where it would upload a session declined under the workspace's current choice (R18).
export async function countWorkspace(row, tenantId, ctx, deps = {}) {
  const runAudit = deps.runAudit == null ? _runAudit : deps.runAudit;
  const tenantKey = offerTenantKey(row, tenantId);
  const workspace = workspaceName(row, tenantId);
  const who = await workspaceWhoami(row, tenantId, deps);
  const engine = engineOf(who);
  const options = engineRunOptions(row, tenantId, ctx.via, engine, { planWorkspaceRuns: ctx.planRuns });
  if (ctx.override) delete options.sessionRoutes;
  const runDeps = { runCache: ctx.runCache, onProgress: printProgress, whoamiImpl: async () => who };
  const result = await runAudit(runDeps, { ...options, dryRun: true });
  if (ctx.via === OfferVia.SYNC && isBusy(result) && (await followRunning(row, tenantKey, deps))) return { offer: null, status: 0, reason: result.reason };
  if (result.reason != null || result.halt != null) {
    return { offer: null, status: exitStatus(printStop(result, { via: ctx.via, workspace, dryRun: true })), reason: result.reason };
  }
  if (engine === OfferEngine.SYNC && coverageUnknown(result)) {
    console.log(OFFER_COVERAGE_NOTE);
    return { offer: null, status: 0 };
  }
  const changedAt = pastSessionsFor(freshOf(row, who), tenantId).changedAt;
  // /beezi:sync is the way back to a declined session, so only it lists them.
  const declined = ctx.via === OfferVia.SYNC ? new Set() : readDeclinedIds(row.key, tenantKey, changedAt);
  const planned = result.plannedSessions.filter((s) => !declined.has(s.sessionId));
  if (ctx.via === OfferVia.SYNC) printPendingLive(result);
  // An offer file still on disk may be a question waiting for its answer, so a run that offers nothing leaves it.
  if (planned.length === 0) {
    if (ctx.via === OfferVia.SYNC && !(result.pendingLive > 0)) printNothingNew(result.active);
    // Sessions held back for their queued live reports are still to come, so nothing settles yet.
    if (result.active === 0 && !(result.pendingLive > 0)) await recordOfferSettled(row.key, tenantKey, { changedAt, handled: offerStateOf(row, tenantId).reopen });
    return { offer: null, status: 0 };
  }
  const offer = offerFromRun({ ...result, plannedSessions: planned }, {
    via: ctx.via, engine, tenantId, historyCutoffMs: options.historyCutoffMs, override: ctx.override === true, changedAt,
    // Held-back sessions count as still open, so the accepted upload scans again instead of settling.
    nowIso: new Date().toISOString(), active: result.pendingLive > 0 ? result.active + result.pendingLive : result.active,
  });
  let mode = ctx.override === true ? OfferMode.ASK : freshMode(who, tenantId);
  if (mode === OfferMode.UPLOAD && ctx.via === OfferVia.SYNC) {
    const declinedNow = readDeclinedIds(row.key, tenantKey, changedAt);
    if (planned.some((s) => declinedNow.has(s.sessionId))) mode = OfferMode.ASK;
  }
  return { offer, mode, status: 0, who };
}

// A no-ask workspace's offer is written and owed to the history worker before it is stamped settled, never declined
// (R4), so an upload that never finishes stays owed (R5); one nothing could hold stays unsettled and is noticed again.
// True when an entry holds it.
async function oweWithoutAsking(row, tenantId, offer) {
  const tenantKey = offerTenantKey(row, tenantId);
  writeOffer(row.key, tenantKey, offer);
  forgetDeclined(row.key, tenantKey, offer.sessionIds);
  const owed = await oweUpload(row, tenantId, offer);
  if (owed) await recordOfferSettled(row.key, tenantKey, { changedAt: offerChangedAt(row, tenantId, offer), handled: offerStateOf(row, tenantId).reopen });
  return owed;
}

// The session start's no-ask workspaces the history worker now owes, one failure not stopping the rest; { owed, status }.
// One nothing could hold is left to the foreground paths (/beezi:login, /beezi:sync), which upload it directly.
async function oweInBackground(row, noAsk) {
  const owed = [];
  let status = 0;
  for (const c of noAsk) {
    try {
      if (await oweWithoutAsking(row, c.tenantId, c.offer)) owed.push(c);
    } catch (error) {
      console.error(`✗ ${friendlyMessage(error)}`);
      status = 1;
    }
  }
  return { owed, status };
}

// Owes each counted workspace its offer as a question would have shown it, recording no question; { owed, status }.
export function oweConsented(row, counted) {
  return oweInBackground(row, counted.map((c) => ({ ...c, offer: shownOffer(row, c) })));
}

// Owes every no-ask workspace before the first run (R5), then uploads each through `ctx.runOne`, one failure not
// stopping the rest; one ✓ line for those that uploaded clean, and 1 when any failed. A clean run clears the entry it
// owed, unless one was already owed.
async function uploadNoAsk(row, noAsk, ctx) {
  const owedBefore = pendingHistoryOf(row).map((e) => e.tenantId);
  let status = 0;
  const fail = (error) => {
    console.error(`✗ ${friendlyMessage(error)}`);
    status = 1;
  };
  const due = [];
  for (const c of noAsk) {
    try {
      const owed = await oweWithoutAsking(row, c.tenantId, c.offer);
      due.push({ ...c, clears: owed && owedBefore.indexOf(c.tenantId) === -1 });
    } catch (error) {
      fail(error);
    }
  }
  const uploaded = [];
  for (const c of due) {
    try {
      const run = await runAccepted(row, offerTenantKey(row, c.tenantId), c.offer, ctx.runOne, false, ctx);
      if (run.status !== 0) status = 1;
      if (run.clean && c.clears) {
        const nowMs = Date.now();
        await settlePendingHistory(row.key, c.tenantId, { outcome: RunOutcome.CLEAN, sent: 0, skipped: 0 }, { plannedAtMs: nowMs, nowMs });
      }
      if (run.clean) uploaded.push({ workspace: workspaceName(row, c.tenantId), n: c.offer.sessionIds.length });
      // The locks a busy run waited on are machine-wide; the rest are owed, so the history worker takes them.
      if (run.busy) break;
    } catch (error) {
      fail(error);
    }
  }
  if (uploaded.length > 0) console.log(uploadedTotalsLine(uploaded));
  return status;
}

// The offer as its block shows it: the kinds the fresh whoami hides (the cached row's without one), and a no-ask
// upload is stamped with its changedAt (F4 (#21)).
function shownOffer(row, c) {
  const fresh = freshOf(row, c.who);
  const offer = { ...c.offer, shownKinds: kindsOf(anonymizationFor(fresh, c.tenantId)) };
  return c.mode === OfferMode.UPLOAD ? { ...offer, changedAt: pastSessionsFor(fresh, c.tenantId).changedAt } : offer;
}

// Prints the account's counted workspaces ({ tenantId, offer, mode, who }): one keeps today's full block, several share
// the combined layout (R1). No-ask ones upload under ctx = { uploadPrefix(tenantKey), background, runOne } before any
// question is asked; { offers, notices, status }, counting only the questions and notices printed. In the background
// the no-ask ones are owed first and only those owed are printed.
export async function presentOffers(row, counted, ctx) {
  const shown = counted.map((c) => ({ ...c, offer: shownOffer(row, c) }));
  const ask = shown.filter((c) => c.mode !== OfferMode.UPLOAD);
  let noAsk = shown.filter((c) => c.mode === OfferMode.UPLOAD);
  let status = 0;
  if (ctx.background) {
    const background = await oweInBackground(row, noAsk);
    noAsk = background.owed;
    status = background.status;
  }
  const printed = noAsk.length + ask.length;
  if (printed > 1) printCombined(row, noAsk, ask);
  else if (noAsk.length === 1) printNoticeBlock(row, noAsk[0].tenantId, noAsk[0].offer);
  if (!ctx.background) status = await uploadNoAsk(row, noAsk, ctx);
  else if (noAsk.length > 0) {
    console.log(backgroundLine(row, noAsk.map((c) => c.tenantId), noAsk.reduce((n, c) => n + c.offer.sessionIds.length, 0)));
  }
  let offers = 0;
  try {
    if (ask.length === 1) {
      await askOffer(row, ask[0].tenantId, ask[0].offer, ctx.uploadPrefix(offerTenantKey(row, ask[0].tenantId)), printed === 1);
      offers = 1;
    }
    if (ask.length > 1) await printAskParts(row, ask, ctx.uploadPrefix, noAsk.length > 0, (n) => { offers += n; });
  } catch (error) {
    console.error(`✗ ${friendlyMessage(error)}`);
    status = 1;
  }
  return { offers, notices: noAsk.length, status };
}

// Uploads an accepted offer through `runOne(options, target, engine)` → result and prints the result, or without `report` only its stop
// line, else the failure line of an unclean run; { status, clean }. A clean run that answered the file now on disk
// settles the workspace, or scans it again when the offer left active sessions. A run that met another run's lock
// follows that run's record (followRecord's `deps`) when it has one.
async function runAccepted(row, tenantKey, offer, runOne, report, deps = {}) {
  const tenantId = tenantIdOfKey(tenantKey);
  const engine = offer.engine === OfferEngine.BACKFILL ? OfferEngine.BACKFILL : OfferEngine.SYNC;
  forgetDeclined(row.key, tenantKey, offer.sessionIds);
  const where = { via: OfferVia.SYNC, workspace: workspaceName(row, tenantId) };
  const result = await runOne(replayOptions(row, tenantId, offer), { tenantId: tenantKey, workspace: where.workspace }, engine);
  if (isBusy(result) && (await followRunning(row, tenantKey, deps))) return { status: 0, clean: false, busy: true };
  const outcome = classifyRun(result, false, engine);
  const clean = outcome === RunOutcome.CLEAN;
  let status;
  if (report) {
    status = printUploadResult(result, engine, where);
  } else {
    const stop = printStop(result, where);
    if (stop !== StopStatus.NONE || clean) status = exitStatus(stop);
    // Held back for queued live reports only: not a failure, the owed entry retries them soon.
    else if (outcome === RunOutcome.BUSY) {
      if (result.sessionsImported > 0) console.log(uploadedLine(result, engine));
      printPendingLive(result);
      status = 0;
    } else if (result.sessionsImported === 0) status = printStopped(result);
    else {
      console.log(uploadedLine(result, engine));
      status = 1;
    }
  }
  if (clean && answeredBy(readOffer(row.key, tenantKey), offer.sessionIds)) {
    if (offer.active === 0) await recordOfferSettled(row.key, tenantKey, { changedAt: offer.changedAt == null ? null : offer.changedAt });
    else await recordOfferRescan(row.key, tenantKey);
    removeOffer(row.key, tenantKey);
  }
  return { status, clean, busy: isBusy(result) };
}

// Uploads the stored offer the printed `token` names through `runOne(options, target, engine)` → result, and prints it; the
// exit status. `deps` as runAccepted's.
export async function acceptOffer(row, tenantKey, token, runOne, deps = {}) {
  const tenantId = tenantIdOfKey(tenantKey);
  const offer = readOffer(row.key, tenantKey);
  if (offer == null) {
    console.log(nothingLine(row, tenantId));
    return 0;
  }
  if (!matchesShown(offer, token)) {
    console.log(CHANGED_LINE);
    return 0;
  }
  return (await runAccepted(row, tenantKey, offer, runOne, true, deps)).status;
}
