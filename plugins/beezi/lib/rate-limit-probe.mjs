import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { runClaudeAuthStatus as _runClaudeAuthStatus } from './claude-auth-status.mjs';
import { readClaudeAccount as _readClaudeAccount } from './claude-account.mjs';
import { recordStatuslineUsage as _recordStatuslineUsage } from './statusline-usage.mjs';
import { oauthTokenEnvWithOsProbe } from './claude-settings-env.mjs';
import { compareVersions, parseVersion } from './version-compare.mjs';
import { recordUsageCheckOutcome, setupTokenInForce as _setupTokenInForce } from './usage-check.mjs';
import { usageCheckCwd } from './paths.mjs';

// The detached plan-usage probe: one headless Haiku call whose rate_limit_event carries both live
// windows, recorded through the status line's own queue. Never reads or passes a credential.

// --setting-sources '' keeps every user plugin (Beezi's hooks too) out of the child; --bare would skip OAuth.
export const PROBE_ARGS = ['-p', 'hi', '--model', 'haiku', '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence', '--output-format', 'stream-json', '--verbose'];
export const PROBE_TIMEOUT_MS = 30000;

const MAX_STDOUT_CHARS = 1024 * 1024;
const SUBSCRIPTION_AUTH = 'claude.ai';
const FIRST_PARTY = 'firstParty';
const WINDOWS = ['five_hour', 'seven_day'];
const HOMEBREW_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];
const BUNDLE_ROOT = ['Library', 'Application Support', 'Claude', 'claude-code'];
const BUNDLE_BINARY = ['claude.app', 'Contents', 'MacOS', 'claude'];

const isObject = (value) => value != null && typeof value === 'object';

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function listDir(p) {
  try { return fs.readdirSync(p); } catch { return []; }
}

// <root>/<version>/<hash>/claude.app/…, newest version first.
function bundleCandidates(root, readdir) {
  const versions = readdir(root).filter((v) => parseVersion(v) != null).sort((a, b) => compareVersions(b, a));
  const out = [];
  for (const version of versions) {
    for (const hash of readdir(path.join(root, version))) out.push(path.join(root, version, hash, ...BUNDLE_BINARY));
  }
  return out;
}

// GUI-launched apps often lack ~/.local/bin on PATH, hence the fallbacks. A win32 `claude.cmd` needs a shell, so it never counts.
export function resolveClaudeBinary(deps = {}) {
  const env = deps.env == null ? process.env : deps.env;
  const platform = deps.platform == null ? process.platform : deps.platform;
  const homedir = deps.homedir == null ? os.homedir() : deps.homedir;
  const exists = deps.exists == null ? isFile : deps.exists;
  const readdir = deps.readdir == null ? listDir : deps.readdir;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const name = platform === 'win32' ? 'claude.exe' : 'claude';

  const candidates = (env.PATH == null ? '' : env.PATH).split(p.delimiter).filter((dir) => p.isAbsolute(dir))
    .map((dir) => ({ command: p.join(dir, name), kind: 'path' }));
  candidates.push({ command: p.join(homedir, '.local', 'bin', name), kind: 'local-bin' });
  if (platform === 'darwin') {
    for (const dir of HOMEBREW_DIRS) candidates.push({ command: p.join(dir, name), kind: 'homebrew' });
  }
  const hit = candidates.find((c) => exists(c.command));
  if (hit != null) return hit;
  if (platform !== 'darwin') return null;
  const bundled = bundleCandidates(p.join(homedir, ...BUNDLE_ROOT), readdir).find(exists);
  return bundled == null ? null : { command: bundled, kind: 'desktop-bundle' };
}

export function parseRateLimitInfo(stdout) {
  let info = null;
  for (const line of stdout.split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (isObject(event) && event.type === 'rate_limit_event' && isObject(event.rate_limit_info)) info = event.rate_limit_info;
  }
  return info;
}

function toWindow(window) {
  if (!isObject(window) || !Number.isFinite(window.utilization) || !Number.isFinite(window.resetsAt)) return null;
  return { used_percentage: Math.round(window.utilization * 10000) / 100, resets_at: window.resetsAt };
}

// unifiedWindows is @internal in the SDK schema; without it the top-level fields describe one window.
export function toStatuslinePayload(info) {
  if (!isObject(info)) return null;
  const windows = isObject(info.unifiedWindows) ? info.unifiedWindows : { [info.rateLimitType]: info };
  const rateLimits = {};
  for (const name of WINDOWS) {
    const converted = toWindow(windows[name]);
    if (converted != null) rateLimits[name] = converted;
  }
  return Object.keys(rateLimits).length === 0 ? null : { rate_limits: rateLimits };
}

const sameEmail = (a, b) => typeof a === 'string' && typeof b === 'string' && a !== '' && a.toLowerCase() === b.toLowerCase();

// Better no row than one stamped with the wrong account.
export function accountMatches(status, account) {
  if (account == null || !sameEmail(status.email, account.email)) return false;
  return status.orgId == null || account.organizationUuid == null || status.orgId === account.organizationUuid;
}

// Resolves with the captured stdout once the child closes, fails to start, or is killed at the timeout.
function runProbe(command, spawnImpl, timeoutMs) {
  const cwd = usageCheckCwd();
  fs.mkdirSync(cwd, { recursive: true });
  return new Promise((resolve) => {
    let stdout = '';
    let timer = null;
    const settle = () => { clearTimeout(timer); resolve(stdout); };
    const child = spawnImpl(command, PROBE_ARGS, { cwd, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    timer = setTimeout(() => { child.kill('SIGTERM'); settle(); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk.slice(0, MAX_STDOUT_CHARS - stdout.length); });
    child.on('error', settle);
    child.on('close', settle);
  });
}

async function probe(deps, found) {
  const osProbeEnv = deps.osProbeEnv == null ? oauthTokenEnvWithOsProbe : deps.osProbeEnv;
  const setupTokenInForce = deps.setupTokenInForce == null ? _setupTokenInForce : deps.setupTokenInForce;
  const runClaudeAuthStatus = deps.runClaudeAuthStatus == null ? _runClaudeAuthStatus : deps.runClaudeAuthStatus;
  const readClaudeAccount = deps.readClaudeAccount == null ? _readClaudeAccount : deps.readClaudeAccount;
  const recordStatuslineUsage = deps.recordStatuslineUsage == null ? _recordStatuslineUsage : deps.recordStatuslineUsage;
  const spawnImpl = deps.spawnImpl == null ? spawn : deps.spawnImpl;
  const timeoutMs = deps.timeoutMs == null ? PROBE_TIMEOUT_MS : deps.timeoutMs;

  if (setupTokenInForce(osProbeEnv(deps.env))) return 'setup-token';
  const binary = resolveClaudeBinary(deps);
  if (binary == null) return 'no-cli';
  found.kind = binary.kind;
  const status = runClaudeAuthStatus({ command: binary.command });
  if (status == null) return 'no-cli';
  if (!status.loggedIn) return 'signed-out';
  if (status.authMethod !== SUBSCRIPTION_AUTH || status.apiProvider !== FIRST_PARTY) return 'not-subscription';
  const account = readClaudeAccount();
  if (!accountMatches(status, account)) return 'account-mismatch';
  const payload = toStatuslinePayload(parseRateLimitInfo(await runProbe(binary.command, spawnImpl, timeoutMs)));
  if (payload == null) return 'no-event';
  // A /login during the probe would otherwise stamp these limits with the new account.
  if (!accountMatches(status, readClaudeAccount())) return 'account-mismatch';
  return recordStatuslineUsage(payload, { readClaudeAccount: () => account }).recorded ? 'recorded' : 'unchanged';
}

export async function runRateLimitProbe(deps = {}) {
  const env = deps.env == null ? process.env : deps.env;
  const found = { kind: null };
  let outcome;
  try { outcome = await probe({ ...deps, env }, found); } catch { outcome = 'no-event'; }
  try {
    recordUsageCheckOutcome(outcome, { lastEntrypoint: env.CLAUDE_CODE_ENTRYPOINT, lastBinaryKind: found.kind });
  } catch { /* a state write failure never surfaces */ }
  return { outcome };
}
