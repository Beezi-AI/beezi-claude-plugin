import os from 'os';

// Client id of this machine's registered OAuth app; set wherever credentials are
// loaded, consumed by the HTTP helpers for the X-Beezi-Client header.
let clientId = null;

export function setMachineClientId(id) {
  clientId = id == null ? null : id;
}

// The current login's OAuth client id (dynamic registration mints a new one per login), used as
// the binding key for machine-global files that must not survive a workspace switch.
export function getMachineClientId() {
  return clientId;
}

// Identifying headers for the portal's linked-machines view (display/bookkeeping
// only — auth stays the bearer token). X-Beezi-Agent picks the tool axis for the
// backfill scope and analytics source — the server defaults an absent header to
// claude-code, but explicit beats implicit.
export function machineHeaders() {
  const headers = {
    'X-Beezi-Agent': 'claude-code',
    'X-Beezi-Host': String(os.hostname()).slice(0, 255),
  };
  if (clientId) headers['X-Beezi-Client'] = clientId;
  return headers;
}
