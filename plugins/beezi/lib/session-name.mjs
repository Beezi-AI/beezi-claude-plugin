import fs from 'node:fs';
import path from 'node:path';
import { claudeSessionsDir } from './paths.mjs';
import { readJson } from './fs-store.mjs';

const MAX = 200;

// The live session name Claude Code shows in /status. It writes a per-process descriptor to
// ~/.claude/sessions/<pid>.json holding { sessionId, name, ... }; the file is keyed by pid, so
// we scan and match on sessionId. This name is user-facing and can change after the first prompt
// (Claude Code renames the session), which is exactly what we want to surface in analytics.
export function sessionNameFromStore(sessionId) {
  if (!sessionId) return null;
  const dir = claudeSessionsDir();
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const rec = readJson(path.join(dir, file));
    if (!rec || rec.sessionId !== sessionId) continue;
    // nameSource "derived" is a placeholder Claude Code builds from the cwd folder name
    // (e.g. "my-repo-64") before a real title exists — not a session name. Skip the record
    // rather than bail: a stale descriptor from a dead pid can share the sessionId with the
    // live one that holds the real name.
    if (rec.nameSource === 'derived') continue;
    const name = typeof rec.name === 'string' ? rec.name.trim() : '';
    return name.slice(0, MAX) || null;
  }
  return null;
}

// Titles are appended to the transcript (latest wins), so like Claude Code itself we avoid
// parsing the whole file: raw-scan only a bounded head/tail chunk for the key.
const SCAN_CHUNK = 64 * 1024;

function lastTitleIn(chunk, key) {
  const re = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`, 'g');
  const values = [];
  let m;
  while ((m = re.exec(chunk)) !== null) values.push(m[1]);
  for (let i = values.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(`"${values[i]}"`).trim();
      if (v) return v.slice(0, MAX);
    } catch { /* escape split at a chunk boundary; try an earlier occurrence */ }
  }
  return null;
}

// First and last SCAN_CHUNK bytes of the file ({ head, tail } are the same string when the
// file fits in one chunk). null when the file can't be read.
function readChunks(transcriptPath) {
  let fd;
  try { fd = fs.openSync(transcriptPath, 'r'); } catch { return null; }
  try {
    const size = fs.fstatSync(fd).size;
    const headBuf = Buffer.alloc(Math.min(size, SCAN_CHUNK));
    fs.readSync(fd, headBuf, 0, headBuf.length, 0);
    const head = headBuf.toString('utf-8');
    if (size <= SCAN_CHUNK) return { head, tail: head };
    const tailBuf = Buffer.alloc(SCAN_CHUNK);
    fs.readSync(fd, tailBuf, 0, SCAN_CHUNK, size - SCAN_CHUNK);
    return { head, tail: tailBuf.toString('utf-8') };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Fallback title from the transcript, mirroring Claude Code's own precedence: `custom-title`
// (written by /rename and --name) beats `ai-title` (regenerated as work progresses); both are
// latest-wins, so the tail chunk is scanned before the head. Else a `summary` line, else the
// first user prompt (truncated), else null.
export function sessionNameFrom(transcriptPath) {
  const chunks = readChunks(transcriptPath);
  if (!chunks) return null;
  const { head, tail } = chunks;
  const scan = (key) => lastTitleIn(tail, key) ?? (tail === head ? null : lastTitleIn(head, key));
  const title = scan('customTitle') ?? scan('aiTitle');
  if (title) return title;

  // The summary line and first prompt live near the start of the transcript.
  let summary = null;
  let firstUser = null;
  for (const raw of head.split('\n')) {
    if (!raw.trim()) continue;
    let line;
    try { line = JSON.parse(raw); } catch { continue; }
    if (!summary && line.type === 'summary' && typeof line.summary === 'string') {
      summary = line.summary.trim().slice(0, MAX) || null;
    } else if (!firstUser && line.type === 'user') {
      const text = typeof line.message?.content === 'string'
        ? line.message.content
        : Array.isArray(line.message?.content)
          ? line.message.content.map((c) => c.text ?? '').join(' ')
          : '';
      if (text.trim()) firstUser = text.trim().slice(0, MAX);
    }
  }
  return summary ?? firstUser;
}

// Session display name: prefer Claude Code's live session store (real names only — the derived
// placeholder is skipped), falling back to the transcript's custom-title / ai-title / summary /
// first user prompt.
export function resolveSessionName(sessionId, transcriptPath) {
  return sessionNameFromStore(sessionId) ?? sessionNameFrom(transcriptPath);
}
