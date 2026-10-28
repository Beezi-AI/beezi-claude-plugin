import { readSessionWorkspace, tenantsOf } from './workspace.mjs';
import { createRouteContext, routeKeyForDir } from './workspace-rules.mjs';
import { firstRecordedCwd, listAllTranscripts } from './transcript-index.mjs';
import { resolveSessionId } from './permission-mode-store.mjs';
import { isImported, loadLedger } from './audit-ledger.mjs';

// The history upload's own skips, as in workspace-rules.mjs: transcripts over 64 MB and ones written in the last 30 minutes.
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const ACTIVE_SESSION_WINDOW_MS = 30 * 60 * 1000;

const placeId = (key) => `${key.kind}\n${key.match}`;

// Past sessions the history upload would send (not live, active, oversized or imported) and the distinct places they ran in,
// deduped by kind+match and less `hereKey`'s place; one with no directory counts in sessions only.
export function countPastSessions(entries, { liveSessionId = null, now = Date.now(), imported, readState, readCwd, keyOf, hereKey = null }) {
  const places = new Set();
  let sessions = 0;
  for (const entry of entries || []) {
    if (entry == null || entry.sessionId == null || (liveSessionId != null && entry.sessionId === liveSessionId)) continue;
    if (now - entry.mtimeMs < ACTIVE_SESSION_WINDOW_MS || entry.size > MAX_TRANSCRIPT_BYTES || imported(entry.sessionId)) continue;
    sessions += 1;
    const state = readState(entry.sessionId);
    const dir = state != null && typeof state.cwd === 'string' && state.cwd !== '' ? state.cwd : readCwd(entry.transcriptPath);
    const key = dir == null ? null : keyOf(dir);
    if (key != null) places.add(placeId(key));
  }
  if (hereKey != null) places.delete(placeId(hereKey));
  return { sessions, places: places.size };
}

// countPastSessions over this machine's transcripts; a session imported into any of the account's workspaces is not uploaded again.
export function pastSessions(row, hereKey = null) {
  const ctx = createRouteContext();
  const ledgers = tenantsOf(row).map((t) => loadLedger(row.key, row.clientId == null ? null : row.clientId, t.id));
  return countPastSessions(listAllTranscripts(), {
    liveSessionId: resolveSessionId(),
    imported: (sessionId) => ledgers.some((ledger) => isImported(ledger, sessionId)),
    readState: readSessionWorkspace,
    readCwd: firstRecordedCwd,
    keyOf: (dir) => routeKeyForDir(dir, ctx),
    hereKey,
  });
}
