// Strict semver: no leading zeros in a core number, so "01.2.3" is not a version. Verified —
// the looser /^(\d+)\.(\d+)\.(\d+)$/ accepts "01.2.3" and would break the null case below.
const CORE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PRERELEASE_ID = /^[0-9A-Za-z-]+$/;
// Same rule for prerelease identifiers: "007" has a leading zero, so it is ALPHANUMERIC and
// compares as a string.
const NUMERIC_ID = /^(0|[1-9]\d*)$/;

export function parseVersion(value) {
  if (typeof value !== 'string') return null;
  let text = value.trim();
  if (text === '') return null;
  if (text.charAt(0) === 'v') text = text.slice(1);          // tolerate a tag-style leading v
  const plus = text.indexOf('+');
  if (plus !== -1) text = text.slice(0, plus);               // build metadata never affects order
  const dash = text.indexOf('-');
  const core = dash === -1 ? text : text.slice(0, dash);
  const match = CORE.exec(core);
  if (match == null) return null;
  let prerelease = [];
  if (dash !== -1) {
    const pre = text.slice(dash + 1);
    if (pre === '') return null;                             // "1.0.0-" is not a version
    prerelease = pre.split('.');
    for (let i = 0; i < prerelease.length; i++) {
      if (!PRERELEASE_ID.test(prerelease[i])) return null;    // catches "1.0.0-a..b"
    }
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease };
}

function compareNumbers(a, b) { if (a < b) return -1; if (a > b) return 1; return 0; }

function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;                              // release outranks its prerelease
  if (b.length === 0) return -1;
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const left = a[i], right = b[i];
    const leftNumeric = NUMERIC_ID.test(left), rightNumeric = NUMERIC_ID.test(right);
    if (leftNumeric && rightNumeric) {
      const byNumber = compareNumbers(Number(left), Number(right));
      if (byNumber !== 0) return byNumber;
      continue;
    }
    // The rule people drop: a numeric identifier always sorts BELOW an alphanumeric one.
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    if (left < right) return -1;
    if (left > right) return 1;
  }
  return compareNumbers(a.length, b.length);                 // more identifiers wins
}

export function compareVersions(a, b) {
  const left = parseVersion(a), right = parseVersion(b);
  if (left == null || right == null) return null;
  let r = compareNumbers(left.major, right.major); if (r !== 0) return r;
  r = compareNumbers(left.minor, right.minor);     if (r !== 0) return r;
  r = compareNumbers(left.patch, right.patch);     if (r !== 0) return r;
  return comparePrerelease(left.prerelease, right.prerelease);
}

// Fails CLOSED: an uncomparable pair is not "newer", so a malformed manifest entry or a
// hand-edited plugin.json can never produce a nag.
export function isNewer(candidate, current) {
  return compareVersions(candidate, current) === 1;
}
