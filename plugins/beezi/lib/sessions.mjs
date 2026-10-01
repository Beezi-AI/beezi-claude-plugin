import { getAuthentication as _getAuthentication } from './token.mjs';
import { listAccounts as _listAccounts, getDefaultKey as _getDefaultKey, AccountStatus } from './accounts.mjs';

function toSession(row, token) {
  return {
    key: row.key,
    email: row.email == null ? null : row.email,
    name: row.name == null ? null : row.name,
    tenantName: row.tenantName == null ? null : row.tenantName,
    token,
    clientId: row.clientId == null ? null : row.clientId,
  };
}

async function resolve(row, deps) {
  if (row == null || row.status !== AccountStatus.LINKED) return null;
  if (deps.getAccessToken && !deps.getAuthentication) {
    const token = await deps.getAccessToken(deps, { account: row.key }).catch(() => null);
    return token ? toSession(row, token) : null;
  }
  const auth = await (deps.getAuthentication || _getAuthentication)(deps, { account: row.key }).catch(() => null);
  return auth != null && auth.authState === 'ready' ? toSession({ ...row, clientId: auth.clientId }, auth.accessToken) : null;
}

export async function sessionFor(key, deps = {}) {
  const listAccounts = deps.listAccounts == null ? _listAccounts : deps.listAccounts;
  const row = (await listAccounts(deps)).find((a) => a.key === key);
  return resolve(row, deps);
}

export async function defaultSession(deps = {}) {
  const getDefaultKey = deps.getDefaultKey == null ? _getDefaultKey : deps.getDefaultKey;
  const key = await getDefaultKey(deps);
  return key == null ? null : sessionFor(key, deps);
}

// Every linked account with a usable token, resolved concurrently; failures are dropped for this call.
export async function linkedSessions(deps = {}) {
  const listAccounts = deps.listAccounts == null ? _listAccounts : deps.listAccounts;
  const rows = await listAccounts(deps);
  const sessions = await Promise.all(rows.map((row) => resolve(row, deps)));
  return sessions.filter((s) => s != null);
}

// Plugin diagnostics go through one account: the default when it is live, else the first.
export function diagnosticsSession(sessions, defaultKey = null) {
  if (!sessions || sessions.length === 0) return null;
  const def = sessions.find((s) => s.key === defaultKey);
  return def == null ? sessions[0] : def;
}
