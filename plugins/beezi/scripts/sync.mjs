import { parseArgs, runAudit, SYNC_MODE } from '../lib/session-audit.mjs';
import { BackfillHalt } from '../lib/audit-flush.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';

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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.sinceMs != null) {
    fail('Beezi: /beezi:sync does not take --since — it uploads exactly what Beezi is missing. Run it with no flags.');
  }
  if (options.force) {
    fail('Beezi: /beezi:sync does not take --force — there is no one-time seal to force past.');
  }
  options.mode = SYNC_MODE;

  const result = await runAudit(
    {
      onProgress: ({ processed, total }) => {
        console.log(`Beezi: ${processed}/${total} sessions read…`);
      },
    },
    options,
  );

  if (result.reason === 'no-token') {
    fail('Beezi: this machine is not linked. Run /beezi:login first.');
  }
  if (result.halt === BackfillHalt.NOT_ALLOWED) {
    fail('Beezi: uploads are disabled for this workspace — the audit period has ended.');
  }
  if (result.halt === BackfillHalt.UNSUPPORTED_SERVER) {
    fail('Beezi: this portal does not support /beezi:sync yet — try again after the next portal update.');
  }
  if (result.halt === BackfillHalt.FORBIDDEN) {
    fail(
      `Beezi: the server refused the upload (${result.lastError == null ? 'forbidden' : result.lastError}). ` +
        'Check your seat with your workspace admin, then try again.',
    );
  }

  if (result.scanned === 0) {
    console.log('✓ Beezi: no Claude Code sessions found on this machine.');
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
    const bits = [];
    if (result.active > 0) bits.push(`${result.active} still active — they sync once they settle`);
    console.log(`✓ Beezi: everything is already uploaded${bits.length ? ` (${bits.join(', ')})` : ''}.`);
    return;
  }

  if (options.dryRun) {
    console.log(
      `Beezi: would upload ${plural(result.plannedReports, 'report')} across ` +
        `${plural(result.candidates, 'session')} in ${plural(result.plannedChunks, 'request')} ` +
        '(dry run — nothing sent).',
    );
    return;
  }

  if (result.reportsFailed > 0 && result.sessionsImported === 0) {
    fail(
      `Beezi: upload stopped — could not reach the server (${result.lastError == null ? 'unknown error' : result.lastError}). ` +
        'Run /beezi:sync again to continue where it left off.',
    );
  }

  // `empty` is the headline number here, not a footnote: a session already fully uploaded produces
  // no reports, so on a healthy repeat run it accounts for nearly every candidate.
  const parts = [`✓ Beezi: uploaded ${plural(result.sessionsImported, 'session')} (${plural(result.reportsStored, 'report')} stored).`];
  if (result.empty > 0) parts.push(`${result.empty} were already up to date.`);
  if (result.active > 0) parts.push(`${result.active} still active — they sync once they settle.`);
  if (result.itemErrors > 0) {
    parts.push(`${plural(result.itemErrors, 'report')} skipped — their repository is not connected to Beezi.`);
  }
  if (result.sessionsRejected > 0) {
    parts.push(`${plural(result.sessionsRejected, 'session')} were rejected by the server.`);
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

main().catch((error) => fail(friendlyMessage(error)));
