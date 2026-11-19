import { isLive, readProgress } from './upload-progress.mjs';
import { FINISHING_PLAIN, finishingText, isFinishing, spinnerFrame } from './upload-phase.mjs';

const BAR_CELLS = 14;
const GLYPHS = { unicode: ['▓', '░'], ascii: ['#', '-'] };
const POLL_MS = 1000;
const NO_RECORD_MS = 120000;
// A record started this long before the follower still belongs to its run.
const FRESH_SLACK_MS = 5000;

export const REST_LINE = 'Beezi: the rest keeps uploading in the background';

export function progressBar(processed, total, { ascii = false } = {}) {
  const [done, left] = ascii ? GLYPHS.ascii : GLYPHS.unicode;
  const filled = total ? Math.round((BAR_CELLS * processed) / total) : 0;
  return done.repeat(filled) + left.repeat(BAR_CELLS - filled);
}

export function barLine(record, { ascii = false } = {}) {
  const bar = progressBar(record.processed, record.total, { ascii });
  return `Uploading past sessions to ${record.workspace}  ${bar}  ${record.processed}/${record.total}`;
}

// The terminal's live row: a spinner frame, then the bar while reading or the finishing text once every session is read.
export function liveLine(record, { ascii = false, tick = 0 } = {}) {
  const text = isFinishing(record) ? finishingText(record.workspace) : barLine(record, { ascii });
  return `${spinnerFrame(tick, { ascii })} ${text}`;
}

export function plainLine(record) {
  if (isFinishing(record)) return FINISHING_PLAIN;
  return `Beezi: ${record.processed}/${record.total} sessions read…`;
}

export function doneLine(record) {
  const noun = record.sent === 1 ? 'past session' : 'past sessions';
  return `✓ ${record.sent} ${noun} uploaded to ${record.workspace}`;
}

function isFresh(record, sinceMs) {
  return Date.parse(record.startedAt) >= sinceMs - FRESH_SLACK_MS;
}

export async function followUploads({
  key,
  tenantIds,
  sinceMs,
  capMs = Infinity,
  shouldStop = () => false,
  onUpdate,
  onTick = () => {},
  onDone,
  read = readProgress,
  now = Date.now,
  sleep,
}) {
  const finished = [];
  const startMs = now();
  let index = 0;
  let lastSeenMs = startMs;
  let lastProcessed = null;
  let tick = 0;
  while (index < tenantIds.length) {
    if (shouldStop()) return { finished, timedOut: false, stopped: true };
    const nowMs = now();
    if (nowMs - startMs >= capMs) return { finished, timedOut: true, stopped: false };
    const record = read(key, tenantIds[index]);
    if (record && isFresh(record, sinceMs)) {
      // A run that did not end clean left the rest to the worker: no done line, never reported.
      if (record.finishedAt != null && record.failed === true) return { finished, timedOut: false, stopped: true };
      if (record.finishedAt != null) {
        onDone(record);
        finished.push(record);
        index += 1;
        lastSeenMs = nowMs;
        lastProcessed = null;
        continue;
      }
      if (isLive(record, nowMs)) {
        lastSeenMs = nowMs;
        if (record.processed !== lastProcessed) onUpdate(record);
        lastProcessed = record.processed;
        onTick(record, tick);
        tick += 1;
      }
    }
    if (nowMs - lastSeenMs >= NO_RECORD_MS) return { finished, timedOut: false, stopped: true };
    await sleep(POLL_MS);
  }
  return { finished, timedOut: false, stopped: false };
}
