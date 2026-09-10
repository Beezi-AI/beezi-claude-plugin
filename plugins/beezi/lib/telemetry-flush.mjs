import fs from 'fs';
import path from 'path';
import { apiBase, ENDPOINTS } from './config.mjs';
import { readJson, readJsonSalvaged, writeJsonSecure } from './fs-store.mjs';
import { telemetryDir, telemetrySendStateFile } from './paths.mjs';
import { isTelemetryGranted } from './telemetry-consent.mjs';
import { rotateInstallationId } from './installation-id.mjs';
import { postDiagnostics } from './diagnostics-transport.mjs';

export const DIAGNOSTICS_SCHEMA_VERSION = 2;
const MAX_PER_BATCH = 50;
// The route answers 413 above 32 KiB. Aim under it so a routine batch is not a routine 413.
const MAX_BODY_BYTES = 28 * 1024;
// Sealed events are named for their eventId; a pending event is named for its dedup key, so the
// prefix is what tells "still accumulating occurrences" from "frozen and awaiting delivery".
const SEALED_PREFIX = 'evt-';
const SAFE_EVENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SEND_STATE_VERSION = 1;
export const SEND_BACKOFF_MS = [60000, 120000, 300000, 900000, 1800000, 3600000];
export const MIN_SEND_INTERVAL_MS = 60000;
// Nothing is retried after a permanent refusal, so the only reason to loop is a 413 split or a
// backlog; four round trips keeps a worker short-lived.
const MAX_REQUESTS_PER_RUN = 4;

// Preserved: the report is still deliverable later. 401/403 are authorization answers this route
// should never produce, but if a gateway invents one the evidence must survive it; 404/405 mean
// an older API that has not deployed the route yet.
const PRESERVING_STATUSES = new Set([401, 403, 404, 405, 408, 429]);
const preserves = (status) => status === 0 || status >= 500 || PRESERVING_STATUSES.has(status);

// Exactly the fields the public DTO accepts. A whitelist rather than a spread: an unknown key
// fails the whole request, and a key nobody meant to send is how identity leaks.
const WIRE_FIELDS = [
  'eventId', 'code', 'source', 'pluginVersion', 'site', 'errorName', 'errorCode', 'httpStatus',
  'claudeCodeVersion', 'nodeVersion', 'os', 'osRelease', 'arch', 'count', 'firstSeenAt', 'lastSeenAt',
];
const OPTIONAL_WIRE_FIELDS = ['installationId', 'authState', 'reason'];

// Everything the server DTO requires. A salvaged prefix can lack any of these — admitting it to
// the batch anyway would have it rejected and cost a round trip for nothing.
function isPostableEvent(value) {
  return value != null
    && typeof value.eventId === 'string' && SAFE_EVENT_ID.test(value.eventId)
    && typeof value.code === 'string' && value.code.length > 0
    && typeof value.source === 'string' && value.source.length > 0
    && typeof value.pluginVersion === 'string' && value.pluginVersion.length > 0
    && Number.isInteger(value.count) && value.count >= 1
    && typeof value.firstSeenAt === 'string' && value.firstSeenAt.length > 0
    && typeof value.lastSeenAt === 'string' && value.lastSeenAt.length > 0;
}

function toWireEvent(value) {
  const event = {};
  for (const field of WIRE_FIELDS) event[field] = value[field] === undefined ? null : value[field];
  for (const field of OPTIONAL_WIRE_FIELDS) {
    if (value[field] != null) event[field] = value[field];
  }
  return event;
}

const unlink = (filePath) => { try { fs.unlinkSync(filePath); return true; } catch { return false; } };

function listDir() {
  try { return fs.readdirSync(telemetryDir()); } catch { return []; }
}

export function readSendState() {
  const raw = readJson(telemetrySendStateFile());
  if (raw == null || raw.version !== SEND_STATE_VERSION) return { attempts: 0, nextAttemptAt: 0 };
  return {
    attempts: Number.isInteger(raw.attempts) ? raw.attempts : 0,
    nextAttemptAt: Number.isFinite(raw.nextAttemptAt) ? raw.nextAttemptAt : 0,
  };
}

function writeSendState(attempts, nextAttemptAt) {
  try {
    writeJsonSecure(telemetrySendStateFile(), { version: SEND_STATE_VERSION, attempts, nextAttemptAt });
  } catch { /* a machine that cannot write its backoff still must not spin: the caller's own
                minimum interval is the fallback gate */ }
}

// Freezes each accumulating event into an immutable one, named for its eventId. rename() is the
// synchronization: it is atomic within a filesystem, so a competing recorder either finds the file
// (and adds an occurrence to what will be sealed) or does not (and starts a NEW event with a NEW
// eventId). An acknowledgement therefore never deletes an occurrence recorded after the seal.
export function sealPending() {
  const dir = telemetryDir();
  let sealed = 0;
  for (const file of listDir()) {
    if (!file.endsWith('.json') || file.startsWith(SEALED_PREFIX)) continue;
    const filePath = path.join(dir, file);
    const { value } = readJsonSalvaged(filePath);
    if (!isPostableEvent(value)) { unlink(filePath); continue; }
    try {
      fs.renameSync(filePath, path.join(dir, `${SEALED_PREFIX}${value.eventId}.json`));
      sealed += 1;
    } catch { /* another worker sealed it first, or it was pruned mid-pass */ }
  }
  return sealed;
}

function readSealed() {
  const dir = telemetryDir();
  const entries = [];
  for (const file of listDir()) {
    if (!file.startsWith(SEALED_PREFIX) || !file.endsWith('.json')) continue;
    const filePath = path.join(dir, file);
    const { value } = readJsonSalvaged(filePath);
    if (!isPostableEvent(value)) { unlink(filePath); continue; }
    entries.push({ filePath, event: toWireEvent(value) });
    if (entries.length >= MAX_PER_BATCH) break;
  }
  return entries;
}

// Bounded by count AND by serialized size, because 50 ordinary events already approach the
// route's 32 KiB body cap.
function takeBatch(entries, limit) {
  const batch = [];
  let bytes = 32; // the schemaVersion wrapper
  for (const entry of entries.slice(0, limit)) {
    const size = JSON.stringify(entry.event).length + 1;
    if (batch.length > 0 && bytes + size > MAX_BODY_BYTES) break;
    batch.push(entry);
    bytes += size;
  }
  return batch;
}

const encode = (batch) => JSON.stringify({
  schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
  events: batch.map((entry) => entry.event),
});

// Applies a 200 to the files: only acknowledged events and individually rejected ones go away.
// An event the server neither accepted nor named is kept and re-sent (it dedups on eventId).
//
// Returns { removed, unreadable }. A 200 whose body is not the route's shape is far more often a
// proxy, captive portal or load balancer than the route itself, so nothing is deleted on it —
// the server dedups on eventId, which makes preserving free, while unlinking destroys the
// evidence with no retry.
function applyAcknowledgement(batch, body) {
  if (body == null || !Array.isArray(body.acceptedEventIds)) {
    return { removed: 0, unreadable: true };
  }
  const accepted = new Set(body.acceptedEventIds);
  const rejected = new Set(
    (Array.isArray(body.rejected) ? body.rejected : [])
      .map((row) => (row == null ? null : row.index))
      .filter((index) => Number.isInteger(index)),
  );
  let removed = 0;
  batch.forEach((entry, index) => {
    if (accepted.has(entry.event.eventId) || rejected.has(index)) {
      if (unlink(entry.filePath)) removed += 1;
    }
  });
  return { removed, unreadable: false };
}

// Deletes every pending and sealed report plus the correlation identity. The user said no; what
// was already recorded must not survive the answer.
export function purgeAllDiagnostics() {
  const dir = telemetryDir();
  for (const file of listDir()) unlink(path.join(dir, file));
  unlink(telemetrySendStateFile());
  rotateInstallationId();
}

// Withdrawing correlation only: reports already stamped with the installation ID go, the
// anonymous ones stay, and the identity itself is dropped so later events are anonymous.
export function purgeCorrelatedDiagnostics() {
  const dir = telemetryDir();
  let removed = 0;
  for (const file of listDir()) {
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(dir, file);
    const { value } = readJsonSalvaged(filePath);
    if (value != null && value.installationId != null && unlink(filePath)) removed += 1;
  }
  rotateInstallationId();
  return removed;
}

// Delivers sealed diagnostics over the authorization-free route. Deliberately records nothing
// about its own failures: telemetry about telemetry is a loop that feeds itself.
export async function flushDiagnostics(deps = {}) {
  const post = deps.postDiagnosticsImpl == null ? postDiagnostics : deps.postDiagnosticsImpl;
  const now = (deps.now == null ? () => Date.now() : deps.now)();
  const result = { sent: 0, deleted: 0, kept: 0, requests: 0, status: null, purged: false };

  if (!isTelemetryGranted()) {
    purgeAllDiagnostics();
    result.purged = true;
    return result;
  }

  sealPending();
  let pending = readSealed();
  if (pending.length === 0) return result;

  const state = readSendState();
  let attempts = state.attempts;
  let nextIn = MIN_SEND_INTERVAL_MS;
  // Halved on a 413 and never raised again in the same run: the cap is what shrinks, so the next
  // pass cannot rebuild the batch the server just refused.
  let limit = MAX_PER_BATCH;

  while (pending.length > 0 && result.requests < MAX_REQUESTS_PER_RUN) {
    // Immediately before transmission, not once per worker: a run makes up to MAX_REQUESTS_PER_RUN
    // requests, and a user who types /beezi:telemetry off between two of them must not have the
    // rest sent anyway.
    if (!isTelemetryGranted()) {
      purgeAllDiagnostics();
      result.purged = true;
      return result;
    }
    const batch = takeBatch(pending, limit);
    if (batch.length === 0) break;
    let outcome;
    try {
      result.requests += 1;
      outcome = await post(`${apiBase()}${ENDPOINTS.pluginDiagnosticsPublic}`, encode(batch), deps);
    } catch {
      // Timeout or transport failure: preserve everything and back off.
      outcome = { status: 0, retryAfterMs: null, body: null };
    }
    result.status = outcome.status;

    if (outcome.status === 413) {
      if (batch.length === 1) {
        // One event alone is over the cap; the same bytes will be refused forever.
        unlink(batch[0].filePath);
        result.deleted += 1;
        pending = pending.slice(1);
        continue;
      }
      limit = Math.ceil(batch.length / 2);
      continue;
    }

    if (outcome.status >= 200 && outcome.status < 300) {
      result.sent += batch.length;
      const ack = applyAcknowledgement(batch, outcome.body);
      result.deleted += ack.removed;
      if (ack.unreadable) {
        // Something answered 200 that is not the route. Keep everything and back off.
        result.kept = pending.length;
        attempts += 1;
        nextIn = SEND_BACKOFF_MS[Math.min(attempts - 1, SEND_BACKOFF_MS.length - 1)];
        break;
      }
      attempts = 0;
      nextIn = MIN_SEND_INTERVAL_MS;
      pending = pending.slice(batch.length);
      continue;
    }

    if (preserves(outcome.status)) {
      result.kept = pending.length;
      attempts += 1;
      nextIn = outcome.retryAfterMs == null
        ? SEND_BACKOFF_MS[Math.min(attempts - 1, SEND_BACKOFF_MS.length - 1)]
        : Math.max(outcome.retryAfterMs, MIN_SEND_INTERVAL_MS);
      break;
    }

    // Any other refusal (400, 422, …) is about the bytes, which will never change.
    for (const entry of batch) { if (unlink(entry.filePath)) result.deleted += 1; }
    attempts = 0;
    pending = pending.slice(batch.length);
  }

  writeSendState(attempts, now + nextIn);
  return result;
}
