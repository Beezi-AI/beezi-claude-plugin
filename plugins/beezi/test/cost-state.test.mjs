import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readLastCostState, toWireModels } from '../lib/cost-state.mjs';

function writeTranscript(t, lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-state-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'sess.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

const block = (cost, models) => ({
  type: 'cost-state',
  sessionId: 'sess',
  totalCostUSD: cost,
  totalAPIDuration: 1,
  totalAPIDurationWithoutRetries: 1,
  totalToolDuration: 0,
  totalLinesAdded: 0,
  totalLinesRemoved: 0,
  totalDuration: 1,
  startTime: 1788172399626,
  modelUsage: models,
  hasUnknownModelCost: false,
});

const usage = (cost) => ({
  inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3,
  cacheCreationInputTokens: 4, webSearchRequests: 0, costUSD: cost,
});

test('returns null when the transcript has no block', (t) => {
  const file = writeTranscript(t, [{ type: 'user' }, { type: 'assistant' }]);
  assert.strictEqual(readLastCostState(file), null);
});

test('returns the LAST block, not the first', (t) => {
  const file = writeTranscript(t, [
    block(0.5, { 'claude-opus-5': usage(0.5) }),
    { type: 'last-prompt' },
    block(2.25, { 'claude-opus-5': usage(2.25) }),
  ]);
  assert.strictEqual(readLastCostState(file).totalCostUSD, 2.25);
});

test('finds a block that is not the final line', (t) => {
  const file = writeTranscript(t, [
    block(1, { 'claude-opus-5': usage(1) }),
    { type: 'last-prompt' },
    { type: 'artifact-comment-monitor' },
  ]);
  assert.strictEqual(readLastCostState(file).totalCostUSD, 1);
});

test('ignores a truncated leading line in the tail window', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-state-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'sess.jsonl');
  // A huge first line guarantees the tail read starts mid-JSON.
  const filler = JSON.stringify({ type: 'user', pad: 'x'.repeat(400 * 1024) });
  fs.writeFileSync(file, filler + '\n' + JSON.stringify(block(3, { 'claude-opus-5': usage(3) })) + '\n');
  assert.strictEqual(readLastCostState(file).totalCostUSD, 3);
});

test('rejects a malformed block', (t) => {
  const file = writeTranscript(t, [{ type: 'cost-state', sessionId: 'sess' }]);
  assert.strictEqual(readLastCostState(file), null);
});

test('returns null on an unreadable path', () => {
  assert.strictEqual(readLastCostState('/definitely/not/here.jsonl'), null);
});

test('refuses a block whose sessionId does not match the filename', (t) => {
  const file = writeTranscript(t, [block(1, { 'claude-opus-5': usage(1) })]);
  // The block says sessionId 'sess'; a copied transcript would disagree.
  assert.strictEqual(readLastCostState(file, 'someone-elses-session'), null);
  assert.ok(readLastCostState(file, 'sess') != null);
});

test('toWireModels maps every field and omits absent thinkingTokens', () => {
  const wire = toWireModels(block(1, {
    'claude-opus-5[1m]': { inputTokens: 2, outputTokens: 550, cacheReadInputTokens: 29476,
      cacheCreationInputTokens: 16891, webSearchRequests: 0, costUSD: 0.197408 },
    'claude-opus-5': { inputTokens: 1, outputTokens: 1, thinkingTokens: 23,
      cacheReadInputTokens: 1, cacheCreationInputTokens: 1, webSearchRequests: 2, costUSD: 0.1 },
  }));
  assert.strictEqual(wire.length, 2);
  const withMarker = wire.find((m) => m.model === 'claude-opus-5[1m]');
  assert.deepStrictEqual(withMarker, {
    model: 'claude-opus-5[1m]', token_input: 2, token_output: 550,
    token_cache_read: 29476, token_cache_creation: 16891,
    web_search_requests: 0, cost_usd: 0.197408,
  });
  assert.strictEqual(wire.find((m) => m.model === 'claude-opus-5').thinking_tokens, 23);
});

test('toWireModels returns [] for an empty modelUsage', () => {
  assert.deepStrictEqual(toWireModels(block(0, {})), []);
});
