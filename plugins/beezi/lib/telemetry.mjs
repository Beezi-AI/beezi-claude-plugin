import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { telemetryDir, telemetryConsentFile } from './paths.mjs';
import { isTelemetryGranted } from './telemetry-consent.mjs';
import { isKnownCode, isKnownSource, DIAGNOSTIC_SOURCES } from './telemetry-codes.mjs';
import { isKnownAuthState, isKnownAuthReason } from './auth-state.mjs';
import { currentInstallationId } from './installation-id.mjs';

const PLUGIN_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_PENDING = 200;

// Structured vocabularies have a shape; prose does not. Anything that fails these patterns is
// dropped rather than truncated, because a truncated sentence is still a sentence.
const IDENTIFIER = /^[A-Za-z0-9_$.-]{1,64}$/;   // ENOENT, ERR_MODULE_NOT_FOUND, SyntaxError
const VERSION = /^[0-9][0-9A-Za-z.+-]{0,39}$/;  // 2.1.251, 0.16.2, 1.0.0-beta.3
const OS_RELEASE = /^[A-Za-z0-9._-]{1,80}$/;    // 25.4.0, 6.8.0-45-generic
// Deliberately mirrors the `site` pattern in the portal's plugin-diagnostics.request.dto.ts —
// keep the two in lockstep so a shape only this side considers valid can never fail server-side.
const SITE = /^[A-Za-z0-9_./-]+:\d+$/;

// Set for the lifetime of the diagnostics worker process. Recursion protection: a failure while
// delivering diagnostics must never enqueue another diagnostic about that failure.
let suppressed = false;
export function suppressRecording(value = true) {
  suppressed = value;
}

let currentSource = null;
// Published by hook-runner for the duration of a hook. A call site that does not know its own
// source (fs-store, token) falls back to it instead of guessing.
export function setCurrentSource(source) {
  currentSource = source;
}

const shaped = (value, pattern) => {
  if (value == null) return null;
  const text = String(value);
  return pattern.test(text) ? text : null;
};

// Never let a correlation lookup be the reason a diagnostic is lost.
function installationIdOrNull() {
  try { return currentInstallationId(); } catch { return null; }
}

function pluginVersion() {
  const pkg = readJson(path.join(PLUGIN_ROOT, 'package.json'));
  return pkg == null || typeof pkg.version !== 'string' ? 'unknown' : pkg.version;
}

// Only frames inside the plugin, rendered relative to it. A stack with no plugin frame yields
// null rather than a path belonging to the user. The containment check after path.relative is
// the actual guarantee here — the regex only has to find A path, never to prove it is safe.
export function siteFrom(error, pluginRoot = PLUGIN_ROOT) {
  const stack = error == null || typeof error.stack !== 'string' ? '' : error.stack;
  for (const line of stack.split('\n')) {
    // Sites come from stack frames, never the message line — a message can contain anything,
    // including something that looks like a path plus a line:col.
    if (!/^\s*at\s/.test(line)) continue;
    const index = line.indexOf(pluginRoot);
    if (index === -1) continue;
    // Anchored to the start of the slice (which is already proven to begin with pluginRoot) and
    // to the end of the line, so a space or paren inside the root can never fracture the match
    // into a shorter, relative-looking fragment the way an unanchored char-class regex would.
    const match = /^(.+):(\d+):\d+\)?$/.exec(line.slice(index));
    if (!match) continue;
    const rel = path.relative(pluginRoot, match[1]);
    // The guarantee: no site ever escapes the plugin directory, whatever the input looked like.
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const site = `${rel}:${match[2]}`.split(path.sep).join('/');
    return SITE.test(site) ? site : null;
  }
  return null;
}

// Structured fields only. There is deliberately no branch that can put error.message,
// a stack, or any caller-supplied string into the record.
export function recordIssue({ code, source, error, httpStatus, authState, reason } = {}, deps = {}) {
  try {
    if (suppressed) return false;
    // A call site that does not know its own source (fs-store, token) falls back to the source
    // hook-runner published for the hook currently in flight, then to a neutral default.
    const effectiveSource = source == null ? (currentSource == null ? DIAGNOSTIC_SOURCES.UNKNOWN : currentSource) : source;
    if (!isKnownCode(code) || !isKnownSource(effectiveSource)) return false;
    if (!isTelemetryGranted()) return false;

    const errorName = shaped(error == null || error.constructor == null ? null : error.constructor.name, IDENTIFIER);
    const errorCode = shaped(error == null ? null : error.code, IDENTIFIER);
    const site = siteFrom(error);
    const version = pluginVersion();
    // Unknown vocabulary is dropped rather than sent: the server rejects an event carrying a
    // value its enum lacks, and a rejected event is deleted rather than retried.
    const state = isKnownAuthState(authState) ? authState : null;
    const why = isKnownAuthReason(reason) ? reason : null;

    // Repeated notices of the same shape — a prompt on every turn of an unlinked machine — fold
    // into one event's count instead of minting a new event each time.
    const key = crypto.createHash('sha1')
      .update([code, effectiveSource, site, errorName, errorCode, version, state, why].join('|'))
      .digest('hex')
      .slice(0, 16);

    const dir = telemetryDir();
    const file = path.join(dir, `${key}.json`);
    const now = (deps.now == null ? () => new Date().toISOString() : deps.now)();
    const existing = readJson(file);

    // A corrupt count (e.g. a salvaged string fragment) must never compound via string
    // concatenation — start a fresh event instead of trusting it.
    if (existing != null && Number.isInteger(existing.count)) {
      writeJsonSecure(file, { ...existing, count: existing.count + 1, lastSeenAt: now });
      return true;
    }

    let pending = 0;
    try { pending = fs.readdirSync(dir).length; } catch { /* first event */ }
    if (pending >= MAX_PENDING) return false;

    const consent = readJson(telemetryConsentFile());
    writeJsonSecure(file, {
      eventId: crypto.randomUUID == null ? key + Date.now().toString(36) : crypto.randomUUID(),
      code,
      source: effectiveSource,
      site,
      errorName,
      errorCode,
      httpStatus: typeof httpStatus === 'number' ? httpStatus : null,
      authState: state,
      reason: why,
      // Stamped once, at queue time. An event keeps the identity it was queued under even if the
      // machine later rotates or drops it, so a report is never re-attributed after the fact.
      installationId: installationIdOrNull(),
      pluginVersion: version,
      claudeCodeVersion: shaped(consent == null ? null : consent.claudeCodeVersion, VERSION),
      nodeVersion: process.version,
      os: process.platform,
      osRelease: shaped((deps.osRelease == null ? () => os.release() : deps.osRelease)(), OS_RELEASE),
      arch: process.arch,
      count: 1,
      firstSeenAt: now,
      lastSeenAt: now,
    });
    return true;
  } catch {
    // Telemetry must never be the reason a hook fails.
    return false;
  }
}

export { rememberClaudeCodeVersion } from './claude-version.mjs';
