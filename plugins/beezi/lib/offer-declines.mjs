import { historyDeclinedFile } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { SOLO_KEY } from './offer-gate.mjs';

// Session ids asked about and not uploaded, per workspace, as { changedAt, sessionIds }.

function declinedFile(key, tenantKey) {
  return historyDeclinedFile(key, tenantKey === SOLO_KEY ? null : tenantKey);
}

function readStored(key, tenantKey) {
  const stored = readJson(declinedFile(key, tenantKey), null);
  return stored != null && typeof stored === 'object' && Array.isArray(stored.sessionIds) ? stored : null;
}

// A null current changedAt keeps the remembered ids; any other one must equal the file's.
function remembered(stored, changedAt) {
  if (stored == null) return [];
  if (changedAt != null && stored.changedAt !== changedAt) return [];
  return stored.sessionIds;
}

export function readDeclinedIds(key, tenantKey, changedAt) {
  return new Set(remembered(readStored(key, tenantKey), changedAt));
}

export function rememberDeclined(key, tenantKey, ids, changedAt) {
  const kept = remembered(readStored(key, tenantKey), changedAt);
  const sessionIds = kept.concat(ids.filter((id, i) => kept.indexOf(id) === -1 && ids.indexOf(id) === i));
  writeJsonSecure(declinedFile(key, tenantKey), { changedAt, sessionIds });
}

export function forgetDeclined(key, tenantKey, ids) {
  const stored = readStored(key, tenantKey);
  if (stored == null) return;
  writeJsonSecure(declinedFile(key, tenantKey), { ...stored, sessionIds: stored.sessionIds.filter((id) => ids.indexOf(id) === -1) });
}
