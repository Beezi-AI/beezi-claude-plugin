import { readJson, writeJsonSecure } from './fs-store.mjs';
import { costStateSyncFile } from './paths.mjs';

export const STATE_VERSION = 1;

// At most one scan per hour, per the feature spec.
export const DUE_MS = 60 * 60 * 1000;

// How far back before lastScanAt a transcript's mtime still counts as unscanned. Clock skew
// between the stamp and the filesystem is the only thing this covers; re-uploading is free
// because the block is cumulative and the server upserts on (tenant, source_ref).
export const OVERLAP_MS = 10 * 60 * 1000;

export function readSyncState(deps = {}) {
  const read = deps.readJsonImpl == null ? readJson : deps.readJsonImpl;
  const raw = read(costStateSyncFile(), null);
  if (raw == null || raw.version !== STATE_VERSION) return null;
  return raw;
}

// Merges onto the prior record rather than replacing it. markAttempt fires on a DIRTY run, so a
// replacing write would erase lastScanAt, collapse the mtime floor to 0, and make every later
// scan re-read every transcript on the machine.
function write(patch, deps) {
  const writeImpl = deps.writeJsonImpl == null ? writeJsonSecure : deps.writeJsonImpl;
  const prior = readSyncState(deps);
  const next = prior == null ? { version: STATE_VERSION } : { ...prior, ...{ version: STATE_VERSION } };
  try {
    writeImpl(costStateSyncFile(), { ...next, ...patch });
  } catch { /* best-effort: a gate we failed to write costs one extra scan, nothing more */ }
}

// Stamped by the PARENT before it spawns, so a child that dies on startup still costs an hour
// instead of respawning on every single turn.
export function markAttempt(nowMs, deps = {}) {
  write({ attemptedAt: new Date(nowMs).toISOString() }, deps);
}

// Stamped by the CHILD, and ONLY after a fully clean run: every chunk 2xx and zero rejections.
// This is the value the incremental mtime filter reads, so advancing it is a promise that every
// transcript below the floor is done. A 404, a transport failure, a 401 or an "unknown session"
// rejection must leave it alone — a transcript's mtime never changes again, so a floor advanced
// past a rejected session strands that session's cost permanently.
export function markSuccess(nowMs, deps = {}) {
  write({ lastScanAt: new Date(nowMs).toISOString() }, deps);
}

function stampMs(value) {
  const at = Date.parse(value == null ? '' : value);
  return isNaN(at) ? null : at;
}

// Gated on max(attemptedAt, lastScanAt): the attempt suppresses a respawn storm, the success
// records real progress, and whichever is later decides.
export function isDue(state, nowMs) {
  if (state == null) return true;
  const attempted = stampMs(state.attemptedAt);
  const scanned = stampMs(state.lastScanAt);
  if (attempted == null && scanned == null) return true;
  const last = Math.max(attempted == null ? 0 : attempted, scanned == null ? 0 : scanned);
  // A stamp in the future is a clock change, not freshness — do not let it lock the gate shut.
  if (last > nowMs) return true;
  return nowMs - last >= DUE_MS;
}

// The mtime floor for the incremental scan: files untouched since the last SUCCESSFUL scan are
// already uploaded. Never derived from attemptedAt — a failed attempt saw nothing.
export function scanFloorMs(state) {
  if (state == null) return 0;
  const scanned = stampMs(state.lastScanAt);
  if (scanned == null) return 0;
  const floor = scanned - OVERLAP_MS;
  return floor > 0 ? floor : 0;
}
