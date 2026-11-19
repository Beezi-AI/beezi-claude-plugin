// Packs queued reports into batch requests for /sessions/report-batch. Pure: no I/O.
//
// A batch carries one tenant (the X-Beezi-Tenant header is per request). A scope group (same
// tenantId and groupKey) is placed as a unit, so a resend after an unknown outcome never splits a
// narrow window from its wide one: inside one batch the server writes them narrow-then-wide again.

export const BATCH_MAX_ITEMS = 50;
export const BATCH_MAX_BYTES = 4 * 1024 * 1024;

function limitOf(limits, key, fallback) {
  return limits == null || limits[key] == null ? fallback : limits[key];
}

// The entries' scope groups in order of their first entry; an entry without a groupKey is its own group.
function groupsOf(entries) {
  const byTenant = new Map();
  const groups = [];
  entries.forEach((entry, index) => {
    const tenantId = entry.tenantId == null ? null : entry.tenantId;
    let group = null;
    if (entry.groupKey != null) {
      let keyed = byTenant.get(tenantId);
      if (keyed == null) {
        keyed = new Map();
        byTenant.set(tenantId, keyed);
      }
      group = keyed.get(entry.groupKey);
      if (group == null) {
        group = { tenantId, indices: [], bytes: 0 };
        keyed.set(entry.groupKey, group);
        groups.push(group);
      }
    } else {
      group = { tenantId, indices: [], bytes: 0 };
      groups.push(group);
    }
    group.indices.push(index);
    group.bytes += entry.bytes;
  });
  return groups;
}

// planBatches(entries, { maxItems, maxBytes }) -> index lists, ordered by their first entry.
// Each tenant has one open batch; a group that does not fit closes it and opens a new one. A group
// over either limit on its own fills consecutive batches of its own; an entry over maxBytes travels alone.
export function planBatches(entries, limits) {
  const maxItems = limitOf(limits, 'maxItems', BATCH_MAX_ITEMS);
  const maxBytes = limitOf(limits, 'maxBytes', BATCH_MAX_BYTES);
  const batches = [];
  const open = new Map();

  const openBatch = (tenantId) => {
    const batch = { indices: [], bytes: 0 };
    batches.push(batch);
    open.set(tenantId, batch);
    return batch;
  };

  for (const group of groupsOf(entries)) {
    const oversize = group.indices.length > maxItems || group.bytes > maxBytes;
    let batch = open.get(group.tenantId);
    if (!oversize) {
      const fits = batch != null
        && batch.indices.length + group.indices.length <= maxItems
        && batch.bytes + group.bytes <= maxBytes;
      if (!fits) batch = openBatch(group.tenantId);
      batch.indices.push(...group.indices);
      batch.bytes += group.bytes;
      continue;
    }
    batch = null;
    for (const index of group.indices) {
      const bytes = entries[index].bytes;
      const fits = batch != null && batch.indices.length < maxItems && batch.bytes + bytes <= maxBytes;
      if (!fits) batch = openBatch(group.tenantId);
      batch.indices.push(index);
      batch.bytes += bytes;
    }
    // Its own batches: the tenant's next group starts a fresh one.
    open.delete(group.tenantId);
  }

  return batches
    .map((batch) => batch.indices.sort((a, b) => a - b))
    .sort((a, b) => a[0] - b[0]);
}
