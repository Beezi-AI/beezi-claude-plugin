import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCodeChanges } from '../lib/code-changes.mjs';

const asstLine = (...blocks) => ({ type: 'assistant', message: { content: blocks } });
const tool = (name, input) => ({ type: 'tool_use', name, input });

test('Edit counts added/removed and the file + extension', () => {
  const lines = [asstLine(tool('Edit', {
    file_path: '/repo/src/foo.ts', old_string: 'a\nb\nc', new_string: 'a\nb\nc\nd\ne',
  }))];
  const r = computeCodeChanges(lines);
  assert.equal(r.files_changed, 1);
  assert.equal(r.lines_removed, 3);
  assert.equal(r.lines_added, 5);
  assert.deepEqual(r.by_extension, { '.ts': 1 });
});

test('MultiEdit sums over edits', () => {
  const lines = [asstLine(tool('MultiEdit', {
    file_path: '/repo/a.tsx',
    edits: [
      { old_string: 'x', new_string: 'x\ny' },
      { old_string: 'p\nq', new_string: 'p' },
    ],
  }))];
  const r = computeCodeChanges(lines);
  assert.equal(r.lines_added, 3);   // 2 + 1
  assert.equal(r.lines_removed, 3); // 1 + 2
  assert.deepEqual(r.by_extension, { '.tsx': 1 });
});

test('Write counts content as added only', () => {
  const lines = [asstLine(tool('Write', { file_path: '/repo/new.py', content: 'one\ntwo\nthree' }))];
  const r = computeCodeChanges(lines);
  assert.equal(r.lines_added, 3);
  assert.equal(r.lines_removed, 0);
  assert.deepEqual(r.by_extension, { '.py': 1 });
});

test('NotebookEdit counts new_source as added, no removed (no old_source field)', () => {
  const lines = [asstLine(tool('NotebookEdit', {
    notebook_path: '/repo/nb.ipynb', new_source: 'a\nb\nc',
  }))];
  const r = computeCodeChanges(lines);
  assert.equal(r.lines_added, 3);
  assert.equal(r.lines_removed, 0);
  assert.deepEqual(r.by_extension, { '.ipynb': 1 });
});

test('distinct files per extension; same file edited twice counts once in byExtension', () => {
  const lines = [
    asstLine(tool('Edit', { file_path: '/repo/a.ts', old_string: '', new_string: 'x' })),
    asstLine(tool('Edit', { file_path: '/repo/a.ts', old_string: 'x', new_string: 'y' })),
    asstLine(tool('Write', { file_path: '/repo/b.ts', content: 'z' })),
  ];
  const r = computeCodeChanges(lines);
  assert.equal(r.files_changed, 2);
  assert.deepEqual(r.by_extension, { '.ts': 2 });
});

test('no-extension file buckets under (none); non-edit tools ignored', () => {
  const lines = [
    asstLine(tool('Bash', { command: 'ls' })),
    asstLine(tool('Write', { file_path: '/repo/Makefile', content: 'all:' })),
  ];
  const r = computeCodeChanges(lines);
  assert.equal(r.files_changed, 1);
  assert.deepEqual(r.by_extension, { '(none)': 1 });
});

test('empty input → all zeros', () => {
  const r = computeCodeChanges([]);
  assert.deepEqual(r, { files_changed: 0, lines_added: 0, lines_removed: 0, by_extension: {} });
});
