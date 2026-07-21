import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOperations } from '../lib/operations.mjs';

const asstLine = (...blocks) => ({ type: 'assistant', message: { content: blocks } });
const tool = (name, id, input) => ({ type: 'tool_use', name, id, input: input || {} });
const resultLine = (toolUseId, content) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
});

const zero = () => ({ count: 0, est_tokens: 0 });
const emptyTotals = () => ({
  file: zero(), search: zero(), internet: zero(),
  mcp: { count: 0, est_tokens: 0, by_server: {} },
  shell: zero(),
  skill: { count: 0, est_tokens: 0, by_skill: {} },
  other: zero(),
  plugins: {},
});

test('categorizes each tool into its bucket', () => {
  const lines = [
    asstLine(tool('Read', 't1')),
    asstLine(tool('Grep', 't2')),
    asstLine(tool('WebFetch', 't3')),
    asstLine(tool('mcp__atlassian__search', 't4')),
    asstLine(tool('Bash', 't5')),
    asstLine(tool('Skill', 't6', { skill: 'superpowers:tdd' })),
    asstLine(tool('Agent', 't7')),
  ];
  const r = computeOperations(lines);
  assert.equal(r.file.count, 1);
  assert.equal(r.search.count, 1);
  assert.equal(r.internet.count, 1);
  assert.equal(r.mcp.count, 1);
  assert.equal(r.shell.count, 1);
  assert.equal(r.skill.count, 1);
  assert.equal(r.other.count, 1); // Agent (subagent spawn) stays in other
});

test('Skill tool lands in skill bucket with per-skill tally, not other', () => {
  const lines = [
    asstLine(tool('Skill', 't1', { skill: 'superpowers:test-driven-development' })),
    asstLine(tool('Skill', 't2', { skill: 'superpowers:test-driven-development' })),
    asstLine(tool('Skill', 't3', { skill: 'beezi:track' })),
    asstLine(tool('Skill', 't4', {})), // no skill id → 'unknown'
  ];
  const r = computeOperations(lines);
  assert.equal(r.skill.count, 4);
  assert.equal(r.other.count, 0);
  assert.deepEqual(r.skill.by_skill, {
    'superpowers:test-driven-development': { count: 2, est_tokens: 0 },
    'beezi:track': { count: 1, est_tokens: 0 },
    unknown: { count: 1, est_tokens: 0 },
  });
});

test('mcp calls tally per server between the __ delimiters', () => {
  const lines = [
    asstLine(tool('mcp__azure-devops__repo_list', 't1')),
    asstLine(tool('mcp__azure-devops__repo_reply', 't2')),
    asstLine(tool('mcp__figma__get_file', 't3')),
  ];
  const r = computeOperations(lines);
  assert.equal(r.mcp.count, 3);
  assert.deepEqual(r.mcp.by_server, {
    'azure-devops': { count: 2, est_tokens: 0 },
    figma: { count: 1, est_tokens: 0 },
  });
});

test('by_server accumulates est_tokens per server and sums to the mcp bucket total', () => {
  const lines = [
    asstLine(tool('mcp__azure-devops__repo_list', 't1')),
    resultLine('t1', 'a'.repeat(400)), // 100 est
    asstLine(tool('mcp__azure-devops__repo_reply', 't2')),
    resultLine('t2', 'b'.repeat(80)), // 20 est
    asstLine(tool('mcp__figma__get_file', 't3')),
    resultLine('t3', 'c'.repeat(40)), // 10 est
    asstLine(tool('mcp__figma__get_comments', 't4')), // no result → 0 est
  ];
  const r = computeOperations(lines);
  assert.deepEqual(r.mcp.by_server, {
    'azure-devops': { count: 2, est_tokens: 120 },
    figma: { count: 2, est_tokens: 10 },
  });
  const subtypeSum = Object.values(r.mcp.by_server).reduce((s, v) => s + v.est_tokens, 0);
  assert.equal(subtypeSum, r.mcp.est_tokens);
});

test('by_skill accumulates est_tokens per skill and sums to the skill bucket total', () => {
  const lines = [
    asstLine(tool('Skill', 't1', { skill: 'superpowers:tdd' })),
    resultLine('t1', 'a'.repeat(400)), // 100 est
    asstLine(tool('Skill', 't2', { skill: 'superpowers:tdd' })),
    resultLine('t2', 'b'.repeat(40)), // 10 est
    asstLine(tool('Skill', 't3', {})), // unknown, no result → 0 est
  ];
  const r = computeOperations(lines);
  assert.deepEqual(r.skill.by_skill, {
    'superpowers:tdd': { count: 2, est_tokens: 110 },
    unknown: { count: 1, est_tokens: 0 },
  });
  const subtypeSum = Object.values(r.skill.by_skill).reduce((s, v) => s + v.est_tokens, 0);
  assert.equal(subtypeSum, r.skill.est_tokens);
});

test('an mcp name with a blank server segment falls back to unknown', () => {
  const r = computeOperations([asstLine(tool('mcp__', 't1')), asstLine(tool('mcp____tool', 't2'))]);
  assert.equal(r.mcp.count, 2);
  assert.deepEqual(r.mcp.by_server, { unknown: { count: 2, est_tokens: 0 } });
});

test('plugins cross-cut groups skills by namespace and MCP as unknown', () => {
  const lines = [
    asstLine(tool('Skill', 't1', { skill: 'superpowers:tdd' })),
    resultLine('t1', 'a'.repeat(400)), // 100 est
    asstLine(tool('Skill', 't2', { skill: 'beezi:track' })),
    resultLine('t2', 'b'.repeat(40)), // 10 est
    asstLine(tool('Skill', 't3', { skill: 'dataviz' })), // namespaceless → builtin
    asstLine(tool('mcp__figma__get', 't4')),
  ];
  const r = computeOperations(lines);
  assert.equal(r.plugins.superpowers.count, 1);
  assert.equal(r.plugins.superpowers.est_tokens, 100);
  assert.equal(r.plugins.beezi.est_tokens, 10);
  assert.equal(r.plugins.builtin.count, 1);
  assert.equal(r.plugins.unknown.count, 1); // the MCP call
});

test('PowerShell + all file tools land in shell/file', () => {
  const lines = [
    asstLine(tool('PowerShell', 't1')),
    asstLine(tool('Write', 't2'), tool('Edit', 't3')),
    asstLine(tool('MultiEdit', 't4')),
    asstLine(tool('NotebookEdit', 't5')),
    asstLine(tool('ToolSearch', 't6')),
    asstLine(tool('WebSearch', 't7')),
  ];
  const r = computeOperations(lines);
  assert.equal(r.shell.count, 1);
  assert.equal(r.file.count, 4);
  assert.equal(r.search.count, 1);
  assert.equal(r.internet.count, 1);
});

test('est_tokens = matched tool_result bytes / 4, rounded', () => {
  const lines = [
    asstLine(tool('Read', 't1')),
    resultLine('t1', 'x'.repeat(400)), // 400 bytes → 100 est tokens
  ];
  const r = computeOperations(lines);
  assert.equal(r.file.count, 1);
  assert.equal(r.file.est_tokens, 100);
});

test('tool_result text-block-array form is summed by bytes', () => {
  const lines = [
    asstLine(tool('Grep', 't1')),
    resultLine('t1', [{ type: 'text', text: 'a'.repeat(40) }, { type: 'text', text: 'b'.repeat(40) }]),
  ];
  const r = computeOperations(lines);
  assert.equal(r.search.est_tokens, 20); // 80 bytes / 4
});

test('multiple calls in one category accumulate count + est_tokens', () => {
  const lines = [
    asstLine(tool('Read', 't1')),
    resultLine('t1', 'y'.repeat(80)),
    asstLine(tool('Read', 't2')),
    resultLine('t2', 'z'.repeat(40)),
  ];
  const r = computeOperations(lines);
  assert.equal(r.file.count, 2);
  assert.equal(r.file.est_tokens, 30); // 20 + 10
});

test('a tool_use with no matching result contributes count but 0 est_tokens', () => {
  const r = computeOperations([asstLine(tool('Bash', 't1'))]);
  assert.equal(r.shell.count, 1);
  assert.equal(r.shell.est_tokens, 0);
});

test('empty input → all six categories zeroed', () => {
  assert.deepEqual(computeOperations([]), emptyTotals());
});
