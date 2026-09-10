import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeDelta } from '../lib/delta.mjs';
import { readCheckoutEvents, buildBranchTimeline, branchAt as branchAtReflog } from '../lib/reflog.mjs';

// Helper: write lines to a temp file and return its path.
function writeFixture(dir, lines) {
  const filePath = path.join(dir, `transcript-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n'), 'utf-8');
  return filePath;
}

// Helper: assistant line factory. `effort` mirrors Claude Code's top-level field; omitted by
// default so pre-effort fixtures stay byte-identical.
function assistantLine(branch, model, usage, timestamp, isSidechain = false, cwd = '/some/path', effort = undefined) {
  return {
    type: 'assistant',
    gitBranch: branch,
    cwd,
    timestamp,
    isSidechain,
    message: { model, usage },
    ...(effort != null ? { effort } : {}),
  };
}

test('1. single-branch token tally', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const ts1 = '2024-01-01T10:00:00.000Z';
  const ts2 = '2024-01-01T10:01:00.000Z';

  const file = writeFixture(dir, [
    assistantLine('main', 'claude-opus-4-8', {
      input_tokens: 100, output_tokens: 50,
      cache_read_input_tokens: 10, cache_creation_input_tokens: 5,
    }, ts1),
    assistantLine('main', 'claude-opus-4-8', {
      input_tokens: 200, output_tokens: 75,
      cache_read_input_tokens: 20, cache_creation_input_tokens: 8,
    }, ts2),
  ]);

  const { nextCursor, segments } = computeDelta(file, 0, { cwd: '/some/path', repoRootOf: (d) => d });

  assert.equal(nextCursor, 2);
  assert.equal(segments.length, 1);

  const seg = segments[0];
  assert.equal(seg.branch, 'main');
  assert.equal(seg.repoRoot, '/some/path', 'segment carries the resolved repo root (seeded from cwd)');
  assert.equal(seg.fromLine, 1);
  assert.equal(seg.toLine, 2);

  const model = seg.stats.models['claude-opus-4-8'];
  assert.ok(model, 'model key must exist');
  assert.equal(model.requests, 2);
  assert.equal(model.token_input, 300);
  assert.equal(model.token_output, 125);
  assert.equal(model.token_cache_read, 30);
  assert.equal(model.token_cache_creation, 13);

  // token_total = input + output + cache_read + cache_creation (all cache pooled)
  const expectedCache = 30 + 13;
  assert.equal(seg.stats.token_input, 300);
  assert.equal(seg.stats.token_output, 125);
  assert.equal(seg.stats.token_cache, expectedCache);
  assert.equal(seg.stats.token_total, 300 + 125 + expectedCache);
});

test('2. multi-branch attribution', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = writeFixture(dir, [
    assistantLine('feature/task-1', 'model-a', {
      input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    }, '2024-01-01T10:00:00.000Z'),
    assistantLine('feature/task-1', 'model-a', {
      input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    }, '2024-01-01T10:01:00.000Z'),
    assistantLine('feature/task-2', 'model-a', {
      input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    }, '2024-01-01T10:02:00.000Z'),
  ]);

  const { nextCursor, segments } = computeDelta(file, 0);

  assert.equal(nextCursor, 3);
  assert.equal(segments.length, 2);

  const seg1 = segments.find(s => s.branch === 'feature/task-1');
  const seg2 = segments.find(s => s.branch === 'feature/task-2');

  assert.ok(seg1, 'segment for feature/task-1 must exist');
  assert.ok(seg2, 'segment for feature/task-2 must exist');

  assert.equal(seg1.fromLine, 1);
  assert.equal(seg1.toLine, 2);
  assert.equal(seg1.stats.token_input, 150);
  assert.equal(seg1.stats.models['model-a'].requests, 2);

  assert.equal(seg2.fromLine, 3);
  assert.equal(seg2.toLine, 3);
  assert.equal(seg2.stats.token_input, 200);
  assert.equal(seg2.stats.models['model-a'].requests, 1);
});

test('3. multi-model in one branch', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = writeFixture(dir, [
    assistantLine('main', 'claude-opus-4-8', {
      input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    }, '2024-01-01T10:00:00.000Z'),
    assistantLine('main', 'claude-sonnet-4-5', {
      input_tokens: 200, output_tokens: 75, cache_read_input_tokens: 5, cache_creation_input_tokens: 0,
    }, '2024-01-01T10:01:00.000Z'),
  ]);

  const { segments } = computeDelta(file, 0);

  assert.equal(segments.length, 1);
  const { stats } = segments[0];

  assert.ok(stats.models['claude-opus-4-8'], 'opus model key must exist');
  assert.ok(stats.models['claude-sonnet-4-5'], 'sonnet model key must exist');

  assert.equal(stats.models['claude-opus-4-8'].requests, 1);
  assert.equal(stats.models['claude-sonnet-4-5'].requests, 1);

  // totals must span both models
  assert.equal(stats.token_input, 300);
  assert.equal(stats.token_output, 125);
  assert.equal(stats.token_cache, 5);
  assert.equal(stats.token_total, 300 + 125 + 5);
});

test('4. active-span duration excludes idle gap', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  // gap1 = 60s (active), gap2 = 600s (idle, > 300s)
  const t0 = '2024-01-01T10:00:00.000Z';
  const t1 = '2024-01-01T10:01:00.000Z'; // +60s from t0
  const t2 = '2024-01-01T10:11:00.000Z'; // +600s from t1

  const file = writeFixture(dir, [
    assistantLine('main', 'model-a', { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, t0),
    assistantLine('main', 'model-a', { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, t1),
    assistantLine('main', 'model-a', { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, t2),
  ]);

  const { segments } = computeDelta(file, 0);
  assert.equal(segments.length, 1);
  // Only the 60s gap should count; the 600s gap is idle
  assert.equal(segments[0].stats.duration_sec, 60);
});

test('5. cache tokens: flat and nested', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  // Line 1: only nested cache_creation (no flat field)
  const line1 = {
    type: 'assistant',
    gitBranch: 'main',
    timestamp: '2024-01-01T10:00:00.000Z',
    message: {
      model: 'model-a',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        // no cache_creation_input_tokens flat field
        cache_creation: {
          ephemeral_1h_input_tokens: 30,
          ephemeral_5m_input_tokens: 20,
        },
      },
    },
  };

  // Line 2: only flat cache_creation_input_tokens
  const line2 = {
    type: 'assistant',
    gitBranch: 'main',
    timestamp: '2024-01-01T10:01:00.000Z',
    message: {
      model: 'model-a',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 100,
      },
    },
  };

  const file = path.join(dir, 'fixture.jsonl');
  fs.writeFileSync(file, [JSON.stringify(line1), JSON.stringify(line2)].join('\n'), 'utf-8');

  const { segments } = computeDelta(file, 0);
  assert.equal(segments.length, 1);

  const model = segments[0].stats.models['model-a'];
  // nested: 30+20=50, flat: 100 → total creation = 150
  assert.equal(model.token_cache_creation, 150);
  assert.equal(segments[0].stats.token_cache, 150); // no cache_read in these lines
});

test('6. cursor advances past malformed and non-assistant lines', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = path.join(dir, 'fixture.jsonl');
  const lines = [
    JSON.stringify({ type: 'mode', mode: 'auto', sessionId: 'abc' }),  // line 1 — no gitBranch
    'THIS IS NOT JSON!!!',                                               // line 2 — malformed
    JSON.stringify(assistantLine('main', 'model-a', {
      input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    }, '2024-01-01T10:00:00.000Z')),                                    // line 3 — valid
  ];
  fs.writeFileSync(file, lines.join('\n'), 'utf-8');

  let result;
  assert.doesNotThrow(() => { result = computeDelta(file, 0); });
  assert.equal(result.nextCursor, 3);

  // The mode line resolves no repo and no branch, so it still splits on repoRoot when line 3
  // names one — but the ranges must leave no gap, including over the malformed line 2. (The
  // leading zero-work segment is absorbed one layer up, in enqueueSegments.)
  assertTiles(result.segments, 0, result.nextCursor);

  const mainSeg = result.segments.find(s => s.branch === 'main');
  assert.ok(mainSeg, 'main segment must exist');
  assert.equal(mainSeg.stats.models['model-a'].requests, 1);
  assert.equal(mainSeg.stats.token_input, 10);

  // Malformed line must NOT create any bogus token counts
  // Check that no segment has inflated bogus data
  const totalRequests = result.segments.reduce(
    (sum, s) => sum + Object.values(s.stats.models).reduce((ms, m) => ms + m.requests, 0), 0
  );
  assert.equal(totalRequests, 1, 'only the valid assistant line contributes requests');
});

test('7. empty delta — fromLine equals total lines', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = writeFixture(dir, [
    assistantLine('main', 'model-a', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:00:00.000Z'),
    assistantLine('main', 'model-a', { input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:01:00.000Z'),
  ]);

  const { nextCursor, segments } = computeDelta(file, 2);

  assert.equal(nextCursor, 2);
  assert.equal(segments.length, 0);
});

test('8. fromLine slicing — lines before cursor are ignored', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = writeFixture(dir, [
    assistantLine('main', 'model-a', { input_tokens: 999, output_tokens: 999, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:00:00.000Z'),
    assistantLine('main', 'model-a', { input_tokens: 999, output_tokens: 999, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:01:00.000Z'),
    assistantLine('main', 'model-a', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:02:00.000Z'),
  ]);

  // fromLine = 2 means lines 1 and 2 are already accounted for
  const { nextCursor, segments } = computeDelta(file, 2);

  assert.equal(nextCursor, 3);
  assert.equal(segments.length, 1);

  const model = segments[0].stats.models['model-a'];
  // Only line 3 should be counted
  assert.equal(model.requests, 1);
  assert.equal(model.token_input, 100);
  assert.equal(model.token_output, 50);
});

test('9. missing gitBranch groups under (unknown)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const line = {
    type: 'assistant',
    // no gitBranch
    timestamp: '2024-01-01T10:00:00.000Z',
    message: {
      model: 'model-a',
      usage: { input_tokens: 42, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  };

  const file = path.join(dir, 'fixture.jsonl');
  fs.writeFileSync(file, JSON.stringify(line), 'utf-8');

  const { segments } = computeDelta(file, 0);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].branch, '(unknown)');
  assert.equal(segments[0].stats.models['model-a'].token_input, 42);
});

test('10. sidechain (isSidechain:true) is counted', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = writeFixture(dir, [
    assistantLine('main', 'model-a', { input_tokens: 77, output_tokens: 33, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:00:00.000Z', true /* isSidechain */),
  ]);

  const { segments } = computeDelta(file, 0);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].branch, 'main');
  assert.equal(segments[0].stats.models['model-a'].token_input, 77);
  assert.equal(segments[0].stats.models['model-a'].requests, 1);
});

test('11a. single timestamp → duration 0', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = writeFixture(dir, [
    assistantLine('main', 'model-a', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:00:00.000Z'),
  ]);

  const { segments } = computeDelta(file, 0);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].stats.duration_sec, 0);
  assert.equal(segments[0].stats.started_at, '2024-01-01T10:00:00.000Z');
  assert.equal(segments[0].stats.ended_at, '2024-01-01T10:00:00.000Z');
});

test('12. empty file → nextCursor 0 and no segments (FIX 1 regression)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const emptyPath = path.join(dir, 'empty.jsonl');
  fs.writeFileSync(emptyPath, '', 'utf-8');

  const { nextCursor, segments } = computeDelta(emptyPath, 0);

  assert.equal(nextCursor, 0, 'empty file must not advance cursor beyond 0');
  assert.equal(segments.length, 0, 'empty file must yield no segments');
});

test('11b. no timestamps → started_at and ended_at are null', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  // A non-assistant line with no timestamp
  const line = {
    type: 'mode',
    mode: 'auto',
    sessionId: 'xyz',
  };

  const file = path.join(dir, 'fixture.jsonl');
  fs.writeFileSync(file, JSON.stringify(line), 'utf-8');

  const { segments } = computeDelta(file, 0);
  // Only one segment under (unknown) but it has no timestamps
  assert.equal(segments.length, 1);
  assert.equal(segments[0].stats.started_at, null);
  assert.equal(segments[0].stats.ended_at, null);
  assert.equal(segments[0].stats.duration_sec, 0);
});

test('N. duplicate assistant lines (same message id) count usage once', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  // Claude Code logs the same assistant message across several content-block lines,
  // each carrying the full usage — they must be counted a single time.
  const dupLine = {
    type: 'assistant',
    gitBranch: 'main',
    cwd: '/some/path',
    timestamp: '2024-01-01T10:00:00.000Z',
    requestId: 'req_1',
    message: {
      id: 'msg_1',
      model: 'claude-haiku-4-5',
      usage: {
        input_tokens: 100, output_tokens: 50,
        cache_read_input_tokens: 10, cache_creation_input_tokens: 5,
      },
    },
  };

  const file = writeFixture(dir, [dupLine, dupLine, dupLine]);
  const { segments } = computeDelta(file, 0);

  assert.equal(segments.length, 1);
  const stats = segments[0].stats;
  assert.equal(stats.token_input, 100, 'input counted once');
  assert.equal(stats.token_output, 50, 'output counted once');
  assert.equal(stats.token_cache, 15, 'cache (read + creation) counted once');
  assert.equal(stats.token_total, 165, 'total counted once');
  assert.equal(stats.models['claude-haiku-4-5'].requests, 1, 'one request, not three');
});

test('O. two repos by tool-path signal → two segments (per-repo attribution)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const use = (name, input) => ({ type: 'tool_use', name, input });
  const toolAssistant = (fileDir, usage, ts) => ({
    type: 'assistant',
    gitBranch: 'launch-branch', // frozen launch branch — must NOT drive attribution
    timestamp: ts,
    message: {
      model: 'model-a',
      usage,
      content: [use('Edit', { file_path: `${fileDir}/file.ts` })],
    },
  });

  const file = writeFixture(dir, [
    toolAssistant('/repo/alpha', { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:00:00.000Z'),
    toolAssistant('/repo/beta',  { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:01:00.000Z'),
  ]);

  // Identity repoRootOf: the signal dir IS the root. Branch from a stub keyed on root.
  const { segments } = computeDelta(file, 0, {
    cwd: '/repo/alpha',
    repoRootOf: (d) => d,
    branchAt: (root) => (root === '/repo/beta' ? 'feature/task-beta' : 'feature/task-alpha'),
  });

  assert.equal(segments.length, 2, 'one segment per distinct repo root');

  const alpha = segments.find((s) => s.repoRoot === '/repo/alpha');
  const beta = segments.find((s) => s.repoRoot === '/repo/beta');
  assert.ok(alpha, 'segment for /repo/alpha must exist');
  assert.ok(beta, 'segment for /repo/beta must exist');
  assert.equal(alpha.branch, 'feature/task-alpha');
  assert.equal(beta.branch, 'feature/task-beta');
  assert.equal(alpha.stats.token_input, 100);
  assert.equal(beta.stats.token_input, 200);
});

// Helpers for repo-signal fixtures.
const _use = (name, input) => ({ type: 'tool_use', name, input });
function repoLine(fileDir, usage, ts) {
  return {
    type: 'assistant',
    gitBranch: 'frozen', // frozen launch branch — ignored when branchAt is provided
    timestamp: ts,
    message: { model: 'model-a', usage, content: [_use('Edit', { file_path: `${fileDir}/f.ts` })] },
  };
}
function textLine(usage, ts) {
  // Assistant tokens with NO tool_use → no path signal → carry-forward.
  return { type: 'assistant', gitBranch: 'frozen', timestamp: ts, message: { model: 'model-a', usage } };
}
const U = (i) => ({ input_tokens: i, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });

test('P1. repoA → repoB → repoA interleave → three disjoint contiguous segments', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = writeFixture(dir, [
    repoLine('/repo/a', U(10), '2024-01-01T10:00:00.000Z'), // → a
    repoLine('/repo/b', U(20), '2024-01-01T10:01:00.000Z'), // → b
    repoLine('/repo/a', U(30), '2024-01-01T10:02:00.000Z'), // → a again
  ]);

  const { segments } = computeDelta(file, 0, {
    cwd: '/repo/a',
    repoRootOf: (d) => d,
    branchAt: (root) => `branch-of:${root}`,
  });

  assert.deepEqual(segments.map((s) => s.repoRoot), ['/repo/a', '/repo/b', '/repo/a']);
  assert.deepEqual(segments.map((s) => [s.fromLine, s.toLine]), [[1, 1], [2, 2], [3, 3]]);
  for (let i = 1; i < segments.length; i++) {
    assert.ok(segments[i].fromLine > segments[i - 1].toLine, 'segment ranges must not overlap');
  }
  assert.equal(segments[0].stats.token_input, 10);
  assert.equal(segments[1].stats.token_input, 20);
  assert.equal(segments[2].stats.token_input, 30);
});

test('P2. carry-forward — a text-only line keeps the previous repo', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = writeFixture(dir, [
    repoLine('/repo/b', U(10), '2024-01-01T10:00:00.000Z'), // → b
    textLine(U(5), '2024-01-01T10:00:30.000Z'),             // no signal → still b
    repoLine('/repo/b', U(7), '2024-01-01T10:01:00.000Z'),  // → b
  ]);

  const { segments } = computeDelta(file, 0, {
    cwd: '/repo/a', // seed differs, but the first line switches to b
    repoRootOf: (d) => d,
    branchAt: () => 'feature/task-b',
  });

  assert.equal(segments.length, 1, 'all three lines belong to one contiguous repo/branch run');
  assert.equal(segments[0].repoRoot, '/repo/b');
  assert.equal(segments[0].stats.token_input, 22, '10 + 5 (carried) + 7');
});

test('P3. last-touch tie-break — the Edit line itself bills to the new repo', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = writeFixture(dir, [
    textLine(U(3), '2024-01-01T10:00:00.000Z'),            // seed repo /repo/a
    repoLine('/repo/b', U(9), '2024-01-01T10:00:30.000Z'), // touches b → this line is b
  ]);

  const { segments } = computeDelta(file, 0, {
    cwd: '/repo/a',
    repoRootOf: (d) => d,
    branchAt: (root) => `b:${root}`,
  });

  const a = segments.find((s) => s.repoRoot === '/repo/a');
  const b = segments.find((s) => s.repoRoot === '/repo/b');
  assert.equal(a.stats.token_input, 3, 'pre-touch text billed to seed repo');
  assert.equal(b.stats.token_input, 9, 'the touching line billed to the new repo');
});

test('P4. Read moves attribution (any-touch rule)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const readLine = {
    type: 'assistant', gitBranch: 'frozen', timestamp: '2024-01-01T10:00:00.000Z',
    message: { model: 'model-a', usage: U(4), content: [_use('Read', { file_path: '/repo/b/x.ts' })] },
  };
  const file = writeFixture(dir, [readLine]);

  const { segments } = computeDelta(file, 0, { cwd: '/repo/a', repoRootOf: (d) => d, branchAt: () => 'x' });
  assert.equal(segments[0].repoRoot, '/repo/b', 'reading a repo-B file switches attribution to B');
});

test('P5. branchAt drives branch; frozen gitBranch is ignored when provided', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = writeFixture(dir, [repoLine('/repo/a', U(1), '2024-01-01T10:00:00.000Z')]);
  const { segments } = computeDelta(file, 0, {
    cwd: '/repo/a', repoRootOf: (d) => d,
    branchAt: (root, ms) => (ms === Date.parse('2024-01-01T10:00:00.000Z') ? 'feature/task-Z' : 'wrong'),
  });
  assert.equal(segments[0].branch, 'feature/task-Z');
});

test('P6. unresolvable signal → carry forward, not a switch to null', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = writeFixture(dir, [
    repoLine('/repo/a', U(2), '2024-01-01T10:00:00.000Z'),      // → a
    repoLine('/not/a/repo', U(2), '2024-01-01T10:01:00.000Z'),  // repoRootOf returns null → carry a
  ]);

  const { segments } = computeDelta(file, 0, {
    cwd: '/repo/a',
    repoRootOf: (d) => (d.startsWith('/repo/') ? d : null),
    branchAt: () => 'feature/task-a',
  });

  assert.equal(segments.length, 1, 'null-root line carried forward into repo a run');
  assert.equal(segments[0].repoRoot, '/repo/a');
  assert.equal(segments[0].stats.token_input, 4);
});

test('P7. multi-line message (thinking/text/tool_use, shared id) bills the whole message to its tool_use repo', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  // One assistant message split across 3 block-lines sharing message.id, repeating usage.
  // Only the tool_use line carries the repo-B signal; usage is counted on the first line.
  const mk = (blocks) => ({
    type: 'assistant',
    timestamp: '2024-01-01T10:00:00.000Z',
    message: { id: 'msg_1', model: 'model-a', usage: U(100), content: blocks },
  });
  const file = writeFixture(dir, [
    mk([{ type: 'thinking', thinking: 'hmm' }]),
    mk([{ type: 'text', text: 'editing b' }]),
    mk([_use('Edit', { file_path: '/repo/b/f.ts' })]),
  ]);

  const { segments } = computeDelta(file, 0, {
    cwd: '/repo/a', repoRootOf: (d) => d, branchAt: (root) => `br:${root}`,
  });

  assert.equal(segments.length, 1, 'the whole message is one run');
  assert.equal(segments[0].repoRoot, '/repo/b', 'billed to the repo its tool_use touched, not the seed');
  assert.equal(segments[0].fromLine, 1);
  assert.equal(segments[0].toLine, 3);
  assert.equal(segments[0].stats.models['model-a'].requests, 1, 'usage counted once across 3 block-lines');
  assert.equal(segments[0].stats.token_input, 100, 'tokens counted once, attributed to repo b');
});

test('P8. trailing newline does not overshoot the cursor; boundary line processed next window', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = path.join(dir, 'nl.jsonl');
  const line = (i, ts) => JSON.stringify({ type: 'assistant', gitBranch: 'main', timestamp: ts, message: { model: 'm', usage: U(i) } });

  // File ends WITH a trailing newline, as real JSONL does.
  fs.writeFileSync(file, line(10, '2024-01-01T10:00:00.000Z') + '\n', 'utf-8');
  const first = computeDelta(file, 0);
  assert.equal(first.nextCursor, 1, 'cursor is the real line count, not 2');
  assert.equal(first.segments[0].stats.token_input, 10);

  fs.appendFileSync(file, line(20, '2024-01-01T10:01:00.000Z') + '\n', 'utf-8');
  const second = computeDelta(file, first.nextCursor);
  assert.equal(second.nextCursor, 2);
  assert.equal(second.segments.length, 1, 'the appended line is processed, not skipped');
  assert.equal(second.segments[0].stats.token_input, 20, 'boundary line counted exactly once');
});

// A signal-less assistant line that carries its own recorded cwd (thinking / web / grep lines,
// and whole research subagents, look like this).
function cwdLine(cwd, usage, ts) {
  return { type: 'assistant', gitBranch: 'frozen', cwd, timestamp: ts, message: { model: 'model-a', usage } };
}

test('Q1. per-line cwd drives attribution when there is no tool-path signal', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  // No tool signals anywhere; the two lines only differ by their recorded cwd (a `cd` between them).
  const file = writeFixture(dir, [
    cwdLine('/repo/a', U(10), '2024-01-01T10:00:00.000Z'),
    cwdLine('/repo/b', U(20), '2024-01-01T10:01:00.000Z'),
  ]);

  const { segments } = computeDelta(file, 0, {
    cwd: '/repo/a',
    repoRootOf: (d) => d,
    branchAt: (root) => `br:${root}`,
  });

  assert.deepEqual(segments.map((s) => s.repoRoot), ['/repo/a', '/repo/b']);
  assert.equal(segments[0].stats.token_input, 10);
  assert.equal(segments[1].stats.token_input, 20);
});

test('Q2. a leading signal-less line whose cwd is inside a repo is NOT dropped (subagent fix)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  // Seed cwd is outside any repo (multi-repo parent) — previously this whole line billed to null and
  // was dropped. Its own cwd resolves the repo, so it now gets a real root.
  const file = writeFixture(dir, [cwdLine('/repo/x', U(42), '2024-01-01T10:00:00.000Z')]);

  const { segments } = computeDelta(file, 0, {
    cwd: '/workspace-parent', // not a repo
    repoRootOf: (d) => (d.startsWith('/repo/') ? d : null),
    branchAt: () => 'feature/task-x',
  });

  assert.equal(segments.length, 1);
  assert.equal(segments[0].repoRoot, '/repo/x', 'resolved from the line cwd, not the null seed');
  assert.equal(segments[0].stats.token_input, 42);
});

test('Q3. truly-unresolvable line stays null (never guess)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  // cwd is outside any repo AND there is no tool signal → root stays null (the segment will be
  // dropped downstream, by design — we do not attribute it to some other repo).
  const file = writeFixture(dir, [cwdLine('/nowhere', U(5), '2024-01-01T10:00:00.000Z')]);

  const { segments } = computeDelta(file, 0, {
    cwd: '/nowhere',
    repoRootOf: (d) => (d.startsWith('/repo/') ? d : null),
    branchAt: () => 'x',
  });

  assert.equal(segments.length, 1);
  assert.equal(segments[0].repoRoot, null, 'no guessing — unresolvable stays null');
});

test('collects rate-limit events from the window', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-rl-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = writeFixture(dir, [
    assistantLine('main', 'claude-opus-4-8', {
      input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    }, '2026-07-08T09:59:00.000Z'),
    {
      type: 'assistant',
      model: '<synthetic>',
      timestamp: '2026-07-08T10:00:00.000Z',
      isApiErrorMessage: true,
      error: 'rate_limit',
      apiErrorStatus: 429,
      message: { content: [{ type: 'text', text: "You've hit your session limit · resets 4:30pm (Europe/Kiev)" }] },
    },
  ]);

  const { apiErrorEvents } = computeDelta(file, 0, { cwd: '/some/path', repoRootOf: (d) => d });

  assert.equal(apiErrorEvents.length, 1);
  assert.equal(apiErrorEvents[0].error, 'rate_limit');
  assert.match(apiErrorEvents[0].text, /resets 4:30pm \(Europe\/Kiev\)/);
  assert.equal(apiErrorEvents[0].occurredAt, '2026-07-08T10:00:00.000Z');
  assert.equal(apiErrorEvents[0].lineNo, 2);
});

test('captures a billing error and skips transient ones', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-billing-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = writeFixture(dir, [
    {
      type: 'assistant',
      model: '<synthetic>',
      timestamp: '2026-07-31T18:44:00.000Z',
      isApiErrorMessage: true,
      error: 'server_error',
      message: { content: [{ type: 'text', text: 'API Error: 500' }] },
    },
    {
      type: 'assistant',
      model: '<synthetic>',
      timestamp: '2026-07-31T18:44:50.690Z',
      isApiErrorMessage: true,
      error: 'billing_error',
      apiErrorStatus: 400,
      message: { content: [{ type: 'text', text: 'Credit balance is too low' }] },
    },
  ]);

  const { apiErrorEvents } = computeDelta(file, 0, { cwd: '/some/path', repoRootOf: (d) => d });

  assert.equal(apiErrorEvents.length, 1);
  assert.equal(apiErrorEvents[0].error, 'billing_error');
  assert.equal(apiErrorEvents[0].text, 'Credit balance is too low');
  assert.equal(apiErrorEvents[0].occurredAt, '2026-07-31T18:44:50.690Z');
});

test('no rate-limit events in a clean window', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-clean-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const file = writeFixture(dir, [
    assistantLine('main', 'claude-opus-4-8', {
      input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    }, '2026-07-08T09:59:00.000Z'),
  ]);
  const { apiErrorEvents } = computeDelta(file, 0, { cwd: '/some/path', repoRootOf: (d) => d });
  assert.equal(apiErrorEvents.length, 0);
});

// ─── context peak / final ────────────────────────────────────────────────────

test('context — peak survives auto-compact, final tracks the last counted line', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = writeFixture(dir, [
    assistantLine('main', 'claude-fable-5', {
      input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100000, cache_creation_input_tokens: 1000,
    }, '2024-01-01T10:00:00.000Z'),
    assistantLine('main', 'claude-fable-5', {
      input_tokens: 2, output_tokens: 8, cache_read_input_tokens: 220000, cache_creation_input_tokens: 2000,
    }, '2024-01-01T10:01:00.000Z'),
    // Auto-compact drops the context — peak must survive, final must follow.
    assistantLine('main', 'claude-fable-5', {
      input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 50000, cache_creation_input_tokens: 500,
    }, '2024-01-01T10:02:00.000Z'),
  ]);

  const { segments } = computeDelta(file, 0, { cwd: '/some/path', repoRootOf: (d) => d });
  const stats = segments[0].stats;
  assert.equal(stats.context_peak_tokens, 222002);
  assert.equal(stats.context_final_tokens, 50503);
  assert.equal(stats.context_final_model, 'claude-fable-5');
});

test('context — sidechain assistant lines are excluded', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = writeFixture(dir, [
    assistantLine('main', 'claude-fable-5', {
      input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 200000, cache_creation_input_tokens: 0,
    }, '2024-01-01T10:00:00.000Z'),
    // Tiny sidechain (title generation) — must move neither peak nor final.
    assistantLine('main', 'claude-haiku-4-5', {
      input_tokens: 500, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    }, '2024-01-01T10:00:30.000Z', true),
  ]);

  const { segments } = computeDelta(file, 0, { cwd: '/some/path', repoRootOf: (d) => d });
  const stats = segments[0].stats;
  assert.equal(stats.context_peak_tokens, 200010);
  assert.equal(stats.context_final_tokens, 200010);
  assert.equal(stats.context_final_model, 'claude-fable-5');
});

test('context — fields are ABSENT when no assistant line was counted', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = writeFixture(dir, [
    { type: 'user', gitBranch: 'main', cwd: '/some/path', timestamp: '2024-01-01T10:00:00.000Z', message: { content: 'hello' } },
  ]);

  const { segments } = computeDelta(file, 0, { cwd: '/some/path', repoRootOf: (d) => d });
  for (const seg of segments) {
    assert.equal('context_peak_tokens' in seg.stats, false);
    assert.equal('context_final_tokens' in seg.stats, false);
    assert.equal('context_final_model' in seg.stats, false);
  }
});

test('context — block-line dedup: same message id counts context once', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100000, cache_creation_input_tokens: 0 };
  const withId = (ts) => ({
    type: 'assistant', gitBranch: 'main', cwd: '/some/path', timestamp: ts,
    message: { id: 'msg-1', model: 'claude-fable-5', usage },
  });
  const file = writeFixture(dir, [withId('2024-01-01T10:00:00.000Z'), withId('2024-01-01T10:00:01.000Z')]);

  const { segments } = computeDelta(file, 0, { cwd: '/some/path', repoRootOf: (d) => d });
  const stats = segments[0].stats;
  assert.equal(stats.context_peak_tokens, 100010);
  assert.equal(stats.token_input, 10);
});

test('effort — mixed efforts on one model bucket separately and partition the tally', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = writeFixture(dir, [
    assistantLine('main', 'claude-opus-4-8', {
      input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5,
    }, '2024-01-01T10:00:00.000Z', false, '/some/path', 'high'),
    assistantLine('main', 'claude-opus-4-8', {
      input_tokens: 200, output_tokens: 75, cache_read_input_tokens: 20, cache_creation_input_tokens: 8,
    }, '2024-01-01T10:01:00.000Z', false, '/some/path', 'max'),
  ]);

  const { segments } = computeDelta(file, 0);
  const model = segments[0].stats.models['claude-opus-4-8'];

  // Parent tally is unchanged by the split.
  assert.equal(model.token_input, 300);
  assert.equal(model.requests, 2);

  const high = model.by_effort.high;
  const max = model.by_effort.max;
  assert.deepEqual(high, {
    token_input: 100, token_output: 50, token_cache_read: 10, token_cache_creation: 5, requests: 1,
  });
  assert.deepEqual(max, {
    token_input: 200, token_output: 75, token_cache_read: 20, token_cache_creation: 8, requests: 1,
  });
  assert.equal(Object.keys(model.by_effort).length, 2, 'no stray buckets');
});

test('effort — lines without the field land in the unknown bucket', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = writeFixture(dir, [
    assistantLine('main', 'model-a', {
      input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    }, '2024-01-01T10:00:00.000Z'),
  ]);

  const { segments } = computeDelta(file, 0);
  const model = segments[0].stats.models['model-a'];
  assert.deepEqual(model.by_effort.unknown, {
    token_input: 100, token_output: 10, token_cache_read: 0, token_cache_creation: 0, requests: 1,
  });
});

test('effort — known and missing efforts on one model: buckets sum to the model totals', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = writeFixture(dir, [
    assistantLine('main', 'model-a', {
      input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 3, cache_creation_input_tokens: 1,
    }, '2024-01-01T10:00:00.000Z', false, '/some/path', 'xhigh'),
    assistantLine('main', 'model-a', {
      input_tokens: 40, output_tokens: 4, cache_read_input_tokens: 2, cache_creation_input_tokens: 0,
    }, '2024-01-01T10:01:00.000Z'),
  ]);

  const { segments } = computeDelta(file, 0);
  const model = segments[0].stats.models['model-a'];
  const buckets = Object.values(model.by_effort);
  const sum = (field) => buckets.reduce((acc, b) => acc + b[field], 0);
  assert.ok(model.by_effort.xhigh, 'known bucket exists');
  assert.ok(model.by_effort.unknown, 'unknown bucket exists');
  assert.equal(sum('token_input'), model.token_input);
  assert.equal(sum('token_output'), model.token_output);
  assert.equal(sum('token_cache_read'), model.token_cache_read);
  assert.equal(sum('token_cache_creation'), model.token_cache_creation);
  assert.equal(sum('requests'), model.requests);
});

test('effort — block-line dedup: duplicate message id buckets once', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const dupLine = {
    type: 'assistant',
    gitBranch: 'main',
    cwd: '/some/path',
    timestamp: '2024-01-01T10:00:00.000Z',
    effort: 'high',
    message: {
      id: 'msg_1',
      model: 'claude-haiku-4-5',
      usage: {
        input_tokens: 100, output_tokens: 50,
        cache_read_input_tokens: 10, cache_creation_input_tokens: 5,
      },
    },
  };

  const file = writeFixture(dir, [dupLine, dupLine, dupLine]);
  const { segments } = computeDelta(file, 0);
  const model = segments[0].stats.models['claude-haiku-4-5'];
  assert.equal(model.by_effort.high.requests, 1, 'one bucketed request, not three');
  assert.equal(model.by_effort.high.token_input, 100, 'bucket input counted once');
  assert.equal(model.by_effort.unknown, undefined, 'no unknown bucket for effort-carrying lines');
});

test('effort — two models keep independent by_effort maps', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = writeFixture(dir, [
    assistantLine('main', 'model-a', {
      input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    }, '2024-01-01T10:00:00.000Z', false, '/some/path', 'high'),
    assistantLine('main', 'model-b', {
      input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    }, '2024-01-01T10:01:00.000Z', false, '/some/path', 'max'),
  ]);

  const { segments } = computeDelta(file, 0);
  const { models } = segments[0].stats;
  assert.deepEqual(Object.keys(models['model-a'].by_effort), ['high']);
  assert.deepEqual(Object.keys(models['model-b'].by_effort), ['max']);
});

// ─── session span: the tail Claude Code writes after the human walks away ────
//
// Claude Code stamps bookkeeping lines (away_summary recaps, queue operations, hook/attachment
// output on --resume) long after the last real turn. They used to set the segment's ended_at,
// so a session "ended" 49 minutes into idle — or, on a resume, the next day.

test('span — a trailing away_summary does not extend ended_at into the idle tail', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const work1 = '2026-07-15T13:11:11.000Z';
  const work2 = '2026-07-15T13:12:11.185Z';
  const away = '2026-07-15T14:01:18.729Z'; // 49 min after the last turn

  const file = writeFixture(dir, [
    assistantLine('main', 'm', {
      input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    }, work1),
    assistantLine('main', 'm', {
      input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    }, work2),
    // Real recap lines carry gitBranch/cwd, so they land inside the run they trail.
    { type: 'system', subtype: 'away_summary', content: 'recap', gitBranch: 'main', cwd: '/some/path', timestamp: away },
  ]);

  // branchAt mirrors production (per-repo reflog): the branch does not come off the line.
  const { segments } = computeDelta(file, 0, { cwd: '/some/path', repoRootOf: (d) => d, branchAt: () => 'main' });
  assert.equal(segments.length, 1);
  const { stats } = segments[0];
  assert.equal(stats.started_at, work1);
  assert.equal(stats.ended_at, work2, 'session ends at the last real turn, not at the recap');
  assert.equal(stats.duration_sec, 60);
  assert.equal(segments[0].toLine, 3, 'line range is untouched — segmentId must stay stable');
});

test('span — resume artefacts the next day do not extend ended_at', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const work1 = '2026-07-22T17:51:38.000Z';
  const work2 = '2026-07-22T17:52:46.299Z';
  // Everything Claude Code appends when the session is resumed ~19h later.
  const resume = '2026-07-23T12:24:54.484Z';

  const file = writeFixture(dir, [
    assistantLine('main', 'm', {
      input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    }, work1),
    assistantLine('main', 'm', {
      input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    }, work2),
    { type: 'attachment', attachment: { type: 'date_change', newDate: '2026-07-23' }, cwd: '/some/path', timestamp: resume },
    { type: 'queue-operation', operation: 'remove', timestamp: '2026-07-23T12:24:54.851Z' },
    { type: 'attachment', attachment: { type: 'edited_text_file' }, cwd: '/some/path', timestamp: '2026-07-23T12:24:54.850Z' },
  ]);

  const { segments } = computeDelta(file, 0, { cwd: '/some/path', repoRootOf: (d) => d, branchAt: () => 'main' });
  assert.equal(segments.length, 1);
  const { stats } = segments[0];
  assert.equal(stats.ended_at, work2, 'the resume tail is bookkeeping, not activity');
  // 68.3s of real work + the 0.37s the three resume stamps span. duration_sec is deliberately
  // NOT filtered by isTimingAnchor — only the span is — so this stays exactly what it was
  // before the span fix.
  assert.equal(stats.duration_sec, 69);
});

test('span — a lone timestamped line still reports its own instant', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const only = '2026-07-15T13:11:11.000Z';
  const file = writeFixture(dir, [
    assistantLine('main', 'm', {
      input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    }, only),
  ]);

  const { stats } = computeDelta(file, 0, { cwd: '/some/path', repoRootOf: (d) => d }).segments[0];
  assert.equal(stats.started_at, only);
  assert.equal(stats.ended_at, only);
  assert.equal(stats.duration_sec, 0);
});

test('span — bookkeeping stamps are excluded from the span but NOT from duration_sec', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const work = '2026-07-15T13:00:00.000Z';
  // A task reminder injected 60s into a long turn: real evidence the agent was working, so it
  // must keep bridging the gap for duration_sec even though it never marks the session's end.
  const reminder = '2026-07-15T13:01:00.000Z';
  const done = '2026-07-15T13:02:00.000Z';

  const file = writeFixture(dir, [
    assistantLine('main', 'm', {
      input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    }, work),
    { type: 'attachment', attachment: { type: 'task_reminder' }, gitBranch: 'main', cwd: '/some/path', timestamp: reminder },
    assistantLine('main', 'm', {
      input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    }, done),
  ]);

  const { stats } = computeDelta(file, 0, { cwd: '/some/path', repoRootOf: (d) => d, branchAt: () => 'main' }).segments[0];
  assert.equal(stats.duration_sec, 120, 'the attachment still bridges the turn');
  assert.equal(stats.started_at, work);
  assert.equal(stats.ended_at, done);
});

// ─── teardown vs real work: simulated cases, one per shape found in the corpus ───────────────
//
// Every row here is modelled on a real local transcript. The NEGATIVE cases matter most: 8
// errored tool_results land after an idle gap and 7 of them are genuine session time, so a
// broader "errored result = teardown" rule would silently eat real work. These pin that boundary.

const TEARDOWN_TEXT =
  'Tool permission request failed: AbortError: Tool permission stream closed before response received';

// Two turns of work, then one trailing line after a long gap. Returns the reported span.
function spanAfterTrailing(dir, trailingLine) {
  const w1 = '2026-07-22T17:51:38.000Z';
  const w2 = '2026-07-22T17:52:46.299Z';
  const file = writeFixture(dir, [
    assistantLine('main', 'm', {
      input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    }, w1),
    assistantLine('main', 'm', {
      input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    }, w2),
    trailingLine,
  ]);
  const { segments } = computeDelta(file, 0, { cwd: '/some/path', repoRootOf: (d) => d, branchAt: () => 'main' });
  return { span: segments[0].stats, lastWork: w2 };
}

const errorResult = (text, timestamp) => ({
  type: 'user',
  gitBranch: 'main',
  cwd: '/some/path',
  timestamp,
  toolUseResult: { stdout: '' },
  message: { role: 'user', content: [{ type: 'tool_result', content: text, is_error: true }] },
});

test('teardown — the permission stream-closed result never ends the session (afa6f965)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  // 1112 minutes later — the session was reopened the next day.
  const { span, lastWork } = spanAfterTrailing(dir, errorResult(TEARDOWN_TEXT, '2026-07-23T12:24:54.484Z'));
  assert.equal(span.ended_at, lastWork, 'stream-closed teardown is not session time');
});

test('teardown — a tool that ran and timed out IS session time (dd6e1682)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const at = '2026-07-22T17:57:46.299Z'; // +5min, matching the real "timed out after 5m 0s"
  const { span } = spanAfterTrailing(dir, errorResult('Exit code 143\nCommand timed out after 5m 0s', at));
  assert.equal(span.ended_at, at, 'a real tool run that failed still ends the session');
});

test('teardown — a human rejecting a permission after 95min IS session time (ad8996c1)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const at = '2026-07-22T19:27:46.299Z'; // +95min
  const { span } = spanAfterTrailing(
    dir,
    errorResult("The user doesn't want to proceed with this tool use. The tool use was rejected", at),
  );
  assert.equal(span.ended_at, at, 'the human answered — they were there');
});

test('teardown — a failed command exit code IS session time (4a7db9ee)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const at = '2026-07-22T17:58:46.299Z';
  const { span } = spanAfterTrailing(dir, errorResult('Exit code 128', at));
  assert.equal(span.ended_at, at);
});

test('teardown — a batch mixing teardown with a real result stays session time', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  // Parallel tool calls answer in one batch: one died with the stream, the other really ran.
  const at = '2026-07-23T12:24:54.484Z';
  const { span } = spanAfterTrailing(dir, {
    type: 'user',
    gitBranch: 'main',
    cwd: '/some/path',
    timestamp: at,
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', content: TEARDOWN_TEXT, is_error: true },
        { type: 'tool_result', content: 'total 12\ndrwxr-xr-x', is_error: false },
      ],
    },
  });
  assert.equal(span.ended_at, at, 'one genuine result makes the whole batch a genuine moment');
});

test('teardown — agents_killed remains an anchor', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  // Considered for the deny list and deliberately left out: 0 of 6 trail a session in the corpus,
  // and the stamp coincides with the human pressing Esc, which is a real moment.
  const killed = '2026-07-22T17:57:46.299Z';
  const { span } = spanAfterTrailing(dir, {
    type: 'system', subtype: 'agents_killed', gitBranch: 'main', cwd: '/some/path', timestamp: killed,
  });
  assert.equal(span.ended_at, killed, 'agents_killed still marks a moment');
});

test('teardown — a <synthetic> placeholder does not end the session (02a54415)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  // model:'<synthetic>' means Claude Code filled the assistant slot itself — no model call, no
  // tokens. It records that nothing happened. Left out of the deny list until the local-command
  // rule exposed 02a54415, whose transcript ends on one 8 minutes past the last real turn.
  const { span, lastWork } = spanAfterTrailing(dir, {
    type: 'assistant',
    gitBranch: 'main',
    cwd: '/some/path',
    timestamp: '2026-07-22T18:00:46.299Z',
    message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'No response requested.' }] },
  });
  assert.equal(span.ended_at, lastWork, 'a placeholder is not a turn');
});

// ─── local slash commands: solid housekeeping vs a command that does something ───────────────
//
// The rule needs no lookahead. A command that spawns work is followed within milliseconds by its
// expansion and the assistant turn, and THOSE anchor the session. A "solid" command (no user
// input, nothing follows) leaves nothing behind, so the wait after it is skipped.

const commandEcho = (name, args, timestamp) => ({
  type: 'user',
  gitBranch: 'main',
  cwd: '/some/path',
  timestamp,
  message: {
    role: 'user',
    content: `<command-name>/${name}</command-name>\n<command-message>${name}</command-message>\n<command-args>${args}</command-args>`,
  },
});

test('command — a solid /clear does not open the session hours early (cec9640d)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  // Modelled on the real worst case: /clear at 08:33, first real prompt at 12:28.
  const work = '2026-08-05T12:28:42.551Z';
  const file = writeFixture(dir, [
    commandEcho('clear', '', '2026-08-05T08:33:06.311Z'),
    { type: 'system', subtype: 'local_command', gitBranch: 'main', cwd: '/some/path', timestamp: '2026-08-05T08:33:13.346Z',
      message: { role: 'user', content: '<local-command-stdout></local-command-stdout>' } },
    assistantLine('main', 'm', {
      input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    }, work),
  ]);

  const { stats } = computeDelta(file, 0, { cwd: '/some/path', repoRootOf: (d) => d, branchAt: () => 'main' }).segments[0];
  assert.equal(stats.started_at, work, '236 minutes of nothing are not session time');
});

test('command — a command that spawns work IS tracked from the work (/code-review)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  // The echo is denied, but the expansion is followed immediately by a real assistant turn, so
  // the session is timed from the moment the work began — milliseconds later, not hours.
  const cmd = '2026-08-10T09:35:18.100Z';
  const spawn = '2026-08-10T09:35:18.300Z';
  const later = '2026-08-10T10:02:28.778Z';
  const file = writeFixture(dir, [
    commandEcho('code-review', 'https://dev.azure.com/org/repo', cmd),
    assistantLine('main', 'm', {
      input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    }, spawn),
    assistantLine('main', 'm', {
      input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    }, later),
  ]);

  const { stats } = computeDelta(file, 0, { cwd: '/some/path', repoRootOf: (d) => d, branchAt: () => 'main' }).segments[0];
  assert.equal(stats.started_at, spawn, 'work that follows the command anchors it');
  assert.equal(stats.ended_at, later, 'and the whole fan-out stays inside the span');
});

test('command — a solid command at the END does not extend the session (/plugin)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  // 8 local transcripts close on a system:local_command from /plugin or /reload-plugins.
  const { span, lastWork } = spanAfterTrailing(dir, commandEcho('plugin', '', '2026-07-22T19:43:46.299Z'));
  assert.equal(span.ended_at, lastWork, 'housekeeping after the work is not session time');
});

test('command — injected meta lines are not anchors at either end', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  // A system-reminder (5b4bc730) and the resume marker are both isMeta injections, stamped when
  // the session is assembled rather than when a human speaks.
  const { span, lastWork } = spanAfterTrailing(dir, {
    type: 'user',
    isMeta: true,
    gitBranch: 'main',
    cwd: '/some/path',
    timestamp: '2026-07-22T18:05:46.299Z',
    message: { role: 'user', content: '<system-reminder>The user named this session "ping".</system-reminder>' },
  });
  assert.equal(span.ended_at, lastWork);
});

// ---------------------------------------------------------------------------
// R-family: the segments of a window must TILE it. Every line between the
// cursor and EOF has to sit inside some segment's [fromLine, toLine], because
// nextCursor consumes the whole window regardless — a line outside every
// segment is a hole no later run can ever fill, and the server's coverage fold
// stops dead at the first one.
// ---------------------------------------------------------------------------

// Reflog with a checkout to feature/task-1 BEFORE the fixture timestamps, so a
// timestamped line resolves to feature/task-1 while '(head)' stands in for the
// repo's current branch — the two answers whose disagreement split the window.
const R_REFLOG = [
  'a1 HEAD@{2026-07-03T10:00:00+00:00}: checkout: moving from main to feature/task-1',
].join('\n');

function reflogBranchAt() {
  const timeline = buildBranchTimeline(readCheckoutEvents(() => R_REFLOG, 'x'));
  return (_root, ms) => (ms == null ? '(head)' : branchAtReflog(timeline, ms));
}

// Asserts the tiling invariant: no gap at the head, none between segments, none
// at the tail.
function assertTiles(segments, fromLine, nextCursor) {
  assert.ok(segments.length > 0, 'expected at least one segment');
  assert.equal(segments[0].fromLine, fromLine + 1, 'first segment must start at the cursor');
  assert.equal(segments.at(-1).toLine, nextCursor, 'last segment must reach nextCursor');
  for (let i = 1; i < segments.length; i++) {
    assert.equal(segments[i].fromLine, segments[i - 1].toLine + 1, `gap before segment ${i}`);
  }
}

test('R1. timestamp-less head lines join the first resolved run (real reflog)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = writeFixture(dir, [
    { type: 'mode', mode: 'default' },                        // no timestamp
    { type: 'file-history-snapshot', messageId: 'x' },        // no timestamp
    repoLine('/repo/a', U(10), '2026-07-03T11:00:00.000Z'),
    repoLine('/repo/a', U(20), '2026-07-03T11:05:00.000Z'),
  ]);

  const { segments, nextCursor } = computeDelta(file, 0, {
    cwd: '/repo/a', repoRootOf: (d) => d, branchAt: reflogBranchAt(),
  });

  assert.equal(segments.length, 1);
  assert.equal(segments[0].branch, 'feature/task-1', 'must bill the historical branch, not HEAD');
  assertTiles(segments, 0, nextCursor);
});

test('R2. an unparseable timestamp resolves no branch and never enters the clock', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = writeFixture(dir, [
    repoLine('/repo/a', U(10), 'not-a-date'),
    repoLine('/repo/a', U(20), '2026-07-03T11:05:00.000Z'),
  ]);

  const { segments, nextCursor } = computeDelta(file, 0, {
    cwd: '/repo/a', repoRootOf: (d) => d, branchAt: reflogBranchAt(),
  });

  assert.equal(segments.length, 1);
  assert.equal(segments[0].branch, 'feature/task-1');
  assertTiles(segments, 0, nextCursor);
  // NaN must not reach the span or the interval builder.
  assert.ok(Number.isFinite(segments[0].stats.duration_sec), 'duration_sec must be finite');
  assert.equal(segments[0].stats.started_at, '2026-07-03T11:05:00.000Z');
  assert.equal(segments[0].stats.ended_at, '2026-07-03T11:05:00.000Z');
});

test('R3. a malformed first line still leaves the window sealed at line 1', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = path.join(dir, 'broken.jsonl');
  fs.writeFileSync(file, [
    'THIS IS NOT JSON!!!',
    JSON.stringify(repoLine('/repo/a', U(10), '2026-07-03T11:00:00.000Z')),
  ].join('\n'), 'utf-8');

  const { segments, nextCursor } = computeDelta(file, 0, {
    cwd: '/repo/a', repoRootOf: (d) => d, branchAt: reflogBranchAt(),
  });

  assert.equal(nextCursor, 2);
  assertTiles(segments, 0, nextCursor);
});

test('R4. a malformed trailing line is inside the last segment', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = path.join(dir, 'broken-tail.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify(repoLine('/repo/a', U(10), '2026-07-03T11:00:00.000Z')),
    '{ NOPE',
  ].join('\n'), 'utf-8');

  const { segments, nextCursor } = computeDelta(file, 0, {
    cwd: '/repo/a', repoRootOf: (d) => d, branchAt: reflogBranchAt(),
  });

  assert.equal(nextCursor, 2);
  assertTiles(segments, 0, nextCursor);
});

test('R5. a repo switch drops the carried branch instead of leaking it', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = writeFixture(dir, [
    repoLine('/repo/a', U(10), '2026-07-03T11:00:00.000Z'),
    // No timestamp, but its cwd moves the active repo to /repo/b.
    { type: 'mode', mode: 'default', cwd: '/repo/b' },
    repoLine('/repo/b', U(20), '2026-07-03T11:05:00.000Z'),
  ]);

  const { segments, nextCursor } = computeDelta(file, 0, {
    cwd: '/repo/a', repoRootOf: (d) => d, branchAt: (root, ms) => (ms == null ? null : `br:${root}`),
  });

  assert.deepEqual(segments.map((s) => s.repoRoot), ['/repo/a', '/repo/b']);
  assert.equal(segments[1].branch, 'br:/repo/b', 'the meta line must not carry repo A\'s branch into B');
  assertTiles(segments, 0, nextCursor);
});

test('R6. multi-repo windows tile with no gaps', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = writeFixture(dir, [
    { type: 'mode', mode: 'default' },
    repoLine('/repo/a', U(10), '2026-07-03T11:00:00.000Z'),
    repoLine('/repo/b', U(20), '2026-07-03T11:01:00.000Z'),
    repoLine('/repo/a', U(30), '2026-07-03T11:02:00.000Z'),
  ]);

  const { segments, nextCursor } = computeDelta(file, 0, {
    cwd: '/repo/a', repoRootOf: (d) => d, branchAt: (root) => `branch-of:${root}`,
  });

  assert.deepEqual(segments.map((s) => s.repoRoot), ['/repo/a', '/repo/b', '/repo/a']);
  assertTiles(segments, 0, nextCursor);
});

test('R7. a run that never sees a usable timestamp falls back to the head branch', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = writeFixture(dir, [
    { type: 'mode', mode: 'default' },
    { type: 'last-prompt', prompt: 'hi' },
  ]);

  const calls = [];
  const { segments, nextCursor } = computeDelta(file, 0, {
    cwd: '/repo/a',
    repoRootOf: (d) => d,
    branchAt: (root, ms) => { calls.push(ms); return ms == null ? '(head)' : 'never'; },
  });

  assert.equal(segments.length, 1);
  assert.equal(segments[0].branch, '(head)');
  assertTiles(segments, 0, nextCursor);
  // closeRun is the only site allowed to ask with a null ms, and it asks exactly once.
  assert.deepEqual(calls, [null]);
});

test('R8. a malformed line on a run boundary belongs to the run that follows it', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = path.join(dir, 'boundary.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify(repoLine('/repo/a', U(10), '2026-07-03T11:00:00.000Z')),
    'NOT JSON',                                                              // line 2
    JSON.stringify(repoLine('/repo/b', U(20), '2026-07-03T11:01:00.000Z')),  // splits here
  ].join('\n'), 'utf-8');

  const { segments, nextCursor } = computeDelta(file, 0, {
    cwd: '/repo/a', repoRootOf: (d) => d, branchAt: (root) => `br:${root}`,
  });

  assert.deepEqual(segments.map((s) => [s.fromLine, s.toLine]), [[1, 1], [2, 3]]);
  assertTiles(segments, 0, nextCursor);
});

test('R9. untimestamped lines mid-run keep the run open', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = writeFixture(dir, [
    repoLine('/repo/a', U(10), '2026-07-03T11:00:00.000Z'),
    { type: 'permission-mode', cwd: '/repo/a' },
    { type: 'atis-latch', cwd: '/repo/a' },
    repoLine('/repo/a', U(20), '2026-07-03T11:05:00.000Z'),
  ]);

  const { segments, nextCursor } = computeDelta(file, 0, {
    cwd: '/repo/a', repoRootOf: (d) => d, branchAt: reflogBranchAt(),
  });

  assert.equal(segments.length, 1, 'meta lines must not split a run in two');
  assert.equal(segments[0].stats.token_input, 30);
  assertTiles(segments, 0, nextCursor);
});

test('R10. a resumed window opens at the cursor, not at its first parsed line', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = path.join(dir, 'resumed.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify(repoLine('/repo/a', U(10), '2026-07-03T11:00:00.000Z')),
    'GARBAGE',                                                               // line 2, first of the window
    JSON.stringify(repoLine('/repo/a', U(20), '2026-07-03T11:05:00.000Z')),
  ].join('\n'), 'utf-8');

  const { segments, nextCursor } = computeDelta(file, 1, {
    cwd: '/repo/a', repoRootOf: (d) => d, branchAt: reflogBranchAt(),
  });

  assert.equal(segments[0].fromLine, 2);
  assertTiles(segments, 1, nextCursor);
});

// ─── advisor iterations: the API calls top-level usage does not report ────────
//
// A single API turn now arrives as `usage.iterations` — one entry per leg. Top-level
// input/output/cache fields sum ONLY the legs of type 'message'; an `advisor_message` leg
// (the advisor tool's own uncached call, often on a different model) is excluded entirely.
// Reading top-level alone lost 1,229,631 input / 29,140 output tokens on one local session.

// Helper: an assistant line whose usage carries iteration legs.
function advisorLine(model, top, iterations, timestamp, effort = undefined, id = undefined) {
  const line = {
    type: 'assistant',
    gitBranch: 'main',
    cwd: '/some/path',
    timestamp,
    message: { model, usage: Object.assign({}, top, { iterations }) },
  };
  if (effort != null) line.effort = effort;
  if (id != null) line.message.id = id;
  return line;
}

test('advisor — an advisor_message leg lands in its own model bucket', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = writeFixture(dir, [
    advisorLine('model-a', {
      input_tokens: 4, output_tokens: 524, cache_read_input_tokens: 117831, cache_creation_input_tokens: 4533,
    }, [
      { type: 'message', input_tokens: 2, output_tokens: 41, cache_read_input_tokens: 57378, cache_creation_input_tokens: 3075 },
      { type: 'advisor_message', model: 'advisor-b', input_tokens: 61696, output_tokens: 4008, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      { type: 'message', input_tokens: 2, output_tokens: 483, cache_read_input_tokens: 60453, cache_creation_input_tokens: 1458 },
    ], '2024-01-01T10:00:00.000Z', 'high'),
  ]);

  const { models } = computeDelta(file, 0).segments[0].stats;

  assert.deepEqual(models['model-a'], {
    token_input: 4, token_output: 524, token_cache_read: 117831, token_cache_creation: 4533, requests: 1,
    by_effort: {
      high: { token_input: 4, token_output: 524, token_cache_read: 117831, token_cache_creation: 4533, requests: 1 },
    },
  }, 'the parent tally still comes off top-level usage, unchanged');

  assert.deepEqual(models['advisor-b'], {
    token_input: 61696, token_output: 4008, token_cache_read: 0, token_cache_creation: 0, requests: 1,
    by_effort: {
      high: { token_input: 61696, token_output: 4008, token_cache_read: 0, token_cache_creation: 0, requests: 1 },
    },
  }, 'the advisor leg is its own request, bucketed under the parent line effort');
});

test('advisor — a leg on the same model merges into that model bucket', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = writeFixture(dir, [
    advisorLine('model-a', {
      input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5,
    }, [
      { type: 'message', input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 },
      { type: 'advisor_message', model: 'model-a', input_tokens: 900, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    ], '2024-01-01T10:00:00.000Z', 'max'),
  ]);

  const { models } = computeDelta(file, 0).segments[0].stats;
  assert.deepEqual(Object.keys(models), ['model-a'], 'one bucket, not two');
  assert.equal(models['model-a'].token_input, 902);
  assert.equal(models['model-a'].token_output, 50);
  assert.equal(models['model-a'].requests, 2, 'the advisor call is a second API request');
  assert.equal(models['model-a'].by_effort.max.token_input, 902, 'buckets still partition the model tally');
});

test('advisor — a leg without its own model falls back to the parent model', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = writeFixture(dir, [
    advisorLine('model-a', {
      input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    }, [
      { type: 'message', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      { type: 'advisor_message', input_tokens: 500, output_tokens: 20 },
    ], '2024-01-01T10:00:00.000Z'),
  ]);

  const { models } = computeDelta(file, 0).segments[0].stats;
  assert.deepEqual(Object.keys(models), ['model-a']);
  assert.deepEqual(models['model-a'], {
    token_input: 501, token_output: 21, token_cache_read: 0, token_cache_creation: 0, requests: 2,
    by_effort: {
      unknown: { token_input: 501, token_output: 21, token_cache_read: 0, token_cache_creation: 0, requests: 2 },
    },
  }, 'absent cache fields read as 0, never undefined or NaN');
});

test('advisor — message legs are never added on top of the top-level totals', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = writeFixture(dir, [
    advisorLine('model-a', {
      input_tokens: 4, output_tokens: 60, cache_read_input_tokens: 30, cache_creation_input_tokens: 8,
    }, [
      { type: 'message', input_tokens: 2, output_tokens: 20, cache_read_input_tokens: 10, cache_creation_input_tokens: 3 },
      { type: 'message', input_tokens: 2, output_tokens: 40, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 },
    ], '2024-01-01T10:00:00.000Z'),
  ]);

  const { models } = computeDelta(file, 0).segments[0].stats;
  assert.equal(models['model-a'].token_input, 4, 'top-level already sums the message legs');
  assert.equal(models['model-a'].token_output, 60);
  assert.equal(models['model-a'].requests, 1);
});

test('advisor — an unrecognised leg type is ignored rather than counted twice', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = writeFixture(dir, [
    advisorLine('model-a', {
      input_tokens: 4, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    }, [
      { type: 'message', input_tokens: 4, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      { type: 'future_leg_20990101', input_tokens: 9999, output_tokens: 9999 },
    ], '2024-01-01T10:00:00.000Z'),
  ]);

  const { models } = computeDelta(file, 0).segments[0].stats;
  assert.equal(models['model-a'].token_input, 4, 'an unknown leg may already sit inside top-level; never inflate');
  assert.equal(Object.keys(models).length, 1);
});

test('advisor — block-line dedup counts an advisor leg once', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const legs = [
    { type: 'message', input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    { type: 'advisor_message', model: 'advisor-b', input_tokens: 700, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  ];
  const line = advisorLine('model-a', {
    input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
  }, legs, '2024-01-01T10:00:00.000Z', 'high', 'msg_1');

  const file = writeFixture(dir, [line, line, line]);
  const { models } = computeDelta(file, 0).segments[0].stats;
  assert.equal(models['advisor-b'].token_input, 700, 'advisor tokens counted once across 3 block-lines');
  assert.equal(models['advisor-b'].requests, 1);
});

test('advisor — a line with no iterations behaves exactly as before', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = writeFixture(dir, [
    assistantLine('main', 'model-a', {
      input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5,
    }, '2024-01-01T10:00:00.000Z', false, '/some/path', 'high'),
  ]);

  const { models } = computeDelta(file, 0).segments[0].stats;
  assert.deepEqual(models['model-a'], {
    token_input: 100, token_output: 50, token_cache_read: 10, token_cache_creation: 5, requests: 1,
    by_effort: {
      high: { token_input: 100, token_output: 50, token_cache_read: 10, token_cache_creation: 5, requests: 1 },
    },
  });
});

test('advisor — advisor input does not move the session context peak', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));

  const file = writeFixture(dir, [
    advisorLine('model-a', {
      input_tokens: 4, output_tokens: 60, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100,
    }, [
      { type: 'message', input_tokens: 4, output_tokens: 60, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100 },
      { type: 'advisor_message', model: 'advisor-b', input_tokens: 900000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    ], '2024-01-01T10:00:00.000Z'),
  ]);

  const { stats } = computeDelta(file, 0).segments[0];
  assert.equal(stats.context_peak_tokens, 1104, 'the advisor runs its own context; it is not the session context');
  assert.equal(stats.context_final_tokens, 1104);
});
