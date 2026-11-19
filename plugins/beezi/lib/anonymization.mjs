import { oneLine } from './one-line.mjs';
import { PRIVATE_MARK, ANON_KINDS, AnonKind, anonymizeReport, without } from './anonymize.mjs';

export { PRIVATE_MARK };

const KEY_PATTERN = /^[0-9a-f]{64}$/;
export const PastSessionsChoice = Object.freeze({ OFFER: 'offer', UPLOAD: 'upload', SKIP: 'skip' });
const PAST_SESSIONS_DEFAULT = { choice: PastSessionsChoice.OFFER, changedAt: null };

// A kinds object with all five K1 booleans gives its true keys; any other shape gives all five.
function parseKinds(raw) {
  const wellFormed = raw != null && typeof raw === 'object' && ANON_KINDS.every((k) => typeof raw[k] === 'boolean');
  return wellFormed ? ANON_KINDS.filter((k) => raw[k]) : ANON_KINDS.slice();
}

// Absent block → null (old server); a non-object block parses as empty, so it hides all five; a malformed key is dropped.
export function parseAnonymization(raw, tenantId) {
  if (raw == null) return null;
  const block = typeof raw === 'object' ? raw : {};
  return {
    tenantId: typeof tenantId === 'string' ? tenantId : null,
    kinds: parseKinds(block.kinds),
    key: typeof block.key === 'string' && KEY_PATTERN.test(block.key) ? block.key : null,
    machineName: oneLine(block.machineName),
  };
}

export function parsePastSessions(raw) {
  if (raw == null || typeof raw !== 'object') return { ...PAST_SESSIONS_DEFAULT };
  return {
    choice: Object.values(PastSessionsChoice).indexOf(raw.choice) !== -1 ? raw.choice : PastSessionsChoice.OFFER,
    changedAt: typeof raw.changedAt === 'string' && Number.isFinite(Date.parse(raw.changedAt)) ? raw.changedAt : null,
  };
}

// A present block whose kinds are not a list hides every kind.
export function kindsOf(block) {
  if (block == null) return [];
  return Array.isArray(block.kinds) ? ANON_KINDS.filter((k) => block.kinds.indexOf(k) !== -1) : ANON_KINDS.slice();
}

function fieldOf(holder, field) {
  return holder[field] == null ? null : holder[field];
}

// The workspace a lookup resolves to: tenantId, else the lone workspace, else null (the top-level block).
function scopeId(holder, tenantId) {
  if (tenantId != null) return tenantId;
  return Array.isArray(holder.tenants) && holder.tenants.length === 1 ? holder.tenants[0].id : null;
}

// A workspace with no value of its own takes the top level only when ownerOf(top) names it.
function resolveFor(holder, tenantId, field, ownerOf) {
  const tenants = Array.isArray(holder.tenants) ? holder.tenants : null;
  const top = fieldOf(holder, field);
  const id = scopeId(holder, tenantId);
  if (id == null) return top;
  const entry = tenants == null ? null : tenants.find((t) => t.id === id);
  const own = entry == null ? null : fieldOf(entry, field);
  if (own != null) return own;
  return top != null && ownerOf(top) === id ? top : null;
}

export function anonymizationFor(session, tenantId) {
  return resolveFor(session, tenantId, 'anonymization', (top) => top.tenantId);
}

// The top-level choice belongs to the row's own tenant.
export function pastSessionsFor(row, tenantId) {
  const found = resolveFor(row, tenantId, 'pastSessions', () => row.tenantId);
  return found == null ? { ...PAST_SESSIONS_DEFAULT } : found;
}

// The account row's workspaces, anonymization blocks and past-sessions choices, so authHeaders can pick the host header.
export function anonymizationScope(row) {
  return row == null ? {} : { tenants: row.tenants, anonymization: row.anonymization, pastSessions: row.pastSessions };
}

export function hasKind(block, kind) {
  return kindsOf(block).indexOf(kind) !== -1;
}

export function unionKinds(lists) {
  return ANON_KINDS.filter((kind) => lists.some((list) => list.indexOf(kind) !== -1));
}

// A legacy array marker names tenants captured private before kinds existed, so each gets every kind.
function markOf(payload) {
  const mark = payload[PRIVATE_MARK];
  if (Array.isArray(mark)) {
    const map = {};
    mark.forEach((id) => { map[id] = ANON_KINDS; });
    return map;
  }
  return mark != null && typeof mark === 'object' ? mark : {};
}

function withoutMark(payload) {
  return without(payload, [PRIVATE_MARK]);
}

// A null target resolves to its block's own tenant id; a block without one cannot be marked.
export function privateKinds(plans) {
  const map = {};
  for (const p of plans) {
    for (const t of p.targets.concat(p.hold)) {
      const block = anonymizationFor(p.session, t);
      const id = t == null ? (block == null ? null : block.tenantId) : t;
      const kinds = kindsOf(block);
      if (id != null && kinds.length > 0) map[id] = unionKinds([map[id] || [], kinds]);
    }
  }
  return map;
}

// The entries of a kind map whose kinds hide accounts.
export function accountKinds(kindMap) {
  const map = {};
  Object.keys(kindMap).forEach((id) => { if (kindMap[id].indexOf(AnonKind.ACCOUNTS) !== -1) map[id] = kindMap[id]; });
  return map;
}

// Each target's current kinds, keyed by workspace, for the targets that hide accounts.
export function accountKindMap(targets) {
  return accountKinds(privateKinds(targets.map((session) => ({ session, targets: [session.tenantId], hold: [] }))));
}

export function markPrivate(payload, kindMap) {
  const mark = Object.assign({}, markOf(payload));
  Object.keys(kindMap).forEach((id) => { mark[id] = unionKinds([mark[id] || [], kindMap[id]]); });
  const out = withoutMark(payload);
  if (Object.keys(mark).length > 0) out[PRIVATE_MARK] = mark;
  return out;
}

export function markedKinds(payload, tenantId) {
  const kinds = markOf(payload)[tenantId];
  return Array.isArray(kinds) ? unionKinds([kinds]) : [];
}

// The kinds captured for the tenant plus the ones it applies now.
export function wireKinds(payload, session, tenantId) {
  const block = anonymizationFor(session, tenantId);
  const id = tenantId || (block && block.tenantId);
  return unionKinds([id == null ? [] : markedKinds(payload, id), kindsOf(block)]);
}

// The marker stripped and the wire kinds applied; null when a kind applies but no key is known.
export function reportForWire(payload, session, tenantId) {
  const kinds = wireKinds(payload, session, tenantId);
  if (kinds.length === 0) return withoutMark(payload);
  const block = anonymizationFor(session, tenantId);
  return block != null && block.key != null ? anonymizeReport(payload, block.key, kinds) : null;
}
