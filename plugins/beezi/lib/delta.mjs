import fs from 'node:fs';
import { extractPathSignal } from './repo-timeline.mjs';
import { computeCodeChanges } from './code-changes.mjs';
import { computeOperations } from './operations.mjs';

// Gaps longer than this between two activity lines count as idle, not active time. Exported so the
// session-timeline derivation classifies "working" against the exact same threshold.
export const IDLE_GAP_SEC = 300;

// Pull display text out of an assistant message (string content or text blocks).
function messageText(message) {
  const c = message?.content;
  if (typeof c === 'string') return c.trim() || null;
  if (Array.isArray(c)) {
    const text = c.filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text).join('\n').trim();
    return text || null;
  }
  return null;
}

// Attribute each new transcript line to (repoRoot, branch): repo from tool-path signals,
// branch from the injected branchAt (per-repo reflog in production). Split the window into
// contiguous same-(repo, branch) runs; each maximal run is one segment with a disjoint
// fromLine..toLine range.
//
// Claude Code writes ONE transcript line per content block, so a single assistant message
// becomes several consecutive lines (thinking, text, tool_use…) that share one message id
// and repeat the same usage. Two consequences drive the shape below:
//   1. usage is counted once per message id (dedup), on its FIRST block-line;
//   2. the tool-path signal lives on the tool_use block-line, which is NOT the first.
// So we pre-resolve each message's repo signal across all its block-lines and apply it to
// every block-line (incl. the first) — otherwise a message's tokens bill to the repo that
// was active before its own tool_use ran, which is exactly the wrong repo on a switch.
export function computeDelta(transcriptPath, fromLine, resolvers = {}) {
  const cwd = resolvers.cwd ?? null;
  const repoRootOf = resolvers.repoRootOf ?? ((dir) => dir);
  const branchAt = resolvers.branchAt ?? null;

  const content = fs.readFileSync(transcriptPath, 'utf-8');
  // Strip trailing newline(s): a JSONL file at rest ends with '\n', and the trailing empty
  // split element would otherwise advance the cursor past the last real line, skipping the
  // next window's first record.
  const trimmed = content.replace(/\n+$/, '');
  const raw = trimmed === '' ? [] : trimmed.split('\n');

  // Parse the new window (lines after the cursor) once; skip blank/malformed lines and keep
  // each surviving record with its 1-based line number. Both passes below reuse this.
  const parsed = [];
  for (let i = fromLine; i < raw.length; i++) {
    if (!raw[i].trim()) continue;
    let line;
    try { line = JSON.parse(raw[i]); } catch { continue; }
    parsed.push({ lineNo: i + 1, line });
  }

  // Pre-pass: message id -> last tool-path signal across all of the message's block-lines.
  const messageDir = new Map();
  for (const { line } of parsed) {
    const id = line.message?.id ?? line.requestId ?? null;
    if (!id) continue;
    const dir = extractPathSignal(line, cwd);
    if (dir) messageDir.set(id, dir); // last-touch-wins within the message
  }

  const countedMessages = new Set();
  const segments = [];
  const rateLimitEvents = [];
  let run = null;
  let activeRoot = cwd != null ? repoRootOf(cwd) : null;

  const closeRun = () => {
    if (run) {
      segments.push({
        repoRoot: run.repoRoot,
        branch: run.branch,
        fromLine: run.fromLine,
        toLine: run.toLine,
        stats: summarize(run.models, run.timestamps, run.lines),
      });
      run = null;
    }
  };

  for (const { lineNo, line } of parsed) {
    const id = line.message?.id ?? line.requestId ?? null;
    // Whole-message signal when known (applies to every block-line incl. the first, so the
    // message's tokens bill to the repo its own tool_use touched); else the line's own tool path;
    // else the line's own recorded cwd. The cwd fallback tracks `cd`s and attributes signal-less
    // lines (thinking / web-search / grep, and whole research subagents) to the repo they ran in,
    // instead of only the window's seed cwd — this is what recovers dropped subagent/cwd-change tokens.
    const toolDir = (id && messageDir.has(id)) ? messageDir.get(id) : extractPathSignal(line, cwd);
    const sigDir = toolDir || (typeof line.cwd === 'string' ? line.cwd : null);
    if (sigDir) {
      const sigRoot = repoRootOf(sigDir);
      if (sigRoot) activeRoot = sigRoot; // last-touch-wins; unresolvable -> carry forward
    }

    const ms = line.timestamp ? new Date(line.timestamp).getTime() : null;
    const branch = branchAt
      ? branchAt(activeRoot, ms)
      : (line.gitBranch || '(unknown)');

    if (!run || run.repoRoot !== activeRoot || run.branch !== branch) {
      closeRun();
      run = { repoRoot: activeRoot, branch, fromLine: lineNo, toLine: lineNo, models: {}, timestamps: [], lines: [] };
    }
    run.toLine = lineNo;
    run.lines.push(line);
    if (ms != null) run.timestamps.push(ms);

    if (line.isApiErrorMessage === true && (line.error === 'rate_limit' || line.apiErrorStatus === 429)) {
      rateLimitEvents.push({
        text: messageText(line.message),
        occurredAt: line.timestamp ?? null,
        lineNo,
      });
    }

    if (line.type === 'assistant' && line.message?.usage) {
      if (id && countedMessages.has(id)) continue;
      if (id) countedMessages.add(id);

      const model = line.message.model || 'unknown';
      const u = line.message.usage;
      const cacheCreation = u.cache_creation_input_tokens
        || Object.values(u.cache_creation || {}).reduce((a, x) => a + (x || 0), 0);
      const m = (run.models[model] ??= {
        token_input: 0, token_output: 0, token_cache_read: 0, token_cache_creation: 0, requests: 0,
      });
      m.token_input += u.input_tokens || 0;
      m.token_output += u.output_tokens || 0;
      m.token_cache_read += u.cache_read_input_tokens || 0;
      m.token_cache_creation += cacheCreation;
      m.requests += 1;
    }
  }
  closeRun();
  return { nextCursor: Math.max(fromLine, raw.length), segments, rateLimitEvents };
}

function summarize(models, timestamps, lines) {
  timestamps.sort((a, z) => a - z);
  let activeMs = 0;
  for (let i = 1; i < timestamps.length; i++) {
    const gap = timestamps[i] - timestamps[i - 1];
    if (gap > 0 && gap < IDLE_GAP_SEC * 1000) activeMs += gap;
  }
  const totals = Object.values(models).reduce((acc, m) => ({
    token_input: acc.token_input + m.token_input,
    token_output: acc.token_output + m.token_output,
    token_cache: acc.token_cache + m.token_cache_read + m.token_cache_creation,
  }), { token_input: 0, token_output: 0, token_cache: 0 });
  return {
    models,
    token_total: totals.token_input + totals.token_output + totals.token_cache,
    ...totals,
    duration_sec: Math.round(activeMs / 1000),
    code_changes: computeCodeChanges(lines),
    operations: computeOperations(lines),
    started_at: timestamps.length ? new Date(timestamps[0]).toISOString() : null,
    ended_at: timestamps.length ? new Date(timestamps[timestamps.length - 1]).toISOString() : null,
  };
}
