import fs from 'fs';
import path from 'path';
import { stateDir } from './paths.mjs';

// A long agent turn fires no Stop and often no git command for an hour, so nothing checkpoints:
// token segments, the timeline, usage snapshots and statusline rows all wait for the turn to
// end. The pulse rides PostToolUse for EVERY tool and bounds that wait: almost every firing is
// a single stat() and exit; only when the last pulse is older than the interval does it pay for
// a full turn-end-grade checkpoint.
export const PULSE_INTERVAL_MS = 15 * 60 * 1000;

const markerFile = (sessionId) => path.join(stateDir(), `${sessionId}.pulse`);

// Claim the interval by touching the marker BEFORE the checkpoint runs: parallel tool
// completions racing here at most double-run (segments upsert by segmentId, snapshots dedupe
// server-side), and a checkpoint that dies waits out the interval instead of retrying per tool.
export function claimPulse(sessionId, deps = {}) {
  const now = deps.now == null ? Date.now : deps.now;
  const intervalMs = deps.intervalMs == null ? PULSE_INTERVAL_MS : deps.intervalMs;
  const marker = markerFile(sessionId);
  try {
    if (now() - fs.statSync(marker).mtimeMs < intervalMs) return false;
  } catch { /* no marker yet — first pulse of the session */ }
  // An unclaimable marker (unwritable disk) skips the pulse rather than running a full
  // checkpoint on every tool call; Stop still covers the turn end.
  try {
    fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    fs.closeSync(fs.openSync(marker, 'w'));
  } catch {
    return false;
  }
  return true;
}

// Returns { ran } — ran is true when this firing performed the checkpoint.
export async function maybeRunPulse(input, deps = {}) {
  if (input == null || !input.session_id || !input.transcript_path) return { ran: false };
  if (!claimPulse(input.session_id, deps)) return { ran: false };
  // Heavy import only after a successful claim, so the gated path stays at node startup.
  const runCheckpoint =
    deps.runCheckpoint == null ? (await import('./checkpoint.mjs')).runCheckpoint : deps.runCheckpoint;
  // emitTimeline: the pulse substitutes for a Stop that is not coming, so it ships everything
  // a turn end would — segments, timeline, usage snapshot, statusline drain.
  const result = await runCheckpoint(input, {}, { emitTimeline: true });
  return { ran: true, result };
}
