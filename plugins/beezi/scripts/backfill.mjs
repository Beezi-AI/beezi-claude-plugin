import { parseArgs, runAudit } from '../lib/session-audit.mjs';
import { BackfillHalt } from '../lib/audit-flush.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';

// The login flow's final step: uploads this machine's past sessions into Beezi. There is no
// slash command for it — /beezi:login runs it after the link and plan capture, and re-running
// /beezi:login resumes an interrupted upload. Flags (--dry-run / --since / --force) remain for
// manual `node scripts/backfill.mjs` runs only.

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const viaLogin = options.via === 'login';

  const result = await runAudit(
    {
      // "read", not "sent": `processed` counts candidates PARSED, and a parsed session may still
      // produce nothing to upload. Calling it "sent" is what made the final totals look like they
      // had lost sessions when the arithmetic was simply against a different number.
      onProgress: ({ processed, total }) => {
        console.log(`Beezi: ${processed}/${total} sessions read…`);
      },
    },
    options,
  );

  if (result.reason === 'no-token') {
    fail('Beezi: this machine is not linked. Run /beezi:login first.');
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
      return;
    }
    fail(lines.join(' '));
  }
  if (result.halt === BackfillHalt.NOT_ALLOWED) {
    fail('Beezi: the audit period has ended — new history pulls are disabled for this workspace.');
  }
  if (result.halt === BackfillHalt.UNSUPPORTED_SERVER) {
    fail('Beezi: the server does not support the history pull yet — try again after the portal update.');
  }
  if (result.halt === BackfillHalt.FORBIDDEN) {
    fail(
      `Beezi: the server refused the upload (${result.lastError == null ? 'forbidden' : result.lastError}). ` +
        'Check your seat with your workspace admin, then re-run /beezi:login.',
    );
  }

  if (result.scanned === 0) {
    console.log('✓ Beezi: no past Claude Code sessions found to upload.');
    return;
  }
  if (result.candidates === 0) {
    const bits = [];
    if (result.alreadyImported > 0) bits.push(`${plural(result.alreadyImported, 'session')} already uploaded`);
    if (result.liveTracked > 0) bits.push(`${result.liveTracked} already tracked live`);
    if (result.active > 0) bits.push(`${result.active} still active — they upload on a later login`);
    console.log(`✓ Beezi: nothing new to upload${bits.length ? ` (${bits.join(', ')})` : ''}.`);
    if (result.finalized) console.log('✓ Beezi: your history pull is finalized.');
    return;
  }

  if (options.dryRun) {
    console.log(
      `Beezi: would upload ${plural(result.candidates, 'session')} / ` +
        `${plural(result.plannedReports, 'report')} in ${plural(result.plannedChunks, 'request')} ` +
        '(dry run — nothing sent).',
    );
    return;
  }

  // Everything that was parsed but never judged by the server. Those sessions stay unledgered, so
  // saying "log in again to continue" is accurate — the next login's backfill picks them up.
  if (result.reportsFailed > 0 && result.sessionsImported === 0) {
    fail(
      `Beezi: upload stopped — could not reach the server (${result.lastError == null ? 'unknown error' : result.lastError}). ` +
        'Re-run /beezi:login to continue where it left off.',
    );
  }

  const parts = [`✓ Beezi: uploaded ${plural(result.sessionsImported, 'session')} (${plural(result.reportsStored, 'report')} stored).`];
  if (result.alreadyImported > 0) parts.push(`${result.alreadyImported} were already uploaded.`);
  if (result.liveTracked > 0) parts.push(`${result.liveTracked} were already tracked live.`);
  if (result.active > 0) parts.push(`${result.active} still active — they upload on a later login.`);
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
}

main().catch((error) => fail(friendlyMessage(error)));
