import fs from 'node:fs';
import path from 'node:path';
import { claudeProjectsDir, stateDir } from './paths.mjs';
import { readJson } from './fs-store.mjs';

// Claude Code stores transcripts under a per-project dir named from the cwd with
// every non-alphanumeric character replaced by '-'.
function encodeCwd(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function newestJsonl(dir) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return null;
  }
  let best = null;
  for (const file of files) {
    const full = path.join(dir, file);
    let mtime;
    try {
      mtime = fs.statSync(full).mtimeMs;
    } catch {
      continue;
    }
    if (!best || mtime > best.mtime) {
      best = { full, mtime, sessionId: file.slice(0, -'.jsonl'.length) };
    }
  }
  return best;
}

function transcriptMatchesCwd(file, cwd) {
  let content;
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch {
    return false;
  }
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.cwd) return parsed.cwd === cwd;
  }
  return false;
}

// Locate a session's transcript by its id, scanning every project dir. Immune to cwd
// changes (cd/worktree switches) because Claude Code keys the project dir by the LAUNCH
// cwd while the filename is the globally-unique session id.
// Returns { sessionId, transcriptPath } or null.
export function findTranscriptBySessionId(sessionId) {
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9-]+$/.test(sessionId)) return null;
  const root = claudeProjectsDir();
  let dirs;
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = path.join(root, dir.name, `${sessionId}.jsonl`);
    let isFile = false;
    try {
      isFile = fs.statSync(candidate).isFile();
    } catch {
      continue;
    }
    if (isFile) return { sessionId, transcriptPath: candidate };
  }
  return null;
}

// Newest-updatedAt session state whose recorded cwd matches. Checkpoints keep state.cwd
// current as the session cd's around, so this finds the right session even after the
// live cwd stopped matching any transcript project dir.
function findTranscriptBySessionState(cwd) {
  let files;
  try {
    files = fs.readdirSync(stateDir()).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }
  let best = null;
  for (const file of files) {
    const state = readJson(path.join(stateDir(), file));
    if (!state || state.cwd !== cwd || !state.transcriptPath) continue;
    try {
      if (!fs.statSync(state.transcriptPath).isFile()) continue;
    } catch {
      continue;
    }
    const updatedAt = typeof state.updatedAt === 'string' ? state.updatedAt : '';
    if (!best || updatedAt > best.updatedAt) {
      best = { sessionId: file.slice(0, -'.json'.length), transcriptPath: state.transcriptPath, updatedAt };
    }
  }
  return best ? { sessionId: best.sessionId, transcriptPath: best.transcriptPath } : null;
}

// Resolve the transcript of the session this command runs inside. The session's cwd
// drifts (cd, worktree switches) while Claude Code keys the transcript dir by the
// LAUNCH cwd, so cwd alone is unreliable: prefer the session id Claude Code exports
// into the tool environment, then the cwd mapping checkpoints persist in state, then
// the legacy cwd-encoded project-dir scan.
// Returns { sessionId, transcriptPath } or null.
export function resolveSessionTranscript(cwd, { env = process.env } = {}) {
  const sessionId = env.CLAUDE_CODE_SESSION_ID;
  if (sessionId) {
    const byId = findTranscriptBySessionId(sessionId);
    if (byId) return byId;
  }
  const byState = findTranscriptBySessionState(cwd);
  if (byState) return byState;
  return findCurrentTranscript(cwd);
}

// Locate the current session's transcript for `cwd`.
// Returns { sessionId, transcriptPath } or null.
export function findCurrentTranscript(cwd) {
  const root = claudeProjectsDir();

  const primary = newestJsonl(path.join(root, encodeCwd(cwd)));
  if (primary) return { sessionId: primary.sessionId, transcriptPath: primary.full };

  // Fallback: encoding mismatch — scan project dirs for a transcript reporting this cwd.
  let dirs;
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return null;
  }

  let best = null;
  for (const dir of dirs) {
    const candidate = newestJsonl(path.join(root, dir.name));
    if (!candidate) continue;
    if (!transcriptMatchesCwd(candidate.full, cwd)) continue;
    if (!best || candidate.mtime > best.mtime) best = candidate;
  }
  return best ? { sessionId: best.sessionId, transcriptPath: best.full } : null;
}
