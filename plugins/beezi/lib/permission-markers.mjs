import fs from 'fs';
import path from 'path';
import { stateDir } from './paths.mjs';

// Permission prompts the human APPROVED leave no trace in the transcript: an approved tool_use is
// byte-identical to one that never needed asking, so the wait charts as `working` (or `idle` past
// the gap threshold). Only a DECLINE writes a marker text, which is why session-timeline.mjs could
// see half the picture and no more.
//
// The PermissionRequest hook fires when Claude Code is about to put a prompt on screen, so a line
// appended here is the one durable proof that a human was being waited on at that instant. The
// file is the whole channel between the two processes — the hook and the timeline computation run
// in separate processes with nothing shared but the filesystem.
//
// Append-only, one JSON object per line. Deliberately NOT writeJsonSecure: that rewrites the whole
// file, and a read-modify-write races with a parallel tool batch where several prompts open at
// once. A short `appendFileSync` is a single O_APPEND write, which the OS does not interleave, so
// concurrent hooks can only ever produce whole lines in some order. A reader that skips an
// unparseable line therefore loses nothing real.
//
// Never trimmed in place for the same reason. ~70 bytes a line, and pruneStale's 14-day sweep over
// stateDir() already collects these alongside every other per-session file.

// Read-time ceiling, so a pathological session cannot hand the classifier an unbounded array.
const MAX_MARKERS = 2000;

// `.perm.jsonl`, not `.json`: transcript.mjs scans stateDir() for `.json` and would otherwise try
// to read these as checkpoint state. Same per-session shape as pulse.mjs's `<sessionId>.pulse`.
const permissionMarkerFile = (sessionId) => path.join(stateDir(), `${sessionId}.perm.jsonl`);

// Append one marker. Best-effort: a telemetry line must never break the permission dialog that is
// waiting on this hook to exit.
export function appendPermissionMarker(sessionId, marker) {
  if (!sessionId) return false;
  const file = permissionMarkerFile(sessionId);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${JSON.stringify(marker)}\n`, { encoding: 'utf-8', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

// Load a session's markers as `{ ts, toolName, permissionMode }`, oldest first. Missing file,
// unreadable file and torn lines all resolve to "no markers", which degrades to exactly the
// behaviour this plugin had before markers existed.
export function readPermissionMarkers(sessionId) {
  if (!sessionId) return [];
  let raw;
  try {
    raw = fs.readFileSync(permissionMarkerFile(sessionId), 'utf-8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (parsed == null) continue;
    const ts = parsed.at == null ? NaN : Date.parse(parsed.at);
    if (!Number.isFinite(ts)) continue;
    out.push({
      ts,
      toolName: typeof parsed.tool_name === 'string' ? parsed.tool_name : null,
      permissionMode: typeof parsed.permission_mode === 'string' ? parsed.permission_mode : null,
    });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out.length > MAX_MARKERS ? out.slice(-MAX_MARKERS) : out;
}
