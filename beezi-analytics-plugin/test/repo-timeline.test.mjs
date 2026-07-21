import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPathSignal, resolveRepoRoot } from '../lib/repo-timeline.mjs';

// Build an assistant line whose message.content carries tool_use blocks.
function toolLine(blocks) {
  return { type: 'assistant', message: { model: 'm', content: blocks } };
}
const use = (name, input) => ({ type: 'tool_use', name, input });

test('extractPathSignal — Edit/Write/Read return dirname of file_path', () => {
  assert.equal(extractPathSignal(toolLine([use('Edit', { file_path: '/repo/alpha/src/x.ts' })])), '/repo/alpha/src');
  assert.equal(extractPathSignal(toolLine([use('Write', { file_path: '/repo/beta/y.ts' })])), '/repo/beta');
  assert.equal(extractPathSignal(toolLine([use('Read', { file_path: '/repo/gamma/z.ts' })])), '/repo/gamma');
});

test('extractPathSignal — NotebookEdit uses notebook_path', () => {
  assert.equal(extractPathSignal(toolLine([use('NotebookEdit', { notebook_path: '/repo/nb/a.ipynb' })])), '/repo/nb');
});

test('extractPathSignal — Bash cd target (quoted, absolute)', () => {
  assert.equal(extractPathSignal(toolLine([use('Bash', { command: 'cd "/repo/alpha" && npm test' })])), '/repo/alpha');
});

test('extractPathSignal — Bash multiple cd → last wins', () => {
  assert.equal(extractPathSignal(toolLine([use('Bash', { command: 'cd /repo/a && cd /repo/b && ls' })])), '/repo/b');
});

test('extractPathSignal — Bash relative cd resolved against cwd', () => {
  assert.equal(extractPathSignal(toolLine([use('Bash', { command: 'cd sub && ls' })]), '/repo/alpha'), '/repo/alpha/sub');
});

test('extractPathSignal — Bash without cd → null', () => {
  assert.equal(extractPathSignal(toolLine([use('Bash', { command: 'npm test' })])), null);
});

test('extractPathSignal — multiple tool_use blocks → last block wins', () => {
  const line = toolLine([
    use('Read', { file_path: '/repo/alpha/x.ts' }),
    use('Edit', { file_path: '/repo/beta/y.ts' }),
  ]);
  assert.equal(extractPathSignal(line), '/repo/beta');
});

test('extractPathSignal — no content / no tool_use → null', () => {
  assert.equal(extractPathSignal({ type: 'assistant', message: { model: 'm', usage: {} } }), null);
  assert.equal(extractPathSignal(toolLine([{ type: 'text', text: 'hi' }])), null);
});

test('resolveRepoRoot — trims git output and caches; second call does not re-invoke git', () => {
  let calls = 0;
  const gitImpl = () => { calls += 1; return '/repo/alpha\n'; };
  const cache = new Map();
  assert.equal(resolveRepoRoot(gitImpl, '/repo/alpha/src', cache), '/repo/alpha');
  assert.equal(resolveRepoRoot(gitImpl, '/repo/alpha/src', cache), '/repo/alpha');
  assert.equal(calls, 1, 'result memoized by dir');
});

test('resolveRepoRoot — throw (not a repo) caches null', () => {
  let calls = 0;
  const gitImpl = () => { calls += 1; throw new Error('not a git repository'); };
  const cache = new Map();
  assert.equal(resolveRepoRoot(gitImpl, '/tmp/notrepo', cache), null);
  assert.equal(resolveRepoRoot(gitImpl, '/tmp/notrepo', cache), null);
  assert.equal(calls, 1, 'null result memoized too');
});

test('resolveRepoRoot — null dir returns null without calling git', () => {
  let calls = 0;
  const gitImpl = () => { calls += 1; return 'x'; };
  assert.equal(resolveRepoRoot(gitImpl, null, new Map()), null);
  assert.equal(calls, 0);
});

test('extractPathSignal — non-string file_path/notebook_path is ignored (no throw)', () => {
  assert.equal(extractPathSignal(toolLine([use('Edit', { file_path: 123 })])), null);
  assert.equal(extractPathSignal(toolLine([use('Write', { file_path: { x: 1 } })])), null);
  assert.equal(extractPathSignal(toolLine([use('NotebookEdit', { notebook_path: 5 })])), null);
});
