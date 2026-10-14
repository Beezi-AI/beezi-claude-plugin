import { parseArgs, runAudit, planWorkspaceRuns, dontTrackSessionIds, createRunCache, SYNC_MODE } from '../lib/session-audit.mjs';
import { BackfillHalt } from '../lib/audit-flush.mjs';
import { parseAccountFlag, getAccount, describeAccount } from '../lib/accounts.mjs';
import { parseTenantFlags, isMultiTenant, tenantById, newFoldersOf, joinedAfterLink } from '../lib/workspace.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';
import { usesRules } from '../lib/workspace-rules.mjs';
import { readTrackingState } from '../lib/tracking.mjs';
import { startHistoryWorker } from '../lib/history-trigger.mjs';

// The login flow's final step: uploads this machine's past sessions into Beezi. There is no
// slash command for it — /beezi:login runs it after the link and plan capture, and re-running
// /beezi:login resumes an interrupted upload. Flags (--dry-run / --since / --force) remain for
// manual `node scripts/backfill.mjs` runs only.

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Prints the error and reports a failed run, so the remaining workspaces still run.
function failed(message) {
  console.error(`✗ ${message}`);
  return 1;
}

const DEFERRED_LINE = '  Your one-time history upload stays open until those repos and folders have a rule — run /beezi:login or /beezi:sync to choose.';

// One workspace's run; returns the exit status instead of exiting mid-loop.
async function backfillOne(account, tenantId, argv, sessionRoutes, excludedSessionIds = null, excludedLabel = null, runCache = null) {
  const options = parseArgs(argv);
  options.account = account;
  options.tenantId = tenantId;
  options.sessionRoutes = sessionRoutes;
  options.excludedSessionIds = excludedSessionIds;
  const viaLogin = options.via === 'login';

  const result = await runAudit(
    {
      runCache,
      // "read", not "sent": `processed` counts candidates PARSED, and a parsed session may still
      // produce nothing to upload. Calling it "sent" is what made the final totals look like they
      // had lost sessions when the arithmetic was simply against a different number.
      onProgress: ({ processed, total }) => {
        console.log(`Beezi: ${processed}/${total} sessions read…`);
      },
    },
    options,
  );

  // The real count, after the live-session skip the audit already applies — not the pre-run plan,
  // which also counts the live session and sessions still being written.
  if (excludedLabel != null && result.excluded > 0) {
    console.log(`Beezi (${excludedLabel}): ${plural(result.excluded, 'past session')} in repos or folders you don't track ${result.excluded === 1 ? 'is' : 'are'} skipped.`);
  }

  if (result.reason === 'busy') {
    console.log('Beezi: another session sync is running. Run /beezi:sync after it finishes.');
    return;
  }
  if (result.coworkWarnings > 0) {
    console.log('Beezi: some Cowork cache data could not be read; run /beezi:sync again to retry.');
  }
  if (result.reason === 'no-account') {
    return failed('Beezi: this machine is not linked. Run /beezi:login first.');
  }
  if (result.reason === 'workspace-required') {
    return failed('Beezi: this account belongs to several workspaces and none was picked for this run. Check where analytics go with /beezi:settings, then re-run /beezi:login.');
  }
  // Linked, but the credential could not be read right now — a busy OS credential store, a
  // refresh still in flight, a held lock. Signing in again fixes none of those and re-running
  // login is what this message used to ask for, so it says the opposite: wait and retry.
  if (result.reason === 'auth-unavailable') {
    return failed(
      'Beezi: this machine is linked, but its saved login could not be read just now '
        + `(${result.authReason == null ? result.authState : result.authReason}). `
        + 'Nothing was removed — wait a moment and run /beezi:sync to finish the upload.',
    );
  }

  // The one-time import has been used — verified against the server before anything was parsed.
  // Inside the login flow this is a normal outcome; a direct/manual run is a rejected request.
  const alreadyUsed =
    result.reason === 'already-completed' || result.halt === BackfillHalt.ALREADY_COMPLETED;
  if (alreadyUsed) {
    const lines = [
      'Beezi already has the history for this workspace — the one-time import has been used and cannot run again.',
    ];
    if (result.upgradeAdvised) {
      lines.push(
        'Your audit snapshot is complete. To keep tracking new sessions and unlock live analytics, upgrade your workspace plan in the Beezi portal.',
      );
    }
    if (viaLogin) {
      console.log(`✓ ${lines[0]}`);
      if (lines[1]) console.log(`  ${lines[1]}`);
      return 0;
    }
    return failed(lines.join(' '));
  }
  if (result.halt === BackfillHalt.NOT_ALLOWED) {
    return failed('Beezi: the audit period has ended — new history pulls are disabled for this workspace.');
  }
  if (result.halt === BackfillHalt.UNSUPPORTED_SERVER) {
    return failed('Beezi: the server does not support the history pull yet — try again after the portal update.');
  }
  if (result.halt === BackfillHalt.FORBIDDEN) {
    return failed(
      `Beezi: the server refused the upload (${result.lastError == null ? 'forbidden' : result.lastError}). ` +
        'Check your seat with your workspace admin, then re-run /beezi:login.',
    );
  }

  if (result.scanned === 0) {
    console.log('✓ Beezi: no past Claude Code sessions found to upload.');
    return 0;
  }
  if (result.candidates === 0) {
    const bits = [];
    if (result.alreadyImported > 0) bits.push(`${plural(result.alreadyImported, 'session')} already uploaded`);
    if (result.liveTracked > 0) bits.push(`${result.liveTracked} already tracked live`);
    console.log(`✓ Beezi: nothing new to upload${bits.length ? ` (${bits.join(', ')})` : ''}.`);
    if (result.finalized) console.log('✓ Beezi: your history pull is finalized.');
    else if (result.routeDeferred > 0) console.log(DEFERRED_LINE);
    return 0;
  }

  if (options.dryRun) {
    console.log(
      `Beezi: would upload ${plural(result.candidates, 'session')} / ` +
        `${plural(result.plannedReports, 'report')} in ${plural(result.plannedChunks, 'request')} ` +
        '(dry run — nothing sent).',
    );
    return 0;
  }

  // Everything that was parsed but never judged by the server. Those sessions stay unledgered, so
  // saying "log in again to continue" is accurate — the next login's backfill picks them up.
  if ((result.reportsFailed > 0 || result.costStatesFailed > 0) && result.sessionsImported === 0) {
    // A server that rejects the cost records outright is a version mismatch, not an unreachable
    // one, and re-running against the same build would fail identically. Say which it is.
    if (result.costStatesUnsupported) {
      return failed(
        'Beezi: upload stopped — this Beezi server does not accept Claude cost records yet. ' +
          'Nothing was uploaded and nothing was lost; re-run /beezi:login after the portal update.',
      );
    }
    return failed(
      `Beezi: upload stopped — could not reach the server (${result.lastError == null ? 'unknown error' : result.lastError}). ` +
        'Re-run /beezi:login to continue where it left off.',
    );
  }

  const parts = [`✓ Beezi: uploaded ${plural(result.sessionsImported, 'session')} (${plural(result.reportsStored, 'report')} stored).`];
  if (result.alreadyImported > 0) parts.push(`${result.alreadyImported} were already uploaded.`);
  if (result.liveTracked > 0) parts.push(`${result.liveTracked} were already tracked live.`);
  if (result.costStateSessions > 0) {
    parts.push(`${plural(result.costStateSessions, 'session')} used Claude's own cost record for their totals.`);
  }
  if (result.costStateOnlySessions > 0) {
    parts.push(
      `${plural(result.costStateOnlySessions, 'session')} had only that record ` +
        '(no repository, billing or timeline detail for those).',
    );
  }
  // Server-side skips already include the errored items; report the errors, not both numbers.
  if (result.itemErrors > 0) {
    parts.push(`${plural(result.itemErrors, 'report')} skipped — their repository is not connected to Beezi.`);
  }
  // Sessions the server refused outright. Ledgered, so a re-run will not retry them — saying so
  // is the only chance the user has to notice.
  if (result.sessionsRejected > 0) {
    parts.push(
      `${plural(result.sessionsRejected, 'session')} were rejected by the server and will not be retried.`,
    );
  }
  // Its own line, not folded into the retry stanza below: this one is a server-version problem the
  // user cannot fix by re-running, and reportsFailed stays 0 for these sessions (they carry no
  // reports), so nothing else in this summary would mention them.
  if (result.costStatesUnsupported && result.costStatesFailed > 0) {
    parts.push(
      `${plural(result.costStatesFailed, 'session')} could not be uploaded — this Beezi server ` +
        'does not accept Claude cost records yet. They are kept for the next run.',
    );
  } else if (result.costStatesUnsupported) {
    parts.push("This Beezi server does not accept Claude cost records yet, so totals use Beezi's own tally.");
  } else if (result.costStatesFailed > 0) {
    parts.push(
      `${plural(result.costStatesFailed, 'session')} could not be delivered — re-run /beezi:login to retry them.`,
    );
  }
  if (result.reportsFailed > 0 || result.unattributed > 0 || result.permanentRejections > 0) {
    const reason = result.lastError ? ` (last error: ${result.lastError})` : '';
    parts.push(
      `${plural(result.reportsFailed, 'report')} could not be delivered${reason} — re-run /beezi:login to retry them.`,
    );
  }
  console.log(parts.join(' '));

  // Every candidate that produced nothing to upload. These used to be invisible: the run said it
  // read N sessions and uploaded fewer, with no account of the difference.
  if (result.empty > 0) {
    console.log(
      `  ${plural(result.empty, 'session')} held no usage data (no assistant tokens recorded) — nothing to upload.`,
    );
  }
  if (result.noRemote > 0) {
    console.log(
      `  ${plural(result.noRemote, 'session')} could not be matched to a repository — not uploaded. ` +
        'Their transcripts record no working directory.',
    );
  }
  if (result.emitFailed > 0) {
    console.log(
      `  ${plural(result.emitFailed, 'session')} failed while being prepared — not uploaded.`,
    );
  }
  if (result.unreadable > 0) {
    console.log(`  ${plural(result.unreadable, 'session')} could not be read — not uploaded.`);
  }
  // The server's stored count against what we actually handed it. A silent shortfall here means
  // reports were acknowledged but not persisted, which nothing else in this summary would show.
  if (result.plannedReports > result.reportsStored + result.reportsSkipped) {
    console.log(
      `  Note: ${plural(result.plannedReports, 'report')} sent, ${result.reportsStored} stored ` +
        `and ${result.reportsSkipped} skipped by the server.`,
    );
  }

  if (result.finalized) {
    console.log('✓ Beezi: your history pull is finalized.');
  } else if (options.sinceMs != null) {
    console.log('  Scoped run (--since): the pull stays open — a full run (no flags) finalizes it.');
  } else if (result.retriableUnreadable > 0) {
    console.log(
      `  Your history is NOT finalized yet — ${plural(result.retriableUnreadable, 'session')} could not be read ` +
        'this time. Re-run /beezi:login to retry them; if they fail again the pull finalizes without them.',
    );
  } else if (result.routeDeferred > 0) {
    console.log(DEFERRED_LINE);
  } else {
    console.log(
      '  Your history is NOT finalized yet — re-run /beezi:login once the remaining sessions can be delivered.',
    );
  }
  if (result.timelines > 0) {
    console.log('  ' + plural(result.timelines, 'session timeline') + ' attached.');
  }
  // One stanza, not two: `timelinesDropped` is a subset of the offered-minus-attached gap, so an
  // if/else would suppress the unexplained remainder — the very gap these counters exist to show.
  const notAttached = result.timelinesOffered - result.timelines;
  if (notAttached > 0) {
    console.log(
      `  ${plural(notAttached, 'session timeline')} could not be attached` +
        (result.timelinesDropped > 0 ? ' (the server did not accept them)' : '') +
        ' — the usage itself was uploaded.',
    );
  }
  if (!result.followupsAllowed) {
    console.log('  Rate-limit events are not collected in audit mode.');
  }
  console.log(
    '  Plan and billing details reflect your current setup, not the plan you were on at the time.',
  );
  return 0;
}

// A workspace joined after this machine linked the account got nothing live before the re-pick, so its
// history resumes from what it already has (sync's coverage check). One that takes no uploads on
// demand (audit-only) gets the one-time import instead, which has no link cutoff there.
async function backfillJoinedOne(account, tenantId, argv, sessionRoutes, runCache = null) {
  const options = { ...parseArgs(argv), account, tenantId, sessionRoutes, mode: SYNC_MODE, liveOnly: true };
  const result = await runAudit(
    { runCache, onProgress: ({ processed, total }) => { console.log(`Beezi: ${processed}/${total} sessions read…`); } },
    options,
  );
  if (result.reason === 'audit-only' || result.halt === BackfillHalt.NOT_ALLOWED || result.halt === BackfillHalt.ALREADY_COMPLETED) {
    return backfillOne(account, tenantId, argv, sessionRoutes, null, null, runCache);
  }
  // A stop the next run will not clear prints backfillOne's own ✗ line; a busy run gets the sync line below.
  if (result.reason === 'no-account') {
    return failed('Beezi: this machine is not linked. Run /beezi:login first.');
  }
  if (result.reason === 'auth-unavailable') {
    return failed(
      'Beezi: this machine is linked, but its saved login could not be read just now '
        + `(${result.authReason == null ? result.authState : result.authReason}). `
        + 'Nothing was removed — wait a moment and run /beezi:sync to finish the upload.',
    );
  }
  if (result.halt === BackfillHalt.UNSUPPORTED_SERVER) {
    return failed('Beezi: the server does not support the history pull yet — try again after the portal update.');
  }
  if (result.halt === BackfillHalt.FORBIDDEN) {
    return failed(
      `Beezi: the server refused the upload (${result.lastError == null ? 'forbidden' : result.lastError}). ` +
        'Check your seat with your workspace admin, then re-run /beezi:login.',
    );
  }
  if (options.dryRun) {
    console.log(`✓ Beezi (dry run): would send ${plural(result.plannedReports > 0 ? result.plannedReports : 0, 'report')} to this workspace you joined — nothing was sent.`);
    return 0;
  }
  const imported = result.sessionsImported > 0 ? result.sessionsImported : 0;
  const complete = result.reason == null && result.halt == null
    && !(result.coverageKnown === false && result.candidates > 0)
    && !(result.reportsFailed > 0) && !(result.costStatesFailed > 0);
  if (imported > 0) {
    const stored = result.reportsStored > 0 ? result.reportsStored : 0;
    console.log(`✓ Beezi: uploaded ${imported} session${imported === 1 ? '' : 's'} (${stored} report${stored === 1 ? '' : 's'} stored) to this workspace you joined.`);
  } else if (complete) {
    console.log('✓ Beezi: this workspace already has this machine\'s history.');
  }
  if (!complete) {
    console.log('  Some history did not reach this workspace this time. Run /beezi:sync to send the rest and see why.');
  }
  return 0;
}

function tenantLabel(row, tenantId) {
  const t = tenantById(row, tenantId);
  return t != null && t.name ? t.name : tenantId;
}

// Sessions a rule routes, then the rest by New folders; a zero clause is dropped and null means print nothing.
function routeSummary(row, plan) {
  const ruled = plan.counts.rule;
  const rest = plan.counts['new-folders'] + plan.counts.none + plan.counts.pending;
  const clauses = [];
  if (ruled > 0) clauses.push(`${plural(ruled, 'past session')} ${ruled === 1 ? 'follows' : 'follow'} your rules`);
  if (rest > 0) {
    // The first printed clause names the sessions.
    const lead = clauses.length === 0 ? plural(rest, 'past session') : String(rest);
    const newFolders = newFoldersOf(row);
    if (newFolders.mode === 'send') {
      const names = newFolders.tenantIds.map((id) => tenantLabel(row, id)).join(', ');
      clauses.push(`${lead} in new folders ${rest === 1 ? 'goes' : 'go'} to ${names}`);
    } else if (newFolders.mode === 'none') {
      clauses.push(`${lead} in new folders ${rest === 1 ? 'is' : 'are'} not sent`);
    } else {
      clauses.push(`${lead} in repos or folders with no rule ${rest === 1 ? 'is' : 'are'} not sent this time`);
    }
  }
  return clauses.length === 0 ? null : `Beezi (${describeAccount(row)}): ${clauses.join('; ')}.`;
}

// Pending history (rules gained a workspace) gets its own coverage-based pass once this upload let go of the lock.
async function startAfterBackfill(account, argv) {
  if (!parseArgs(argv).dryRun) await startHistoryWorker(account);
}

async function main() {
  const { account, rest } = await parseAccountFlag(process.argv.slice(2));
  if (account == null) fail('Beezi: backfill needs --account <key|email|n>. /beezi:login passes it automatically.');
  const row = (await getAccount(account)) || { key: account };
  const { argv, tenantIds: override } = parseTenantFlags(rest, row);
  // One or unknown workspaces: one headerless run.
  if (!isMultiTenant(row)) {
    // Already sealed: every re-run (every /beezi:login) would otherwise re-plan and re-read up to
    // 64KB of every transcript just to report "already uploaded" right after.
    const tracking = readTrackingState(row.key);
    const sealed = usesRules(row) && tracking != null && tracking.backfillCompleted === true;
    let status;
    if (usesRules(row) && !sealed) {
      const plan = planWorkspaceRuns(row);
      const excludedSessionIds = dontTrackSessionIds(plan);
      status = await backfillOne(account, null, argv, null, excludedSessionIds, describeAccount(row));
    } else {
      status = await backfillOne(account, null, argv, null);
    }
    await startAfterBackfill(account, argv);
    if (status !== 0) process.exit(1);
    return;
  }
  // --tenant is an override: those workspaces get every past session, unrouted.
  let tenantIds = override;
  let routes = null;
  if (tenantIds.length === 0) {
    const plan = planWorkspaceRuns(row, { markWaiting: true });
    if (plan.scanned === 0) {
      console.log('✓ Beezi: no past Claude Code sessions found to upload.');
      return;
    }
    const summary = routeSummary(row, plan);
    if (summary != null) console.log(summary);
    tenantIds = plan.tenantIds;
    routes = plan.routes;
  }
  const joinedIds = joinedAfterLink(row);
  // One git cache for every workspace's run, so each session's git correlation runs once.
  const runCache = createRunCache();
  let status = 0;
  for (const tenantId of tenantIds) {
    console.log(`\n— ${describeAccount(row)} · ${tenantLabel(row, tenantId)} —`);
    // One workspace's exception must not stop the rest.
    try {
      const run = joinedIds.indexOf(tenantId) === -1
        ? backfillOne(account, tenantId, argv, routes, null, null, runCache)
        : backfillJoinedOne(account, tenantId, argv, routes, runCache);
      if (await run !== 0) status = 1;
    } catch (error) {
      console.error(`✗ ${friendlyMessage(error)}`);
      status = 1;
    }
  }
  await startAfterBackfill(account, argv);
  if (status !== 0) process.exit(status);
}

main().catch((error) => fail(friendlyMessage(error)));
