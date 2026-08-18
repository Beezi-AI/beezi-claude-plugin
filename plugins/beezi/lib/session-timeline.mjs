import fs from 'fs';
import { listSubagentTranscripts } from './subagents.mjs';
import { IDLE_GAP_SEC, isTimingAnchor } from './delta.mjs';
import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';
import { resolveFetch } from './fetch-compat.mjs';

// Work done while a plan permission mode is active is `planning`. Matched loosely (substring) so a
// schema tweak — 'plan', 'plan_mode', 'planning' — still classifies as planning instead of silently
// falling back to `working` and dropping the whole planning dimension. The other permission modes
// ('default', 'auto', 'acceptEdits') don't contain 'plan', so they read as `working`.
const isPlanMode = (mode) => typeof mode === 'string' && mode.toLowerCase().includes('plan');

const STATE = {
  WORKING: 'working',
  PLANNING: 'planning',
  WAITING_USER: 'waiting_user',
  IDLE: 'idle',
  BREAK: 'break',
};

// Past this, the session was not waited on — it was abandoned and later resumed, usually
// overnight. Charted as `break` so a client can collapse it to a marker instead of drawing
// hours of empty axis: 16 such bands account for 45% of all charted time locally, and 10 of
// them cross a calendar day.
//
// Duration is the whole test; crossing midnight deliberately is NOT one. A 23:50→00:20 pause is
// the human stepping away for half an hour and must stay `waiting_user`, while 18:00→10:00 is a
// break whether or not a date changed — and a date test would drag timezone and DST handling in
// for nothing. 6h sits in the empty part of the distribution (one single band falls between 3h
// and 6h locally), so it separates "long lunch and a meeting" from "came back tomorrow" without
// balancing on a knife edge.
export const BREAK_GAP_SEC = 6 * 60 * 60;

// Parse a JSONL transcript into an array of records; blank/malformed lines are skipped.
function parseTranscript(transcriptPath) {
  const content = fs.readFileSync(transcriptPath, 'utf-8');
  const trimmed = content.replace(/\n+$/, '');
  if (trimmed === '') return [];
  const out = [];
  for (const raw of trimmed.split('\n')) {
    if (!raw.trim()) continue;
    try { out.push(JSON.parse(raw)); } catch { /* skip malformed */ }
  }
  return out;
}

function tsOf(line) {
  return line != null && line.timestamp ? new Date(line.timestamp).getTime() : null;
}

// The active permission mode, from either a dedicated `type:'permission-mode'` change line or the
// `permissionMode` stamped on a normal (user) line. Claude Code's `type:'mode'` lines carry the
// EDITOR mode ('normal'/'insert'), NOT the permission mode — reading those never surfaced planning.
// Neither the change line nor most work lines are timestamped/plan-stamped, so the mode is tracked
// forward from whichever line last set it.
function permissionModeOf(line) {
  if (line != null && line.type === 'permission-mode' && typeof line.permissionMode === 'string') {
    return line.permissionMode;
  }
  return line != null && typeof line.permissionMode === 'string' ? line.permissionMode : null;
}

// A Ctrl+C / Esc interrupt is written as a type:'user' line whose text is
// '[Request interrupted by user]' (or '...for tool use'). No Stop hook fires on an interrupt, so
// the aborted turn is only emitted at the next Stop/SessionEnd — and only classifies correctly if
// this marker is NOT read as a turn-start: the gap before it is the agent's aborted WORK, not the
// human thinking.
const INTERRUPT_PREFIX = '[Request interrupted by user';
function isInterruptMarker(line) {
  const message = line == null ? undefined : line.message;
  const c = message == null ? undefined : message.content;
  if (!Array.isArray(c)) return false;
  return c.some(
    (b) => b != null && b.type === 'text' && typeof b.text === 'string' && b.text.startsWith(INTERRUPT_PREFIX),
  );
}

// A finished subagent re-enters the main thread as a type:'user' line whose text opens with
// '<task-notification>' — content is a plain string, not blocks, so the array-only scan used for
// interrupts does not reach it. It is the agent being woken by its OWN subagent, never a human
// typing: read as a turn-start it painted every subagent wait as waiting_user.
const TASK_NOTIFICATION_PREFIX = '<task-notification>';
function startsWithPrefix(content, prefix) {
  if (typeof content === 'string') return content.trimStart().startsWith(prefix);
  if (Array.isArray(content)) {
    return content.some(
      (b) => b != null && b.type === 'text' && typeof b.text === 'string' && b.text.trimStart().startsWith(prefix),
    );
  }
  return false;
}
function isTaskNotification(line) {
  if (line == null || line.type !== 'user') return false;
  return startsWithPrefix(line.message == null ? undefined : line.message.content, TASK_NOTIFICATION_PREFIX);
}

// Tools whose entire job is to block on the human. Their tool_result arrives when the person
// answers, so the gap before it is time spent waiting on them — not idle, and not planning. It
// reads as anything else only because the answer comes back as a tool_result, which
// isRealUserPrompt (correctly) refuses to treat as a turn-start.
//
//   AskUserQuestion — the agent asked; all 15 local waits (5.4h) used to chart as idle.
//   ExitPlanMode    — the agent presented a plan and is blocked until the human approves or
//                     rejects it. 36 local waits: 32 charted as `planning` (the plan permission
//                     mode is still active, so they fell through to it) and 4 as idle once the
//                     wait passed the 5-minute gap. Presenting a plan ends the planning; what
//                     follows is the human deciding, so it belongs to them. This does move ~1.8h
//                     out of `planning` — that is the point, not a side effect.
const USER_DECISION_TOOLS = { AskUserQuestion: true, ExitPlanMode: true };

// The tool_result Claude Code writes when the human DECLINES a permission prompt. Any tool can
// come back this way, so it is matched on the marker text rather than a tool name.
//
// Not to be confused with the stream-closed teardown in delta.mjs, which is the opposite fact: it
// means nobody was there. This one proves the human WAS there and answered — locally after 9 and
// 95 minutes of deliberation, both charted as idle.
const PERMISSION_DECLINED_PREFIX = "The user doesn't want to proceed with this tool use";

// Map every tool_use id in the transcript to its tool name, so a tool_result can be traced back
// to the tool that produced it (the result block carries only `tool_use_id`).
function buildToolUseNames(lines) {
  const names = new Map();
  for (const line of lines) {
    const message = line == null ? undefined : line.message;
    const content = message == null ? undefined : message.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b != null && b.type === 'tool_use' && b.id && typeof b.name === 'string') names.set(b.id, b.name);
    }
  }
  return names;
}

// Is this line the human answering something the agent put to them — a question, a plan waiting on
// approval, or a permission prompt they declined?
function isUserDecision(line, toolUseNames) {
  if (line == null || line.type !== 'user') return false;
  const message = line.message == null ? undefined : line.message;
  const content = message == null ? undefined : message.content;
  if (!Array.isArray(content)) return false;
  for (const b of content) {
    if (b == null || b.type !== 'tool_result') continue;
    if (b.tool_use_id && USER_DECISION_TOOLS[toolUseNames.get(b.tool_use_id)] === true) return true;
    if (typeof b.content === 'string' && b.content.indexOf(PERMISSION_DECLINED_PREFIX) === 0) return true;
  }
  return false;
}

// A genuine user turn-start, as opposed to a tool_result echo (Claude Code writes those as
// type:'user' too), an interrupt marker, a subagent completion notification, or an injected meta
// line. The gap BEFORE such a line is time the agent spent waiting on the human.
function isRealUserPrompt(line) {
  if (line == null || line.type !== 'user') return false;
  if (line.isMeta || line.isCompactSummary) return false;
  if (line.toolUseResult !== undefined) return false;
  if (isInterruptMarker(line)) return false;
  if (isTaskNotification(line)) return false;
  const c = line.message == null ? undefined : line.message.content;
  if (typeof c === 'string') return c.trim().length > 0;
  if (Array.isArray(c)) {
    if (c.some((b) => b != null && b.type === 'tool_result')) return false;
    return c.some((b) => b != null && b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0);
  }
  return false;
}

// Walk the transcript in file order, tracking the active permission mode (set by permission-mode
// change lines and the permissionMode field on user lines; assistant work lines inherit the last
// value). Classify each interval between consecutive timestamped anchors, then merge adjacent
// same-state runs into periods.
function buildPeriods(lines) {
  let currentMode = 'default';
  const toolUseNames = buildToolUseNames(lines);
  const anchors = [];
  for (const line of lines) {
    const pm = permissionModeOf(line);
    if (pm != null) currentMode = pm;
    // A permission-mode change line has no timestamp — it flips the mode but isn't an anchor.
    if (line != null && line.type === 'permission-mode') continue;
    // Nor is a line Claude Code stamped while nobody was working (away recaps, resume
    // bookkeeping) — anchoring on those closed the session with a band of pure dead time.
    if (!isTimingAnchor(line)) continue;
    const ms = tsOf(line);
    if (ms == null) continue;
    anchors.push({
      ts: ms,
      isPrompt: isRealUserPrompt(line),
      isTaskNotif: isTaskNotification(line),
      isUserDecision: isUserDecision(line, toolUseNames),
      mode: currentMode,
    });
  }
  anchors.sort((a, b) => a.ts - b.ts);

  const merged = [];
  for (let i = 1; i < anchors.length; i++) {
    const prev = anchors[i - 1];
    const cur = anchors[i];
    if (cur.ts <= prev.ts) continue;
    let state;
    // A gap that ENDS at a subagent notification is the agent blocked on its own subagent, at any
    // duration: background subagents hand back their tool_result in under a second, so the wait is
    // not the tool_use→tool_result window, it is the stretch of main-thread silence that the
    // notification breaks. Checked FIRST so a long-running background agent is never mistaken for
    // the human walking away — no local band ≥6h overlaps a live subagent today, but one that did
    // would be real work.
    if (cur.isTaskNotif) state = STATE.IDLE;
    // Abandoned and resumed, rather than waited on. This outranks the prompt rule below: these
    // gaps DO end at a real prompt (the human returning), which is exactly why they used to be
    // charted as one 29-hour `waiting_user` band.
    else if (cur.ts - prev.ts >= BREAK_GAP_SEC * 1000) state = STATE.BREAK;
    // Waiting on the human wins at any duration up to that — a prompt is a prompt whether the
    // human answered in 5 seconds or came back after lunch. A decision counts the same: an answered
    // question, an approved or rejected plan, a declined permission all arrive as a tool_result
    // rather than a turn-start, but the wait was still theirs. Note this outranks the plan-mode
    // check below, so a plan sitting unapproved is the human's time, not more planning.
    else if (cur.isPrompt || cur.isUserDecision) state = STATE.WAITING_USER;
    // The `>=` gap fallback matches delta.mjs, which accrues a gap only while it is strictly under
    // the threshold. With `>` an exactly-300s gap read as WORKING here but was dropped there.
    else if (cur.ts - prev.ts >= IDLE_GAP_SEC * 1000) state = STATE.IDLE;
    else state = isPlanMode(cur.mode) ? STATE.PLANNING : STATE.WORKING;

    const last = merged[merged.length - 1];
    if (last && last.state === state) last.endMs = cur.ts;
    else merged.push({ state, startMs: prev.ts, endMs: cur.ts });
  }
  return merged.map((m) => ({
    state: m.state,
    started_at: new Date(m.startMs).toISOString(),
    ended_at: new Date(m.endMs).toISOString(),
  }));
}

// Does this line carry an assistant `ExitPlanMode` tool_use block? That block marks Claude
// presenting a finished plan, and it sits on a timestamped line (unlike mode lines). Mirrors the
// content-block scan inlined in operations.mjs / code-changes.mjs.
function hasExitPlanMode(line) {
  const message = line == null ? undefined : line.message;
  const content = message == null ? undefined : message.content;
  if (!Array.isArray(content)) return false;
  return content.some((b) => b != null && b.type === 'tool_use' && b.name === 'ExitPlanMode');
}

// Discrete plan-mode markers, complementing the continuous `planning` periods:
//   plan_start — entered plan permission mode (a permission-mode change line, or a user line
//     stamped permissionMode:'plan'). Those aren't timestamped/plan-stamped on the change itself,
//     so the marker is anchored to the next timestamped line — matching how buildPeriods dates
//     plan-mode work.
//   plan_ready — Claude presented a finished plan via ExitPlanMode; that block is timestamped, so
//     the marker is exact.
// A session may hold several plan cycles; each entry/present is emitted independently. Plan mode
// entered but never presented yields a lone plan_start (acceptable).
function buildPlanEvents(lines) {
  const events = [];
  let inPlan = false;
  let pendingStart = false;
  for (const line of lines) {
    const pm = permissionModeOf(line);
    if (pm != null) {
      const nowPlan = isPlanMode(pm);
      if (nowPlan && !inPlan) pendingStart = true; // stamp on the next timestamped line
      inPlan = nowPlan;
    }
    if (line != null && line.type === 'permission-mode') continue; // no timestamp — mode flip only
    const ms = tsOf(line);
    if (ms == null) continue;
    if (pendingStart) {
      events.push({ type: 'plan_start', at: new Date(ms).toISOString() });
      pendingStart = false;
    }
    if (hasExitPlanMode(line)) {
      events.push({ type: 'plan_ready', at: new Date(ms).toISOString() });
    }
  }
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return events;
}

// One active span per subagent transcript (first→last timestamp). Parallel subagents overlap in
// time; the client packs them into lanes.
function buildSubagents(transcriptPath, sessionId) {
  const out = [];
  for (const { agentId, path: agentPath, agentType } of listSubagentTranscripts(transcriptPath, sessionId)) {
    let times;
    try {
      times = parseTranscript(agentPath).map(tsOf).filter((t) => t != null);
    } catch { continue; }
    if (!times.length) continue;
    times.sort((a, b) => a - b);
    out.push({
      agent_id: agentId,
      agent_type: agentType,
      started_at: new Date(times[0]).toISOString(),
      ended_at: new Date(times[times.length - 1]).toISOString(),
    });
  }
  return out;
}

// Drop everything before the first real user prompt. Claude Code opens every transcript with the
// SessionStart hook attachments, stamped the moment the session appears — and `/clear` opens a
// fresh transcript in a terminal the human may not touch again for ten minutes. Charting from
// there dates the session to when the terminal was cleared and bills the whole pre-prompt gap as
// waiting_user. The session starts when the human first speaks. A transcript with no prompt at all
// (cleared, then abandoned) has nothing to chart — null, and the caller reports no timeline.
function dropLeadIn(lines) {
  const first = lines.findIndex(isRealUserPrompt);
  return first === -1 ? null : lines.slice(first);
}

// Derive the whole session timeline from the transcript. Returns null when there's nothing to
// place on a time axis (no user prompt, or no timestamped lines). generated_at stamps when it was
// computed.
export function computeSessionTimeline(transcriptPath, sessionId) {
  let lines;
  try { lines = parseTranscript(transcriptPath); } catch { return null; }
  lines = dropLeadIn(lines);
  if (lines === null) return null;

  const periods = buildPeriods(lines);
  const plan_events = buildPlanEvents(lines);
  const subagents = buildSubagents(transcriptPath, sessionId);

  // Axis domain = earliest/latest timestamp across main + subagent activity. Single-pass min/max
  // rather than collecting and sorting every timestamp just to read the two extremes.
  let minTs = Infinity;
  let maxTs = -Infinity;
  const track = (t) => {
    if (t < minTs) minTs = t;
    if (t > maxTs) maxTs = t;
  };
  for (const line of lines) {
    // Same anchor rule as buildPeriods, or the axis would still run out to the away recap and
    // leave the chart with a long empty tail past the final period.
    if (!isTimingAnchor(line)) continue;
    const t = tsOf(line);
    if (t != null) track(t);
  }
  for (const s of subagents) {
    track(Date.parse(s.started_at));
    track(Date.parse(s.ended_at));
  }
  if (minTs === Infinity) return null;

  return {
    periods,
    plan_events,
    subagents,
    started_at: new Date(minTs).toISOString(),
    ended_at: new Date(maxTs).toISOString(),
    generated_at: new Date().toISOString(),
  };
}

// POST the session timeline to Beezi. Session-scoped (upserted by sessionId), fire-and-forget by
// convention — callers swallow the result. Mirrors session-error-report.mjs.
export async function postSessionTimeline(payload, token, deps = {}) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  if (payload == null || !payload.sessionId || !Array.isArray(payload.periods)) {
    return { reported: false, reason: 'missing-fields' };
  }
  if (!token) return { reported: false, reason: 'no-token' };
  try {
    // timeoutMs is undefined for every hook caller, so postJson keeps its 3s default; the bulk
    // import raises it, having no 10s hook budget to protect.
    const res = await postJson(`${apiBase()}${ENDPOINTS.sessionsTimeline}`, token, payload, { fetchImpl, timeoutMs: deps.timeoutMs });
    return { reported: res.status >= 200 && res.status < 300, status: res.status };
  } catch {
    return { reported: false, reason: 'network' };
  }
}
