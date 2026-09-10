import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listSubagentTranscripts,
  buildTaskDescriptionMap,
  createWorkflowNameResolver,
} from '../lib/subagents.mjs';

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-subagents-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Layout: <transcriptDir>/<sessionId>.jsonl  +  <transcriptDir>/<sessionId>/subagents/agent-*.jsonl
function setup(t) {
  const transcriptDir = makeTmpDir(t);
  const sessionId = 'sess-1';
  const transcriptPath = path.join(transcriptDir, `${sessionId}.jsonl`);
  fs.writeFileSync(transcriptPath, '', 'utf-8');
  const subagentsDir = path.join(transcriptDir, sessionId, 'subagents');
  fs.mkdirSync(subagentsDir, { recursive: true });
  return { transcriptPath, sessionId, subagentsDir };
}

test('returns agentType and spawnDepth from the sibling meta.json', (t) => {
  const { transcriptPath, sessionId, subagentsDir } = setup(t);
  fs.writeFileSync(path.join(subagentsDir, 'agent-abc.jsonl'), '', 'utf-8');
  fs.writeFileSync(
    path.join(subagentsDir, 'agent-abc.meta.json'),
    JSON.stringify({ agentType: 'Explore', spawnDepth: 2, toolUseId: 'toolu_1' }),
    'utf-8',
  );

  const [entry] = listSubagentTranscripts(transcriptPath, sessionId);
  assert.equal(entry.agentId, 'agent-abc');
  assert.equal(entry.agentType, 'Explore');
  assert.equal(entry.spawnDepth, 2);
  assert.equal(entry.toolUseId, 'toolu_1', 'toolUseId carried for name resolution');
});

test('missing or malformed meta.json yields null identity, transcript still listed', (t) => {
  const { transcriptPath, sessionId, subagentsDir } = setup(t);
  fs.writeFileSync(path.join(subagentsDir, 'agent-nometa.jsonl'), '', 'utf-8');
  fs.writeFileSync(path.join(subagentsDir, 'agent-bad.jsonl'), '', 'utf-8');
  fs.writeFileSync(path.join(subagentsDir, 'agent-bad.meta.json'), '{not json', 'utf-8');

  const entries = listSubagentTranscripts(transcriptPath, sessionId);
  assert.equal(entries.length, 2, 'both transcripts listed regardless of meta');
  for (const e of entries) {
    assert.equal(e.agentType, null);
    assert.equal(e.spawnDepth, null);
    assert.ok(e.path.endsWith('.jsonl'));
  }
});

test('no subagents dir → empty list', (t) => {
  const transcriptDir = makeTmpDir(t);
  const transcriptPath = path.join(transcriptDir, 'sess-x.jsonl');
  fs.writeFileSync(transcriptPath, '', 'utf-8');
  assert.deepEqual(listSubagentTranscripts(transcriptPath, 'sess-x'), []);
});

test('buildTaskDescriptionMap — maps Task tool_use id → trimmed description', (t) => {
  const dir = makeTmpDir(t);
  const p = path.join(dir, 'main.jsonl');
  const lines = [
    { type: 'user', message: { content: 'hi' } },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'launching' },
          { type: 'tool_use', name: 'Task', id: 'toolu_1', input: { description: '  Explore analytics plugin  ', subagent_type: 'Explore' } },
          { type: 'tool_use', name: 'Read', id: 'toolu_2', input: { file_path: '/x' } },
        ],
      },
    },
  ];
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf-8');

  const map = buildTaskDescriptionMap(p);
  assert.equal(map.get('toolu_1'), 'Explore analytics plugin', 'Task description trimmed + mapped by id');
  assert.equal(map.has('toolu_2'), false, 'non-Task tool_use ignored');
});

test('buildTaskDescriptionMap — unreadable/empty transcript yields empty map', (t) => {
  const dir = makeTmpDir(t);
  assert.equal(buildTaskDescriptionMap(path.join(dir, 'missing.jsonl')).size, 0);
});

// ---------------------------------------------------------------------------
// Workflow-tool subagents shard by run id one level deeper than Task subagents:
// <sessionId>/subagents/workflows/<wf_id>/agent-<id>.jsonl. The flat scan skipped
// them entirely, losing every token they spent.
// ---------------------------------------------------------------------------

function writeWorkflowAgent(subagentsDir, wfId, agentId, { meta, lines = "" } = {}) {
  const dir = path.join(subagentsDir, "workflows", wfId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${agentId}.jsonl`), lines, "utf-8");
  if (meta) fs.writeFileSync(path.join(dir, `${agentId}.meta.json`), JSON.stringify(meta), "utf-8");
  return dir;
}

// Every workflow run drops a journal.jsonl beside its agents. It is not an agent, and a
// filter that only checks the extension mints a phantom one called "journal".
test("W1. journal.jsonl in a workflow dir is not listed as an agent", (t) => {
  const { transcriptPath, sessionId, subagentsDir } = setup(t);
  const dir = writeWorkflowAgent(subagentsDir, "wf_abc123", "agent-w1", {
    meta: { agentType: "workflow-subagent", spawnDepth: 1 },
  });
  fs.writeFileSync(path.join(dir, "journal.jsonl"), '{"type":"started"}', "utf-8");

  const entries = listSubagentTranscripts(transcriptPath, sessionId);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].agentId, "agent-w1");
});

test("W2. nested and flat agents merge, sorted, with bare ids", (t) => {
  const { transcriptPath, sessionId, subagentsDir } = setup(t);
  fs.writeFileSync(path.join(subagentsDir, "agent-flat.jsonl"), "", "utf-8");
  writeWorkflowAgent(subagentsDir, "wf_one", "agent-aaa");
  writeWorkflowAgent(subagentsDir, "wf_two", "agent-zzz");

  const entries = listSubagentTranscripts(transcriptPath, sessionId);
  assert.deepEqual(entries.map((e) => e.agentId), ["agent-aaa", "agent-flat", "agent-zzz"]);
  // The id stays bare so agentCursors keys, the segment scope and the queue filename all hold.
  assert.ok(entries[0].path.endsWith(path.join("workflows", "wf_one", "agent-aaa.jsonl")));
  assert.ok(entries[1].path.endsWith(path.join("subagents", "agent-flat.jsonl")));
});

test("W3. nested meta is read from the deeper directory", (t) => {
  const { transcriptPath, sessionId, subagentsDir } = setup(t);
  writeWorkflowAgent(subagentsDir, "wf_abc123", "agent-w1", {
    meta: { agentType: "workflow-subagent", spawnDepth: 1 },
  });

  const [entry] = listSubagentTranscripts(transcriptPath, sessionId);
  assert.equal(entry.agentType, "workflow-subagent");
  assert.equal(entry.spawnDepth, 1);
  // Real workflow metas carry no toolUseId at all, so name resolution cannot go via Task.
  assert.equal(entry.toolUseId, null);
});

test("W4. workflowId is set for nested agents and null for flat ones", (t) => {
  const { transcriptPath, sessionId, subagentsDir } = setup(t);
  fs.writeFileSync(path.join(subagentsDir, "agent-flat.jsonl"), "", "utf-8");
  writeWorkflowAgent(subagentsDir, "wf_abc123", "agent-nested");

  const byId = Object.fromEntries(
    listSubagentTranscripts(transcriptPath, sessionId).map((e) => [e.agentId, e.workflowId]),
  );
  assert.equal(byId["agent-nested"], "wf_abc123");
  assert.equal(byId["agent-flat"], null);
});

test("W5. a session with no workflows dir is unaffected", (t) => {
  const { transcriptPath, sessionId, subagentsDir } = setup(t);
  fs.writeFileSync(path.join(subagentsDir, "agent-flat.jsonl"), "", "utf-8");

  const entries = listSubagentTranscripts(transcriptPath, sessionId);
  assert.deepEqual(entries.map((e) => e.agentId), ["agent-flat"]);
});

test("W6. an unreadable workflows entry does not lose the flat agents", (t) => {
  const { transcriptPath, sessionId, subagentsDir } = setup(t);
  fs.writeFileSync(path.join(subagentsDir, "agent-flat.jsonl"), "", "utf-8");
  // A file where a directory is expected.
  fs.writeFileSync(path.join(subagentsDir, "workflows"), "not a dir", "utf-8");

  const entries = listSubagentTranscripts(transcriptPath, sessionId);
  assert.deepEqual(entries.map((e) => e.agentId), ["agent-flat"]);
});

// A workflow agent's meta carries no toolUseId, and its id never appears in the main transcript,
// so the Task-description map resolves none of them. The run's own state file is the name source.
function writeWorkflowState(transcriptPath, sessionId, wfId, state) {
  const dir = path.join(path.dirname(transcriptPath), sessionId, 'workflows');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${wfId}.json`), JSON.stringify(state), 'utf-8');
}

const STATE = {
  workflowName: 'code-review',
  workflowProgress: [
    { type: 'workflow_phase', index: 1, title: 'Verify' },
    { type: 'workflow_agent', agentId: 'w1', label: 'verify:UserRow.tsx(1)', phaseTitle: 'Verify' },
  ],
};

test('W7. resolves workflowName:label, stripping the agent- prefix off the join key', (t) => {
  const { transcriptPath, sessionId } = setup(t);
  writeWorkflowState(transcriptPath, sessionId, 'wf_abc123', STATE);

  const resolve = createWorkflowNameResolver(transcriptPath, sessionId);
  // The filename carries agent-w1; workflowProgress records the id bare, as w1.
  assert.equal(resolve('wf_abc123', 'agent-w1'), 'code-review:verify:UserRow.tsx(1)');
});

test('W8. falls back to the workflow name when the agent is not in the progress list', (t) => {
  const { transcriptPath, sessionId } = setup(t);
  writeWorkflowState(transcriptPath, sessionId, 'wf_abc123', STATE);

  const resolve = createWorkflowNameResolver(transcriptPath, sessionId);
  assert.equal(resolve('wf_abc123', 'agent-never-ran'), 'code-review');
});

test('W9. falls back to the workflow name when the label is blank or not a string', (t) => {
  const { transcriptPath, sessionId } = setup(t);
  writeWorkflowState(transcriptPath, sessionId, 'wf_abc123', {
    workflowName: 'code-review',
    workflowProgress: [
      { type: 'workflow_agent', agentId: 'w1', label: '   ' },
      { type: 'workflow_agent', agentId: 'w2', label: 42 },
    ],
  });

  const resolve = createWorkflowNameResolver(transcriptPath, sessionId);
  assert.equal(resolve('wf_abc123', 'agent-w1'), 'code-review');
  assert.equal(resolve('wf_abc123', 'agent-w2'), 'code-review');
});

test('W10. returns null for a missing or corrupt state file, and for a flat agent', (t) => {
  const { transcriptPath, sessionId } = setup(t);
  const dir = path.join(path.dirname(transcriptPath), sessionId, 'workflows');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'wf_broken.json'), '{ not json', 'utf-8');

  const resolve = createWorkflowNameResolver(transcriptPath, sessionId);
  assert.equal(resolve('wf_missing', 'agent-w1'), null);
  assert.equal(resolve('wf_broken', 'agent-w1'), null);
  assert.equal(resolve(null, 'agent-flat'), null, 'a flat agent must not trigger a read');
});

test('W11. reads each workflow state file at most once', (t) => {
  const { transcriptPath, sessionId } = setup(t);
  writeWorkflowState(transcriptPath, sessionId, 'wf_abc123', STATE);

  const resolve = createWorkflowNameResolver(transcriptPath, sessionId);
  assert.equal(resolve('wf_abc123', 'agent-w1'), 'code-review:verify:UserRow.tsx(1)');
  fs.rmSync(path.join(path.dirname(transcriptPath), sessionId, 'workflows'), { recursive: true });
  // Memoized: the answer survives the file going away mid-checkpoint.
  assert.equal(resolve('wf_abc123', 'agent-w1'), 'code-review:verify:UserRow.tsx(1)');
});
