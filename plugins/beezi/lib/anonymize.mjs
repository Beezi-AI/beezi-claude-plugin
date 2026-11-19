import crypto from 'crypto';
import { sanitizeRemote, canonicalRemote } from './git.mjs';

const ANON_RE = /^anon:(repo|folder|branch|host|account|session):[0-9a-f]{32}$/;
const LOCAL_RE = /^local:/i;
const LOCAL_PREFIX_LENGTH = 'local:'.length;
const PASSTHROUGH_REMOTES = ['local:copilot-chats', 'local:unknown', 'local:'];
const PASSTHROUGH_BRANCHES = ['(unknown)', 'HEAD', ''];
export const PRIVATE_MARK = 'beeziPrivate';
export const AnonKind = Object.freeze({
  REPOS: 'repos',
  BRANCHES: 'branches',
  SESSIONS: 'sessions',
  HOSTS: 'hosts',
  ACCOUNTS: 'accounts',
});
export const ANON_KINDS = Object.values(AnonKind);

export function isAnonValue(v) {
  return typeof v === 'string' && ANON_RE.test(v);
}

export function anonValue(keyHex, kind, input) {
  const hex = crypto.createHmac('sha256', Buffer.from(keyHex, 'hex'))
    .update(`${kind}\0${input}`, 'utf8')
    .digest('hex');
  return `anon:${kind}:${hex.slice(0, 32)}`;
}

// A pass-through remote, an anon: value, or the sanitized address that names the repo or folder.
function remoteScope(remote) {
  if (typeof remote !== 'string' || remote.trim() === '') return null;
  if (isAnonValue(remote)) return remote;
  const clean = sanitizeRemote(remote.trim());
  return LOCAL_RE.test(clean) ? clean : canonicalRemote(clean);
}

export function anonRemote(keyHex, remote) {
  const scope = remoteScope(remote);
  if (scope == null || isAnonValue(scope) || PASSTHROUGH_REMOTES.indexOf(scope) !== -1) return remote;
  return LOCAL_RE.test(scope)
    ? anonValue(keyHex, 'folder', scope.slice(LOCAL_PREFIX_LENGTH))
    : anonValue(keyHex, 'repo', scope);
}

function branchScope(keyHex, remote) {
  const scope = remoteScope(remote);
  if (scope == null) return '';
  if (PASSTHROUGH_REMOTES.indexOf(scope) !== -1) return scope;
  const anon = anonRemote(keyHex, remote);
  return isAnonValue(anon) ? anon : '';
}

export function anonBranch(keyHex, remote, branch) {
  if (typeof branch !== 'string' || isAnonValue(branch) || PASSTHROUGH_BRANCHES.indexOf(branch) !== -1) {
    return branch;
  }
  return anonValue(keyHex, 'branch', `${branchScope(keyHex, remote)}\0${branch}`);
}

function anonNormalized(keyHex, kind, value) {
  if (typeof value !== 'string' || isAnonValue(value)) return value;
  return anonValue(keyHex, kind, value.toLowerCase().trim());
}

export function anonHost(keyHex, hostname) {
  return anonNormalized(keyHex, 'host', hostname);
}

export function anonAccount(keyHex, value) {
  return anonNormalized(keyHex, 'account', value);
}

export function anonSession(keyHex, sessionId) {
  if (typeof sessionId !== 'string' || isAnonValue(sessionId)) return sessionId;
  return anonValue(keyHex, 'session', sessionId);
}

export function without(body, keys) {
  const out = Object.assign({}, body);
  keys.forEach((key) => { delete out[key]; });
  return out;
}

// Replaces out[field] with fn(value) only when the field is non-null.
function mapField(out, field, fn) {
  if (out[field] != null) out[field] = fn(out[field]);
}

function has(kinds, kind) {
  return kinds.indexOf(kind) !== -1;
}

function keysOf(kinds, kind, keys) {
  return has(kinds, kind) ? keys : [];
}

function anonSessionName(out, keyHex) {
  mapField(out, 'session_name', () => anonSession(keyHex, out.sessionId));
}

export function anonymizeReport(payload, keyHex, kinds) {
  const out = without(payload, [PRIVATE_MARK].concat(
    keysOf(kinds, AnonKind.SESSIONS, ['agent_name']),
    keysOf(kinds, AnonKind.ACCOUNTS, ['account_org_name']),
  ));
  if (has(kinds, AnonKind.REPOS)) mapField(out, 'remote', (remote) => anonRemote(keyHex, remote));
  if (has(kinds, AnonKind.BRANCHES)) mapField(out, 'branch', (branch) => anonBranch(keyHex, payload.remote, branch));
  if (has(kinds, AnonKind.SESSIONS)) anonSessionName(out, keyHex);
  if (has(kinds, AnonKind.ACCOUNTS)) mapField(out, 'account_email', (email) => anonAccount(keyHex, email));
  return out;
}

export function anonymizeCostState(item, keyHex, kinds) {
  const out = Object.assign({}, item);
  if (has(kinds, AnonKind.SESSIONS)) anonSessionName(out, keyHex);
  if (has(kinds, AnonKind.REPOS)) mapField(out, 'repo_urls', (urls) => urls.map((url) => anonRemote(keyHex, url)));
  return out;
}

function anonymizeAccountFields(body, keyHex, kinds, emailField, orgNameField) {
  const out = without(body, keysOf(kinds, AnonKind.ACCOUNTS, [orgNameField]));
  if (has(kinds, AnonKind.ACCOUNTS)) mapField(out, emailField, (email) => anonAccount(keyHex, email));
  return out;
}

export function anonymizeUsage(body, keyHex, kinds) {
  return anonymizeAccountFields(body, keyHex, kinds, 'account_email', 'account_org_name');
}

export function anonymizeAccountSync(body, keyHex, kinds) {
  return anonymizeAccountFields(body, keyHex, kinds, 'email', 'organizationName');
}

export function scrubSessionError(body) {
  return without(body, ['errorDetails', 'lastAssistantMessage']);
}
