import fs from 'fs';

// The last cost-state record sits in the final three lines of every transcript that has one
// (verified 123/123 on 2026-09-09), so a tail window this size always contains it. Reading the
// whole file instead would mean slurping a 2MB transcript 349 times per scan for one line.
export const TAIL_SCAN_BYTES = 256 * 1024;

// The block Claude Code writes is a flat top-level record with no envelope — no uuid, no
// timestamp, no cwd. Everything we can know about it is in these twelve keys.
function isCostStateBlock(parsed) {
  if (parsed == null || parsed.type !== 'cost-state') return false;
  if (typeof parsed.sessionId !== 'string' || !parsed.sessionId) return false;
  if (typeof parsed.totalCostUSD !== 'number' || !isFinite(parsed.totalCostUSD)) return false;
  if (parsed.modelUsage == null || typeof parsed.modelUsage !== 'object') return false;
  return true;
}

// The FINAL block in the file, or null.
//
// Cumulative, not per-turn: totalCostUSD is monotonically non-decreasing across the 1-8 records a
// file can hold, so every earlier one is a stale partial snapshot of the same session. Reading the
// last one and re-uploading it is exactly right — the server upserts on (tenant, source_ref).
//
// Best-effort by contract: an unreadable file, a truncated line or a malformed block all yield
// null. This runs unattended in a detached process; nothing here may throw.
export function readLastCostState(transcriptPath, expectedSessionId, deps = {}) {
  const openSync = deps.openSync == null ? fs.openSync : deps.openSync;
  const readSync = deps.readSync == null ? fs.readSync : deps.readSync;
  const closeSync = deps.closeSync == null ? fs.closeSync : deps.closeSync;
  const statSync = deps.statSync == null ? fs.statSync : deps.statSync;

  let tail;
  try {
    const size = statSync(transcriptPath).size;
    const start = size > TAIL_SCAN_BYTES ? size - TAIL_SCAN_BYTES : 0;
    const length = size - start;
    if (length <= 0) return null;
    const fd = openSync(transcriptPath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const read = readSync(fd, buffer, 0, length, start);
      tail = { text: buffer.subarray(0, read).toString('utf-8'), fromStart: start === 0 };
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }

  const lines = tail.text.split('\n');
  // The window is byte-bounded, so unless it starts at byte 0 the first line is almost certainly
  // truncated mid-JSON. Dropping it costs nothing: the record we want is at the other end.
  if (!tail.fromStart) lines.shift();

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isCostStateBlock(parsed)) continue;
    // The block's sessionId equals the filename in every record checked (227/227). A mismatch
    // means a copied or hand-edited transcript, and uploading it would attribute one session's
    // whole cost to another. Caller passes the id derived from the filename.
    if (expectedSessionId != null && parsed.sessionId !== expectedSessionId) return null;
    return parsed;
  }
  return null;
}

// modelUsage is an object map keyed by raw model id; the wire takes an array. class-validator
// cannot walk a Record<string, T>, and the API's forbidNonWhitelisted would reject arbitrary keys.
//
// Ids go up RAW — `claude-opus-5[1m]` and `claude-opus-5` both, as separate entries. The server
// owns the [1m] strip, the version truncation and the summing of the two into one row, so there is
// exactly one implementation of that collapse and it lives next to the pricing lookup that needs it.
export function toWireModels(block) {
  const usage = block == null ? null : block.modelUsage;
  if (usage == null || typeof usage !== 'object') return [];
  const out = [];
  for (const model of Object.keys(usage)) {
    const entry = usage[model];
    if (entry == null || typeof entry !== 'object') continue;
    const wire = {
      model: model,
      token_input: num(entry.inputTokens),
      token_output: num(entry.outputTokens),
      token_cache_read: num(entry.cacheReadInputTokens),
      token_cache_creation: num(entry.cacheCreationInputTokens),
      web_search_requests: num(entry.webSearchRequests),
      cost_usd: typeof entry.costUSD === 'number' && isFinite(entry.costUSD) ? entry.costUSD : 0,
    };
    // Present on roughly a quarter of entries. Omitted rather than zeroed so the API's
    // @IsOptional() sees absence, not a fabricated 0.
    if (typeof entry.thinkingTokens === 'number') wire.thinking_tokens = num(entry.thinkingTokens);
    out.push(wire);
  }
  return out;
}

function num(value) {
  return typeof value === 'number' && isFinite(value) && value > 0 ? Math.round(value) : 0;
}

// The wire item both cost-state producers build: the hourly scan and the backfill's fast path.
//
// Returns null when the block prices no model usage at all — sending it would only earn a
// "no priced model usage" rejection, and on the backfill route that rejection is LEDGERED.
export function toCostStateItem(sessionId, block, capturedAtIso) {
  if (block == null) return null;
  const models = toWireModels(block);
  if (models.length === 0) return null;
  return {
    sessionId: sessionId,
    total_cost_usd: typeof block.totalCostUSD === 'number' ? block.totalCostUSD : 0,
    has_unknown_model_cost: block.hasUnknownModelCost === true,
    captured_at: capturedAtIso,
    models: models,
  };
}
