import fs from 'fs';
import os from 'os';
import path from 'path';
import { keyFingerprint } from './oauth-identity.mjs';
import { osEnvOauthToken as _osEnvOauthToken } from './os-env-token.mjs';

// The SECOND documented home of CLAUDE_CODE_OAUTH_TOKEN.
//
// Claude Code's docs name exactly two places a setup token may live: a shell export, and the `env`
// block of a settings file ("until you remove it from your shell profile or the `env` block of a
// settings file"). Claude Code does write every `env` entry into its OWN process environment — but
// that is where the inheritance stops. Verified against the shipped Claude Code bundle 2.1.251:
// its child-environment builder explicitly does `delete d.CLAUDE_CODE_OAUTH_TOKEN` for EVERY
// subprocess it spawns — hooks, stdio MCP servers, the Bash tool, LSP servers, plugin commands.
// It is plain JS with no platform branch, so macOS behaves exactly like Windows. The settings
// value therefore lands in Claude Code's process.env and is scrubbed again on the way out.
//
// So this module is not a rare fallback for odd sessions: for a hook it is the PRIMARY — and the
// only — channel by which a settings-file token can reach us at all. However the user set it,
// process.env in this process will not carry it. That is the whole reason the module exists, and
// it is why the resolution below has to READ the settings file rather than trust inheritance.
//
// USER SCOPE ONLY, deliberately. Claude Code's precedence also has project files
// (`.claude/settings.json`, `.claude/settings.local.json`) and managed policy above them, but most
// project `env` values apply only after the user trusts the folder — so reading a project file
// here could hand us a token Claude Code itself refused to apply, and we would then report the
// machine's identity as a credential no request ever used. `~/.claude` has no such gate.
//
// Nothing here is a secret boundary change: the token value stays in this process, and only its
// fingerprint (prefix / last4 / length) ever leaves — see oauth-identity.mjs.

const SETTINGS_FILES = ['settings.json', 'settings.local.json'];

// Lowest precedence first, so a later file overwrites an earlier one — settings.local.json is the
// user's own override of settings.json, exactly as Claude Code ranks them.
export function settingsCandidates(env, homedir) {
  const dir = env != null && env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CONFIG_DIR : path.join(homedir, '.claude');
  return SETTINGS_FILES.map((name) => path.join(dir, name));
}

// The merged `env` block of the user's settings files, or {}. Best-effort by contract: a missing
// file, a malformed one, and an unreadable one are all "nothing known", never an error — this runs
// on hook paths where a throw would cost the user their session start.
export function readSettingsEnv(deps = {}) {
  const readFile = deps.readFile == null ? ((p) => fs.readFileSync(p, 'utf-8')) : deps.readFile;
  const exists = deps.exists == null ? ((p) => fs.existsSync(p)) : deps.exists;
  const env = deps.env == null ? process.env : deps.env;
  const homedir = deps.homedir == null ? os.homedir() : deps.homedir;

  const out = {};
  for (const p of settingsCandidates(env, homedir)) {
    let cfg;
    try {
      if (!exists(p)) continue;
      cfg = JSON.parse(readFile(p));
    } catch {
      continue;
    }
    if (cfg == null || typeof cfg !== 'object') continue;
    const block = cfg.env;
    if (block == null || typeof block !== 'object' || Array.isArray(block)) continue;
    for (const key of Object.keys(block)) {
      // Only strings: a number or an object in an env block is a malformed settings file, and
      // coercing it would invent a credential shape nothing on the wire could match.
      if (typeof block[key] === 'string') out[key] = block[key];
    }
  }
  return out;
}

// One read per process. Every hook is a short-lived process, so this is the whole cache: it turns
// the checkpoint path (which runs on every Bash tool call) from two file reads into zero after the
// first, and it cannot go stale within a process's life. Only the no-deps path is cached — an
// injected deps object describes a different disk and must never be answered from another one.
let cachedSettingsEnv = null;

function settingsEnvOnce(deps) {
  if (deps != null && (deps.readFile != null || deps.exists != null || deps.homedir != null || deps.env != null)) {
    return readSettingsEnv(deps);
  }
  if (cachedSettingsEnv == null) cachedSettingsEnv = readSettingsEnv(deps);
  return cachedSettingsEnv;
}

// The env every token read should use: `env` as given, unless it carries no fingerprintable setup
// token and a settings file does. Returns the SAME object when it has nothing to add, so the
// common case allocates nothing and identity comparisons stay cheap.
//
// The gate is keyFingerprint, not truthiness, and it is the same gate every suppression site uses:
// `CLAUDE_CODE_OAUTH_TOKEN=x` in a shell profile identifies nothing, so a real settings token must
// be allowed to replace it — which is also how Claude Code ranks the two ("the settings file value
// applies").
//
// Only the one key is taken. The settings block may also hold ANTHROPIC_API_KEY and friends, and
// letting those in through the side door would change what detectBillingSource sees on machines
// whose billing we have no new evidence about.
export function oauthTokenEnv(env = process.env, deps = {}) {
  if (keyFingerprint(env == null ? null : env.CLAUDE_CODE_OAUTH_TOKEN) != null) return env;
  const fromSettings = settingsEnvOnce(deps).CLAUDE_CODE_OAUTH_TOKEN;
  if (keyFingerprint(fromSettings) == null) return env;
  return { ...env, CLAUDE_CODE_OAUTH_TOKEN: fromSettings };
}

// The same resolution as oauthTokenEnv, plus ONE tier at the very end: the OS-level persistent
// environment (Windows' registry env, macOS' launchctl) via lib/os-env-token.mjs. Chain order is
// process.env → user settings file → OS environment, weakest last, and every candidate passes the
// same keyFingerprint gate.
//
// It is a SEPARATE function on purpose. osEnvOauthToken may spawn subprocesses, and oauthTokenEnv
// is reached through default parameters (`env = oauthTokenEnv(process.env)` in billing-config.mjs)
// that make a call site look free while it is not — a spawn hidden behind one of those would ride
// the PostToolUse-Bash hot path invisibly. Keeping the spawning variant separate means every
// caller that pays the cost names it in its own source.
//
// Structure carries the cost guarantee: oauthTokenEnv only returns a NEW object when it found a
// fingerprintable token, so an early return on the merged result means the probe cannot run once
// an earlier tier has answered. Nothing is probed on the machines that already know who they are.
//
// deps NARROWING, and it is load-bearing. The settings-file tier legitimately consumes
// deps.readFile / deps.exists / deps.homedir / deps.env, so the full bag goes to oauthTokenEnv. The
// probe gets ONLY its own seam: os-env-token bypasses its module-level cache the moment it sees an
// injected `env`, `platform` or `run`, so forwarding this bag would let a caller that injects an
// env — session-start.mjs offers exactly that seam — silently turn the cache off and re-spawn the
// whole chain on every call. The probe therefore runs with no deps at all unless a test replaces
// the function itself.
//
// Best-effort like everything else here: a probe that throws is "nothing known", never an error on
// a hook path.
export function oauthTokenEnvWithOsProbe(env = process.env, deps = {}) {
  const merged = oauthTokenEnv(env, deps);
  if (keyFingerprint(merged == null ? null : merged.CLAUDE_CODE_OAUTH_TOKEN) != null) return merged;
  const probe = deps.osEnvOauthToken == null ? _osEnvOauthToken : deps.osEnvOauthToken;
  let found = null;
  try { found = probe(); } catch { found = null; }
  if (keyFingerprint(found) == null) return env;
  return { ...env, CLAUDE_CODE_OAUTH_TOKEN: found };
}

// Test seam: the process-lifetime cache above would otherwise leak one test's disk into the next.
export function resetSettingsEnvCache() {
  cachedSettingsEnv = null;
}
