import path from 'node:path';
import { getAccessToken } from '../lib/token.mjs';
import { runCheckpoint } from '../lib/checkpoint.mjs';
import { currentBranch, taskFromBranch } from '../lib/git.mjs';
import { resolveSessionTranscript } from '../lib/transcript.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';

const cwd = process.cwd();

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

async function main() {
  // Label only. The checkpoint attributes every segment from the transcript, so a cwd outside
  // any repo — or a repo with no origin — is not a reason to refuse; those report under a
  // `local:<folder>` remote like the automatic hooks do.
  let branch = null;
  try { branch = currentBranch(cwd); } catch { /* not a repo */ }
  const label = taskFromBranch(branch) ?? branch ?? (path.basename(cwd) || cwd);

  const token = await getAccessToken().catch(() => null);
  if (!token) fail('Beezi: this machine is not linked. Run /beezi:login first.');

  const transcript = resolveSessionTranscript(cwd);
  if (!transcript) {
    fail('Beezi: could not find this session’s transcript to track.');
  }

  const { enqueued, flush } = await runCheckpoint({
    session_id: transcript.sessionId,
    transcript_path: transcript.transcriptPath,
    cwd,
  });

  if (flush?.failed) {
    fail('Beezi: could not reach the server — analytics will be retried automatically.');
  }
  if (flush?.rejected) {
    fail(`Beezi: ${flush.lastError ?? 'the server rejected this report'}.`);
  }

  const saved = flush?.flushed ?? 0;
  if (enqueued === 0 && saved === 0) {
    console.log(`✓ Beezi: nothing new to save for ${label} — already up to date.`);
    return;
  }

  console.log(`✓ Beezi: analytics saved for ${label} (${saved} segment${saved === 1 ? '' : 's'}).`);
}

main().catch((error) => fail(friendlyMessage(error)));
