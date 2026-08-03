import path from 'node:path';
import { getAccessToken as _getAccessToken } from './token.mjs';
import { runCheckpoint as _runCheckpoint } from './checkpoint.mjs';
import { currentBranch as _currentBranch, taskFromBranch } from './git.mjs';

// The manual /beezi:track flow for one session: checkpoint, flush, word the outcome.
// Returns { ok, message } (message unprefixed); expected failures never throw.
export async function trackSession({ sessionId, transcriptPath, cwd }, deps = {}) {
  const getAccessToken = deps.getAccessToken ?? _getAccessToken;
  const runCheckpoint = deps.runCheckpoint ?? _runCheckpoint;
  const currentBranch = deps.currentBranch ?? _currentBranch;

  // Label only. The checkpoint attributes every segment from the transcript, so a cwd outside
  // any repo — or a repo with no origin — is not a reason to refuse; those report under a
  // `local:<folder>` remote like the automatic hooks do.
  let branch = null;
  try { branch = currentBranch(cwd); } catch { /* not a repo */ }
  const label = taskFromBranch(branch) ?? branch ?? (path.basename(cwd ?? '') || cwd);

  const token = await getAccessToken().catch(() => null);
  if (!token) {
    return { ok: false, message: 'Beezi: this machine is not linked. Run /beezi:login first.' };
  }

  const { enqueued, flush } = await runCheckpoint({
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd,
  });

  if (flush?.failed) {
    return { ok: false, message: 'Beezi: could not reach the server — analytics will be retried automatically.' };
  }
  if (flush?.rejected) {
    return { ok: false, message: `Beezi: ${flush.lastError ?? 'the server rejected this report'}.` };
  }

  const saved = flush?.flushed ?? 0;
  if (enqueued === 0 && saved === 0) {
    return { ok: true, message: `Beezi: nothing new to save for ${label} — already up to date.` };
  }
  return { ok: true, message: `Beezi: analytics saved for ${label} (${saved} segment${saved === 1 ? '' : 's'}).` };
}
