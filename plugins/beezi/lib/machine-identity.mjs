import os from 'node:os';

// Client id of this machine's registered OAuth app; set wherever credentials are
// loaded, consumed by the HTTP helpers for the X-Beezi-Client header.
let clientId = null;

export function setMachineClientId(id) {
  clientId = id ?? null;
}

// Identifying headers for the portal's linked-machines view (display/bookkeeping
// only — auth stays the bearer token).
export function machineHeaders() {
  const headers = { 'X-Beezi-Host': String(os.hostname()).slice(0, 255) };
  if (clientId) headers['X-Beezi-Client'] = clientId;
  return headers;
}
