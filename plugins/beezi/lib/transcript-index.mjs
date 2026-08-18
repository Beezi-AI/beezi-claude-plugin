import fs from 'fs';
import path from 'path';
import { claudeProjectsDir } from './paths.mjs';

// Claude Code names a session file after its globally-unique session id. Anchored, and the same
// character class findTranscriptBySessionId uses: it is what rejects '..', separators, and any
// non-session file, so no path built from the result can escape the project dir.
const SESSION_ID = /^[a-zA-Z0-9-]+$/;

// How much of a transcript's head to read looking for the recorded cwd. The cwd is on the very
// first record in practice; the cap keeps a 50MB transcript from being slurped for one field.
const CWD_SCAN_BYTES = 64 * 1024;

// Every past session transcript on this machine: ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl.
//
// Non-recursive per project dir on purpose. Subagent transcripts live one level deeper
// (<projectDir>/<sessionId>/subagents/agent-*.jsonl) and must NOT appear here — runCheckpoint
// discovers those itself from the main transcript path, and surfacing them as sessions would
// report each subagent as a session of its own.
//
// Sorted oldest-first so an interrupted import advances chronologically. Best-effort throughout:
// an unreadable root yields [], an unreadable entry is skipped, nothing throws.
export function listAllTranscripts({ projectsDir = claudeProjectsDir() } = {}) {
  let dirs;
  try {
    dirs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }

  const found = [];
  for (const dir of dirs) {
    const projectDir = path.join(projectsDir, dir.name);
    let entries;
    try {
      entries = fs.readdirSync(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      // isFile() also stops a *directory* named "x.jsonl" from being read as a transcript.
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const sessionId = entry.name.slice(0, -'.jsonl'.length);
      if (!SESSION_ID.test(sessionId)) continue;
      const transcriptPath = path.join(projectDir, entry.name);
      let stat;
      try {
        stat = fs.statSync(transcriptPath);
      } catch {
        continue;
      }
      found.push({ sessionId, transcriptPath, projectDir, mtimeMs: stat.mtimeMs, size: stat.size });
    }
  }
  return found.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

// The cwd this session actually ran in, read from the transcript's first record carrying one.
//
// Not optional for the import: runCheckpoint attributes a segment with no resolvable repo root to
// `local:<basename(cwd)>`, and with a null cwd there is no remote at all, so every such segment is
// silently dropped. A past session has no live process cwd, so the file is the only source.
// Returns null when no record carries a string cwd.
export function firstRecordedCwd(transcriptPath) {
  let head;
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buffer = Buffer.alloc(CWD_SCAN_BYTES);
      const read = fs.readSync(fd, buffer, 0, CWD_SCAN_BYTES, 0);
      head = buffer.subarray(0, read).toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }

  const lines = head.split('\n');
  // Drop a trailing partial line: the read is byte-bounded, so the last line may be truncated
  // mid-JSON unless the head happened to end exactly on a newline.
  if (!head.endsWith('\n')) lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed != null && typeof parsed.cwd === 'string' && parsed.cwd) return parsed.cwd;
  }
  return null;
}
