import fs from 'fs';
import path from 'path';
import { stateDir, tenantTag } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';

const STALE_MS = 120000;
// An account key as paths.mjs's requireKey accepts it: 8 lowercase hex, never a path part.
const ACCOUNT_KEY = /^[0-9a-f]{8}$/;

const isAccountKey = (key) => typeof key === 'string' && ACCOUNT_KEY.test(key);

function progressDir() {
  return path.join(stateDir(), 'upload-progress');
}

export function progressPath(key, tenantId) {
  return path.join(progressDir(), `${key}-${tenantTag(tenantId)}.json`);
}

// Null for an invalid account key, as for a missing record; markReported then writes nothing.
export function readProgress(key, tenantId) {
  if (!isAccountKey(key)) return null;
  return readJson(progressPath(key, tenantId));
}

export function isLive(record, nowMs) {
  return record.finishedAt == null && nowMs - Date.parse(record.updatedAt) <= STALE_MS;
}

export function listProgress(key) {
  let names;
  try {
    names = fs.readdirSync(progressDir());
  } catch {
    return [];
  }
  return names
    .map((name) => readJson(path.join(progressDir(), name)))
    .filter((record) => record != null && record.key === key);
}

export function markReported(key, tenantId) {
  const record = readProgress(key, tenantId);
  if (record) writeJsonSecure(progressPath(key, tenantId), { ...record, reported: true });
}

// One writer per workspace run: at most one write per `throttleMs`, plus the final one. The final one records
// `failed` (the run did not end clean, so the rest is the worker's) and `reported` (the run printed its own result).
// An invalid account key writes nothing.
export function createProgressWriter({ key, tenantId, workspace, now = Date.now, throttleMs = 1000 }) {
  const file = progressPath(key, tenantId);
  let startedAt = null;
  let lastWriteMs = -Infinity;
  const write = ({ processed, total, sent }, extra) => {
    if (!isAccountKey(key)) return;
    lastWriteMs = now();
    const updatedAt = new Date(lastWriteMs).toISOString();
    if (startedAt === null) startedAt = updatedAt;
    const record = { key, tenantId, workspace, processed, total, sent, startedAt, updatedAt, finishedAt: null, reported: false };
    writeJsonSecure(file, extra == null ? record : { ...record, finishedAt: updatedAt, ...extra });
  };
  return {
    update(counts) {
      if (now() - lastWriteMs >= throttleMs) write(counts, null);
    },
    finish(counts, { failed = false, reported = false } = {}) {
      write(counts, { reported, failed });
    },
  };
}
