import path from 'path';
import { linkedSessions as _linkedSessions } from './sessions.mjs';
import { runCheckpoint as _runCheckpoint } from './checkpoint.mjs';
import { currentBranch as _currentBranch, taskFromBranch } from './git.mjs';

// Names an account by the friendliest field it carries.
function accountLabel(f) {
  return f.tenantName || f.email || f.key;
}

// The manual /beezi:track flow for one session: checkpoint, flush, word the outcome.
// Returns { ok, message } (message unprefixed); expected failures never throw.
export async function trackSession({ sessionId, transcriptPath, cwd }, deps = {}) {
  const linkedSessions = deps.linkedSessions == null ? _linkedSessions : deps.linkedSessions;
  const runCheckpoint = deps.runCheckpoint == null ? _runCheckpoint : deps.runCheckpoint;
  const currentBranch = deps.currentBranch == null ? _currentBranch : deps.currentBranch;

  // Label only. The checkpoint attributes every segment from the transcript, so a cwd outside
  // any repo — or a repo with no origin — is not a reason to refuse; those report under a
  // `local:<folder>` remote like the automatic hooks do.
  let branch = null;
  try { branch = currentBranch(cwd); } catch { /* not a repo */ }
  const task = taskFromBranch(branch);
  const label = task == null
    ? (branch == null ? (path.basename(cwd == null ? '' : cwd) || cwd) : branch)
    : task;

  const sessions = await linkedSessions().catch(() => []);
  if (sessions.length === 0) {
    return { ok: false, message: 'Beezi: this machine is not linked. Run /beezi:login first.' };
  }

  // Resolved once here and handed down, so the wording below names the same accounts that ran.
  const { enqueued, flush, flushes, gated } = await runCheckpoint(
    { session_id: sessionId, transcript_path: transcriptPath, cwd },
    { linkedSessions: async () => sessions },
  );

  // The tenant gate answered, not the server: "already up to date" would be a lie here.
  if (gated) {
    return { ok: false, message: 'Beezi: live tracking is off for every linked workspace (audit mode).' };
  }
  if (flush && flush.failed && !flush.flushed) {
    return { ok: false, message: 'Beezi: could not reach the server — analytics will be retried automatically.' };
  }
  if (flush && flush.rejected && !flush.flushed) {
    return { ok: false, message: `Beezi: ${flush.lastError == null ? 'the server rejected this report' : flush.lastError}.` };
  }

  const saved = flush == null || flush.flushed == null ? 0 : flush.flushed;
  if (enqueued === 0 && saved === 0) {
    return { ok: true, message: `Beezi: nothing new to save for ${label} — already up to date.` };
  }
  if (flushes.length <= 1) {
    return { ok: true, message: `Beezi: analytics saved for ${label} (${saved} segment${saved === 1 ? '' : 's'}).` };
  }
  const lines = flushes.map((f) => {
    const n = f.flushed == null ? 0 : f.flushed;
    const tail = f.failed ? ` — ${f.failed} pending retry` : (f.rejected ? ` — ${f.rejected} rejected` : '');
    return `  ${accountLabel(f)}: ${n} segment${n === 1 ? '' : 's'}${tail}`;
  });
  return { ok: true, message: `Beezi: analytics saved for ${label}.\n${lines.join('\n')}` };
}
