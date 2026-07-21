import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeDelta } from '../lib/delta.mjs';

function writeTranscript(t, records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-cc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = path.join(dir, 'session.jsonl');
  fs.writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  return p;
}

test('computeDelta attaches code_changes to each segment', (t) => {
  const p = writeTranscript(t, [
    {
      type: 'assistant',
      timestamp: '2026-07-06T10:00:00.000Z',
      message: {
        id: 'm1',
        model: 'claude-sonnet-4-5-20250929',
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [
          { type: 'tool_use', name: 'Edit', input: { file_path: '/repo/a.ts', old_string: 'x', new_string: 'x\ny' } },
        ],
      },
    },
  ]);

  const { segments } = computeDelta(p, 0, {
    cwd: '/repo',
    repoRootOf: () => '/repo',
    branchAt: () => 'main',
  });

  assert.equal(segments.length, 1);
  assert.deepEqual(segments[0].stats.code_changes, {
    files_changed: 1, lines_added: 2, lines_removed: 1, by_extension: { '.ts': 1 },
  });
});

test('computeDelta attaches per-category operations to each segment', (t) => {
  const p = writeTranscript(t, [
    {
      type: 'assistant',
      timestamp: '2026-07-06T10:00:00.000Z',
      message: {
        id: 'm1',
        model: 'claude-sonnet-4-5-20250929',
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/a.ts' } },
          { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    },
    {
      type: 'user',
      timestamp: '2026-07-06T10:00:01.000Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(400) }] },
    },
  ]);

  const { segments } = computeDelta(p, 0, {
    cwd: '/repo',
    repoRootOf: () => '/repo',
    branchAt: () => 'main',
  });

  assert.equal(segments.length, 1);
  const ops = segments[0].stats.operations;
  assert.equal(ops.file.count, 1);
  assert.equal(ops.file.est_tokens, 100); // 400 bytes / 4
  assert.equal(ops.shell.count, 1);
  assert.equal(ops.shell.est_tokens, 0);
  assert.equal(ops.search.count, 0);
});
