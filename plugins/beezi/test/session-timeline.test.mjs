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

test('an ordinary tool_result after a long gap is still idle, not waiting_user', (t) => {
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
