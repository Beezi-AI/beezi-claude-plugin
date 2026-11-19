// Delivery order for queued reports. Pure: names in, names out, no fs.
//
// A killed hook can re-emit a wider window from the same start line (`_10-120` next to `_10-80`).
// The server absorbs narrow-then-wide (the wide one supersedes the window it contains), but not
// wide-then-narrow: both rows would count. So inside one (scope, tenant suffix) group the files go
// by ascending end line, then descending start line — a contained window always precedes the
// window containing it. Groups are interleaved round-robin so one busy session cannot starve the
// others, and names this grammar does not know go last, in lexical order.

const RANGE = /^(.*)_(\d+)-(\d+)$/;
const SUFFIX = '.json';
const TENANT_SEP = '__';

// Code-unit order, not localeCompare: small-icu builds of old Node order `_` and case differently.
function compare(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// Queue names are `<segmentName>.json` or `<segmentName>__<tenantTag|ask>.json`, where
// segmentName is the segmentId `<scope>:<from>-<to>` with `:`, `/` and whitespace mapped to `_`.
// The scope may therefore contain `_` itself, so it is matched greedily up to the last `_<from>-<to>`.
// Returns { scope, from, to, tenant } or null for anything else (legacy, `.tmp`, `.corrupt`).
export function parseQueueName(name) {
  if (typeof name !== 'string' || name.length <= SUFFIX.length || name.slice(-SUFFIX.length) !== SUFFIX) return null;
  let stem = name.slice(0, -SUFFIX.length);
  let tenant = null;
  const sep = stem.lastIndexOf(TENANT_SEP);
  if (sep !== -1) {
    tenant = stem.slice(sep + TENANT_SEP.length);
    stem = stem.slice(0, sep);
  }
  const match = RANGE.exec(stem);
  if (match == null) return null;
  return { scope: match[1], from: Number(match[2]), to: Number(match[3]), tenant };
}

// Returns a new array in delivery order; the input is left untouched.
export function orderQueueFiles(names) {
  const groups = new Map();
  const unparsed = [];
  for (const name of names) {
    const parsed = parseQueueName(name);
    if (parsed == null) {
      unparsed.push(name);
      continue;
    }
    const key = `${parsed.scope}|${parsed.tenant == null ? '' : parsed.tenant}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ name, from: parsed.from, to: parsed.to });
  }

  const lanes = Array.from(groups.keys()).sort(compare).map((key) => groups.get(key).sort((a, b) => {
    if (a.to !== b.to) return a.to - b.to;
    if (a.from !== b.from) return b.from - a.from;
    return compare(a.name, b.name);
  }));

  const out = [];
  for (let round = 0; ; round += 1) {
    let took = false;
    for (const lane of lanes) {
      if (round < lane.length) {
        out.push(lane[round].name);
        took = true;
      }
    }
    if (!took) break;
  }
  return out.concat(unparsed.sort(compare));
}
