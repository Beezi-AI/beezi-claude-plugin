import fs from 'fs';
import path from 'path';
import { listSubagentTranscripts } from './subagents.mjs';
import { IDLE_GAP_SEC, isTimingAnchor } from './delta.mjs';
import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';
import { resolveFetch } from './fetch-compat.mjs';
import { readPermissionMarkers } from './permission-markers.mjs';

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

// WHY the human was being waited on, carried on `waiting_user` periods only. Every member names
// what was being waited ON, never the event that ended the wait — keep that convention if one is
// added, or the vocabulary stops meaning one thing.
//
// An absent subtype is NOT the same as NEXT_INSTRUCTION: it means the timeline came from a plugin
// old enough to predate this field. The server relies on that distinction, so a period must never
// carry the key with a null/undefined value.
const WAITING = {
  PLAN_APPROVAL: 'plan_approval',
  QUESTION_ANSWER: 'question_answer',
  COMMAND_APPROVAL: 'command_approval',
  NEXT_INSTRUCTION: 'next_instruction',
};

// Permission modes in which the prompt is never actually put to a human: the call is auto-denied
// or auto-allowed. A marker written under one of these is a machine event, not a wait.
const UNATTENDED_PERMISSION_MODES = { dontAsk: true, bypassPermissions: true };

// A marker whose next anchor lands within this window was answered too fast to have been a human
// reading a dialog — almost certainly an auto-resolved prompt. Charging it to the human would
// pepper the timeline with sub-second waiting bands.
const MARKER_MIN_WAIT_MS = 1000;

// How far back a marker may be pulled onto a matching tool_use anchor. Covers the case where
// Claude Code runs the permission check before it stamps the assistant line, which would otherwise
// sort the marker in front of the tool_use and lose the wait entirely.
const MARKER_SNAP_MS = 5000;

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

// Skills whose job is to PRODUCE a plan. Matched on the segment after the last ':', tokenized on
// non-alphanumerics, by token PREFIX — 'plans' matches 'plan', 'brainstorming' matches
// 'brainstorm', but 'inspect' does NOT match 'spec' and 'explanation' does NOT match 'plan',
// which a raw substring test gets wrong both times. Last segment only, so a plugin namespaced
// 'planner' cannot make every one of its skills a planning entry.
const PLAN_SKILL_HINTS = ['plan', 'spec', 'brainstorm'];
// ...and skills that CONSUME one. 'superpowers:executing-plans' matches 'plan' on every rule
// above and is the exact opposite of planning: it edits the plan document during implementation
// (ticking checkboxes), so reading it as an entry point drags plan_ready to the end of the
// session. Matched the same way, and it also CLOSES an open cycle — execution has begun even
// when its code edits happen in subagent transcripts this walk never sees.
const PLAN_SKILL_EXCLUSIONS = ['execut', 'implement'];

// A produced plan document: '.md' exactly, keyword in the BASENAME — or sitting directly in a
// folder whose name is EXACTLY plan(s)/spec(s)/design(s): superpowers' writing-plans emits
// docs/superpowers/plans/<date>-<slug>.md with no keyword in the basename at all. Exact folder
// names only, never substring — sdd execution dirs (.superpowers/sdd/<date>-<slug>-design/)
// hold progress.md/task-N-report.md artifacts whose code edits happen in subagent transcripts,
// so a substring dir match would keep the cycle open forever.
const PLAN_DOC_HINTS = ['design', 'spec', 'plan'];
const PLAN_DIR_NAMES = { plan: true, plans: true, spec: true, specs: true, design: true, designs: true };
const PLAN_DOC_EXT = '.md';

// Mirrors code-changes.mjs's EDIT_TOOLS (not imported: that module doesn't export it, and this
// file already mirrors rather than shares the block-scan idiom — see hasExitPlanMode).
const EDIT_TOOLS = { Edit: true, MultiEdit: true, Write: true, NotebookEdit: true };

// Forward slashes, so a Windows path parses with path.posix. Mirrors repo-timeline.mjs's norm().
// Bare path.basename on a POSIX runtime returns the WHOLE 'C:\...\plans\foo.md' string, which
// would silently turn basename matching into directory matching.
function normPath(p) {
  return typeof p === 'string' ? p.replace(/\\/g, '/') : p;
}

function leafTokens(skillId) {
  if (typeof skillId !== 'string' || skillId === '') return [];
  const i = skillId.lastIndexOf(':');
  const leaf = i === -1 ? skillId : skillId.slice(i + 1);
  return leaf.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t !== '');
}

function anyTokenStartsWith(tokens, hints) {
  for (const t of tokens) {
    for (const h of hints) {
      if (t.indexOf(h) === 0) return true;
    }
  }
  return false;
}

function isPlanningSkill(skillId) {
  const tokens = leafTokens(skillId);
  if (tokens.length === 0) return false;
  if (anyTokenStartsWith(tokens, PLAN_SKILL_EXCLUSIONS)) return false;
  return anyTokenStartsWith(tokens, PLAN_SKILL_HINTS);
}

function isExcludedPlanSkill(skillId) {
  return anyTokenStartsWith(leafTokens(skillId), PLAN_SKILL_EXCLUSIONS);
}

function isPlanDocPath(filePath) {
  if (typeof filePath !== 'string' || filePath === '') return false;
  const p = normPath(filePath);
  const base = path.posix.basename(p).toLowerCase();
  if (path.posix.extname(base) !== PLAN_DOC_EXT) return false;
  for (const h of PLAN_DOC_HINTS) {
    if (base.indexOf(h) !== -1) return true;
  }
  const parent = path.posix.basename(path.posix.dirname(p)).toLowerCase();
  return PLAN_DIR_NAMES[parent] === true;
}

// Agent housekeeping under a .claude directory — memory saves, scratchpads, settings. Neither a
// plan document nor implementation starting: a MEMORY.md save mid-brainstorm closed a real
// cycle 15 minutes before the design doc was finished. Neutral — neither advances nor closes.
function isHousekeepingPath(filePath) {
  return normPath(filePath).toLowerCase().indexOf('/.claude/') !== -1;
}

// Does this line carry a Skill tool_use matching `match`? Skill tool_use lines are timestamped
// assistant lines, so unlike the permission-mode change line no forward anchoring is needed.
function hasSkillMatching(line, match) {
  const message = line == null ? undefined : line.message;
  const content = message == null ? undefined : message.content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (b) => b != null && b.type === 'tool_use' && b.name === 'Skill'
      && b.input != null && match(b.input.skill),
  );
}

// { plan, other }: did this line write a matching plan document, and/or edit anything else?
// A message with parallel tool calls can do both.
function fileEditsOn(line) {
  const out = { plan: false, other: false };
  const message = line == null ? undefined : line.message;
  const content = message == null ? undefined : message.content;
  if (!Array.isArray(content)) return out;
  for (const b of content) {
    if (b == null || b.type !== 'tool_use' || EDIT_TOOLS[b.name] !== true) continue;
    const input = b.input == null ? {} : b.input;
    const fp = input.file_path == null ? input.notebook_path : input.file_path;
    if (typeof fp !== 'string' || fp === '' || isHousekeepingPath(fp)) continue;
    if (isPlanDocPath(fp)) out.plan = true;
    else out.other = true;
  }
  return out;
}

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

// Which decision is this line the human answering — a question, a plan waiting on approval, or a
// permission prompt they declined? Returns the waiting subtype, or null when the line is not a
// decision at all.
//
// The tool name was always resolved here to answer "is this a decision"; it is now kept rather
// than collapsed to a boolean, which is the whole of the plan/question half of this feature.
function userDecisionKind(line, toolUseNames) {
  if (line == null || line.type !== 'user') return null;
  const message = line.message == null ? undefined : line.message;
  const content = message == null ? undefined : message.content;
  if (!Array.isArray(content)) return null;
  for (const b of content) {
    if (b == null || b.type !== 'tool_result') continue;
    if (b.tool_use_id) {
      const name = toolUseNames.get(b.tool_use_id);
      if (name === 'ExitPlanMode') return WAITING.PLAN_APPROVAL;
      if (name === 'AskUserQuestion') return WAITING.QUESTION_ANSWER;
    }
    // A decline can come back from ANY tool, so it is matched on the marker text. Checked after
    // the named tools so a declined plan still reads as a plan approval.
    if (typeof b.content === 'string' && b.content.indexOf(PERMISSION_DECLINED_PREFIX) === 0) {
      return WAITING.COMMAND_APPROVAL;
    }
  }
  return null;
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

// Names of the tools this line opens a tool_use for. Lets a marker be snapped onto the anchor of
// the very call it belongs to when the two are stamped out of order.
function toolUseNamesOf(line) {
  const message = line == null ? undefined : line.message;
  const content = message == null ? undefined : message.content;
  if (!Array.isArray(content)) return null;
  let names = null;
  for (const b of content) {
    if (b != null && b.type === 'tool_use' && typeof b.name === 'string') {
      if (names === null) names = [];
      names.push(b.name);
    }
  }
  return names;
}

// Fold permission-prompt markers into the sorted anchor list, in place.
//
// A marker is not a transcript line, so it becomes a synthetic anchor whose only job is to open a
// waiting interval. Everything here exists because the merge loop drops a bad anchor SILENTLY
// (`if (cur.ts <= prev.ts) continue`), so a marker landing in the wrong place would not fail — it
// would just quietly chart nothing.
function applyPermissionMarkers(anchors, markers) {
  if (!Array.isArray(markers) || markers.length === 0 || anchors.length === 0) return;
  const firstTs = anchors[0].ts;
  const lastTs = anchors[anchors.length - 1].ts;
  const injected = [];
  let lastAcceptedTs = -Infinity;

  for (const marker of markers) {
    if (marker == null || !Number.isFinite(marker.ts)) continue;
    // Prompts for these are already read off the transcript, with a more specific subtype.
    if (marker.toolName != null && USER_DECISION_TOOLS[marker.toolName] === true) continue;
    // No human was asked: the call was auto-allowed or auto-denied.
    if (marker.permissionMode != null && UNATTENDED_PERMISSION_MODES[marker.permissionMode] === true) continue;
    // Outside the charted span — lead-in dropped by dropLeadIn, or a stale file from an earlier
    // run of a session that was later resumed.
    if (marker.ts < firstTs || marker.ts >= lastTs) continue;

    let ts = marker.ts;
    // The hook may be stamped just BEFORE the assistant tool_use line it belongs to, depending on
    // whether Claude Code writes the transcript entry before or after running the permission
    // check. Pull it onto that call so the wait opens at the anchor rather than in front of it.
    const snapped = snapToToolUse(anchors, ts, marker.toolName);
    if (snapped != null) ts = snapped;

    const idx = precedingAnchorIndex(anchors, ts);
    if (idx === -1) continue;
    const next = anchors[idx + 1];
    // Answered too fast to have been read by a human — an auto-resolved prompt.
    if (next != null && next.ts - ts < MARKER_MIN_WAIT_MS) continue;
    // Several prompts between the same pair of real anchors (a parallel tool batch) describe one
    // continuous wait; the earliest opens it and the rest are noise.
    if (ts <= lastAcceptedTs) continue;

    if (ts <= anchors[idx].ts) {
      // Landing exactly on an existing anchor, so there is nothing to inject between. Flagging is
      // only safe when the snap matched — that anchor IS the tool call being asked about. Without
      // a match the anchor is merely whatever happened to be stamped at that instant, and flagging
      // it would charge the human for the agent's work leading up to the prompt.
      if (snapped == null) continue;
      anchors[idx].isPermissionMarker = true;
      lastAcceptedTs = anchors[idx].ts;
      continue;
    }
    injected.push({
      ts,
      isPrompt: false,
      isTaskNotif: false,
      decisionKind: null,
      toolUseNames: null,
      isPermissionMarker: true,
      mode: anchors[idx].mode,
    });
    lastAcceptedTs = ts;
  }

  if (injected.length === 0) return;
  for (const a of injected) anchors.push(a);
  anchors.sort((a, b) => a.ts - b.ts);
}

// Index of the last anchor at or before `ts`, or -1 when `ts` precedes them all.
function precedingAnchorIndex(anchors, ts) {
  let found = -1;
  for (let i = 0; i < anchors.length; i++) {
    if (anchors[i].ts > ts) break;
    found = i;
  }
  return found;
}

// If a tool_use anchor for this tool sits within MARKER_SNAP_MS after the marker, return its
// timestamp so the marker can be moved onto it. Null when there is nothing to snap to.
function snapToToolUse(anchors, ts, toolName) {
  if (toolName == null) return null;
  for (const a of anchors) {
    if (a.ts < ts) continue;
    if (a.ts - ts > MARKER_SNAP_MS) return null;
    if (a.toolUseNames != null && a.toolUseNames.indexOf(toolName) !== -1) return a.ts;
  }
  return null;
}

// Walk the transcript in file order, tracking the active permission mode (set by permission-mode
// change lines and the permissionMode field on user lines; assistant work lines inherit the last
// value). Classify each interval between consecutive timestamped anchors, then merge adjacent
// same-state runs into periods.
function buildPeriods(lines, skillPlanIntervals, permissionMarkers) {
  // A skill-plan window (buildSkillPlanCycles) classifies as `planning` too — same rank as the
  // plan permission mode, so everything above it in the chain still outranks it.
  const inSkillPlan = (ms) => {
    if (!Array.isArray(skillPlanIntervals)) return false;
    for (const iv of skillPlanIntervals) {
      if (ms >= iv.startMs && ms <= iv.endMs) return true;
    }
    return false;
  };
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
      decisionKind: userDecisionKind(line, toolUseNames),
      toolUseNames: toolUseNamesOf(line),
      isPermissionMarker: false,
      mode: currentMode,
    });
  }
  anchors.sort((a, b) => a.ts - b.ts);
  applyPermissionMarkers(anchors, permissionMarkers);

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
    let subtype = null;
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
    else if (cur.isPrompt) { state = STATE.WAITING_USER; subtype = WAITING.NEXT_INSTRUCTION; }
    // Outranks the permission marker below on purpose: if PermissionRequest turns out to fire for
    // ExitPlanMode or AskUserQuestion too, the transcript's answer is the more specific one and a
    // plan approval must not be relabelled as a bare command approval.
    else if (cur.decisionKind != null) { state = STATE.WAITING_USER; subtype = cur.decisionKind; }
    // The one backward-looking rule in this loop. Every other branch classifies the interval
    // [prev, cur] by what CUR is; a permission marker instead marks where the wait BEGAN, so the
    // interval it describes is the one it opens. Reading it off `cur` would paint the stretch
    // before the prompt — the agent's own work — as waiting.
    //
    // Sits above the idle rule deliberately: an approval the human took ten minutes over is still
    // their time, and the gap threshold would otherwise swallow every slow one as `idle`.
    else if (prev.isPermissionMarker) { state = STATE.WAITING_USER; subtype = WAITING.COMMAND_APPROVAL; }
    // The `>=` gap fallback matches delta.mjs, which accrues a gap only while it is strictly under
    // the threshold. With `>` an exactly-300s gap read as WORKING here but was dropped there.
    else if (cur.ts - prev.ts >= IDLE_GAP_SEC * 1000) state = STATE.IDLE;
    else state = (isPlanMode(cur.mode) || inSkillPlan(cur.ts)) ? STATE.PLANNING : STATE.WORKING;

    // Merged on state AND subtype: two adjacent waits for different reasons are two periods, or
    // one reason would silently win the whole run. Splitting preserves total waiting time (the
    // halves are contiguous) but does raise the period count.
    const last = merged[merged.length - 1];
    if (last && last.state === state && last.subtype === subtype) last.endMs = cur.ts;
    else merged.push({ state, subtype, startMs: prev.ts, endMs: cur.ts });
  }
  return merged.map((m) => {
    const period = {
      state: m.state,
      started_at: new Date(m.startMs).toISOString(),
      ended_at: new Date(m.endMs).toISOString(),
    };
    // Emitted only where it means something. Stamping the key as null/undefined on every period
    // would both bloat the stored blob and destroy the server's "absent = older plugin" reading.
    if (m.state === STATE.WAITING_USER && m.subtype != null) period.waiting_subtype = m.subtype;
    return period;
  });
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

// Skill-based planning, complementing the built-in permissionMode/ExitPlanMode cycle above —
// planning done via skills (superpowers:brainstorming, superpowers:writing-plans, spec skills)
// never touches the plan permission mode, so it used to chart as uninterrupted `working`:
//   plan_start — a `Skill` tool_use for a plan/spec/brainstorm skill (exact timestamp).
//   plan_ready — the LAST matching plan-.md write before the cycle closes, i.e. the plan as it
//     stood when implementation began. Not the first write: a plan is authored over many edits.
// A cycle closes on the first of: an edit to a NON-matching file after at least one plan write
// (implementation started; the ≥1 gate keeps a scratchpad write during research from closing the
// cycle before there is anything to be ready), another planning-skill invoke, an execution skill,
// built-in plan mode starting (that mechanism owns its window — and skill entries inside it are
// suppressed, or the same window would double-emit), or end of transcript. A still-open cycle at
// EOF emits plan_ready at the last write so far; each Stop recompute slides it later until
// implementation begins — the server upserts, so this converges rather than drifts.
// No entry point → a matching .md write is ignored entirely.
// Returns the events plus the [start, ready] intervals buildPeriods paints as `planning`; a lone
// plan_start gets NO interval — an unclosed brainstorm must not paint the rest of the session.
function buildSkillPlanCycles(lines) {
  const events = [];
  const intervals = [];
  let inBuiltinPlan = false;
  let cycle = null; // { startMs, lastPlanMs }

  const close = () => {
    if (cycle == null) return;
    if (cycle.lastPlanMs != null) {
      events.push({ type: 'plan_ready', at: new Date(cycle.lastPlanMs).toISOString() });
      intervals.push({ startMs: cycle.startMs, endMs: cycle.lastPlanMs });
    }
    cycle = null;
  };

  for (const line of lines) {
    const pm = permissionModeOf(line);
    if (pm != null) {
      const nowPlan = isPlanMode(pm);
      if (nowPlan && !inBuiltinPlan) close();
      inBuiltinPlan = nowPlan;
    }
    if (line != null && line.type === 'permission-mode') continue; // no timestamp — mode flip only
    const ms = tsOf(line);
    if (ms == null) continue;

    if (!inBuiltinPlan && hasSkillMatching(line, isPlanningSkill)) {
      close(); // a new planning skill ends the previous cycle
      events.push({ type: 'plan_start', at: new Date(ms).toISOString() });
      cycle = { startMs: ms, lastPlanMs: null };
      continue;
    }
    if (cycle == null) continue;
    if (hasSkillMatching(line, isExcludedPlanSkill)) { close(); continue; }

    const edits = fileEditsOn(line);
    if (edits.plan) cycle.lastPlanMs = ms;
    if (edits.other && cycle.lastPlanMs != null) close();
  }
  close(); // end of transcript
  return { events, intervals };
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
// `deps.readPermissionMarkers` is injectable so the tests never touch the developer's real
// ~/.beezi/state — a stray marker file there would otherwise flip assertions on unrelated runs.
export function computeSessionTimeline(transcriptPath, sessionId, deps = {}) {
  let lines;
  try { lines = parseTranscript(transcriptPath); } catch { return null; }
  lines = dropLeadIn(lines);
  if (lines === null) return null;

  const readMarkers = deps.readPermissionMarkers == null ? readPermissionMarkers : deps.readPermissionMarkers;
  let markers;
  try { markers = readMarkers(sessionId); } catch { markers = []; }

  const skillPlan = buildSkillPlanCycles(lines);
  const periods = buildPeriods(lines, skillPlan.intervals, markers);
  const plan_events = buildPlanEvents(lines)
    .concat(skillPlan.events)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
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
