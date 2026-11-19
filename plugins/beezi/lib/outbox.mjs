import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { outboxDir, tenantTag } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';

// Durable store for hook network work other than session reports: session errors, session
// timelines and the per-account usage snapshot. Hooks enqueue; the upload worker lists, claims
// (rename to `.sending`), sends and finishes each item. No token, refresh token or setup-token
// value is ever written here: enqueueOutbox builds the file body from the documented fields only.

export const OUTBOX_KINDS = Object.freeze({ ERROR: 'error', TIMELINE: 'timeline', SNAPSHOT: 'snapshot' });

const OUTBOX_VERSION = 1;
const MAX_SAMPLES = 40;
const SNAPSHOT_FILE = 'snapshot.json';
const KIND_ORDER = { error: 0, timeline: 1, snapshot: 2 };

// Same character rule as tenantTag: a session id from hook input must never steer the path.
function nameSafe(value) {
  return tenantTag(value);
}

function textOf(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

// One file per distinct error and tenant: the same error seen twice overwrites itself.
function errorFileName(sessionId, tenantId, payload) {
  const hash = crypto.createHash('sha1')
    .update(`${textOf(payload.error)}\n${textOf(payload.occurredAt)}`)
    .digest('hex')
    .slice(0, 12);
  return `error__${nameSafe(sessionId)}__${tenantTag(tenantId)}_${hash}.json`;
}

function kindOfName(name) {
  if (name.startsWith('error__')) return OUTBOX_KINDS.ERROR;
  if (name.startsWith('timeline__')) return OUTBOX_KINDS.TIMELINE;
  if (name === SNAPSHOT_FILE) return OUTBOX_KINDS.SNAPSHOT;
  return null;
}

function targetIds(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((id) => id === null || (typeof id === 'string' && id !== ''));
}

function unionTargets(a, b) {
  const out = [];
  for (const id of a.concat(b)) {
    if (out.indexOf(id) === -1) out.push(id);
  }
  return out;
}

function sampleKey(sample) {
  return `${sample.accountUuid == null ? '' : sample.accountUuid}\u0000${sample.fetchedAtMs}`;
}

function isSample(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

// Dedupe by (accountUuid, fetchedAtMs), keep the MAX_SAMPLES newest, oldest first.
function mergeSamples(existing, sample) {
  const seen = {};
  const out = [];
  for (const s of existing.concat(isSample(sample) ? [sample] : [])) {
    if (!isSample(s)) continue;
    const k = sampleKey(s);
    if (seen[k]) continue;
    seen[k] = true;
    out.push(s);
  }
  out.sort((x, y) => (Number(x.fetchedAtMs) || 0) - (Number(y.fetchedAtMs) || 0));
  return out.length > MAX_SAMPLES ? out.slice(out.length - MAX_SAMPLES) : out;
}

function requireSessionItem(item) {
  if (typeof item.sessionId !== 'string' || item.sessionId === '') {
    throw new TypeError(`outbox ${item.kind} item needs a sessionId`);
  }
  if (item.payload == null || typeof item.payload !== 'object') {
    throw new TypeError(`outbox ${item.kind} item needs a payload`);
  }
}

// Writes one item and returns its file name. Only kind, tenantId, sessionId (name only),
// payload, targets and sample are read from `item`; anything else on it is ignored.
export function enqueueOutbox(key, item) {
  const kind = item == null ? null : item.kind;
  if (kind !== OUTBOX_KINDS.ERROR && kind !== OUTBOX_KINDS.TIMELINE && kind !== OUTBOX_KINDS.SNAPSHOT) {
    throw new TypeError(`unknown outbox kind: ${kind}`);
  }
  const dir = outboxDir(key);
  const tenantId = item.tenantId == null ? null : String(item.tenantId);
  const createdAt = new Date().toISOString();

  if (kind === OUTBOX_KINDS.SNAPSHOT) {
    const filePath = path.join(dir, SNAPSHOT_FILE);
    const prior = readJson(filePath, null);
    const valid = prior != null && prior.version === OUTBOX_VERSION && prior.kind === OUTBOX_KINDS.SNAPSHOT;
    const body = {
      version: OUTBOX_VERSION,
      kind,
      tenantId,
      payload: null,
      targets: unionTargets(valid ? targetIds(prior.targets) : [], targetIds(item.targets)),
      samples: mergeSamples(valid && Array.isArray(prior.samples) ? prior.samples : [], item.sample),
      createdAt: valid && typeof prior.createdAt === 'string' ? prior.createdAt : createdAt,
    };
    writeJsonSecure(filePath, body);
    return SNAPSHOT_FILE;
  }

  requireSessionItem(item);
  const name = kind === OUTBOX_KINDS.ERROR
    ? errorFileName(item.sessionId, tenantId, item.payload)
    : `timeline__${nameSafe(item.sessionId)}__${tenantTag(tenantId)}.json`;
  writeJsonSecure(path.join(dir, name), {
    version: OUTBOX_VERSION,
    kind,
    tenantId,
    payload: item.payload,
    targets: null,
    samples: null,
    createdAt,
  });
  return name;
}

// Errors first, then timelines, then the snapshot; by name within a kind. Only `*.json`, so a
// `.tmp`, a claimed `.sending` and a quarantined `.corrupt` are never listed. A file that does
// not parse, or whose kind does not match its name, is renamed `.corrupt` (pruneStale expires it).
// A file of a newer version is skipped but left alone: a newer plugin may own it.
export function listOutbox(key) {
  const dir = outboxDir(key);
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const entries = [];
  for (const name of files) {
    if (!name.endsWith('.json')) continue;
    const kind = kindOfName(name);
    if (kind == null) continue;
    const filePath = path.join(dir, name);
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue; // claimed or removed between readdir and read
    }
    let item = null;
    try {
      item = JSON.parse(raw);
    } catch {
      item = null;
    }
    const isObject = item != null && typeof item === 'object' && !Array.isArray(item);
    if (isObject && typeof item.version === 'number' && item.version > OUTBOX_VERSION) continue;
    if (!isObject || item.version !== OUTBOX_VERSION || item.kind !== kind) {
      try { fs.renameSync(filePath, `${filePath}.corrupt`); } catch { /* best-effort */ }
      continue;
    }
    entries.push({ name, filePath, item });
  }
  entries.sort((a, b) => {
    const byKind = KIND_ORDER[a.item.kind] - KIND_ORDER[b.item.kind];
    if (byKind !== 0) return byKind;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return entries;
}

// Claims an item for sending by an atomic rename. Null when it is gone (another worker claimed
// it, or it was delivered) or cannot be renamed right now.
export function claimOutbox(filePath) {
  const claimed = `${filePath}.${process.pid}.sending`;
  try {
    fs.renameSync(filePath, claimed);
    return claimed;
  } catch {
    return null;
  }
}

function unlinkQuiet(p) {
  try { fs.unlinkSync(p); } catch { /* already gone */ }
}

// Settles a claimed item. Delivered: the claimed file goes. Not delivered: it goes back to
// `filePath` only if nothing new was enqueued there meanwhile (a newer enqueue wins and the
// claimed copy goes). A claimed file that is already gone is not an error: pruneStale may have
// put it back during a long send, and the worst outcome is then a duplicate send, never a loss.
// Returns 'removed' | 'restored' | 'superseded' | 'gone'.
export function finishOutbox(claimedPath, filePath, delivered) {
  if (delivered) {
    unlinkQuiet(claimedPath);
    return 'removed';
  }
  try {
    // link fails with EEXIST when filePath exists, so "restore only if absent" has no window.
    fs.linkSync(claimedPath, filePath);
  } catch (error) {
    const code = error == null ? null : error.code;
    if (code === 'ENOENT') return 'gone';
    if (code === 'EEXIST') {
      unlinkQuiet(claimedPath);
      return 'superseded';
    }
    // No hard links on this filesystem: check, then rename.
    if (fs.existsSync(filePath)) {
      unlinkQuiet(claimedPath);
      return 'superseded';
    }
    try {
      fs.renameSync(claimedPath, filePath);
      return 'restored';
    } catch {
      return 'gone';
    }
  }
  unlinkQuiet(claimedPath);
  return 'restored';
}

// Folds an undelivered snapshot into snapshot.json through enqueueOutbox's read-merge-write
// (targets union, samples deduped), so a newer snapshot written mid-send loses nothing.
// `enqueue` is injectable for the delivery worker's test seam.
export function mergeSnapshotBack(key, item, enqueue = enqueueOutbox) {
  const targets = targetIds(item.targets);
  const samples = Array.isArray(item.samples) ? item.samples.filter(isSample) : [];
  const base = { kind: OUTBOX_KINDS.SNAPSHOT, tenantId: item.tenantId, targets };
  if (samples.length === 0) enqueue(key, base);
  for (const sample of samples) enqueue(key, Object.assign({}, base, { sample }));
}

// Settles a claimed snapshot that was not delivered. finishOutbox's not-delivered rule would drop
// the claimed copy whenever a newer snapshot.json exists; a snapshot accumulates targets and
// samples, so the claimed one is merged into the newer one instead. `item` is the claimed body.
// Used by the delivery worker (a failed send) and by pruneStale (a dead worker's claim).
export function keepSnapshotClaim(key, claimedPath, filePath, item, deps = {}) {
  const enqueue = deps.enqueueOutbox == null ? enqueueOutbox : deps.enqueueOutbox;
  const finish = deps.finishOutbox == null ? finishOutbox : deps.finishOutbox;
  try {
    if (fs.existsSync(filePath)) {
      mergeSnapshotBack(key, item, enqueue);
      finish(claimedPath, filePath, true);
      return;
    }
  } catch {
    // Could not merge: fall through to the plain rule, which keeps it when nothing newer exists.
  }
  // A snapshot written between the check and the restore supersedes the claimed copy, which
  // finishOutbox then drops: fold this item (still in memory) into the newer one.
  if (finish(claimedPath, filePath, false) === 'superseded') {
    try { mergeSnapshotBack(key, item, enqueue); } catch { /* best-effort */ }
  }
}

// True for a parsed outbox body this version can merge as a snapshot.
export function isSnapshotItem(item) {
  return item != null && typeof item === 'object' && !Array.isArray(item)
    && item.version === OUTBOX_VERSION && item.kind === OUTBOX_KINDS.SNAPSHOT;
}
