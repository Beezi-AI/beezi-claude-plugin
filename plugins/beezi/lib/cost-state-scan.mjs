import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';
import { readResponseBody } from './audit-flush.mjs';
import { resolveFetch } from './fetch-compat.mjs';
import { getAccessToken as _getAccessToken } from './token.mjs';
import { listAllTranscripts } from './transcript-index.mjs';
import { readLastCostState, toWireModels } from './cost-state.mjs';
import { readSyncState, scanFloorMs, markSuccess, markAttempt } from './cost-state-sync-state.mjs';
import { markTrackingDisabled as _markTrackingDisabled } from './tracking.mjs';

// The product decision is 30 per batch. Deliberately below audit-flush.mjs's MAX_CHUNK_ITEMS = 50
// and mirrored by MAX_COST_STATE_SESSIONS on the API's DTO — both ends must agree or a legal chunk
// is rejected with a 400.
export const MAX_COST_STATE_ITEMS = 30;

// Longer than postJson's 3s default for the same reason the backfill path is: this runs in its own
// detached process with no hook budget to protect, and the server ingests a chunk sequentially.
const UPLOAD_TIMEOUT_MS = 60000;

// A session still being written is skipped: its block is not final yet, and the next hourly pass
// picks it up. Mirrors session-audit.mjs's ACTIVE_SESSION_WINDOW_MS.
const ACTIVE_SESSION_WINDOW_MS = 30 * 60 * 1000;

export function planCostStateChunks(items, maxItems = MAX_COST_STATE_ITEMS) {
  const chunks = [];
  for (let i = 0; i < items.length; i += maxItems) {
    chunks.push(items.slice(i, i + maxItems));
  }
  return chunks;
}

// Scan every past transcript for its final cost-state block and upload what is new since the last
// SUCCESSFUL scan. Runs only inside the detached child, which watches nothing and reports nothing,
// so every failure here is a counter and a gate decision rather than an exception.
export async function runCostStateScan(deps = {}) {
  const getToken = deps.getAccessToken == null ? _getAccessToken : deps.getAccessToken;
  const listTranscripts = deps.listTranscripts == null ? listAllTranscripts : deps.listTranscripts;
  const readBlock = deps.readBlock == null ? readLastCostState : deps.readBlock;
  const readState = deps.readState == null ? readSyncState : deps.readState;
  const markSuccessImpl = deps.markSuccessImpl == null ? markSuccess : deps.markSuccessImpl;
  const markAttemptImpl = deps.markAttemptImpl == null ? markAttempt : deps.markAttemptImpl;
  const post = deps.postJsonImpl == null ? postJson : deps.postJsonImpl;
  const markDisabled = deps.markTrackingDisabledImpl == null ? _markTrackingDisabled : deps.markTrackingDisabledImpl;
  const now = deps.now == null ? (() => Date.now()) : deps.now;

  // `clean` is a gate, not a statistic: it is what decides between markSuccess (which advances the
  // mtime floor) and markAttempt (which only holds the hourly gate).
  const result = {
    scanned: 0, candidates: 0, withBlock: 0, sent: 0,
    stored: 0, skipped: 0, chunks: 0, halted: null, clean: true,
  };

  let token = await getToken();
  if (token == null) {
    result.halted = 'not-linked';
    return result;
  }

  const state = readState();
  const floor = scanFloorMs(state);
  const nowMs = now();

  // lastScanAt promises that everything below it is uploaded, and the mtime floor is derived from
  // it. Transcripts inside the active window are deliberately NOT read, so the promise may only
  // reach the window boundary. Stamping `nowMs` instead would drop every deferred transcript below
  // the next run's floor — scanFloorMs backs off just OVERLAP_MS (10 min), which is narrower than
  // the 30-minute window — and a transcript's mtime never moves again, so its cost would be
  // stranded permanently. The hourly gate is unaffected: cost-state-trigger stamps attemptedAt at
  // `now` before spawning, and isDue reads max(attemptedAt, lastScanAt).
  const progressMs = nowMs - ACTIVE_SESSION_WINDOW_MS;

  const all = listTranscripts();
  result.scanned = all.length;

  const items = [];
  for (const entry of all) {
    // Incremental: a transcript untouched since the last SUCCESSFUL scan already uploaded its
    // block. The overlap in scanFloorMs covers clock skew; a re-upload is free anyway because the
    // block is cumulative and the server upserts on (tenant, source_ref).
    if (entry.mtimeMs < floor) continue;
    // Still being written — its block is not final yet. The next hourly pass picks it up.
    if (nowMs - entry.mtimeMs < ACTIVE_SESSION_WINDOW_MS) continue;
    result.candidates += 1;
    const block = readBlock(entry.transcriptPath, entry.sessionId);
    if (block == null) continue;
    result.withBlock += 1;
    const models = toWireModels(block);
    // A block with no model usage carries no cost to record; sending it would only earn a
    // "no priced model usage" rejection.
    if (models.length === 0) continue;
    items.push({
      sessionId: entry.sessionId,
      total_cost_usd: typeof block.totalCostUSD === 'number' ? block.totalCostUSD : 0,
      has_unknown_model_cost: block.hasUnknownModelCost === true,
      // The file mtime, because the block itself carries no timestamp and its startTime resets
      // mid-file. Observability only — never a date basis.
      captured_at: new Date(entry.mtimeMs).toISOString(),
      models: models,
    });
  }

  result.sent = items.length;
  if (items.length === 0) {
    // A pass that found nothing to upload genuinely made progress: everything below the boundary
    // is done, so the floor may advance.
    markSuccessImpl(progressMs);
    return result;
  }

  const url = apiBase() + ENDPOINTS.sessionsCostState;
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;

  // postJson returns the RAW fetch Response: no status check, no JSON parse, and it does not throw
  // on a non-2xx (lib/http.mjs). Reading `body.stored` straight off it would be undefined forever
  // and an `error.status === 404` branch could never fire. Same shape audit-flush.mjs's sendChunk
  // uses — and postJson itself stays untouched, because every other caller in this plugin depends
  // on it NOT throwing on status.

  // 403 is authenticated-but-not-permitted: no token resolves it, and every remaining chunk would
  // be refused identically, so it ends the run rather than costing three more round trips.
  //
  // A coded TRACKING_DISABLED is also written to tracking.json, which is what closes the loop:
  // cost-state-trigger reads that record and stops spawning this child at all from the next Stop
  // hook onward, instead of rediscovering the same 403 every hour. Branch on the machine-readable
  // code and never the message, as checkpoint.mjs and audit-flush.mjs do — a code-less 403 (seat
  // revoked, deactivated user) is a different, reversible thing and must not go dark locally.
  const outcomeFor = async (res) => {
    if (res != null && res.status === 403) {
      const read = await readResponseBody(res);
      const code = read == null ? null : read.code;
      if (code === 'TRACKING_DISABLED') {
        try { markDisabled(read.message == null ? null : read.message); } catch { /* best-effort */ }
        return { ok: false, trackingDisabled: true };
      }
      return { ok: false, forbidden: true };
    }
    return readOutcome(res);
  };

  const send = async (chunk) => {
    const res = await post(url, token, { sessions: chunk }, {
      fetchImpl: fetchImpl,
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
    if (res == null) return { ok: false };
    if (res.status === 401) {
      // getAccessToken hands back a token that merely LOOKS fresh; the server is the authority.
      // One forced refresh, one retry — mirrors audit-flush.mjs's renewToken path.
      token = await getToken({}, { forceRefresh: true });
      // Revoked or unlinked mid-run. Every remaining chunk would fail identically, so stop rather
      // than posting the rest behind a null Authorization header.
      if (token == null) return { ok: false, unlinked: true };
      const retry = await post(url, token, { sessions: chunk }, {
        fetchImpl: fetchImpl,
        timeoutMs: UPLOAD_TIMEOUT_MS,
      });
      // Through the same funnel: the retry can 403 just as the first attempt can.
      return outcomeFor(retry);
    }
    return outcomeFor(res);
  };

  for (const chunk of planCostStateChunks(items, MAX_COST_STATE_ITEMS)) {
    result.chunks += 1;
    let outcome;
    try {
      outcome = await send(chunk);
    } catch {
      // Transport failure (dead pooled socket, timeout). That chunk's problem alone — the rest of
      // the run still goes out, it just cannot count as progress.
      outcome = { ok: false };
    }
    if (outcome.unsupported === true) {
      // This environment's API predates the route. Stop sending.
      result.halted = 'unsupported-server';
      result.clean = false;
      break;
    }
    if (outcome.unlinked === true) {
      result.halted = 'not-linked';
      result.clean = false;
      break;
    }
    if (outcome.trackingDisabled === true) {
      // The tenant has opted out. Recorded locally already; the gate takes it from here.
      result.halted = 'tracking-disabled';
      result.clean = false;
      break;
    }
    if (outcome.forbidden === true) {
      // Reversible (a revoked seat, a deactivated user) — halt the run, but leave tracking.json
      // alone so the hourly gate keeps trying and recovers on its own once access returns.
      result.halted = 'forbidden';
      result.clean = false;
      break;
    }
    if (outcome.ok !== true) {
      result.clean = false;
      continue;
    }
    result.stored += outcome.stored;
    result.skipped += outcome.skipped;
    // A rejected item is NOT progress. /beezi:sync may create that session later, and the
    // transcript mtime will never move again — advancing the floor past it strands its cost.
    if (outcome.rejected > 0) result.clean = false;
  }

  // lastScanAt is a PROGRESS stamp: it moves the mtime floor, so it may only advance when every
  // chunk landed and the server rejected nothing. attemptedAt holds the hourly gate either way,
  // which is what makes a wrong-order deploy recoverable instead of permanently lossy.
  if (result.clean) {
    markSuccessImpl(progressMs);
  } else {
    markAttemptImpl(nowMs);
  }
  return result;
}

// Reads a NON-403 response: outcomeFor peels that status off first, so this stays a pure body
// reader with no local side effects.
//
// 404 (and 405, if the path exists under another verb) means the server does not know this route.
//
// The body goes through audit-flush's readResponseBody rather than res.json(): it consumes the
// stream exactly once, never throws, and salvages the non-JSON page Express answers with when a
// body is rejected before the Nest router sees it.
async function readOutcome(res) {
  if (res == null) return { ok: false };
  if (res.status === 404 || res.status === 405) return { ok: false, unsupported: true };
  if (res.status < 200 || res.status >= 300) return { ok: false };
  const read = await readResponseBody(res);
  const body = read == null ? null : read.body;
  // A 2xx whose body we cannot read is not a verdict — never count it as progress.
  if (body == null) return { ok: false };
  const errors = Array.isArray(body.errors) ? body.errors : [];
  return {
    ok: true,
    stored: typeof body.stored === 'number' ? body.stored : 0,
    skipped: typeof body.skipped === 'number' ? body.skipped : 0,
    rejected: errors.length,
  };
}
