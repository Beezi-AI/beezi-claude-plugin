import { pastSessionsFor, PastSessionsChoice } from './anonymization.mjs';

// The local offer checks, cheapest first, with no engine imports so a hook can run them.
export const OfferGate = Object.freeze({
  SKIP_CHOICE: 'skip-choice',
  TRACKING_OFF: 'tracking-off',
  DECLINED: 'declined',
  SETTLED: 'settled',
  READY: 'ready',
  SCAN: 'scan',
});

// Whether a workspace's offer asks the developer first or uploads with a notice.
export const OfferMode = Object.freeze({ ASK: 'ask', UPLOAD: 'upload' });

export function offerMode(row, tenantId) {
  return pastSessionsFor(row, tenantId).choice === PastSessionsChoice.UPLOAD ? OfferMode.UPLOAD : OfferMode.ASK;
}

export const SOLO_KEY = 'solo';

// The key of row.historyOffers and of the offer file.
export function offerTenantKey(row, tenantId) {
  if (tenantId != null) return tenantId;
  return row.tenantId != null ? row.tenantId : SOLO_KEY;
}

// A stamp still holds unless the owner changed the choice after it was taken.
export function isRemembered(stamp, currentChangedAt) {
  if (stamp == null) return false;
  if (currentChangedAt == null) return true;
  return stamp.changedAt != null && !(Date.parse(currentChangedAt) > Date.parse(stamp.changedAt));
}

export function offerStateOf(row, tenantId) {
  const offers = row.historyOffers != null && typeof row.historyOffers === 'object' ? row.historyOffers : {};
  const state = offers[offerTenantKey(row, tenantId)];
  return state != null && typeof state === 'object' ? state : {};
}

const orNull = (value) => (value == null ? null : value);

// A ready offer counted under another changedAt is stale, so the workspace scans again.
function isCurrentReady(ready, currentChangedAt) {
  return ready != null && typeof ready === 'object' && orNull(ready.changedAt) === orNull(currentChangedAt);
}

export function offerGate(row, tenantId, { trackingOff }) {
  const past = pastSessionsFor(row, tenantId);
  if (past.choice === PastSessionsChoice.SKIP) return OfferGate.SKIP_CHOICE;
  if (trackingOff) return OfferGate.TRACKING_OFF;
  const state = offerStateOf(row, tenantId);
  const ready = isCurrentReady(state.ready, past.changedAt) ? OfferGate.READY : OfferGate.SCAN;
  if (Array.isArray(state.reopen) && state.reopen.length > 0) return ready;
  if (isRemembered(state.declined, past.changedAt)) return OfferGate.DECLINED;
  if (isRemembered(state.settled, past.changedAt)) return OfferGate.SETTLED;
  return ready;
}
