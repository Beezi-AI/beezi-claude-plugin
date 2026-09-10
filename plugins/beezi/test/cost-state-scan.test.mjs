import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runCostStateScan,
  planCostStateChunks,
  MAX_COST_STATE_ITEMS,
} from '../lib/cost-state-scan.mjs';

const transcript = (sessionId, mtimeMs) => ({
  sessionId, transcriptPath: '/t/' + sessionId + '.jsonl', projectDir: '/t', mtimeMs, size: 10,
});

const block = (sessionId, cost) => ({
  type: 'cost-state', sessionId, totalCostUSD: cost, hasUnknownModelCost: false,
  modelUsage: { 'claude-opus-5': { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: cost } },
});

// NOW is two hours past every fixture mtime. The scan skips anything touched inside the last 30
// minutes (ACTIVE_SESSION_WINDOW_MS), so a `now` close to the mtimes would silently make every
// fixture a skip and every assertion below vacuous.
const NOW = 10_000_000;
const OLD = NOW - 3 * 60 * 60 * 1000;
const RECENT = NOW - 2 * 60 * 60 * 1000;

// postJson returns the RAW fetch Response — it never throws on a non-2xx and never parses JSON.
// `text()` is what the scan actually reads (through audit-flush's readResponseBody, which consumes
// the stream once and never throws); `json()` is here so the fixture stays a faithful Response.
const response = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

function makeDeps(overrides) {
  const posted = [];
  return {
    posted,
    deps: {
      getAccessToken: async () => 'token',
      listTranscripts: () => [transcript('a', RECENT), transcript('b', RECENT)],
      readBlock: (p) => block(p.indexOf('/a.') >= 0 ? 'a' : 'b', 1),
      readState: () => null,
      markSuccessImpl: () => {},
      markAttemptImpl: () => {},
      // Stubbed by DEFAULT, not per-test: the real one writes ~/.beezi/tracking.json, and a 403
      // fixture that reached it would dark-mode the machine running the suite.
      markTrackingDisabledImpl: () => {},
      now: () => NOW,
      postJsonImpl: async (url, token, body) => {
        posted.push(body);
        return response(200, { stored: body.sessions.length, skipped: 0, errors: [] });
      },
      ...overrides,
    },
  };
}

test('chunks at 30 items', () => {
  const items = Array.from({ length: 71 }, (_, i) => ({ sessionId: String(i) }));
  const chunks = planCostStateChunks(items, MAX_COST_STATE_ITEMS);
  assert.deepStrictEqual(chunks.map((c) => c.length), [30, 30, 11]);
});

test('MAX_COST_STATE_ITEMS is 30', () => {
  assert.strictEqual(MAX_COST_STATE_ITEMS, 30);
});

test('uploads every transcript that has a block', async () => {
  const { posted, deps } = makeDeps();
  const result = await runCostStateScan(deps);
  assert.strictEqual(result.withBlock, 2);
  assert.strictEqual(result.stored, 2);
  assert.strictEqual(posted.length, 1);
  assert.strictEqual(posted[0].sessions.length, 2);
});

test('skips transcripts older than the scan floor', async () => {
  const { deps } = makeDeps({
    readState: () => ({ version: 1, lastScanAt: new Date(RECENT - 1000).toISOString() }),
    listTranscripts: () => [transcript('old', OLD), transcript('new', RECENT)],
  });
  const result = await runCostStateScan(deps);
  assert.strictEqual(result.candidates, 1);
});

test('skips a transcript that is still being written', async () => {
  const { deps } = makeDeps({ listTranscripts: () => [transcript('live', NOW - 60_000)] });
  const result = await runCostStateScan(deps);
  assert.strictEqual(result.candidates, 0);
});

// The one case a single-scan test cannot see. A transcript deferred as "still being written" is
// never read, so the progress stamp may not claim it: stamping `now` would put it below the next
// run's floor (scanFloorMs backs off only OVERLAP_MS = 10min, narrower than the 30-minute active
// window) and its mtime never moves again — the cost would be stranded forever.
test('a transcript deferred as still-being-written is picked up by the next scan', async () => {
  const DEFERRED = NOW - 17 * 60 * 1000;
  let stamped = null;
  const first = makeDeps({
    listTranscripts: () => [transcript('live', DEFERRED)],
    markSuccessImpl: (ms) => { stamped = ms; },
  });
  const firstResult = await runCostStateScan(first.deps);
  assert.strictEqual(firstResult.candidates, 0, 'deferred inside the active window');
  assert.ok(stamped != null, 'a pass with nothing to send still records progress');

  const second = makeDeps({
    listTranscripts: () => [transcript('live', DEFERRED)],
    readBlock: () => block('live', 1),
    readState: () => ({ version: 1, lastScanAt: new Date(stamped).toISOString() }),
    now: () => NOW + 60 * 60 * 1000,
  });
  const secondResult = await runCostStateScan(second.deps);
  assert.strictEqual(secondResult.candidates, 1, 'the deferred transcript must survive the floor');
  assert.strictEqual(secondResult.stored, 1);
});

test('skips a transcript with no block without failing the run', async () => {
  const { deps } = makeDeps({ readBlock: (p) => (p.indexOf('/a.') >= 0 ? null : block('b', 1)) });
  const result = await runCostStateScan(deps);
  assert.strictEqual(result.withBlock, 1);
  assert.strictEqual(result.stored, 1);
});

test('skips a block whose modelUsage is empty', async () => {
  const { deps } = makeDeps({
    readBlock: () => ({ type: 'cost-state', sessionId: 'a', totalCostUSD: 0, modelUsage: {}, hasUnknownModelCost: false }),
  });
  const result = await runCostStateScan(deps);
  assert.strictEqual(result.sent, 0);
});

test('marks progress on a fully clean run', async () => {
  let marked = 0;
  const { deps } = makeDeps({ markSuccessImpl: () => { marked += 1; } });
  await runCostStateScan(deps);
  assert.strictEqual(marked, 1);
});

test('a 404 halts, stamps the ATTEMPT and never marks progress', async () => {
  let progress = 0;
  let attempts = 0;
  const { deps } = makeDeps({
    markSuccessImpl: () => { progress += 1; },
    markAttemptImpl: () => { attempts += 1; },
    postJsonImpl: async () => response(404, {}),
  });
  const result = await runCostStateScan(deps);
  assert.strictEqual(result.halted, 'unsupported-server');
  // Backs off for the hour, but the mtime floor must NOT advance — the API may exist next hour and
  // these transcripts' mtimes will never change again.
  assert.strictEqual(progress, 0);
  assert.strictEqual(attempts, 1);
});

test('an unknown-session rejection blocks the progress stamp', async () => {
  let progress = 0;
  const { deps } = makeDeps({
    markSuccessImpl: () => { progress += 1; },
    postJsonImpl: async () => response(200, {
      stored: 1, skipped: 1,
      errors: [{ sessionId: 'a', reason: 'unknown session' }],
    }),
  });
  await runCostStateScan(deps);
  // /beezi:sync may create that session later, and its transcript mtime will not move — so the
  // floor must not skip past it.
  assert.strictEqual(progress, 0);
});

test('retries once on 401 with a forced token refresh', async () => {
  const refreshes = [];
  let call = 0;
  const { deps } = makeDeps({
    getAccessToken: async (d, options) => { refreshes.push(options); return 'token'; },
    postJsonImpl: async () => {
      call += 1;
      return call === 1 ? response(401, {}) : response(200, { stored: 2, skipped: 0, errors: [] });
    },
  });
  const result = await runCostStateScan(deps);
  assert.strictEqual(result.stored, 2);
  assert.deepStrictEqual(refreshes[1], { forceRefresh: true });
});

test('a 401 whose refresh fails halts the whole run instead of posting untokened', async () => {
  let calls = 0;
  let progress = 0;
  const many = Array.from({ length: 40 }, (_, i) => transcript('s' + i, RECENT));
  const { deps } = makeDeps({
    listTranscripts: () => many,
    readBlock: () => block('s', 1),
    markSuccessImpl: () => { progress += 1; },
    getAccessToken: async (d, options) => (options != null && options.forceRefresh ? null : 'token'),
    postJsonImpl: async () => { calls += 1; return response(401, {}); },
  });
  const result = await runCostStateScan(deps);
  assert.strictEqual(result.halted, 'not-linked');
  // One chunk attempted, then stopped: the second chunk is never posted with a null token.
  assert.strictEqual(calls, 1);
  assert.strictEqual(result.chunks, 1);
  assert.strictEqual(progress, 0);
});

test('does nothing at all without a token', async () => {
  const { posted, deps } = makeDeps({ getAccessToken: async () => null });
  const result = await runCostStateScan(deps);
  assert.strictEqual(result.halted, 'not-linked');
  assert.strictEqual(posted.length, 0);
});

test('a failing chunk does not stop the remaining chunks, but does block progress', async () => {
  let call = 0;
  let progress = 0;
  const many = Array.from({ length: 40 }, (_, i) => transcript('s' + i, RECENT));
  const { deps } = makeDeps({
    listTranscripts: () => many,
    readBlock: () => block('s', 1),
    markSuccessImpl: () => { progress += 1; },
    postJsonImpl: async (url, token, body) => {
      call += 1;
      if (call === 1) throw new Error('ECONNRESET');
      return response(200, { stored: body.sessions.length, skipped: 0, errors: [] });
    },
  });
  const result = await runCostStateScan(deps);
  assert.strictEqual(result.chunks, 2);
  assert.strictEqual(result.stored, 10);
  assert.strictEqual(progress, 0);
});

test('a non-2xx is never counted as stored', async () => {
  const { deps } = makeDeps({ postJsonImpl: async () => response(500, {}) });
  const result = await runCostStateScan(deps);
  assert.strictEqual(result.stored, 0);
});

test('a 2xx with an unreadable body is not progress', async () => {
  let progress = 0;
  const { deps } = makeDeps({
    markSuccessImpl: () => { progress += 1; },
    // What Express answers with when it rejects a body before the Nest router sees it.
    postJsonImpl: async () => ({ status: 200, ok: true, text: async () => '<html>413</html>' }),
  });
  const result = await runCostStateScan(deps);
  assert.strictEqual(result.stored, 0);
  assert.strictEqual(progress, 0);
});

test('the wire item carries the API field names, not the block camelCase', async () => {
  const { posted, deps } = makeDeps({
    listTranscripts: () => [transcript('a', RECENT)],
    readBlock: () => block('a', 0.25),
  });
  await runCostStateScan(deps);
  const item = posted[0].sessions[0];
  assert.deepStrictEqual(Object.keys(item).sort(), [
    'captured_at', 'has_unknown_model_cost', 'models', 'sessionId', 'total_cost_usd',
  ]);
  assert.strictEqual(item.total_cost_usd, 0.25);
  assert.strictEqual(item.has_unknown_model_cost, false);
  assert.strictEqual(item.captured_at, new Date(RECENT).toISOString());
  assert.strictEqual(item.models[0].model, 'claude-opus-5');
});

// Two chunks' worth, so a halt can be told apart from "there was only ever one chunk".
const manyTranscripts = () => Array.from({ length: 40 }, (_, i) => transcript('s' + i, RECENT));

test('a 403 TRACKING_DISABLED halts the run, records the verdict and stops posting', async () => {
  const disabled = [];
  let posts = 0;
  const { deps } = makeDeps({
    listTranscripts: manyTranscripts,
    readBlock: () => block('x', 1),
    markTrackingDisabledImpl: (reason) => disabled.push(reason),
    postJsonImpl: async () => {
      posts += 1;
      return response(403, { code: 'TRACKING_DISABLED', message: 'workspace is in audit mode' });
    },
  });
  const res = await runCostStateScan(deps);
  assert.equal(res.halted, 'tracking-disabled');
  assert.equal(res.clean, false);
  assert.equal(res.stored, 0);
  // Broke out after the first refusal instead of posting the second chunk.
  assert.equal(res.chunks, 1);
  assert.equal(posts, 1);
  assert.deepEqual(disabled, ['workspace is in audit mode']);
});

test('a 403 TRACKING_DISABLED stamps the attempt, never progress', async () => {
  let success = 0;
  let attempts = 0;
  const { deps } = makeDeps({
    markSuccessImpl: () => { success += 1; },
    markAttemptImpl: () => { attempts += 1; },
    postJsonImpl: async () => response(403, { code: 'TRACKING_DISABLED', message: null }),
  });
  await runCostStateScan(deps);
  assert.equal(success, 0);
  assert.equal(attempts, 1);
});

// A revoked seat or a deactivated user is reversible. Halt the run, but never write the local
// opt-out — that would stop the hourly gate from ever retrying once access comes back.
test('a code-less 403 halts without recording a tracking opt-out', async () => {
  const disabled = [];
  let posts = 0;
  const { deps } = makeDeps({
    listTranscripts: manyTranscripts,
    readBlock: () => block('x', 1),
    markTrackingDisabledImpl: (reason) => disabled.push(reason),
    postJsonImpl: async () => { posts += 1; return response(403, { message: 'seat revoked' }); },
  });
  const res = await runCostStateScan(deps);
  assert.equal(res.halted, 'forbidden');
  assert.equal(res.clean, false);
  assert.equal(res.chunks, 1);
  assert.equal(posts, 1);
  assert.deepEqual(disabled, []);
});

// The 401 retry goes through the same funnel, so a 403 landing on the SECOND attempt is caught
// too — not misread as an ordinary failed chunk.
test('a 403 on the 401 retry is handled as a 403', async () => {
  const disabled = [];
  let calls = 0;
  const { deps } = makeDeps({
    getAccessToken: async () => 'token',
    markTrackingDisabledImpl: (reason) => disabled.push(reason),
    postJsonImpl: async () => {
      calls += 1;
      return calls === 1
        ? response(401, {})
        : response(403, { code: 'TRACKING_DISABLED', message: 'audit mode' });
    },
  });
  const res = await runCostStateScan(deps);
  assert.equal(res.halted, 'tracking-disabled');
  assert.equal(res.clean, false);
  assert.deepEqual(disabled, ['audit mode']);
});

// A throw out of the local write must not take the run down with it.
test('a failing tracking write still halts cleanly', async () => {
  const { deps } = makeDeps({
    markTrackingDisabledImpl: () => { throw new Error('EACCES'); },
    postJsonImpl: async () => response(403, { code: 'TRACKING_DISABLED', message: null }),
  });
  const res = await runCostStateScan(deps);
  assert.equal(res.halted, 'tracking-disabled');
  assert.equal(res.clean, false);
});
