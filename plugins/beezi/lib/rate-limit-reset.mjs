// "resets 4:30pm (Europe/Kiev)" -> the next UTC instant of that wall-clock in that zone after occurredAt.
// "resets Oct 23, 11pm (Europe/Kyiv)" -> that calendar day's wall-clock; Claude Code names the date
// when the reset is more than a day out (a weekly limit), so the next-occurrence rule can't apply.
const RESET_RE = /resets?\s+(?:at\s+)?(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(([^)]+)\)/i;
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// The exact reset Claude Code stamps on a rate-limit transcript line, in unix seconds:
// apiErrorParams.rate_limit_info.resetsAt, mirrored in quotaLimits.resetsAt. ISO string or null.
// Preferred over parseRateLimitReset: it needs no text, so it survives a scrubbed message too.
export function exactResetsAt(line) {
  if (line == null) return null;
  const params = line.apiErrorParams == null ? null : line.apiErrorParams.rate_limit_info;
  const fromParams = params == null ? null : epochSecondsToIso(params.resetsAt);
  if (fromParams != null) return fromParams;
  return line.quotaLimits == null ? null : epochSecondsToIso(line.quotaLimits.resetsAt);
}

function epochSecondsToIso(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

export function parseRateLimitReset(text, occurredAtIso) {
  if (!text) return null;
  const match = RESET_RE.exec(text);
  if (!match) return null;
  const occurredAt = new Date(occurredAtIso);
  if (isNaN(occurredAt.getTime())) return null;

  let hour = Number(match[3]);
  const minute = match[4] ? Number(match[4]) : 0;
  const meridiem = match[5] ? match[5].toLowerCase() : null;
  const timeZone = match[6].trim();
  if (minute > 59) return null;

  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === 'pm' && hour !== 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
  } else if (hour > 23) {
    return null;
  }

  if (!isValidTimeZone(timeZone)) return null;
  if (match[1] == null) return nextOccurrenceUtc(hour, minute, timeZone, occurredAt).toISOString();

  const month = MONTHS.indexOf(match[1].toLowerCase()) + 1;
  const day = Number(match[2]);
  if (month === 0) return null;
  const dated = nextDatedOccurrenceUtc(month, day, hour, minute, timeZone, occurredAt);
  return dated == null ? null : dated.toISOString();
}

// The text names month and day but no year: the first such date after occurredAt, in that zone.
function nextDatedOccurrenceUtc(month, day, hour, minute, timeZone, after) {
  const year = zonedDateParts(after, timeZone).year;
  for (const y of [year, year + 1]) {
    // Feb 30 rolls into March in Date.UTC; a day that does not survive the round trip is not real.
    if (new Date(Date.UTC(y, month - 1, day)).getUTCDate() !== day) continue;
    const candidate = zonedWallToUtc({ year: y, month, day }, hour, minute, timeZone);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  return null;
}

function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

// Reads numeric calendar/clock fields of `instant` as rendered with `options`.
function zonedFieldReader(instant, options) {
  const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(instant);
  return (type) => {
    const part = parts.find((p) => p.type === type);
    return Number(part == null ? '0' : part.value);
  };
}

function zonedDateParts(instant, timeZone) {
  const get = zonedFieldReader(instant, { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return { year: get('year'), month: get('month'), day: get('day') };
}

// Milliseconds to add to a UTC wall-clock to get the real instant in `timeZone` at `instant`.
function tzOffsetMs(instant, timeZone) {
  const get = zonedFieldReader(instant, {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - (instant.getTime() - instant.getMilliseconds());
}

function zonedWallToUtc(date, hour, minute, timeZone) {
  const naiveUtc = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  return new Date(naiveUtc - tzOffsetMs(new Date(naiveUtc), timeZone));
}

function nextOccurrenceUtc(hour, minute, timeZone, after) {
  const candidate = zonedWallToUtc(zonedDateParts(after, timeZone), hour, minute, timeZone);
  if (candidate.getTime() > after.getTime()) return candidate;
  const tomorrow = zonedDateParts(new Date(after.getTime() + DAY_MS), timeZone);
  return zonedWallToUtc(tomorrow, hour, minute, timeZone);
}
