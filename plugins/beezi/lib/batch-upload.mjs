// Reading /sessions/report-batch answers. The sending lives in checkpoint.mjs's flushQueue.
//
// A batch answer deletes queue files, so only an answer read in full counts: any HTTP 2xx, JSON, and a
// `results` array with exactly one known status per report sent. Anything else is null, and the
// caller deletes nothing on it.

// The longest one batch POST may take. A flush with a deadline starts no batch later than this before it.
export const BATCH_POST_BUDGET_MS = 20000;
// Bound on reading a body once the headers are in: neither postJson nor the fetch shim's text() has a timer of its own.
const READ_MS = 2000;

const STATUSES = ['stored', 'rejected', 'retry'];

// The body as text (or parsed JSON when only json() exists), bounded in time. Null on any failure; never throws.
async function readBounded(res) {
  if (res == null) return null;
  const read = typeof res.text === 'function'
    ? () => res.text()
    : typeof res.json === 'function' ? () => res.json() : null;
  if (read == null) return null;
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(read).catch(() => null),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), READ_MS); }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

// The body parsed as JSON, or null. Bounded; never throws. Reads (and so drains) the body either way.
export async function readBoundedJson(res) {
  const raw = await readBounded(res);
  if (raw == null) return null;
  // Already parsed: the response had json() but no text().
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// readBatchResults(res, count) -> [{ status, code }] in sent order, or null unless the answer is a
// 2xx whose `results` has `count` items, each with a known status. A non-2xx body is still drained.
export async function readBatchResults(res, count) {
  if (res == null) return null;
  const body = await readBoundedJson(res);
  if (!(res.status >= 200 && res.status < 300) || body == null || !Array.isArray(body.results) || body.results.length !== count) return null;
  const items = [];
  for (const item of body.results) {
    if (item == null || STATUSES.indexOf(item.status) === -1) return null;
    items.push({ status: item.status, code: typeof item.code === 'string' ? item.code : null });
  }
  return items;
}
