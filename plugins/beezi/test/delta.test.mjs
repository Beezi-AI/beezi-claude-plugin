import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeDelta } from '../lib/delta.mjs';

// Helper: write lines to a temp file and return its path.
function writeFixture(dir, lines) {
  const filePath = path.join(dir, `transcript-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n'), 'utf-8');
  return filePath;
}

// Helper: assistant line factory.
function assistantLine(branch, model, usage, timestamp, isSidechain = false, cwd = '/some/path') {
  return {
    type: 'assistant',
    gitBranch: branch,
    cwd,
    timestamp,
    isSidechain,
    message: { model, usage },
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

  // The unknown branch from mode line + main from line 3
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

  const { rateLimitEvents } = computeDelta(file, 0, { cwd: '/some/path', repoRootOf: (d) => d });

  assert.equal(rateLimitEvents.length, 1);
  assert.match(rateLimitEvents[0].text, /resets 4:30pm \(Europe\/Kiev\)/);
  assert.equal(rateLimitEvents[0].occurredAt, '2026-07-08T10:00:00.000Z');
  assert.equal(rateLimitEvents[0].lineNo, 2);
});

test('no rate-limit events in a clean window', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-clean-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const file = writeFixture(dir, [
    assistantLine('main', 'claude-opus-4-8', {
      input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    }, '2026-07-08T09:59:00.000Z'),
  ]);
  const { rateLimitEvents } = computeDelta(file, 0, { cwd: '/some/path', repoRootOf: (d) => d });
  assert.equal(rateLimitEvents.length, 0);
});
