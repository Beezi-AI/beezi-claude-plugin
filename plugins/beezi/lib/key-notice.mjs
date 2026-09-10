import { readJson, writeJsonSecure } from './fs-store.mjs';
import { keyNoticeFile } from './paths.mjs';

// One-shot delivery for notices about a specific setup token.
//
// The case that needs it: the portal says this key is bound to an account carrying an identity of
// its own — a subscription some interactive sign-in established — and nobody ever confirmed a plan
// for the KEY. The usage is being priced against that subscription, which may not be the one the
// token belongs to. Worth saying once.
//
// Deliberately once per fingerprint, unlike every other session-start nudge. The others name a
// command the user can run right now; this one does not. `/link` refuses an account that has its
// own identity, so there is nothing the terminal can offer — the fix is an admin's. A line the
// reader cannot act on, repeated at the top of every session, is noise, and noise is how the
// actionable nudges beside it stop being read.
//
// Keyed by fingerprint, so rotating the token re-arms it: a different key is a different question.

const NOTICE_VERSION = 1;

// The stored key. Matches oauthTokenAnchor's value format on purpose — same three fields, same
// separator — so the two can be eyeballed against each other in a support conversation.
function noticeKey(fingerprint) {
  if (fingerprint == null) return null;
  const prefix = typeof fingerprint.prefix === 'string' ? fingerprint.prefix : null;
  const last4 = typeof fingerprint.last4 === 'string' ? fingerprint.last4 : null;
  const length = typeof fingerprint.length === 'number' && Number.isFinite(fingerprint.length)
    ? fingerprint.length
    : null;
  if (prefix == null || last4 == null || length == null) return null;
  return `${prefix}...${last4}:${length}`;
}

function readNotices(deps) {
  const read = deps.readJsonImpl == null ? readJson : deps.readJsonImpl;
  const raw = read(keyNoticeFile(), null);
  if (!raw || raw.version !== NOTICE_VERSION || !Array.isArray(raw.notified)) return [];
  return raw.notified.filter((entry) => typeof entry === 'string');
}

// Has this key already been told? Unreadable state reads as "not yet": showing a notice twice is a
// smaller failure than never showing it at all.
export function hasKeyBeenNotified(fingerprint, deps = {}) {
  const key = noticeKey(fingerprint);
  if (key == null) return false;
  try {
    return readNotices(deps).indexOf(key) !== -1;
  } catch {
    return false;
  }
}

// Record that it has. Best-effort by contract — the caller is a session-start hook, and a failed
// marker write must cost at most one repeated line, never a broken session.
export function markKeyNotified(fingerprint, deps = {}) {
  const key = noticeKey(fingerprint);
  if (key == null) return false;
  const write = deps.writeJsonImpl == null ? writeJsonSecure : deps.writeJsonImpl;
  try {
    const notified = readNotices(deps);
    if (notified.indexOf(key) !== -1) return true;
    notified.push(key);
    // Bounded: a machine that rotates its token often must not grow this file without limit. The
    // oldest entries go first — a key nobody has used for that many rotations asking again is a
    // fair trade against an unbounded file.
    const capped = notified.length > 20 ? notified.slice(notified.length - 20) : notified;
    write(keyNoticeFile(), { version: NOTICE_VERSION, notified: capped });
    return true;
  } catch {
    return false;
  }
}
