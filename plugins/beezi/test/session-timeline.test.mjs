import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeSessionTimeline, postSessionTimeline } from '../lib/session-timeline.mjs';

const BASE_MS = Date.parse('2026-07-14T10:00:00.000Z');
const ts = (offsetSec) => new Date(BASE_MS + offsetSec * 1000).toISOString();

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-timeline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJsonl(filePath, lines) {
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
}

// Main transcript: user prompt → work → plan-mode work → tool-result (must NOT read as a prompt) →
// work → long wait for the next prompt → work → >5min idle gap. Plus one subagent transcript.
function setup(t) {
  const dir = makeTmpDir(t);
  const sessionId = 'sess-1';
  const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
  writeJsonl(transcriptPath, [
    { type: 'user', message: { content: 'do X' }, timestamp: ts(0) },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] }, timestamp: ts(10) },
    { type: 'permission-mode', permissionMode: 'plan' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'planning' }] }, timestamp: ts(30) },
    { type: 'permission-mode', permissionMode: 'default' },
    // tool_result echo — type:'user' but carries a tool_result, so it's activity, not a turn-start.
    { type: 'user', toolUseResult: { stdout: '' }, message: { content: [{ type: 'tool_result', content: 'ok' }] }, timestamp: ts(40) },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'more' }] }, timestamp: ts(60) },
    { type: 'user', message: { content: 'next' }, timestamp: ts(600) },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'resume' }] }, timestamp: ts(610) },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'after idle' }] }, timestamp: ts(1000) },
  ]);

  const subagentsDir = path.join(dir, sessionId, 'subagents');
  fs.mkdirSync(subagentsDir, { recursive: true });
  writeJsonl(path.join(subagentsDir, 'agent-abc.jsonl'), [
    { type: 'assistant', timestamp: ts(100) },
    { type: 'assistant', timestamp: ts(200) },
  ]);
  fs.writeFileSync(
    path.join(subagentsDir, 'agent-abc.meta.json'),
    JSON.stringify({ agentType: 'Explore', spawnDepth: 1 }),
    'utf-8',
  );

  return { transcriptPath, sessionId };
}

test('derives merged main-agent state periods from permission-mode, prompts, and idle gaps', (t) => {
  const { transcriptPath, sessionId } = setup(t);
  const tl = computeSessionTimeline(transcriptPath, sessionId);

  assert.ok(tl, 'timeline computed');
  // working[0,10] · planning[10,30] · working[30,60] (tool_result merged in) · waiting[60,600] ·
  // working[600,610] · idle[610,1000]
  assert.equal(tl.periods.length, 6);
  assert.equal(tl.periods[0].state, 'working');

  const planning = tl.periods.find((p) => p.state === 'planning');
  assert.deepEqual([planning.started_at, planning.ended_at], [ts(10), ts(30)]);

  const waits = tl.periods.filter((p) => p.state === 'waiting_user');
  assert.equal(waits.length, 1, 'tool_result did not create a spurious wait');
  assert.deepEqual([waits[0].started_at, waits[0].ended_at], [ts(60), ts(600)]);

  assert.ok(tl.periods.some((p) => p.state === 'idle'), 'the >5min gap is idle');
  assert.equal(tl.started_at, ts(0));
  assert.equal(tl.ended_at, ts(1000));
  assert.equal(typeof tl.generated_at, 'string');
});

test('derives one active span per subagent transcript', (t) => {
  const { transcriptPath, sessionId } = setup(t);
  const tl = computeSessionTimeline(transcriptPath, sessionId);

  assert.equal(tl.subagents.length, 1);
  assert.deepEqual(tl.subagents[0], {
    agent_id: 'agent-abc',
    agent_type: 'Explore',
    started_at: ts(100),
    ended_at: ts(200),
  });
});

test('planning is driven by permissionMode; assistant work inherits it and vim type:mode is ignored', (t) => {
  const dir = makeTmpDir(t);
  const transcriptPath = path.join(dir, 'plan.jsonl');
  writeJsonl(transcriptPath, [
    { type: 'user', message: { content: 'do X' }, permissionMode: 'default', timestamp: ts(0) },
    // vim editor mode — Claude Code writes this as type:'mode':'normal'; it must NOT touch classification.
    { type: 'mode', mode: 'normal' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] }, timestamp: ts(10) },
    // Enter plan mode via the real dedicated change line (no timestamp).
    { type: 'permission-mode', permissionMode: 'plan' },
    // Assistant work lines carry NO permissionMode — they must inherit 'plan' across the whole turn.
    { type: 'assistant', message: { content: [{ type: 'text', text: 'planning a' }] }, timestamp: ts(30) },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'planning b' }] }, timestamp: ts(50) },
    { type: 'permission-mode', permissionMode: 'default' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'building' }] }, timestamp: ts(70) },
  ]);
  const tl = computeSessionTimeline(transcriptPath, 'plan');
  const planning = tl.periods.find((p) => p.state === 'planning');
  // Planning spans the inherited-mode assistant work [10,50], not just a single interval.
  assert.deepEqual([planning.started_at, planning.ended_at], [ts(10), ts(50)]);
  assert.ok(tl.periods.some((p) => p.state === 'working'), 'post-plan work is working');
});

test('a user interrupt (Ctrl+C) counts as aborted work, not waiting_user', (t) => {
  const dir = makeTmpDir(t);
  const transcriptPath = path.join(dir, 'interrupt.jsonl');
  writeJsonl(transcriptPath, [
    { type: 'user', message: { content: 'do X' }, timestamp: ts(0) },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] }, timestamp: ts(10) },
    // Ctrl+C: written as a type:'user' line, but the gap before it is aborted agent work — it must
    // not read as a turn-start (which would mislabel that work as waiting_user).
    { type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] }, timestamp: ts(20) },
    { type: 'user', message: { content: 'next' }, timestamp: ts(600) },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'resume' }] }, timestamp: ts(610) },
  ]);
  const tl = computeSessionTimeline(transcriptPath, 'interrupt');

  // Aborted work [10,20] stays working and merges into [0,20]; it does NOT become waiting_user.
  const working = tl.periods.filter((p) => p.state === 'working');
  assert.deepEqual([working[0].started_at, working[0].ended_at], [ts(0), ts(20)]);

  // The only real wait is AFTER the interrupt, until the next genuine prompt.
  const waits = tl.periods.filter((p) => p.state === 'waiting_user');
  assert.equal(waits.length, 1, 'the interrupt did not create a spurious wait');
  assert.deepEqual([waits[0].started_at, waits[0].ended_at], [ts(20), ts(600)]);
});

test('the "for tool use" interrupt variant is also not a turn-start', (t) => {
  const dir = makeTmpDir(t);
  const transcriptPath = path.join(dir, 'interrupt-tool.jsonl');
  writeJsonl(transcriptPath, [
    { type: 'user', message: { content: 'do X' }, timestamp: ts(0) },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] }, timestamp: ts(10) },
    { type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] }, timestamp: ts(20) },
  ]);
  const tl = computeSessionTimeline(transcriptPath, 'interrupt-tool');
  assert.ok(!tl.periods.some((p) => p.state === 'waiting_user'), 'no wait from the interrupt');
  assert.ok(tl.periods.some((p) => p.state === 'working'), 'aborted work is working');
});

test('emits plan_start (anchored to next timestamp) and plan_ready (at ExitPlanMode)', (t) => {
  const dir = makeTmpDir(t);
  const transcriptPath = path.join(dir, 'events.jsonl');
  writeJsonl(transcriptPath, [
    { type: 'user', message: { content: 'do X' }, timestamp: ts(0) },
    // permission-mode line has no timestamp → plan_start anchors to the next timestamped line (ts 20).
    { type: 'permission-mode', permissionMode: 'plan' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }] }, timestamp: ts(20) },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'p1', name: 'ExitPlanMode', input: {} }] }, timestamp: ts(50) },
    { type: 'permission-mode', permissionMode: 'default' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'building' }] }, timestamp: ts(60) },
  ]);
  const tl = computeSessionTimeline(transcriptPath, 'events');
  assert.deepEqual(tl.plan_events, [
    { type: 'plan_start', at: ts(20) },
    { type: 'plan_ready', at: ts(50) },
  ]);
});

test('emits one plan_start/plan_ready pair per plan cycle, ordered', (t) => {
  const dir = makeTmpDir(t);
  const transcriptPath = path.join(dir, 'cycles.jsonl');
  writeJsonl(transcriptPath, [
    { type: 'permission-mode', permissionMode: 'plan' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'a' }] }, timestamp: ts(10) },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'p1', name: 'ExitPlanMode', input: {} }] }, timestamp: ts(20) },
    { type: 'permission-mode', permissionMode: 'default' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'work' }] }, timestamp: ts(30) },
    { type: 'permission-mode', permissionMode: 'plan' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'b' }] }, timestamp: ts(40) },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'p2', name: 'ExitPlanMode', input: {} }] }, timestamp: ts(50) },
  ]);
  const tl = computeSessionTimeline(transcriptPath, 'cycles');
  assert.deepEqual(tl.plan_events, [
    { type: 'plan_start', at: ts(10) },
    { type: 'plan_ready', at: ts(20) },
    { type: 'plan_start', at: ts(40) },
    { type: 'plan_ready', at: ts(50) },
  ]);
});

test('plan mode with no ExitPlanMode yields a lone plan_start', (t) => {
  const dir = makeTmpDir(t);
  const transcriptPath = path.join(dir, 'cancelled.jsonl');
  writeJsonl(transcriptPath, [
    { type: 'permission-mode', permissionMode: 'plan' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'planning' }] }, timestamp: ts(15) },
    { type: 'permission-mode', permissionMode: 'default' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'abandoned' }] }, timestamp: ts(25) },
  ]);
  const tl = computeSessionTimeline(transcriptPath, 'cancelled');
  assert.deepEqual(tl.plan_events, [{ type: 'plan_start', at: ts(15) }]);
});

test('empty transcript yields null (nothing to place on the axis)', (t) => {
  const dir = makeTmpDir(t);
  const transcriptPath = path.join(dir, 'empty.jsonl');
  fs.writeFileSync(transcriptPath, '', 'utf-8');
  assert.equal(computeSessionTimeline(transcriptPath, 'empty'), null);
});

test('postSessionTimeline guards missing fields and reports 2xx as success', async () => {
  const missing = await postSessionTimeline({ periods: [] }, 'tok');
  assert.deepEqual(missing, { reported: false, reason: 'missing-fields' });

  const noToken = await postSessionTimeline({ sessionId: 's', periods: [] }, null);
  assert.deepEqual(noToken, { reported: false, reason: 'no-token' });

  let capturedUrl = null;
  const fetchImpl = async (url) => { capturedUrl = url; return { status: 200 }; };
  const ok = await postSessionTimeline({ sessionId: 's', periods: [] }, 'tok', { fetchImpl });
  assert.equal(ok.reported, true);
  assert.equal(ok.status, 200);
  assert.ok(capturedUrl.endsWith('/sessions/timeline'));
});
