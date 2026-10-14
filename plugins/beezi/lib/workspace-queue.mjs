import fs from 'fs';
import path from 'path';
import { queueDir, tenantTag } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { isMultiTenant, readSessionWorkspace, resolveTargets, tenantsOf, QUEUE_HOLD_MS } from './workspace.mjs';

const QUEUE_VERSION = 1;
const HOLD_ASK = 'ask';
const ASK_SUFFIX = '__ask.json';

function segmentName(payload) {
  return payload.segmentId.replace(/[:/\s]/g, '_');
}

function stringIds(value) {
  return Array.isArray(value) ? value.filter((id) => typeof id === 'string' && id !== '') : null;
}

// Multi-workspace copies are <seg>__<tenantTag>.json; everything else keeps <seg>.json.
export function enqueue(key, payload, tenantId = null, { multi = false } = {}) {
  // 0600: these payloads carry session_name (prompt text), remote, and branch.
  const seg = segmentName(payload);
  const filename = multi && tenantId != null ? `${seg}__${tenantTag(tenantId)}.json` : `${seg}.json`;
  writeJsonSecure(path.join(queueDir(key), filename), { version: QUEUE_VERSION, tenantId, payload });
}

// The Ask portion, held until the session answers: <seg>__ask.json.
export function enqueueHeld(key, payload, askTenants) {
  const file = path.join(queueDir(key), `${segmentName(payload)}${ASK_SUFFIX}`);
  writeJsonSecure(file, { version: QUEUE_VERSION, tenantId: null, hold: HOLD_ASK, askTenants: stringIds(askTenants) || [], payload });
}

// Queue files are { version, tenantId, payload[, hold, askTenants] } envelopes; a file without a payload object is a legacy raw payload.
export function unwrapQueueFile(value) {
  if (value != null && typeof value === 'object' && value.payload != null && typeof value.payload === 'object') {
    return {
      tenantId: typeof value.tenantId === 'string' ? value.tenantId : null,
      payload: value.payload,
      hold: value.hold === HOLD_ASK ? HOLD_ASK : null,
      askTenants: stringIds(value.askTenants),
    };
  }
  return { tenantId: null, payload: value, hold: null, askTenants: null };
}

// Held = an ask hold, or a 0.32-era unstamped file on a multi-workspace account (askTenants null = every current workspace).
function isHeld(entry, row) {
  return entry.hold === HOLD_ASK || (entry.tenantId == null && isMultiTenant(row));
}

function heldSegment(filePath) {
  const base = path.basename(filePath);
  return base.endsWith(ASK_SUFFIX) ? base.slice(0, -ASK_SUFFIX.length) : base.slice(0, -'.json'.length);
}

// Copies a held file to each target it may reach, then drops it once the session is no longer pending; returns { written: [file names], deleted, expired }.
export function releaseHeldFile(filePath, row, state) {
  const none = { written: [], deleted: false, expired: false };
  if (!isMultiTenant(row)) return none;
  const value = readJson(filePath, null);
  if (value == null) return none;
  const entry = unwrapQueueFile(value);
  if (entry.payload == null || typeof entry.payload !== 'object' || !isHeld(entry, row)) return none;

  let stat;
  try { stat = fs.statSync(filePath); } catch { return none; }
  if (Date.now() - stat.mtimeMs > QUEUE_HOLD_MS) {
    try { fs.unlinkSync(filePath); return { written: [], deleted: true, expired: true }; } catch { return none; }
  }

  const resolved = resolveTargets(row, state);
  const eligible = entry.askTenants == null ? tenantsOf(row).map((t) => t.id) : entry.askTenants;
  const due = resolved.targets.filter((t) => t != null && eligible.indexOf(t) !== -1);
  const dir = path.dirname(filePath);
  const seg = heldSegment(filePath);
  const written = [];
  // Tenants whose copy could not be written stay in the hold for the next release.
  const unwritten = [];
  for (const tenantId of due) {
    const name = `${seg}__${tenantTag(tenantId)}.json`;
    const target = path.join(dir, name);
    // An existing copy may carry a newer payload.
    if (fs.existsSync(target)) continue;
    try {
      writeJsonSecure(target, { version: QUEUE_VERSION, tenantId, payload: entry.payload });
      written.push(name);
    } catch { unwritten.push(tenantId); }
  }

  const remaining = eligible.filter((t) => due.indexOf(t) === -1 || unwritten.indexOf(t) !== -1);
  // A rule, send or none settles it: what is not due now never will be.
  if (unwritten.length === 0 && (!resolved.pendingAsk || remaining.length === 0)) {
    try { fs.unlinkSync(filePath); return { written, deleted: true, expired: false }; } catch { return { written, deleted: false, expired: false }; }
  }
  const changed = entry.hold !== HOLD_ASK || entry.askTenants == null || remaining.length !== entry.askTenants.length;
  if (changed) {
    try {
      // A flush may have deleted it meanwhile; rewriting would resurrect it.
      if (fs.existsSync(filePath)) {
        writeJsonSecure(filePath, { version: QUEUE_VERSION, tenantId: null, hold: HOLD_ASK, askTenants: remaining, payload: entry.payload });
        // Keeps the original age so the hold window is not extended.
        fs.utimesSync(filePath, stat.atime, stat.mtime);
      }
    } catch { /* left as is; the next release retries */ }
  }
  return { written, deleted: false, expired: false };
}

// Releases every held file of this session on the account; returns how many copies were written.
export function releaseHeldQueue(row, sessionId) {
  if (row == null || sessionId == null || !isMultiTenant(row)) return 0;
  let dir;
  let files;
  try {
    dir = queueDir(row.key);
    files = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const state = readSessionWorkspace(sessionId);
  let count = 0;
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(dir, file);
    const value = readJson(filePath, null);
    if (value == null) continue;
    const entry = unwrapQueueFile(value);
    if (entry.payload == null || entry.payload.sessionId !== sessionId || !isHeld(entry, row)) continue;
    count += releaseHeldFile(filePath, row, state).written.length;
  }
  return count;
}
