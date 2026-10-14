import { parseArgs, runAudit, planWorkspaceRuns, dontTrackSessionIds, createRunCache, SYNC_MODE } from '../lib/session-audit.mjs';
import { BackfillHalt } from '../lib/audit-flush.mjs';
import { parseAccountFlag, listAccounts, getAccount, describeAccount, AccountStatus } from '../lib/accounts.mjs';
import { parseTenantFlags, isMultiTenant, tenantById, newFoldersOf } from '../lib/workspace.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';
import { maybeSpawnCoworkLive } from '../lib/cowork-live.mjs';
import { usesRules } from '../lib/workspace-rules.mjs';
import { startHistoryWorker } from '../lib/history-trigger.mjs';

// /beezi:sync — uploads every past session this machine still has on disk, skipping whatever Beezi
// already holds. Unlike the one-time import at the end of /beezi:login, this is repeatable: it asks
// the server how far each session already reaches and resumes from exactly there, so re-running it
// costs nothing and never double-counts. Flag: --dry-run. No --force (nothing to force past) and no
// --since: it filters on transcript mtime, which says when a session last ran, not what is missing
// from Beezi — it would silently exclude an old session whose upload died halfway, which is exactly
// the case this command exists to repair. Coverage already scopes the work to what is genuinely absent.

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// One account's run. Per-account problems print and return so the accounts after it still run.
async function syncOne(account, options, label, runCache = null) {
  options.account = account;
  options.mode = SYNC_MODE;
  const prefix = label == null ? 'Beezi' : `Beezi (${label})`;

  const result = await runAudit(
    {
      runCache,
      onProgress: ({ processed, total }) => {
        console.log(`${prefix}: ${processed}/${total} sessions read…`);
      },
    },
    options,
  );

  // The real count, after the live-session skip the audit already applies — not the pre-run plan,
  // which also counts the live session and sessions still being written.
  if (options.excludedLabel != null && result.excluded > 0) {
    console.log(`Beezi (${options.excludedLabel}): ${plural(result.excluded, 'past session')} in repos or folders you don't track ${result.excluded === 1 ? 'is' : 'are'} skipped.`);
  }
  if (result.coworkWarnings > 0) {
    console.log('Beezi: some Cowork cache data could not be read; this sync may be incomplete.');
  }
  if (result.reason === 'busy') {
    console.log('Beezi: another session sync is running. Try again after it finishes.');
    return;
  }
  if (result.reason === 'auth-unavailable') {
    console.error('✗ Beezi: authentication is temporarily unavailable. Try /beezi:sync again.');
    return;
  }
  if (result.reason === 'no-account') {
    console.error('✗ Beezi: that account is not linked or its link expired. Run /beezi:login and sign in as it.');
    return;
  }
  if (result.reason === 'workspace-required') {
    console.error('✗ Beezi: this account belongs to several workspaces and none was picked for this run. Check where analytics go with /beezi:settings, then run /beezi:sync again.');
    return;
  }
  if (result.halt === BackfillHalt.NOT_ALLOWED) {
    console.error('✗ Beezi: uploads are disabled for this workspace — the audit period has ended.');
    return;
  }
  if (result.halt === BackfillHalt.UNSUPPORTED_SERVER) {
    console.error('✗ Beezi: this portal does not support /beezi:sync yet — try again after the next portal update.');
    return;
  }
  if (result.halt === BackfillHalt.FORBIDDEN) {
    console.error(
      `✗ Beezi: the server refused the upload (${result.lastError == null ? 'forbidden' : result.lastError}). ` +
        'Check your seat with your workspace admin, then try again.',
    );
    return;
  }

  if (result.scanned === 0) {
    console.log('✓ Beezi: no Claude Code or cached Cowork sessions found on this machine.');
    return;
  }

  // Without a trusted coverage answer the run fell back to local cursors, which a wiped or re-linked
  // ~/.beezi does not have. Saying so is the difference between "nothing to do" and "could not ask".
  if (result.coverageKnown === false && result.candidates > 0) {
    console.log(
      '  Note: Beezi could not confirm what it already has, so this run resumed from local progress only.',
    );
  }

  if (result.candidates === 0) {
    console.log('✓ Beezi: everything is already uploaded.');
    return;
  }

  if (options.dryRun) {
    console.log(
      `Beezi: would upload ${plural(result.plannedReports, 'report')} across ` +
        `${plural(result.candidates, 'session')} in ${plural(result.plannedChunks, 'request')} ` +
        '(dry run — nothing sent).',
    );
    // Counted apart from `plannedReports`, which a cost-record-only session contributes nothing
    // to: it sends one cost record and no reports.
    if (result.costStateSessions > 0) {
      console.log(
        `  ${plural(result.costStateSessions, 'session')} of those would carry Claude's own cost record.`,
      );
    }
    if (result.costStateOnlySessions > 0) {
      console.log(
        `  ${plural(result.costStateOnlySessions, 'session')} would have only that record ` +
          '(no repository, billing or timeline detail for those).',
      );
    }
    return;
  }

  if ((result.reportsFailed > 0 || result.costStatesFailed > 0) && result.sessionsImported === 0) {
    // A server that refuses the cost records outright is a version mismatch, not an unreachable
    // one, and a retry against the same build fails identically. Say which it is.
    if (result.costStatesUnsupported) {
      console.error(
        'Beezi: upload stopped — this Beezi server does not accept Claude cost records yet. ' +
          'Nothing was uploaded and nothing was lost; run /beezi:sync again after the portal update.',
      );
      return;
    }
    console.error(
      `Beezi: upload stopped — could not reach the server (${result.lastError == null ? 'unknown error' : result.lastError}). ` +
        'Run /beezi:sync again to continue where it left off.',
    );
    return;
  }

  // `empty` is the headline number here, not a footnote: a session already fully uploaded produces
  // no reports, so on a healthy repeat run it accounts for nearly every candidate.
  const parts = [`✓ Beezi: uploaded ${plural(result.sessionsImported, 'session')} (${plural(result.reportsStored, 'report')} stored).`];
  if (result.empty > 0) parts.push(`${result.empty} were already up to date.`);
  if (result.itemErrors > 0) {
    parts.push(`${plural(result.itemErrors, 'report')} skipped — their repository is not connected to Beezi.`);
  }
  if (result.costStateSessions > 0) {
    parts.push(`${plural(result.costStateSessions, 'session')} used Claude's own cost record for their totals.`);
  }
  if (result.costStateOnlySessions > 0) {
    parts.push(
      `${plural(result.costStateOnlySessions, 'session')} had only that record ` +
        '(no repository, billing or timeline detail added for those).',
    );
  }
  if (result.sessionsRejected > 0) {
    parts.push(`${plural(result.sessionsRejected, 'session')} were rejected by the server.`);
  }
  // Its own line: reportsFailed stays 0 for cost-record-only sessions, so nothing else here would
  // mention them. Sessions that also had segments landed through those.
  if (result.costStatesUnsupported && result.costStatesFailed > 0) {
    parts.push(
      `${plural(result.costStatesFailed, 'session')} could not be uploaded — this Beezi server ` +
        'does not accept Claude cost records yet.',
    );
  } else if (result.costStatesUnsupported) {
    parts.push("This Beezi server does not accept Claude cost records yet, so totals use Beezi's own tally.");
  } else if (result.costStatesFailed > 0) {
    parts.push(
      `${plural(result.costStatesFailed, 'session')} could not be delivered — run /beezi:sync again to retry.`,
    );
  }
  if (result.reportsFailed > 0 || result.unattributed > 0 || result.permanentRejections > 0) {
    const reason = result.lastError ? ` (last error: ${result.lastError})` : '';
    parts.push(
      `${plural(result.reportsFailed, 'report')} could not be delivered${reason} — run /beezi:sync again to retry.`,
    );
  }
  console.log(parts.join(' '));

  if (result.noRemote > 0) {
    console.log(
      `  ${plural(result.noRemote, 'session')} could not be matched to a repository — not uploaded. ` +
        'Their transcripts record no working directory.',
    );
  }
  if (result.emitFailed > 0) {
    console.log(`  ${plural(result.emitFailed, 'session')} failed while being prepared — not uploaded.`);
  }
  if (result.unreadable > 0) {
    console.log(`  ${plural(result.unreadable, 'session')} could not be read — not uploaded.`);
  }
  if (result.oversize > 0) {
    console.log(`  ${plural(result.oversize, 'session')} were too large to read — not uploaded.`);
  }
  if (result.plannedReports > result.reportsStored + result.reportsSkipped) {
    console.log(
      `  Note: ${plural(result.plannedReports, 'report')} sent, ${result.reportsStored} stored ` +
        `and ${result.reportsSkipped} skipped by the server.`,
    );
  }
  if (result.timelines > 0) {
    console.log('  ' + plural(result.timelines, 'session timeline') + ' attached.');
  }
  console.log(
    '  Plan and billing details reflect your current setup, not the plan you were on at the time.',
  );
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

async function main() {
  const { account, rest } = await parseAccountFlag(process.argv.slice(2));
  const rows = account != null
    ? [(await getAccount(account)) || { key: account }]
    : (await listAccounts()).filter((a) => a.status === AccountStatus.LINKED);
  if (rows.length === 0) fail('Beezi: this machine is not linked. Run /beezi:login first.');
  if (rows.length > 1 && rest.indexOf('--tenant') !== -1) {
    fail('Beezi: --tenant needs --account <key> when several accounts are linked.');
  }
  const options = parseArgs(rest.filter((arg, i) => arg !== '--tenant' && rest[i - 1] !== '--tenant'));
  if (options.sinceMs != null) {
    fail('Beezi: /beezi:sync does not take --since — it uploads exactly what Beezi is missing. Run it with no flags.');
  }
  if (options.force) {
    fail('Beezi: /beezi:sync does not take --force — there is no one-time seal to force past.');
  }

  // One run per account × routed workspace.
  for (const row of rows) {
    const override = parseTenantFlags(rest, row).tenantIds;
    // One git cache for every workspace's run of this account, as in backfill.
    const runCache = createRunCache();
    if (!isMultiTenant(row)) {
      if (rows.length > 1) console.log(`\n— ${describeAccount(row)} —`);
      if (usesRules(row)) {
        const plan = planWorkspaceRuns(row);
        const excludedSessionIds = dontTrackSessionIds(plan);
        await syncOne(row.key, { ...options, tenantId: null, excludedSessionIds, excludedLabel: describeAccount(row) }, null, runCache);
      } else {
        await syncOne(row.key, { ...options, tenantId: null }, null, runCache);
      }
      continue;
    }
    // --tenant is an override: those workspaces get every past session, unrouted.
    if (override.length > 0) {
      for (const tenantId of override) {
        console.log(`\n— ${describeAccount(row)} · ${tenantLabel(row, tenantId)} —`);
        await syncOne(row.key, { ...options, tenantId }, null, runCache);
      }
      continue;
    }
    const plan = planWorkspaceRuns(row);
    if (plan.scanned === 0) {
      console.log(`\n✓ Beezi (${describeAccount(row)}): no Claude Code sessions found on this machine.`);
      continue;
    }
    const summary = routeSummary(row, plan);
    if (summary != null) console.log(`\n${summary}`);
    for (const tenantId of plan.tenantIds) {
      console.log(`\n— ${describeAccount(row)} · ${tenantLabel(row, tenantId)} —`);
      await syncOne(row.key, { ...options, tenantId, sessionRoutes: plan.routes }, null, runCache);
    }
  }
  // Pending history (rules gained a workspace) gets its own coverage-based pass once this sync let go of the lock.
  if (!options.dryRun) for (const row of rows) await startHistoryWorker(row.key);
}

main().then(() => {
  if (!process.argv.includes('--dry-run')) maybeSpawnCoworkLive();
}).catch((error) => fail(friendlyMessage(error)));
