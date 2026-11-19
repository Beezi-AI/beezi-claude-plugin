import { STOPPED, lastLine, outputLines, report, token } from './setup-routing.mjs';
import { markReported as _markReported } from './upload-progress.mjs';
import { isFinishing } from './upload-phase.mjs';
import { REST_LINE, doneLine, followUploads, liveLine, plainLine } from './upload-progress-view.mjs';

const FAILURE_LINE = /^(?:✗ |Beezi: )/;
const CLEAR_LINE = '\r\x1b[2K';
// Off a terminal setup runs under an agent's tool, whose call times out.
const PLAIN_CAP_MS = 100000;
// setup-main's left margin, and the widest row its format keeps whole (setup-style's wrapLines).
const MARGIN_COLUMNS = 2;
const MAX_ROW = 100;

function realSleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// A failed upload's stdout ✗ and Beezi: lines, then its stderr; never its route summary, workspace headers or progress.
function failureLines(result) {
  const said = outputLines(result.stdout).map((line) => line.trim()).filter((line) => FAILURE_LINE.test(line));
  const lines = said.concat(outputLines(result.stderr).map((line) => line.trimEnd()).filter((line) => line !== ''));
  return lines.length > 0 ? lines : [STOPPED];
}

// The live line cut to one row of a `columns`-wide terminal: the workspace name is shortened with '…', so the in-place
// redraw, which clears one row, never leaves a wrapped row behind. The finishing line already ends in '…', which then
// marks the cut name, so only the bar line gets one of its own.
function fittedLive(record, ascii, tick, columns) {
  const room = Math.min(Math.max((columns || 80) - 1, 20), MAX_ROW) - MARGIN_COLUMNS;
  const line = liveLine(record, { ascii, tick });
  if (line.length <= room) return line;
  const cut = isFinishing(record) ? '' : '…';
  const keep = record.workspace.length - (line.length - room) - cut.length;
  if (keep < 1) return `${line.slice(0, room - 1)}…`;
  return liveLine({ ...record, workspace: `${record.workspace.slice(0, keep).trimEnd()}${cut}` }, { ascii, tick });
}

// Follows the worker's progress records of `tenantIds` from `sinceMs`: on a terminal one line redrawn in place, else a
// plain line per change; each workspace's done line, or REST_LINE when following ends first. The worker carries on.
async function followPast(ctx, key, tenantIds, sinceMs) {
  const onTerminal = ctx.activity === true;
  const ascii = (ctx.platform || process.platform) === 'win32';
  const markReported = ctx.markReported || _markReported;
  const interrupt = ctx.interrupt || { stopped: false };
  // On a terminal each line replaces the bar drawn before it.
  const show = (line, end) => {
    if (onTerminal) ctx.output.write(CLEAR_LINE);
    ctx.print(line, end);
  };
  interrupt.following = true;
  let followed;
  try {
    followed = await followUploads({
      key,
      tenantIds,
      sinceMs,
      capMs: onTerminal ? Infinity : PLAIN_CAP_MS,
      shouldStop: () => interrupt.stopped,
      // On a terminal every poll redraws the spinner; off it a line per change.
      onUpdate: (record) => { if (!onTerminal) ctx.print(plainLine(record)); },
      onTick: (record, tick) => { if (onTerminal) show(fittedLive(record, ascii, tick, ctx.output.columns), ''); },
      onDone: (record) => {
        show(doneLine(record));
        // A failed write only lets the next session repeat the done line.
        try {
          markReported(key, record.tenantId);
        } catch {}
      },
      read: ctx.read,
      now: ctx.now,
      sleep: ctx.sleep || realSleep,
    });
  } finally {
    interrupt.following = false;
  }
  if (followed.stopped || followed.timedOut) show(REST_LINE);
}

// Queues the consented upload and follows it until each workspace is done; a failure prints only its failure lines.
export async function uploadPast(ctx, key) {
  const sinceMs = (ctx.now || Date.now)();
  const result = await ctx.run('backfill.mjs', ['--account', key, '--consented']);
  if (result.code !== 0) {
    failureLines(result).forEach((line) => ctx.print(line));
    return;
  }
  const line = lastLine(result.stdout, /^uploading=\d+ /);
  const tenants = line === null ? null : token(line, 'tenants');
  if (tenants === null || tenants === '') return;
  await followPast(ctx, key, tenants.split(','), sinceMs);
}

// The `crash=… statusline=…` line of `settings.mjs keys`, or null.
async function machineLine(ctx) {
  const keys = await ctx.run('settings.mjs', ['keys']);
  if (keys.code !== 0) report(ctx, keys);
  return lastLine(keys.stdout, /^crash=/);
}

// Crash reports on for an undecided machine and the status line installed when off; resolves what is on afterwards.
export async function applyDefaults(ctx) {
  const telemetry = await ctx.run('telemetry.mjs', ['default']);
  if (telemetry.code !== 0) report(ctx, telemetry);
  let line = await machineLine(ctx);
  if (line !== null && token(line, 'statusline') === 'off') {
    // A settings file the installer can't parse is not an error here: the status line just stays off.
    await ctx.run('statusline-install.mjs', []);
    line = await machineLine(ctx);
  }
  return {
    crash: line !== null && token(line, 'crash') !== 'off',
    statusline: line !== null && token(line, 'statusline') === 'on',
  };
}
