import { parseArgs, runAudit, SYNC_MODE } from '../lib/session-audit.mjs';
import { BackfillHalt } from '../lib/audit-flush.mjs';
import { parseAccountFlag, listAccounts, describeAccount, AccountStatus } from '../lib/accounts.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';
import { maybeSpawnCoworkLive } from '../lib/cowork-live.mjs';

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
async function syncOne(account, options, label) {
  options.account = account;
  options.mode = SYNC_MODE;
  const prefix = label == null ? 'Beezi' : `Beezi (${label})`;

  const result = await runAudit(
    {
      onProgress: ({ processed, total }) => {
        console.log(`${prefix}: ${processed}/${total} sessions read…`);
      },
    },
    options,
  );

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
    // Counted apart from `plannedReports`, which a fast-path session contributes nothing to: it
    // sends one cost record and no reports, so the two numbers above would otherwise show a run
    // uploading "0 reports across 300 sessions".
    if (result.costStateSessions > 0) {
      console.log(
        `  ${plural(result.costStateSessions, 'session')} of those would go up as Claude's own cost record.`,
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
    parts.push(
      `${plural(result.costStateSessions, 'session')} used Claude's own cost record ` +
        '(no repository or timeline detail added for those).',
    );
  }
  if (result.sessionsRejected > 0) {
    parts.push(`${plural(result.sessionsRejected, 'session')} were rejected by the server.`);
  }
  // Its own line: reportsFailed stays 0 for these sessions, so nothing else here would mention them.
  if (result.costStatesUnsupported) {
    parts.push(
      `${plural(result.costStatesFailed, 'session')} could not be uploaded — this Beezi server ` +
        'does not accept Claude cost records yet.',
    );
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

async function main() {
  const { account, rest } = await parseAccountFlag(process.argv.slice(2));
  const options = parseArgs(rest);
  if (options.sinceMs != null) {
    fail('Beezi: /beezi:sync does not take --since — it uploads exactly what Beezi is missing. Run it with no flags.');
  }
  if (options.force) {
    fail('Beezi: /beezi:sync does not take --force — there is no one-time seal to force past.');
  }

  if (account != null) {
    await syncOne(account, { ...options }, null);
    return;
  }
  const accounts = (await listAccounts()).filter((a) => a.status === AccountStatus.LINKED);
  if (accounts.length === 0) fail('Beezi: this machine is not linked. Run /beezi:login first.');
  for (const a of accounts) {
    if (accounts.length > 1) console.log(`\n— ${describeAccount(a)} —`);
    await syncOne(a.key, { ...options }, null);
  }
}

main().then(() => {
  if (!process.argv.includes('--dry-run')) maybeSpawnCoworkLive();
}).catch((error) => fail(friendlyMessage(error)));
