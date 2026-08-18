// Turns a raw runtime error into a single, user-readable sentence for the CLI's ✗ line.
//
// Intentional, already-worded failures are thrown as UserError (or tagged `userFacing`)
// and pass through untouched. Everything else is classified by its Node error code so we
// never dump `fetch failed`, `ENOENT: no such file …`, or a JSON-parse stack at the user.
// The raw text stays reachable behind BEEZI_DEBUG for troubleshooting.

export class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
    this.userFacing = true;
  }
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT',
  'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
]);

const FS_CODES = new Set([
  'ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ENOTDIR', 'EROFS', 'EMFILE',
]);

// Node's fetch reports a transport failure as TypeError('fetch failed') with the real
// cause (and its code) nested under `.cause`; check both levels.
function codeOf(error) {
  if (error == null) return null;
  if (error.code != null) return error.code;
  return error.cause == null || error.cause.code == null ? null : error.cause.code;
}

function isNetwork(error) {
  const code = codeOf(error);
  if (code && (NETWORK_CODES.has(code) || String(code).startsWith('UND_ERR'))) return true;
  return error != null && error.message === 'fetch failed';
}

// An aborted fetch surfaces as a DOMException named AbortError with no `code`, so it
// reaches neither NETWORK_CODES nor 'fetch failed'; match on the name at both levels.
function isTimeout(error) {
  if (error == null) return false;
  const name = error.name != null
    ? error.name
    : (error.cause == null ? undefined : error.cause.name);
  return name === 'AbortError' || name === 'TimeoutError';
}

function isBadJson(error) {
  return error instanceof SyntaxError
    || /\bJSON\b/i.test(String(error == null || error.message == null ? '' : error.message));
}

export function friendlyMessage(error, { env = process.env } = {}) {
  if (error != null && error.userFacing) return error.message;

  if (isTimeout(error)) {
    return 'The login server took too long to respond. Check BEEZI_API_URL, then try again.';
  }

  if (isNetwork(error)) {
    return 'Could not reach the Beezi server. Check your internet connection and try again.';
  }

  const code = codeOf(error);
  if (FS_CODES.has(code)) {
    return `Could not access Beezi's local data (${code}). Check file permissions and try again.`;
  }

  if (isBadJson(error)) {
    return 'The Beezi server sent an unexpected response. Please try again in a moment.';
  }

  const message = error == null ? undefined : error.message;
  const raw = String(message == null ? (error == null ? '' : error) : message).trim();
  if (env != null && env.BEEZI_DEBUG && raw) return `Something went wrong: ${raw}`;
  return 'Something went wrong. Re-run with BEEZI_DEBUG=1 to see details.';
}
