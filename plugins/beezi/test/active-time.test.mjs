import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildActiveIntervals,
  claimIntervals,
  mergeIntervals,
  subtractIntervals,
  totalMs,
} from '../lib/active-time.mjs';

const S = 1000;
const IDLE = 300 * S;

// ─── buildActiveIntervals ───────────────────────────────────────────────────

test('buildActiveIntervals joins sub-threshold gaps into one run', () => {
  const iv = buildActiveIntervals([0, 10 * S, 20 * S], IDLE);
  assert.deepEqual(iv, [[0, 20 * S]]);
  assert.equal(totalMs(iv), 20 * S);
});

test('buildActiveIntervals splits on an idle gap and drops it', () => {
  const iv = buildActiveIntervals([0, 10 * S, 10 * S + IDLE, 10 * S + IDLE + 5 * S], IDLE);
  assert.deepEqual(iv, [[0, 10 * S], [10 * S + IDLE, 10 * S + IDLE + 5 * S]]);
  assert.equal(totalMs(iv), 15 * S, 'the idle stretch itself is not active time');
});

test('buildActiveIntervals treats a gap exactly at the threshold as idle', () => {
  assert.deepEqual(buildActiveIntervals([0, IDLE], IDLE), []);
});

test('buildActiveIntervals ignores order and duplicate timestamps', () => {
  const iv = buildActiveIntervals([20 * S, 0, 10 * S, 10 * S], IDLE);
  assert.deepEqual(iv, [[0, 20 * S]]);
});

test('buildActiveIntervals returns nothing for fewer than two timestamps', () => {
  assert.deepEqual(buildActiveIntervals([], IDLE), []);
  assert.deepEqual(buildActiveIntervals([5 * S], IDLE), []);
});

// ─── mergeIntervals ─────────────────────────────────────────────────────────

test('mergeIntervals coalesces overlapping and touching spans, drops empties', () => {
  assert.deepEqual(
    mergeIntervals([[30, 40], [0, 10], [10, 15], [5, 8], [50, 50]]),
    [[0, 15], [30, 40]],
  );
});

// ─── subtractIntervals ──────────────────────────────────────────────────────

test('subtractIntervals returns the input when nothing is covered', () => {
  assert.deepEqual(subtractIntervals([[10, 20]], []), [[10, 20]]);
});

test('subtractIntervals removes a fully covered span', () => {
  assert.deepEqual(subtractIntervals([[10, 20]], [[0, 100]]), []);
});

test('subtractIntervals keeps the head and tail around a covered middle', () => {
  assert.deepEqual(subtractIntervals([[0, 100]], [[40, 60]]), [[0, 40], [60, 100]]);
});

test('subtractIntervals handles several covered chunks inside one span', () => {
  assert.deepEqual(
    subtractIntervals([[0, 100]], [[10, 20], [30, 40], [90, 120]]),
    [[0, 10], [20, 30], [40, 90]],
  );
});

test('subtractIntervals advances across multiple input spans', () => {
  assert.deepEqual(
    subtractIntervals([[0, 10], [20, 30], [40, 50]], [[5, 25]]),
    [[0, 5], [25, 30], [40, 50]],
  );
});

test('subtractIntervals ignores coverage that ends before the span starts', () => {
  assert.deepEqual(subtractIntervals([[100, 110]], [[0, 50]]), [[100, 110]]);
});

// ─── the property that matters: sum of residuals == union ───────────────────

test('sequential claims sum to the union, never to the sum of spans', () => {
  // The main thread blocks 0..520s; six agents run inside that window, overlapping each other.
  const main = [[0, 520 * S]];
  const agents = [
    [[0, 162 * S]],
    [[8 * S, 222 * S]],
    [[17 * S, 482 * S]],
    [[26 * S, 249 * S]],
    [[35 * S, 520 * S]],
    [[43 * S, 178 * S]],
  ];

  let covered = [];
  let billed = 0;
  for (const intervals of [main, ...agents]) {
    billed += totalMs(subtractIntervals(intervals, covered));
    covered = claimIntervals(covered, intervals);
  }

  const naiveSum = [main, ...agents].reduce((acc, iv) => acc + totalMs(iv), 0);
  assert.equal(billed, 520 * S, 'billed time equals the wall-clock union');
  assert.equal(naiveSum, 2204 * S, 'the old behaviour summed every overlapping span (4.24x)');
  assert.equal(totalMs(covered), 520 * S);
});

test('a subagent outliving the main thread still bills its uncovered tail', () => {
  // Main goes idle mid-fan-out (gap over the threshold), so its own span stops early; the agent
  // must contribute the remainder rather than be zeroed out.
  const main = [[0, 100 * S]];
  const agent = [[50 * S, 400 * S]];

  let covered = claimIntervals([], main);
  const residual = subtractIntervals(agent, covered);
  assert.deepEqual(residual, [[100 * S, 400 * S]]);
  assert.equal(totalMs(main) + totalMs(residual), 400 * S);
});

// ─── claimIntervals ─────────────────────────────────────────────────────────

test('claimIntervals merges into existing coverage', () => {
  assert.deepEqual(claimIntervals([[0, 10]], [[8, 20], [40, 50]]), [[0, 20], [40, 50]]);
});

test('claimIntervals caps stored coverage, keeping the most recent', () => {
  // 600 disjoint intervals -> capped to the newest 512.
  const many = Array.from({ length: 600 }, (_, i) => [i * 1000, i * 1000 + 10]);
  const capped = claimIntervals([], many);
  assert.equal(capped.length, 512);
  assert.deepEqual(capped[capped.length - 1], [599 * 1000, 599 * 1000 + 10]);
  assert.deepEqual(capped[0], [88 * 1000, 88 * 1000 + 10]);
});
