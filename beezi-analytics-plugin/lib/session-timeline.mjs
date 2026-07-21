import fs from 'node:fs';
import { listSubagentTranscripts } from './subagents.mjs';
import { IDLE_GAP_SEC } from './delta.mjs';
import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';

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
};

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
  return line?.timestamp ? new Date(line.timestamp).getTime() : null;
}

// The active permission mode, from either a dedicated `type:'permission-mode'` change line or the
// `permissionMode` stamped on a normal (user) line. Claude Code's `type:'mode'` lines carry the
// EDITOR mode ('normal'/'insert'), NOT the permission mode — reading those never surfaced planning.
// Neither the change line nor most work lines are timestamped/plan-stamped, so the mode is tracked
// forward from whichever line last set it.
function permissionModeOf(line) {
  if (line?.type === 'permission-mode' && typeof line.permissionMode === 'string') {
    return line.permissionMode;
  }
  return typeof line?.permissionMode === 'string' ? line.permissionMode : null;
}

// A Ctrl+C / Esc interrupt is written as a type:'user' line whose text is
// '[Request interrupted by user]' (or '...for tool use'). No Stop hook fires on an interrupt, so
// the aborted turn is only emitted at the next Stop/SessionEnd — and only classifies correctly if
// this marker is NOT read as a turn-start: the gap before it is the agent's aborted WORK, not the
// human thinking.
const INTERRUPT_PREFIX = '[Request interrupted by user';
function isInterruptMarker(line) {
  const c = line?.message?.content;
  if (!Array.isArray(c)) return false;
  return c.some(
    (b) => b?.type === 'text' && typeof b.text === 'string' && b.text.startsWith(INTERRUPT_PREFIX),
  );
}

// A genuine user turn-start, as opposed to a tool_result echo (Claude Code writes those as
// type:'user' too), an interrupt marker, or an injected meta line. The gap BEFORE such a line is
// time the agent spent waiting on the human.
function isRealUserPrompt(line) {
  if (line?.type !== 'user') return false;
  if (line.isMeta || line.isCompactSummary) return false;
  if (line.toolUseResult !== undefined) return false;
  if (isInterruptMarker(line)) return false;
  const c = line.message?.content;
  if (typeof c === 'string') return c.trim().length > 0;
  if (Array.isArray(c)) {
    if (c.some((b) => b?.type === 'tool_result')) return false;
    return c.some((b) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0);
  }
  return false;
}

// Walk the transcript in file order, tracking the active permission mode (set by permission-mode
// change lines and the permissionMode field on user lines; assistant work lines inherit the last
// value). Classify each interval between consecutive timestamped anchors, then merge adjacent
// same-state runs into periods.
function buildPeriods(lines) {
  let currentMode = 'default';
  const anchors = [];
  for (const line of lines) {
    const pm = permissionModeOf(line);
    if (pm != null) currentMode = pm;
    // A permission-mode change line has no timestamp — it flips the mode but isn't an anchor.
    if (line?.type === 'permission-mode') continue;
    const ms = tsOf(line);
    if (ms == null) continue;
    anchors.push({ ts: ms, isPrompt: isRealUserPrompt(line), mode: currentMode });
  }
  anchors.sort((a, b) => a.ts - b.ts);

  const merged = [];
  for (let i = 1; i < anchors.length; i++) {
    const prev = anchors[i - 1];
    const cur = anchors[i];
    if (cur.ts <= prev.ts) continue;
    let state;
    if (cur.isPrompt) state = STATE.WAITING_USER;
    else if (cur.ts - prev.ts > IDLE_GAP_SEC * 1000) state = STATE.IDLE;
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
  const content = line?.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((b) => b?.type === 'tool_use' && b.name === 'ExitPlanMode');
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
    if (line?.type === 'permission-mode') continue; // no timestamp — mode flip only
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

// Derive the whole session timeline from the transcript. Returns null when there's nothing to
// place on a time axis (no timestamped lines). generated_at stamps when it was computed.
export function computeSessionTimeline(transcriptPath, sessionId) {
  let lines;
  try { lines = parseTranscript(transcriptPath); } catch { return null; }

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
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (!payload?.sessionId || !Array.isArray(payload?.periods)) {
    return { reported: false, reason: 'missing-fields' };
  }
  if (!token) return { reported: false, reason: 'no-token' };
  try {
    const res = await postJson(`${apiBase()}${ENDPOINTS.sessionsTimeline}`, token, payload, { fetchImpl });
    return { reported: res.status >= 200 && res.status < 300, status: res.status };
  } catch {
    return { reported: false, reason: 'network' };
  }
}
