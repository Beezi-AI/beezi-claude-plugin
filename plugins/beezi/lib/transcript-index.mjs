import fs from 'fs';
import path from 'path';
import { claudeProjectsDir } from './paths.mjs';

// Claude Code names a session file after its globally-unique session id. Anchored, and the same
// character class findTranscriptBySessionId uses: it is what rejects '..', separators, and any
// non-session file, so no path built from the result can escape the project dir.
const SESSION_ID = /^[a-zA-Z0-9-]+$/;

// How much of a transcript's head to read looking for the recorded cwd, in chunks. The cwd is on
// the first records in practice, but a long queued prompt can push it past 64KB; the cap keeps a
// 50MB transcript from being slurped for one field.
const CWD_SCAN_BYTES = 4 * 1024 * 1024;
const CWD_CHUNK_BYTES = 64 * 1024;

// Every past session transcript on this machine: ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl.
//
// Non-recursive per project dir on purpose, and the SESSION_ID regex would happily accept an
// agent-<id> name — so this readdir plus entry.isFile() is the only thing keeping subagent
// transcripts out. test/transcript-index.test.mjs asserts it; do not add recursion here.
// Subagent transcripts live one or two levels deeper
// (<projectDir>/<sessionId>/subagents/[workflows/<wf_id>/]agent-*.jsonl) and must NOT appear
// here — runCheckpoint discovers those itself from the main transcript path, and surfacing them
// as sessions would report each subagent as a session of its own.
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
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      return scanForCwd(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function cwdOfLine(line) {
  try {
    const { cwd } = JSON.parse(line) ?? {};
    return typeof cwd === 'string' && cwd ? cwd : null;
  } catch {
    return null;
  }
}

// Carries the unfinished tail of each chunk as bytes, so a line or a multi-byte character split
// across chunks is decoded whole.
function scanForCwd(fd) {
  const chunk = Buffer.alloc(CWD_CHUNK_BYTES);
  let pending = Buffer.alloc(0);
  for (let offset = 0; offset < CWD_SCAN_BYTES; ) {
    const read = fs.readSync(fd, chunk, 0, CWD_CHUNK_BYTES, offset);
    if (read === 0) break;
    offset += read;
    pending = Buffer.concat([pending, chunk.subarray(0, read)]);
    for (let newline = pending.indexOf('\n'); newline !== -1; newline = pending.indexOf('\n')) {
      const cwd = cwdOfLine(pending.subarray(0, newline).toString('utf-8'));
      if (cwd) return cwd;
      pending = pending.subarray(newline + 1);
    }
  }
  return cwdOfLine(pending.toString('utf-8'));
}
