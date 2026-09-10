import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeSessionTimeline, postSessionTimeline, BREAK_GAP_SEC } from '../lib/session-timeline.mjs';

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

// Workflow-tool agents shard under subagents/workflows/<wf_id>/. They get a span like any other
// subagent, and their wall clock is real session activity, so the axis has to reach it.
test('derives a span for a workflow subagent and widens the axis to cover it', (t) => {
  const { transcriptPath, sessionId } = setup(t);
  const wfDir = path.join(path.dirname(transcriptPath), sessionId, 'subagents', 'workflows', 'wf_abc123');
  fs.mkdirSync(wfDir, { recursive: true });
  writeJsonl(path.join(wfDir, 'agent-w1.jsonl'), [
    { type: 'assistant', timestamp: ts(1200) },
    { type: 'assistant', timestamp: ts(1400) },
  ]);
  fs.writeFileSync(
    path.join(wfDir, 'agent-w1.meta.json'),
    JSON.stringify({ agentType: 'workflow-subagent', spawnDepth: 1 }),
    'utf-8',
  );
  // The run's journal must not become a span of its own.
  writeJsonl(path.join(wfDir, 'journal.jsonl'), [{ type: 'started', agentId: 'w1' }]);

  const tl = computeSessionTimeline(transcriptPath, sessionId);

  assert.equal(tl.subagents.length, 2);
  const wf = tl.subagents.find((a) => a.agent_id === 'agent-w1');
  assert.deepEqual(wf, {
    agent_id: 'agent-w1',
    agent_type: 'workflow-subagent',
    started_at: ts(1200),
    ended_at: ts(1400),
  });
  assert.equal(tl.ended_at, ts(1400), 'axis reaches the workflow agent, which ran past the main thread');
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
    { type: 'user', message: { content: 'do X' }, timestamp: ts(0) },
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
    { type: 'user', message: { content: 'do X' }, timestamp: ts(0) },
    { type: 'permission-mode', permissionMode: 'plan' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'planning' }] }, timestamp: ts(15) },
    { type: 'permission-mode', permissionMode: 'default' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'abandoned' }] }, timestamp: ts(25) },
  ]);
  const tl = computeSessionTimeline(transcriptPath, 'cancelled');
  assert.deepEqual(tl.plan_events, [{ type: 'plan_start', at: ts(15) }]);
});

// --- Skill-based planning (plan/spec/brainstorm skill → last plan-.md write) ---

const skillLine = (skillName, tSec) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id: `s${tSec}`, name: 'Skill', input: { skill: skillName } }] },
  timestamp: ts(tSec),
});
const writeLine = (filePath, tSec) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id: `w${tSec}`, name: 'Write', input: { file_path: filePath, content: 'x' } }] },
  timestamp: ts(tSec),
});
const prompt = (tSec) => ({ type: 'user', message: { content: 'do X' }, timestamp: ts(tSec) });

function timelineOf(t, name, lines) {
  const dir = makeTmpDir(t);
  const transcriptPath = path.join(dir, `${name}.jsonl`);
  writeJsonl(transcriptPath, lines);
  return computeSessionTimeline(transcriptPath, name);
}

test('a planning skill plus a plan .md write emits plan_start/plan_ready', (t) => {
  const tl = timelineOf(t, 'skill-plan', [
    prompt(0),
    skillLine('superpowers:brainstorming', 10),
    writeLine('/r/docs/design.md', 30),
    writeLine('/r/docs/design.md', 50),
    // Implementation starts — the cycle closes at the LAST plan write before it...
    writeLine('/r/src/app.js', 70),
    // ...and a plan edit after the close (checkbox ticking) is ignored.
    writeLine('/r/docs/design.md', 90),
  ]);
  assert.deepEqual(tl.plan_events, [
    { type: 'plan_start', at: ts(10) },
    { type: 'plan_ready', at: ts(50) },
  ]);
});

test('a plan .md write with no preceding planning skill is ignored', (t) => {
  const tl = timelineOf(t, 'no-entry', [
    prompt(0),
    writeLine('/r/docs/design.md', 30),
    writeLine('/r/src/app.js', 60),
  ]);
  assert.deepEqual(tl.plan_events, []);
});

test('only .md files end a cycle — other extensions never trigger', (t) => {
  const tl = timelineOf(t, 'not-md', [
    prompt(0),
    skillLine('superpowers:brainstorming', 10),
    writeLine('/r/design.txt', 20),
    writeLine('/r/plan.mdx', 30),
    writeLine('/r/spec.json', 40),
    writeLine('/r/src/app.js', 50),
  ]);
  assert.deepEqual(tl.plan_events, [{ type: 'plan_start', at: ts(10) }]);
  assert.ok(!tl.periods.some((p) => p.state === 'planning'), 'a lone plan_start paints no band');
});

test('executing-plans is not an entry point', (t) => {
  const tl = timelineOf(t, 'executing', [
    prompt(0),
    skillLine('superpowers:executing-plans', 10),
    writeLine('/r/docs/plan-v2.md', 30),
    writeLine('/r/src/app.js', 50),
  ]);
  assert.deepEqual(tl.plan_events, []);
});

test('an execution skill closes an open cycle', (t) => {
  const tl = timelineOf(t, 'exec-close', [
    prompt(0),
    skillLine('superpowers:writing-plans', 10),
    writeLine('/r/docs/design.md', 20),
    // Execution begins even though its code edits may live in subagent transcripts.
    skillLine('superpowers:executing-plans', 30),
    writeLine('/r/docs/design.md', 40),
  ]);
  assert.deepEqual(tl.plan_events, [
    { type: 'plan_start', at: ts(10) },
    { type: 'plan_ready', at: ts(20) },
  ]);
});

test('built-in and skill plan cycles coexist in one session, ordered', (t) => {
  const tl = timelineOf(t, 'coexist', [
    prompt(0),
    { type: 'permission-mode', permissionMode: 'plan' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'a' }] }, timestamp: ts(10) },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'p1', name: 'ExitPlanMode', input: {} }] }, timestamp: ts(20) },
    { type: 'permission-mode', permissionMode: 'default' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'b' }] }, timestamp: ts(30) },
    skillLine('superpowers:writing-plans', 40),
    writeLine('/r/docs/plan.md', 60),
    writeLine('/r/src/app.js', 80),
  ]);
  assert.deepEqual(tl.plan_events, [
    { type: 'plan_start', at: ts(10) },
    { type: 'plan_ready', at: ts(20) },
    { type: 'plan_start', at: ts(40) },
    { type: 'plan_ready', at: ts(60) },
  ]);
});

test('a planning skill invoked inside built-in plan mode does not double-emit', (t) => {
  const tl = timelineOf(t, 'suppressed', [
    prompt(0),
    { type: 'permission-mode', permissionMode: 'plan' },
    // The skill line is the next timestamped line, so the built-in plan_start anchors to it —
    // exactly the collision that suppression exists for.
    skillLine('superpowers:writing-plans', 20),
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'p1', name: 'ExitPlanMode', input: {} }] }, timestamp: ts(40) },
  ]);
  assert.deepEqual(tl.plan_events, [
    { type: 'plan_start', at: ts(20) },
    { type: 'plan_ready', at: ts(40) },
  ]);
});

test('built-in plan mode starting closes an open skill cycle', (t) => {
  const tl = timelineOf(t, 'builtin-closes', [
    prompt(0),
    skillLine('superpowers:brainstorming', 10),
    writeLine('/r/docs/design.md', 20),
    { type: 'permission-mode', permissionMode: 'plan' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'a' }] }, timestamp: ts(30) },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'p1', name: 'ExitPlanMode', input: {} }] }, timestamp: ts(40) },
  ]);
  assert.deepEqual(tl.plan_events, [
    { type: 'plan_start', at: ts(10) },
    { type: 'plan_ready', at: ts(20) },
    { type: 'plan_start', at: ts(30) },
    { type: 'plan_ready', at: ts(40) },
  ]);
});

test('a planning skill with no plan document yields a lone plan_start and no band', (t) => {
  const tl = timelineOf(t, 'lone', [
    prompt(0),
    skillLine('superpowers:brainstorming', 10),
    { type: 'assistant', message: { content: [{ type: 'text', text: 'a' }] }, timestamp: ts(30) },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'b' }] }, timestamp: ts(60) },
  ]);
  assert.deepEqual(tl.plan_events, [{ type: 'plan_start', at: ts(10) }]);
  assert.ok(!tl.periods.some((p) => p.state === 'planning'));
});

test('two skill-plan cycles emit one ordered pair each', (t) => {
  const tl = timelineOf(t, 'two-cycles', [
    prompt(0),
    skillLine('superpowers:brainstorming', 10),
    writeLine('/r/docs/x-design.md', 20),
    writeLine('/r/src/app.js', 30),
    skillLine('superpowers:writing-plans', 40),
    writeLine('/r/docs/x-plan.md', 50),
    writeLine('/r/src/app.js', 60),
  ]);
  assert.deepEqual(tl.plan_events, [
    { type: 'plan_start', at: ts(10) },
    { type: 'plan_ready', at: ts(20) },
    { type: 'plan_start', at: ts(40) },
    { type: 'plan_ready', at: ts(50) },
  ]);
});

test('multiple plan documents in one cycle — plan_ready is the last write across any of them', (t) => {
  const tl = timelineOf(t, 'multi-doc', [
    prompt(0),
    skillLine('superpowers:brainstorming', 10),
    writeLine('/r/docs/design.md', 20),
    writeLine('/r/docs/plan.md', 40),
    writeLine('/r/src/app.js', 60),
  ]);
  assert.deepEqual(tl.plan_events, [
    { type: 'plan_start', at: ts(10) },
    { type: 'plan_ready', at: ts(40) },
  ]);
});

test('a date-slug file directly in an exact plans/ folder matches', (t) => {
  const tl = timelineOf(t, 'plans-folder', [
    prompt(0),
    skillLine('superpowers:writing-plans', 10),
    // writing-plans output: no keyword in the basename, folder named exactly 'plans'.
    writeLine('/r/docs/superpowers/plans/2026-08-17-fast-connect.md', 30),
    writeLine('/r/src/app.js', 50),
  ]);
  assert.deepEqual(tl.plan_events, [
    { type: 'plan_start', at: ts(10) },
    { type: 'plan_ready', at: ts(30) },
  ]);
});

test('a keyword-substring folder name does not match — exact folder names only', (t) => {
  const tl = timelineOf(t, 'sdd-dir', [
    prompt(0),
    skillLine('superpowers:writing-plans', 10),
    writeLine('/r/docs/superpowers/plans/x.md', 20),
    // sdd execution artifact: folder CONTAINS 'design' but is not exactly a plan folder — it is
    // an "other" edit, so it must not extend the cycle, and must CLOSE it instead.
    writeLine('/r/.superpowers/sdd/2026-08-17-fast-connect-design/progress.md', 40),
    writeLine('/r/.superpowers/sdd/2026-08-17-fast-connect-design/task-1-report.md', 60),
  ]);
  assert.deepEqual(tl.plan_events, [
    { type: 'plan_start', at: ts(10) },
    { type: 'plan_ready', at: ts(20) },
  ]);
});

test('a .claude housekeeping write is neutral — neither plan doc nor cycle close', (t) => {
  const tl = timelineOf(t, 'housekeeping', [
    prompt(0),
    skillLine('superpowers:brainstorming', 10),
    writeLine('/r/docs/specs/api-design.md', 20),
    // Memory save mid-brainstorm — must not close the cycle (a real session lost 15 minutes of
    // design authoring to exactly this write).
    writeLine('C:\\Users\\x\\.claude\\projects\\p\\memory\\MEMORY.md', 30),
    writeLine('/r/docs/specs/api-design.md', 50),
    writeLine('/r/src/app.js', 70),
  ]);
  assert.deepEqual(tl.plan_events, [
    { type: 'plan_start', at: ts(10) },
    { type: 'plan_ready', at: ts(50) },
  ]);
});

test('the skill-plan window paints a planning band; work after the close is working', (t) => {
  const tl = timelineOf(t, 'band', [
    prompt(0),
    skillLine('superpowers:brainstorming', 10),
    { type: 'assistant', message: { content: [{ type: 'text', text: 'a' }] }, timestamp: ts(30) },
    writeLine('/r/docs/design.md', 50),
    writeLine('/r/src/app.js', 70),
  ]);
  const planning = tl.periods.find((p) => p.state === 'planning');
  // The lead-up anchor at ts(10) already sits inside the [10,50] interval, so the band opens at
  // the prompt — matching how built-in plan mode dates the interval ENDING at a plan anchor.
  assert.deepEqual([planning.started_at, planning.ended_at], [ts(0), ts(50)]);
  const working = tl.periods.find((p) => p.state === 'working');
  assert.deepEqual([working.started_at, working.ended_at], [ts(50), ts(70)]);
});

test('a real user prompt inside a skill-plan window still reads waiting_user', (t) => {
  const tl = timelineOf(t, 'precedence', [
    prompt(0),
    skillLine('superpowers:brainstorming', 10),
    { type: 'assistant', message: { content: [{ type: 'text', text: 'a' }] }, timestamp: ts(30) },
    prompt(60),
    writeLine('/r/docs/design.md', 90),
    writeLine('/r/src/app.js', 120),
  ]);
  const waits = tl.periods.filter((p) => p.state === 'waiting_user');
  assert.equal(waits.length, 1);
  assert.deepEqual([waits[0].started_at, waits[0].ended_at], [ts(30), ts(60)]);
  assert.ok(tl.periods.some((p) => p.state === 'planning'));
});

test('Windows backslash paths are matched by basename', (t) => {
  const tl = timelineOf(t, 'backslash', [
    prompt(0),
    skillLine('superpowers:brainstorming', 10),
    // Both match: notes.md sits directly in an exact 'plans' folder, api-design.md by basename;
    // plan_ready is the LAST of them, and neither reads as an implementation edit.
    writeLine('C:\\repo\\docs\\plans\\notes.md', 20),
    writeLine('C:\\repo\\docs\\plans\\api-design.md', 40),
    writeLine('C:\\repo\\src\\a.js', 60),
  ]);
  assert.deepEqual(tl.plan_events, [
    { type: 'plan_start', at: ts(10) },
    { type: 'plan_ready', at: ts(40) },
  ]);
});

test('skill ids and filenames match case-insensitively', (t) => {
  const tl = timelineOf(t, 'case', [
    prompt(0),
    skillLine('Superpowers:Brainstorming', 10),
    writeLine('/r/DESIGN.MD', 30),
    writeLine('/r/src/app.js', 50),
  ]);
  assert.deepEqual(tl.plan_events, [
    { type: 'plan_start', at: ts(10) },
    { type: 'plan_ready', at: ts(30) },
  ]);
});

test('a non-planning skill is not an entry point — design is a document keyword only', (t) => {
  const tl = timelineOf(t, 'non-plan-skill', [
    prompt(0),
    skillLine('frontend-design:frontend-design', 10),
    writeLine('/r/docs/design.md', 30),
  ]);
  assert.deepEqual(tl.plan_events, []);
});

test('the pre-prompt lead-in is dropped — the session starts when the human first speaks', (t) => {
  const dir = makeTmpDir(t);
  const transcriptPath = path.join(dir, 'clear.jsonl');
  writeJsonl(transcriptPath, [
    // /clear opens a fresh transcript and the SessionStart hook attachments land at once...
    { type: 'attachment', attachment: { type: 'hook_success' }, timestamp: ts(0) },
    { type: 'attachment', attachment: { type: 'hook_additional_context' }, timestamp: ts(2) },
    // ...then the terminal sits untouched for ten minutes before the human types.
    { type: 'user', message: { content: 'do X' }, timestamp: ts(600) },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] }, timestamp: ts(610) },
  ]);
  const tl = computeSessionTimeline(transcriptPath, 'clear');

  assert.equal(tl.started_at, ts(600), 'the axis starts at the prompt, not at the clear');
  assert.deepEqual(tl.periods, [{ state: 'working', started_at: ts(600), ended_at: ts(610) }]);
});

test('a transcript with no user prompt yields null (cleared, then abandoned)', (t) => {
  const dir = makeTmpDir(t);
  const transcriptPath = path.join(dir, 'abandoned.jsonl');
  writeJsonl(transcriptPath, [
    { type: 'attachment', attachment: { type: 'hook_success' }, timestamp: ts(0) },
    { type: 'attachment', attachment: { type: 'hook_additional_context' }, timestamp: ts(2) },
  ]);
  assert.equal(computeSessionTimeline(transcriptPath, 'abandoned'), null);
});

test('waiting on a subagent is idle, not waiting_user, at any duration', (t) => {
  const dir = makeTmpDir(t);
  const transcriptPath = path.join(dir, 'subagent-wait.jsonl');
  writeJsonl(transcriptPath, [
    { type: 'user', message: { content: 'do X' }, timestamp: ts(0) },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a1', name: 'Agent', input: {} }] }, timestamp: ts(10) },
    // A background subagent hands its tool_result back at once — this is not where the agent waits.
    { type: 'user', toolUseResult: {}, message: { content: [{ type: 'tool_result', content: 'started' }] }, timestamp: ts(11) },
    // 100s of main-thread silence, broken by the subagent's completion notification. Under the 300s
    // idle threshold, so only the notification itself can classify this as idle.
    { type: 'user', message: { content: '<task-notification>\n<task-id>x</task-id>\n' }, timestamp: ts(111) },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'read the report' }] }, timestamp: ts(120) },
  ]);
  const tl = computeSessionTimeline(transcriptPath, 'subagent-wait');

  assert.ok(!tl.periods.some((p) => p.state === 'waiting_user'), 'a subagent is not a human');
  const idle = tl.periods.filter((p) => p.state === 'idle');
  assert.equal(idle.length, 1);
  assert.deepEqual([idle[0].started_at, idle[0].ended_at], [ts(11), ts(111)]);
});

test('a block-shaped task notification is recognised too', (t) => {
  const dir = makeTmpDir(t);
  const transcriptPath = path.join(dir, 'notif-blocks.jsonl');
  writeJsonl(transcriptPath, [
    { type: 'user', message: { content: 'do X' }, timestamp: ts(0) },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'spawning' }] }, timestamp: ts(10) },
    { type: 'user', message: { content: [{ type: 'text', text: '<task-notification>\n<task-id>x</task-id>' }] }, timestamp: ts(60) },
  ]);
  const tl = computeSessionTimeline(transcriptPath, 'notif-blocks');
  assert.ok(!tl.periods.some((p) => p.state === 'waiting_user'));
  assert.ok(tl.periods.some((p) => p.state === 'idle'));
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

// ─── the tail Claude Code writes after the human walks away ──────────────────
//
// away_summary recaps, queue operations and resume attachments are stamped long after the last
// real turn. Anchoring on them ended the session inside its own idle tail — a session whose last
// visible band was a 49-minute idle block, and on --resume a band spanning the night.

test('a trailing away_summary neither anchors a period nor extends the axis', (t) => {
  const dir = makeTmpDir(t);
  const transcriptPath = path.join(dir, 'away.jsonl');
  writeJsonl(transcriptPath, [
    { type: 'user', message: { content: 'do X' }, timestamp: ts(0) },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] }, timestamp: ts(30) },
    { type: 'system', subtype: 'turn_duration', durationMs: 30000, timestamp: ts(31) },
    // The recap — written 49 minutes after the human stopped.
    { type: 'system', subtype: 'away_summary', content: 'recap', timestamp: ts(2971) },
  ]);

  const tl = computeSessionTimeline(transcriptPath, 'sess-away');
  assert.ok(tl);
  assert.equal(tl.ended_at, ts(31), 'axis ends at the last real turn');
  assert.ok(!tl.periods.some((p) => p.state === 'idle'), 'no idle band for the recap tail');
  assert.equal(tl.periods[tl.periods.length - 1].ended_at, ts(31));
});

test('resume attachments and queue operations do not anchor the axis', (t) => {
  const dir = makeTmpDir(t);
  const transcriptPath = path.join(dir, 'resume.jsonl');
  writeJsonl(transcriptPath, [
    { type: 'user', message: { content: 'do X' }, timestamp: ts(0) },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] }, timestamp: ts(30) },
    // ~19h later the session is resumed; Claude Code replays hook/attachment bookkeeping.
    { type: 'attachment', attachment: { type: 'date_change', newDate: '2026-07-15' }, timestamp: ts(68400) },
    { type: 'queue-operation', operation: 'remove', timestamp: ts(68401) },
    { type: 'attachment', attachment: { type: 'edited_text_file' }, timestamp: ts(68402) },
  ]);

  const tl = computeSessionTimeline(transcriptPath, 'sess-resume');
  assert.ok(tl);
  assert.equal(tl.ended_at, ts(30), 'the overnight resume tail is not session time');
  assert.equal(tl.periods.length, 1);
  assert.equal(tl.periods[0].state, 'working');
});

test('an idle gap that ends at real work keeps its band', (t) => {
  const dir = makeTmpDir(t);
  const transcriptPath = path.join(dir, 'idle-then-work.jsonl');
  writeJsonl(transcriptPath, [
    { type: 'user', message: { content: 'do X' }, timestamp: ts(0) },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] }, timestamp: ts(10) },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'after idle' }] }, timestamp: ts(1000) },
  ]);

  const tl = computeSessionTimeline(transcriptPath, 'sess-idle');
  assert.deepEqual(tl.periods.map((p) => p.state), ['working', 'idle']);
  assert.equal(tl.ended_at, ts(1000));
});

// ─── teardown vs real work on the timeline ───────────────────────────────────

const TEARDOWN_TEXT =
  'Tool permission request failed: AbortError: Tool permission stream closed before response received';

test('the permission stream-closed result does not become a trailing idle band', (t) => {
  const dir = makeTmpDir(t);
  const transcriptPath = path.join(dir, 'teardown.jsonl');
  writeJsonl(transcriptPath, [
    { type: 'user', message: { content: 'do X' }, timestamp: ts(0) },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] }, timestamp: ts(30) },
    // Reopened the next day: the pending permission request is torn down.
    {
      type: 'user',
      toolUseResult: { stdout: '' },
      message: { content: [{ type: 'tool_result', content: TEARDOWN_TEXT, is_error: true }] },
      timestamp: ts(66728),
    },
  ]);

  const tl = computeSessionTimeline(transcriptPath, 'sess-teardown');
  assert.equal(tl.ended_at, ts(30), 'axis stops at the last real turn');
  assert.deepEqual(tl.periods.map((p) => p.state), ['working'], 'no 18.5h idle band');
});

test('a real tool_result after a long gap still closes the session normally', (t) => {
  const dir = makeTmpDir(t);
  const transcriptPath = path.join(dir, 'real-result.jsonl');
  writeJsonl(transcriptPath, [
    { type: 'user', message: { content: 'run the build' }, timestamp: ts(0) },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'building' }] }, timestamp: ts(30) },
    // A build that genuinely ran for 5 minutes and failed — real session time.
    {
      type: 'user',
      toolUseResult: { stdout: '' },
      message: { content: [{ type: 'tool_result', content: 'Exit code 143\nCommand timed out after 5m 0s', is_error: true }] },
      timestamp: ts(330),
    },
  ]);

  const tl = computeSessionTimeline(transcriptPath, 'sess-real');
  assert.equal(tl.ended_at, ts(330), 'the build really did run until then');
  assert.ok(tl.periods.some((p) => p.state === 'idle'), 'the >5min tool wait is still an idle band');
});

test('a session ending on a real user prompt stays waiting_user, not trimmed', (t) => {
  const dir = makeTmpDir(t);
  const transcriptPath = path.join(dir, 'ends-on-prompt.jsonl');
  // Modelled on d60c5cbf: the human types something after 50min and the session ends there.
  writeJsonl(transcriptPath, [
    { type: 'user', message: { content: 'do X' }, timestamp: ts(0) },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] }, timestamp: ts(30) },
    { type: 'user', message: { content: '.сдуфк' }, timestamp: ts(3030) },
  ]);

  const tl = computeSessionTimeline(transcriptPath, 'sess-prompt');
  assert.equal(tl.ended_at, ts(3030), 'the human was there — that is the session end');
  assert.equal(tl.periods[tl.periods.length - 1].state, 'waiting_user');
});

// ─── break: abandoned and resumed, rather than waited on ─────────────────────

test('a gap past the break threshold is charted as break, not waiting_user', (t) => {
  const dir = makeTmpDir(t);
  const transcriptPath = path.join(dir, 'break.jsonl');
  // Modelled on fcebb7fd: work stops, the human returns 29h later and types.
  writeJsonl(transcriptPath, [
    { type: 'user', message: { content: 'do X' }, timestamp: ts(0) },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] }, timestamp: ts(30) },
    { type: 'user', message: { content: 'next day' }, timestamp: ts(30 + 29 * 3600) },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'sure' }] }, timestamp: ts(60 + 29 * 3600) },
  ]);

  const tl = computeSessionTimeline(transcriptPath, 'sess-break');
  assert.deepEqual(tl.periods.map((p) => p.state), ['working', 'break', 'working']);
  const brk = tl.periods[1];
  assert.deepEqual([brk.started_at, brk.ended_at], [ts(30), ts(30 + 29 * 3600)]);
  // Nothing is deleted — the axis still describes real wall clock.
  assert.equal(tl.started_at, ts(0));
  assert.equal(tl.ended_at, ts(60 + 29 * 3600));
});

test('a long pause that crosses midnight but is short stays waiting_user', (t) => {
  const dir = makeTmpDir(t);
  const transcriptPath = path.join(dir, 'midnight.jsonl');
  // 23:50 -> 00:20. A date boundary is crossed, but it is 30 minutes of stepping away.
  const base = Date.parse('2026-07-14T23:45:00.000Z');
  const at = (sec) => new Date(base + sec * 1000).toISOString();
  writeJsonl(transcriptPath, [
    { type: 'user', message: { content: 'do X' }, timestamp: at(0) },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] }, timestamp: at(300) },
    { type: 'user', message: { content: 'back' }, timestamp: at(300 + 30 * 60) },
  ]);

  const tl = computeSessionTimeline(transcriptPath, 'sess-midnight');
  assert.equal(tl.periods[tl.periods.length - 1].state, 'waiting_user', 'crossing a day is not the test');
  assert.ok(!tl.periods.some((p) => p.state === 'break'));
});

test('just under the threshold is still waiting_user; just over is a break', (t) => {
  const dir = makeTmpDir(t);
  const mk = (gapSec, name) => {
    const p = path.join(dir, name);
    writeJsonl(p, [
      { type: 'user', message: { content: 'do X' }, timestamp: ts(0) },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] }, timestamp: ts(30) },
      { type: 'user', message: { content: 'back' }, timestamp: ts(30 + gapSec) },
    ]);
    return computeSessionTimeline(p, 'sess-' + name);
  };
  assert.equal(mk(BREAK_GAP_SEC - 1, 'under.jsonl').periods.pop().state, 'waiting_user');
  assert.equal(mk(BREAK_GAP_SEC, 'over.jsonl').periods.pop().state, 'break');
});

test('a long wait on a background subagent is not a break', (t) => {
  const dir = makeTmpDir(t);
  const transcriptPath = path.join(dir, 'long-agent.jsonl');
  // The main thread is silent for 8h because its own subagent is running — real work.
  writeJsonl(transcriptPath, [
    { type: 'user', message: { content: 'do X' }, timestamp: ts(0) },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'spawning' }] }, timestamp: ts(30) },
    { type: 'user', message: { content: '<task-notification>\n<task-id>abc</task-id>' }, timestamp: ts(30 + 8 * 3600) },
  ]);

  const tl = computeSessionTimeline(transcriptPath, 'sess-agent');
  assert.equal(tl.periods[tl.periods.length - 1].state, 'idle', 'blocked on a subagent, not abandoned');
  assert.ok(!tl.periods.some((p) => p.state === 'break'));
});

// ─── AskUserQuestion: the answer is a tool_result, but the wait was the human's ───────────────

test('an AskUserQuestion wait is waiting_user, not idle', (t) => {
  const dir = makeTmpDir(t);
  const transcriptPath = path.join(dir, 'ask.jsonl');
  writeJsonl(transcriptPath, [
    { type: 'user', message: { content: 'do X' }, timestamp: ts(0) },
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_ask1', name: 'AskUserQuestion', input: {} }] },
      timestamp: ts(30),
    },
    // The human deliberates for 22 minutes, then answers.
    {
      type: 'user',
      toolUseResult: {},
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_ask1', content: 'Option A' }] },
      timestamp: ts(30 + 22 * 60),
    },
  ]);

  const tl = computeSessionTimeline(transcriptPath, 'sess-ask');
  const last = tl.periods[tl.periods.length - 1];
  assert.equal(last.state, 'waiting_user', 'the agent was blocked on the human');
  assert.deepEqual([last.started_at, last.ended_at], [ts(30), ts(30 + 22 * 60)]);
});

test('an ordinary tool_result after a long gap is still idle, without a permission marker', (t) => {
  const dir = makeTmpDir(t);
  const transcriptPath = path.join(dir, 'bash.jsonl');
  writeJsonl(transcriptPath, [
    { type: 'user', message: { content: 'run the build' }, timestamp: ts(0) },
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_bash1', name: 'Bash', input: {} }] },
      timestamp: ts(30),
    },
    {
      type: 'user',
      toolUseResult: {},
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_bash1', content: 'done' }] },
      timestamp: ts(30 + 22 * 60),
    },
  ]);

  const tl = computeSessionTimeline(transcriptPath, 'sess-bash');
  assert.equal(tl.periods[tl.periods.length - 1].state, 'idle', 'a build running is not the human deciding');
});

test('an AskUserQuestion abandoned past the break threshold is still a break', (t) => {
  const dir = makeTmpDir(t);
  const transcriptPath = path.join(dir, 'ask-break.jsonl');
  writeJsonl(transcriptPath, [
    { type: 'user', message: { content: 'do X' }, timestamp: ts(0) },
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_ask2', name: 'AskUserQuestion', input: {} }] },
      timestamp: ts(30),
    },
    {
      type: 'user',
      toolUseResult: {},
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_ask2', content: 'Option B' }] },
      timestamp: ts(30 + 8 * 3600),
    },
  ]);

  const tl = computeSessionTimeline(transcriptPath, 'sess-ask-break');
  assert.equal(tl.periods[tl.periods.length - 1].state, 'break', 'they went home, not deliberated for 8h');
});

// ─── plan approval and declined permissions are the human's time ─────────────

test('waiting for a plan to be approved is waiting_user, not planning', (t) => {
  const dir = makeTmpDir(t);
  const transcriptPath = path.join(dir, 'plan-approve.jsonl');
  writeJsonl(transcriptPath, [
    { type: 'user', message: { content: 'design it' }, timestamp: ts(0) },
    { type: 'permission-mode', permissionMode: 'plan' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }] }, timestamp: ts(30) },
    // The plan is presented — planning is over, the human now owns the clock.
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_plan1', name: 'ExitPlanMode', input: {} }] },
      timestamp: ts(60),
    },
    {
      type: 'user',
      toolUseResult: {},
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_plan1', content: 'approved' }] },
      timestamp: ts(60 + 4 * 60),
    },
  ]);

  const tl = computeSessionTimeline(transcriptPath, 'sess-plan');
  const last = tl.periods[tl.periods.length - 1];
  assert.equal(last.state, 'waiting_user', 'the agent was blocked on the human, not planning');
  assert.deepEqual([last.started_at, last.ended_at], [ts(60), ts(60 + 4 * 60)]);
  // The work BEFORE the plan was presented is still planning.
  assert.ok(tl.periods.some((p) => p.state === 'planning'), 'plan-mode work is untouched');
});

test('a declined permission prompt is waiting_user at any duration', (t) => {
  const dir = makeTmpDir(t);
  const transcriptPath = path.join(dir, 'declined.jsonl');
  writeJsonl(transcriptPath, [
    { type: 'user', message: { content: 'edit the file' }, timestamp: ts(0) },
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_edit1', name: 'Edit', input: {} }] },
      timestamp: ts(30),
    },
    // 95 minutes of the human thinking about it, then saying no.
    {
      type: 'user',
      toolUseResult: {},
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_edit1',
            is_error: true,
            content: "The user doesn't want to proceed with this tool use. The tool use was rejected",
          },
        ],
      },
      timestamp: ts(30 + 95 * 60),
    },
  ]);

  const tl = computeSessionTimeline(transcriptPath, 'sess-declined');
  assert.equal(tl.periods[tl.periods.length - 1].state, 'waiting_user', 'they answered — they were there');
});

test('a plan abandoned past the break threshold is still a break', (t) => {
  const dir = makeTmpDir(t);
  const transcriptPath = path.join(dir, 'plan-break.jsonl');
  writeJsonl(transcriptPath, [
    { type: 'user', message: { content: 'design it' }, timestamp: ts(0) },
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_plan2', name: 'ExitPlanMode', input: {} }] },
      timestamp: ts(30),
    },
    {
      type: 'user',
      toolUseResult: {},
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_plan2', content: 'approved' }] },
      timestamp: ts(30 + 9 * 3600),
    },
  ]);

  const tl = computeSessionTimeline(transcriptPath, 'sess-plan-break');
  assert.equal(tl.periods[tl.periods.length - 1].state, 'break', 'they went home mid-plan');
});

test('an ordinary failed tool_result is still idle, not a user decision', (t) => {
  const dir = makeTmpDir(t);
  const transcriptPath = path.join(dir, 'failed-tool.jsonl');
  writeJsonl(transcriptPath, [
    { type: 'user', message: { content: 'run it' }, timestamp: ts(0) },
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_bash9', name: 'Bash', input: {} }] },
      timestamp: ts(30),
    },
    {
      type: 'user',
      toolUseResult: {},
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_bash9', is_error: true, content: 'Exit code 128' }],
      },
      timestamp: ts(30 + 22 * 60),
    },
  ]);

  const tl = computeSessionTimeline(transcriptPath, 'sess-failed');
  assert.equal(tl.periods[tl.periods.length - 1].state, 'idle', 'a tool that ran and failed is not the human');
});

// --- waiting subtypes -------------------------------------------------------------------------
// Markers are injected rather than read from ~/.beezi/state: the real state dir belongs to whoever
// is running the suite, and a stray file there must never be able to flip an assertion.
const withMarkers = (markers) => ({ readPermissionMarkers: () => markers });
const marker = (offsetSec, toolName, permissionMode) => ({
  ts: BASE_MS + offsetSec * 1000,
  toolName: toolName === undefined ? 'Bash' : toolName,
  permissionMode: permissionMode === undefined ? 'default' : permissionMode,
});

// One assistant tool_use at ts(30), its result 22 minutes later. Without a marker that whole gap
// is the tool running; with one it is the human staring at a permission dialog.
function permissionTranscript(t, name) {
  const dir = makeTmpDir(t);
  const transcriptPath = path.join(dir, `${name}.jsonl`);
  writeJsonl(transcriptPath, [
    { type: 'user', message: { content: 'run the build' }, timestamp: ts(0) },
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_b1', name: 'Bash', input: {} }] },
      timestamp: ts(30),
    },
    {
      type: 'user',
      toolUseResult: {},
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_b1', content: 'done' }] },
      timestamp: ts(30 + 22 * 60),
    },
  ]);
  return transcriptPath;
}

test('a permission marker turns an approved tool wait into waiting_user/command_approval', (t) => {
  const transcriptPath = permissionTranscript(t, 'perm-approved');
  const tl = computeSessionTimeline(transcriptPath, 'sess-perm', withMarkers([marker(35)]));
  const last = tl.periods[tl.periods.length - 1];
  assert.equal(last.state, 'waiting_user', 'the human was reading a permission dialog');
  assert.equal(last.waiting_subtype, 'command_approval');
  // The stretch before the prompt appeared is still the agent's own work, not the human's time.
  assert.deepEqual([last.started_at, last.ended_at], [ts(35), ts(30 + 22 * 60)]);
});

test('a marker for a tool the transcript already explains is ignored', (t) => {
  const transcriptPath = permissionTranscript(t, 'perm-decision-tool');
  const tl = computeSessionTimeline(
    transcriptPath, 'sess-perm2', withMarkers([marker(35, 'ExitPlanMode')]),
  );
  assert.equal(tl.periods[tl.periods.length - 1].state, 'idle', 'plan waits come from the transcript');
});

test('a marker written with nobody to ask is ignored', (t) => {
  const transcriptPath = permissionTranscript(t, 'perm-unattended');
  for (const mode of ['dontAsk', 'bypassPermissions']) {
    const tl = computeSessionTimeline(
      transcriptPath, 'sess-perm3', withMarkers([marker(35, 'Bash', mode)]),
    );
    assert.equal(tl.periods[tl.periods.length - 1].state, 'idle', `${mode} is not a human waiting`);
  }
});

test('a marker answered within a second is ignored as auto-resolved', (t) => {
  const dir = makeTmpDir(t);
  const transcriptPath = path.join(dir, 'perm-fast.jsonl');
  writeJsonl(transcriptPath, [
    { type: 'user', message: { content: 'go' }, timestamp: ts(0) },
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_f1', name: 'Bash', input: {} }] },
      timestamp: ts(30),
    },
    {
      type: 'user',
      toolUseResult: {},
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_f1', content: 'done' }] },
      timestamp: ts(31),
    },
  ]);
  const tl = computeSessionTimeline(
    transcriptPath,
    'sess-perm4',
    withMarkers([{ ts: BASE_MS + 30500, toolName: 'Bash', permissionMode: 'default' }]),
  );
  assert.ok(
    tl.periods.every((p) => p.state !== 'waiting_user'),
    'a prompt resolved in half a second was never read by a human',
  );
});

test('an abandoned permission prompt is still a break, not waiting_user', (t) => {
  const dir = makeTmpDir(t);
  const transcriptPath = path.join(dir, 'perm-break.jsonl');
  const far = BREAK_GAP_SEC + 60;
  writeJsonl(transcriptPath, [
    { type: 'user', message: { content: 'go' }, timestamp: ts(0) },
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_k1', name: 'Bash', input: {} }] },
      timestamp: ts(30),
    },
    {
      type: 'user',
      toolUseResult: {},
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_k1', content: 'done' }] },
      timestamp: ts(30 + far),
    },
  ]);
  const tl = computeSessionTimeline(transcriptPath, 'sess-perm5', withMarkers([marker(35)]));
  assert.equal(tl.periods[tl.periods.length - 1].state, 'break', 'they went home, they did not deliberate');
});

test('the four waiting subtypes are labelled, and a split preserves total waiting time', (t) => {
  const dir = makeTmpDir(t);
  const transcriptPath = path.join(dir, 'subtypes.jsonl');
  const declined = "The user doesn't want to proceed with this tool use. The tool use was rejected";
  writeJsonl(transcriptPath, [
    { type: 'user', message: { content: 'go' }, timestamp: ts(0) },
    // plan approval
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_p1', name: 'ExitPlanMode', input: {} }] },
      timestamp: ts(10),
    },
    {
      type: 'user',
      toolUseResult: {},
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_p1', content: 'approved' }] },
      timestamp: ts(70),
    },
    // …answered, and the human types their next instruction straight after: two adjacent waits.
    { type: 'user', message: { content: 'now do Y' }, timestamp: ts(130) },
    // question
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_q1', name: 'AskUserQuestion', input: {} }] },
      timestamp: ts(140),
    },
    {
      type: 'user',
      toolUseResult: {},
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_q1', content: 'Option A' }] },
      timestamp: ts(200),
    },
    // declined permission
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_d1', name: 'Bash', input: {} }] },
      timestamp: ts(210),
    },
    {
      type: 'user',
      toolUseResult: {},
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_d1', is_error: true, content: declined }],
      },
      timestamp: ts(270),
    },
  ]);

  const tl = computeSessionTimeline(transcriptPath, 'sess-subtypes', withMarkers([]));
  const waits = tl.periods.filter((p) => p.state === 'waiting_user');
  assert.deepEqual(
    waits.map((p) => p.waiting_subtype),
    ['plan_approval', 'next_instruction', 'question_answer', 'command_approval'],
  );
  // The plan wait and the next-instruction wait are one contiguous run that the subtype split in
  // two — the halves must still add up to what a single merged period would have measured.
  const ms = (p) => Date.parse(p.ended_at) - Date.parse(p.started_at);
  assert.equal(ms(waits[0]) + ms(waits[1]), 120 * 1000, 'splitting must not create or lose time');
  assert.equal(waits[0].ended_at, waits[1].started_at, 'the halves are contiguous');
  // Non-waiting periods must stay byte-identical to what they were before subtypes existed.
  for (const p of tl.periods) {
    if (p.state !== 'waiting_user') assert.deepEqual(Object.keys(p), ['state', 'started_at', 'ended_at']);
  }
});

// Skew puts the marker exactly on an anchor rather than between two. Flagging the wrong anchor
// there would charge the human for the agent's own work, so it is only allowed when the anchor is
// demonstrably the tool call the prompt was about.
test('a marker landing exactly on its own tool_use anchor still opens the wait there', (t) => {
  const transcriptPath = permissionTranscript(t, 'perm-exact');
  const tl = computeSessionTimeline(transcriptPath, 'sess-exact', withMarkers([marker(30)]));
  const last = tl.periods[tl.periods.length - 1];
  assert.equal(last.state, 'waiting_user');
  assert.equal(last.waiting_subtype, 'command_approval');
  assert.deepEqual([last.started_at, last.ended_at], [ts(30), ts(30 + 22 * 60)]);
});

test('a marker landing on an unrelated anchor is dropped, not charged to the human', (t) => {
  const transcriptPath = permissionTranscript(t, 'perm-unrelated');
  // ts(0) is the user's prompt, far from the Bash call at ts(30) — nothing to snap to, so this
  // marker must not turn the agent's first 30 seconds of work into a permission wait.
  const tl = computeSessionTimeline(transcriptPath, 'sess-unrelated', withMarkers([marker(0)]));
  assert.equal(tl.periods[0].state, 'working', 'the run-up to the prompt is the agent working');
  assert.ok(
    tl.periods.every((p) => p.waiting_subtype !== 'command_approval'),
    'an unplaceable marker is dropped rather than guessed at',
  );
});
