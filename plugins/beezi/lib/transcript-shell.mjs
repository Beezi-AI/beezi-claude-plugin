import fs from 'fs';

// Head/tail window for the session shell. The cwd and the session's first timestamp sit on its
// very first records, its last timestamp on the very last. The same 64KB either end that
// firstRecordedCwd and sessionNameFrom already read — dozens of records at each boundary.
export const SHELL_SCAN_BYTES = 64 * 1024;

// The bare facts needed to CREATE a session from a cost-state block alone: when it ran, and where.
//
// The block carries no timestamp of its own and its startTime resets mid-file, so the span has to
// come from the records around it. started_at is not optional: every CLI analytics read filters
// and buckets on it, and the server refuses a retrospective session without one — so a shell with
// no start is the caller's signal to fall back to the full segment path.
//
// Best-effort by contract: an unreadable file, a truncated line or a stampless transcript all
// yield nulls. This runs over every past session on the machine; nothing here may throw.
export function readSessionShell(transcriptPath, deps = {}) {
  const openSync = deps.openSync == null ? fs.openSync : deps.openSync;
  const readSync = deps.readSync == null ? fs.readSync : deps.readSync;
  const closeSync = deps.closeSync == null ? fs.closeSync : deps.closeSync;
  const fstatSync = deps.fstatSync == null ? fs.fstatSync : deps.fstatSync;

  const empty = { startedAt: null, endedAt: null, cwd: null };

  let head;
  let tail;
  let fd;
  try {
    fd = openSync(transcriptPath, 'r');
  } catch {
    return empty;
  }
  try {
    const size = fstatSync(fd).size;
    if (!(size > 0)) return empty;
    const headLength = size < SHELL_SCAN_BYTES ? size : SHELL_SCAN_BYTES;
    const headBuffer = Buffer.alloc(headLength);
    const headRead = readSync(fd, headBuffer, 0, headLength, 0);
    head = headBuffer.subarray(0, headRead).toString('utf-8');
    if (size <= SHELL_SCAN_BYTES) {
      tail = head;
    } else {
      const tailBuffer = Buffer.alloc(SHELL_SCAN_BYTES);
      const tailRead = readSync(fd, tailBuffer, 0, SHELL_SCAN_BYTES, size - SHELL_SCAN_BYTES);
      tail = tailBuffer.subarray(0, tailRead).toString('utf-8');
    }
  } catch {
    return empty;
  } finally {
    try { closeSync(fd); } catch { /* best-effort */ }
  }

  const headLines = head.split('\n');
  // The read is byte-bounded, so a head that did not land on a newline ends mid-JSON.
  if (!head.endsWith('\n')) headLines.pop();
  let startedAt = null;
  let cwd = null;
  for (const raw of headLines) {
    const parsed = parseLine(raw);
    if (parsed == null) continue;
    if (startedAt == null && isStamp(parsed.timestamp)) startedAt = parsed.timestamp;
    if (cwd == null && typeof parsed.cwd === 'string' && parsed.cwd) cwd = parsed.cwd;
    if (startedAt != null && cwd != null) break;
  }

  const tailLines = tail.split('\n');
  // Same truncation at the other end: unless the window IS the head, its first line is the partial
  // one. Dropping it costs nothing — the record we want is at the far end.
  if (tail !== head) tailLines.shift();
  let endedAt = null;
  for (let i = tailLines.length - 1; i >= 0; i -= 1) {
    const parsed = parseLine(tailLines[i]);
    if (parsed == null) continue;
    if (isStamp(parsed.timestamp)) {
      endedAt = parsed.timestamp;
      break;
    }
  }
  // A tail window can legitimately hold nothing but the stampless cost-state records. Collapsing
  // the span to its start beats reporting none: the server clamps a missing end the same way.
  if (endedAt == null) endedAt = startedAt;
  // Records are appended in order, but a resumed session can carry an older stamp in its tail.
  // The server's GREATEST/LEAST upsert would absorb an inverted span; the wire should not carry
  // one in the first place.
  if (startedAt != null && endedAt != null && Date.parse(endedAt) < Date.parse(startedAt)) {
    endedAt = startedAt;
  }

  return { startedAt: startedAt, endedAt: endedAt, cwd: cwd };
}

function parseLine(raw) {
  const line = raw.trim();
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// The wire needs a real instant: the API validates @IsISO8601 and every CLI read buckets on it.
function isStamp(value) {
  if (typeof value !== 'string' || !value) return false;
  return !isNaN(Date.parse(value));
}
