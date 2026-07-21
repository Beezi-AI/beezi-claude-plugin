import { getAccessToken } from '../lib/token.mjs';
import { runCheckpoint } from '../lib/checkpoint.mjs';
import { git, resolveOriginRemote, currentBranch, taskFromBranch } from '../lib/git.mjs';
import { resolveSessionTranscript } from '../lib/transcript.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';

const cwd = process.cwd();

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

async function main() {
  let branch;
  try {
    branch = currentBranch(cwd);
  } catch {
    fail('Beezi: not a git repository — run this inside your project.');
  }

  // Every branch is worth tracking: task branches attribute to their ticket, the rest to the
  // repository. `taskFromBranch` only decides the label we echo, never whether we report.
  const task = taskFromBranch(branch);
  const label = task ?? branch;

  const token = await getAccessToken().catch(() => null);
  if (!token) fail('Beezi: this machine is not linked. Run /beezi:login first.');

  if (!resolveOriginRemote(git, cwd)) {
    fail('Beezi: this repo has no "origin" remote. Nothing tracked.');
  }

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
