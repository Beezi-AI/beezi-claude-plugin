import fs from 'fs';
import { extractPathSignal } from './repo-timeline.mjs';
import { computeCodeChanges } from './code-changes.mjs';
import { computeOperations } from './operations.mjs';
import { buildActiveIntervals, totalMs } from './active-time.mjs';

// Gaps longer than this between two activity lines count as idle, not active time. Exported so the
// session-timeline derivation classifies "working" against the exact same threshold.
export const IDLE_GAP_SEC = 300;

// Timestamped lines that mark WHEN THE SESSION RAN, as opposed to lines Claude Code stamps once
// nobody is at the keyboard any more. The three excluded kinds are what made a session look like
// it ENDED inside its own idle tail:
//   system/away_summary — the "while you were away" recap. It is the LAST timestamped record in
//     107 of 231 local transcripts, sometimes tens of minutes past the final turn.
//   queue-operation / attachment — bookkeeping replayed when a session is reopened with --resume
//     (date_change rollovers, SessionStart hook output, queued-command drains). On an overnight
//     resume these land ~19h after the work they trail.
// Everything else stays an anchor. system/turn_duration and system/stop_hook_summary in particular
// are stamped within milliseconds of the turn they close, and 77 transcripts legitimately end
// there, so they mark a real session end.
//
// Scope, deliberately narrow — this decides the reported SPAN (started_at/ended_at) and the
// session timeline's bands. It does NOT gate duration_sec: an attachment written mid-turn is
// genuine evidence the agent was working, and dropping those from the active-interval build
// under-counted billed time by 2.7% across the same corpus. Line numbers and line content are
// untouched too, so segmentId ranges stay stable and a session already reported live keeps
// upserting onto its existing row when the backfill re-reads it.
export function isTimingAnchor(line) {
  if (line == null) return false;
  if (line.type === 'queue-operation' || line.type === 'attachment') return false;
  if (line.type === 'system' && line.subtype === 'away_summary') return false;
  if (isPermissionTeardown(line)) return false;
  if (isLocalCommandEcho(line)) return false;
  // Injected context, not a human utterance: system-reminders, the expanded text of a slash
  // command, image references, the "Continue from where you left off" resume marker. Claude Code
  // stamps them when the session is assembled or a command is expanded, so they carry the same
  // walked-away timestamps the echo lines do. isRealUserPrompt already refuses to treat them as
  // turn-starts for the same reason; this extends that judgement to the clock.
  if (line.type === 'user' && line.isMeta === true) return false;
  // Claude Code's own placeholder in the assistant slot — "No response requested.", or an
  // API-connect failure. model === '<synthetic>' means no model was called and no tokens were
  // spent, so it records that nothing happened rather than that something did.
  if (line.type === 'assistant' && line.message != null && line.message.model === '<synthetic>') return false;
  return true;
}

// A local slash command the human ran in the terminal — /clear, /effort, /plugin, /model,
// /compact — is housekeeping, not work. Claude Code records the whole block as ordinary
// `type:'user'` lines (the caveat wrapper, the <command-name> echo, the captured stdout) plus a
// system/local_command, every one stamped the instant the command ran. When the human then walks
// away, those stamps open the session hours before anything happens: locally the worst case is
// /clear at 08:33 with the first real prompt at 12:28, so 236 minutes of nothing were reported as
// session time. The same block closes 8 transcripts that end on /plugin or /reload-plugins.
//
// Denying the whole block needs NO lookahead to tell "solid" housekeeping from a command that
// actually does something, which is what makes this a per-line rule at all:
//   * a command that spawns work — /code-review, /simplify, a skill that fans out subagents — is
//     followed within milliseconds by its expanded prompt and the assistant turn, and those are
//     anchors in their own right, so the session is still timed from when the work began;
//   * a command that spawns nothing leaves nothing behind to anchor, which is exactly the idle
//     stretch that should be skipped.
// Measured: /clear (82), /plugin (39), /effort (13), /plan (11), /model (9), /compact (6) are
// never followed by an assistant turn; /code-review, /simplify and the /beezi:* skills always are.
//
// Only string content is examined. The echo blocks are plain strings, whereas a genuine turn that
// merely quotes one of these markers arrives as content blocks — so quoting cannot fake an echo.
const LOCAL_COMMAND_MARKERS = ['<command-name>', '<local-command-caveat>', '<local-command-stdout>'];

function isLocalCommandEcho(line) {
  if (line.type === 'system' && line.subtype === 'local_command') return true;
  if (line.type !== 'user') return false;
  const message = line.message == null ? undefined : line.message;
  const content = message == null ? undefined : message.content;
  if (typeof content !== 'string') return false;
  for (let i = 0; i < LOCAL_COMMAND_MARKERS.length; i++) {
    if (content.indexOf(LOCAL_COMMAND_MARKERS[i]) !== -1) return true;
  }
  return false;
}

// The tool_result Claude Code writes when a pending permission request dies because the SESSION
// went away — the stream closed instead of the human answering — and which is only stamped when
// the session is reopened. In the one local instance it lands 18.5h after the work it trails.
//
// This is the only errored tool_result that means "nobody was there". Every other one in the
// corpus (8 land after an idle gap) is real session time: a tool that genuinely ran and failed
// ("Exit code 128", "Exit code 143 Command timed out after 5m 0s", docker builds), or a human who
// genuinely answered after thinking it over ("The user doesn't want to proceed with this tool
// use" — 9 and 95 minutes). So the match is deliberately this one message and not `is_error`,
// which would swallow all of them. Matching Claude Code's literal marker text is how the
// interrupt and task-notification markers are recognised too (see session-timeline.mjs).
const PERMISSION_TEARDOWN_PREFIX = 'Tool permission request failed';

function isPermissionTeardown(line) {
  if (line.type !== 'user') return false;
  const message = line.message == null ? undefined : line.message;
  const content = message == null ? undefined : message.content;
  if (!Array.isArray(content) || content.length === 0) return false;
  // EVERY block has to be teardown noise. Parallel tool calls answer in one batch, and a batch
  // that also carries a genuine result is a genuine moment — keep it.
  for (const b of content) {
    if (b == null) continue;
    if (b.type !== 'tool_result' || b.is_error !== true) return false;
    if (typeof b.content !== 'string' || b.content.indexOf(PERMISSION_TEARDOWN_PREFIX) !== 0) return false;
  }
  return true;
}

// Pull display text out of an assistant message (string content or text blocks).
function messageText(message) {
  const c = message == null ? undefined : message.content;
  if (typeof c === 'string') return c.trim() || null;
  if (Array.isArray(c)) {
    const text = c.filter((b) => b != null && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text).join('\n').trim();
    return text || null;
  }
  return null;
}

// Errors Claude Code retries on its own, using its own classification (the explicit flag, plus
// overloaded/server_error). Reporting these would bury the durable failures — no credits, auth
// revoked, rate limit — that a team actually needs to see.
function isTransientApiError(line) {
  return line.apiErrorIsTransient === true
    || line.error === 'overloaded'
    || line.error === 'server_error';
}

// Attribute each new transcript line to (repoRoot, branch): repo from tool-path signals,
// branch from the injected branchAt (per-repo reflog in production). Split the window into
// contiguous same-(repo, branch) runs; each maximal run is one segment with a disjoint
// fromLine..toLine range.
//
// Claude Code writes ONE transcript line per content block, so a single assistant message
// becomes several consecutive lines (thinking, text, tool_use…) that share one message id
// and repeat the same usage. Two consequences drive the shape below:
//   1. usage is counted once per message id (dedup), on its FIRST block-line;
//   2. the tool-path signal lives on the tool_use block-line, which is NOT the first.
// So we pre-resolve each message's repo signal across all its block-lines and apply it to
// every block-line (incl. the first) — otherwise a message's tokens bill to the repo that
// was active before its own tool_use ran, which is exactly the wrong repo on a switch.
export function computeDelta(transcriptPath, fromLine, resolvers = {}) {
  const cwd = resolvers.cwd == null ? null : resolvers.cwd;
  const repoRootOf = resolvers.repoRootOf == null ? ((dir) => dir) : resolvers.repoRootOf;
  const branchAt = resolvers.branchAt == null ? null : resolvers.branchAt;

  const content = fs.readFileSync(transcriptPath, 'utf-8');
  // Strip trailing newline(s): a JSONL file at rest ends with '\n', and the trailing empty
  // split element would otherwise advance the cursor past the last real line, skipping the
  // next window's first record.
  const trimmed = content.replace(/\n+$/, '');
  const raw = trimmed === '' ? [] : trimmed.split('\n');

  // Parse the new window (lines after the cursor) once; skip blank/malformed lines and keep
  // each surviving record with its 1-based line number. Both passes below reuse this.
  const parsed = [];
  for (let i = fromLine; i < raw.length; i++) {
    if (!raw[i].trim()) continue;
    let line;
    try { line = JSON.parse(raw[i]); } catch { continue; }
    parsed.push({ lineNo: i + 1, line });
  }

  // Pre-pass: message id -> last tool-path signal across all of the message's block-lines.
  const messageDir = new Map();
  for (const { line } of parsed) {
    const msgId = line.message == null ? undefined : line.message.id;
    const id = msgId == null ? (line.requestId == null ? null : line.requestId) : msgId;
    if (!id) continue;
    const dir = extractPathSignal(line, cwd);
    if (dir) messageDir.set(id, dir); // last-touch-wins within the message
  }

  const countedMessages = new Set();
  const segments = [];
  const apiErrorEvents = [];
  let run = null;
  let activeRoot = cwd != null ? repoRootOf(cwd) : null;
  // Last-touch-wins like activeRoot: a line that resolves no branch inherits rather than invents.
  let activeBranch = null;
  let lastToLine = null;

  const closeRun = () => {
    if (run) {
      // A run holding nothing but bookkeeping marks no session presence at all, so it bills no
      // clock either — two recap/queue stamps a second apart are not a second of work, and
      // letting them through would emit a payload with real duration and a null span. Any run
      // with even one real line keeps the unfiltered build, so this can never shorten real work.
      const activeIntervals = run.anchors.length
        ? buildActiveIntervals(run.timestamps, IDLE_GAP_SEC * 1000)
        : [];
      const stats = summarize(run.models, run.anchors, run.lines, activeIntervals);
      // Absent (not 0) when the window counted no assistant line, so zero-token segments
      // don't ship a fake empty context.
      if (run.contextFinal != null) {
        stats.context_peak_tokens = run.contextPeak;
        stats.context_final_tokens = run.contextFinal;
        stats.context_final_model = run.contextFinalModel;
      }
      segments.push({
        repoRoot: run.repoRoot,
        // Only site that passes a null ms: branchAt answers it with the repo's head branch.
        branch: run.branch != null
          ? run.branch
          : (branchAt ? branchAt(run.repoRoot, null) : '(unknown)'),
        fromLine: run.fromLine,
        toLine: run.toLine,
        // Deliberately outside `stats` (which is spread wholesale into the report payload): the
        // intervals feed the caller's cross-transcript union, they are not a reported field.
        activeIntervals,
        stats,
      });
      lastToLine = run.toLine;
      run = null;
    }
  };

  for (const { lineNo, line } of parsed) {
    const msgId = line.message == null ? undefined : line.message.id;
    const id = msgId == null ? (line.requestId == null ? null : line.requestId) : msgId;
    // Whole-message signal when known (applies to every block-line incl. the first, so the
    // message's tokens bill to the repo its own tool_use touched); else the line's own tool path;
    // else the line's own recorded cwd. The cwd fallback tracks `cd`s and attributes signal-less
    // lines (thinking / web-search / grep, and whole research subagents) to the repo they ran in,
    // instead of only the window's seed cwd — this is what recovers dropped subagent/cwd-change tokens.
    const toolDir = (id && messageDir.has(id)) ? messageDir.get(id) : extractPathSignal(line, cwd);
    const sigDir = toolDir || (typeof line.cwd === 'string' ? line.cwd : null);
    if (sigDir) {
      const sigRoot = repoRootOf(sigDir);
      if (sigRoot) {
        if (sigRoot !== activeRoot) activeBranch = null; // only a real move drops the branch
        activeRoot = sigRoot; // last-touch-wins; unresolvable -> carry forward
      }
    }

    // NaN collapses to null: an unparseable stamp resolves the reflog's oldest branch, not none.
    const stamp = line.timestamp ? new Date(line.timestamp).getTime() : NaN;
    const ms = Number.isFinite(stamp) ? stamp : null;
    const branch = branchAt
      ? (ms == null ? activeBranch : branchAt(activeRoot, ms))
      : (line.gitBranch || activeBranch);
    if (branch != null) activeBranch = branch;

    if (!run || run.repoRoot !== activeRoot || (branch != null && run.branch != null && run.branch !== branch)) {
      closeRun();
      // Open flush against the last run: a malformed line on the boundary reaches no run at all.
      const openAt = lastToLine == null ? lineNo : lastToLine + 1;
      run = { repoRoot: activeRoot, branch, fromLine: openAt, toLine: lineNo, models: {}, timestamps: [], anchors: [], lines: [] };
    }
    // The first line that names a branch defines the meta lines above it too.
    if (run.branch == null && branch != null) run.branch = branch;
    run.toLine = lineNo;
    run.lines.push(line);
    if (ms != null) {
      run.timestamps.push(ms);
      if (isTimingAnchor(line)) run.anchors.push(ms);
    }

    // Every API error the turn hit, not just rate limits: `line.error` carries the code
    // (rate_limit, billing_error, authentication_failed…); a 429 without one is a rate limit.
    if (line.isApiErrorMessage === true && !isTransientApiError(line)) {
      apiErrorEvents.push({
        error: typeof line.error === 'string'
          ? line.error
          : (line.apiErrorStatus === 429 ? 'rate_limit' : 'unknown'),
        text: messageText(line.message),
        occurredAt: line.timestamp == null ? null : line.timestamp,
        lineNo,
      });
    }

    if (line.type === 'assistant' && line.message != null && line.message.usage) {
      if (id && countedMessages.has(id)) continue;
      if (id) countedMessages.add(id);

      const model = line.message.model || 'unknown';
      const u = line.message.usage;
      const cacheCreation = u.cache_creation_input_tokens
        || Object.values(u.cache_creation || {}).reduce((a, x) => a + (x || 0), 0);

      // Reasoning effort rides each assistant line as a top-level field, stable across a
      // message's block-lines — reading it here (the dedup site) buckets each message exactly
      // once. Older Claude Code versions omit it -> the 'unknown' bucket, so the buckets always
      // partition the model tally above. Nested inside the model entry so summarize()'s models
      // spread ships it in the report payload untouched (mirrors operations.mcp.by_server).
      const effort = typeof line.effort === 'string' && line.effort !== '' ? line.effort : 'unknown';

      tally(run.models, model, effort, {
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0,
        cacheCreation,
      });

      // `usage.iterations` splits one turn into the legs the API actually billed. The top-level
      // fields above sum ONLY the legs of type 'message' — an `advisor_message` leg (the advisor
      // tool's own uncached call, on whichever model that request named) is left out entirely, so
      // reading top-level alone silently drops it. One local session lost 1,229,631 input and
      // 29,140 output tokens that way: $9.37 of a $57.20 session, 16% of its real cost.
      //
      // Deliberately an allowlist, not `type !== 'message'`. A leg type invented later may well
      // already be inside the top-level totals, and adding it twice would OVER-report what the
      // human spent. Undercounting an unknown leg is the failure we already have; inflating a
      // bill is a worse one. Widen this only against a transcript that proves the leg is excluded.
      const legs = Array.isArray(u.iterations) ? u.iterations : [];
      for (const leg of legs) {
        if (leg == null || leg.type !== 'advisor_message') continue;
        // The leg names its own model; it falls back to the parent's only when absent. Effort
        // comes off the parent line — the advisor's own effort is not recorded anywhere, and
        // 'unknown' already means "Claude Code too old to emit the field", not "not the parent".
        tally(run.models, leg.model || model, effort, {
          input: leg.input_tokens || 0,
          output: leg.output_tokens || 0,
          cacheRead: leg.cache_read_input_tokens || 0,
          cacheCreation: leg.cache_creation_input_tokens || 0,
        });
      }

      // Context the request ran with = prompt-side tokens. Sidechains (title generation etc.)
      // run tiny separate contexts and must not move the session's numbers.
      if (line.isSidechain !== true) {
        const contextTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + cacheCreation;
        run.contextPeak = Math.max(run.contextPeak == null ? 0 : run.contextPeak, contextTokens);
        run.contextFinal = contextTokens;
        run.contextFinalModel = model;
      }
    }
  }
  closeRun();
  const nextCursor = Math.max(fromLine, raw.length);
  // Widen the outer ranges over blank/malformed head and tail lines the cursor consumes anyway.
  if (segments.length > 0) {
    segments[0].fromLine = Math.min(segments[0].fromLine, fromLine + 1);
    const last = segments[segments.length - 1];
    last.toLine = Math.max(last.toLine, nextCursor);
  }
  return { nextCursor, segments, apiErrorEvents };
}

// Add one billed API call to a model bucket and to its effort sub-bucket, creating either on
// first sight. Shared by the parent turn and by each advisor leg inside it so the two can never
// drift — the effort buckets are contractually a partition of the model tally above them.
function tally(models, model, effort, t) {
  if (models[model] == null) {
    models[model] = {
      token_input: 0, token_output: 0, token_cache_read: 0, token_cache_creation: 0, requests: 0,
    };
  }
  const m = models[model];
  if (m.by_effort == null) m.by_effort = {};
  if (m.by_effort[effort] == null) {
    m.by_effort[effort] = {
      token_input: 0, token_output: 0, token_cache_read: 0, token_cache_creation: 0, requests: 0,
    };
  }
  for (const bucket of [m, m.by_effort[effort]]) {
    bucket.token_input += t.input;
    bucket.token_output += t.output;
    bucket.token_cache_read += t.cacheRead;
    bucket.token_cache_creation += t.cacheCreation;
    bucket.requests += 1;
  }
}

// `anchors` are the segment's session-marking stamps (isTimingAnchor), used only for the span.
// `activeIntervals` still comes off every stamp, so duration_sec is unaffected by that filter.
function summarize(models, anchors, lines, activeIntervals) {
  anchors.sort((a, z) => a - z);
  // Segment-local active time. The caller subtracts whatever an earlier transcript already
  // claimed before this reaches the wire — see checkpoint.mjs.
  const activeMs = totalMs(activeIntervals);
  const totals = Object.values(models).reduce((acc, m) => ({
    token_input: acc.token_input + m.token_input,
    token_output: acc.token_output + m.token_output,
    token_cache: acc.token_cache + m.token_cache_read + m.token_cache_creation,
  }), { token_input: 0, token_output: 0, token_cache: 0 });
  return {
    models,
    token_total: totals.token_input + totals.token_output + totals.token_cache,
    ...totals,
    duration_sec: Math.round(activeMs / 1000),
    code_changes: computeCodeChanges(lines),
    operations: computeOperations(lines),
    // The span is the first-to-last moment the session was actually running: the extremes of the
    // anchor stamps, with isTimingAnchor having already dropped the lines that mark no session
    // presence. Deliberately NOT the extremes of the active intervals — an anchor stranded past
    // an idle gap builds no interval, and once the bookkeeping kinds are filtered out the only
    // things left out there are real: across the corpus the two rules differ on 3 transcripts,
    // and in all 3 the interval form cut a genuine user prompt that ended the session.
    started_at: anchors.length ? new Date(anchors[0]).toISOString() : null,
    ended_at: anchors.length ? new Date(anchors[anchors.length - 1]).toISOString() : null,
  };
}
