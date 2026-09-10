import { execFileSync } from 'child_process';
import path from 'path';
import { keyFingerprint } from './oauth-identity.mjs';

// The THIRD home of CLAUDE_CODE_OAUTH_TOKEN, and the only one this process cannot simply read:
// the OS-level persistent environment (Windows' User/Machine registry env, macOS' launchctl).
//
// WHY THIS MODULE EXISTS AT ALL. Verified against the shipped Claude Code bundle 2.1.251: its
// child-environment builder explicitly does `delete d.CLAUDE_CODE_OAUTH_TOKEN` — alongside
// CLAUDE_CODE_ARTIFACTS_API_TOKEN and CLAUDE_CODE_SLACK_TAG_TOKEN — for EVERY subprocess it spawns:
// hooks, stdio MCP servers, the Bash tool, LSP servers, plugin commands, `gh`. It is plain JS with
// no platform branch, so macOS behaves exactly like Windows, and the scrub is self-triggering: the
// sanitize branch engages precisely BECAUSE the token is present. Consequence: a plugin hook can
// never see CLAUDE_CODE_OAUTH_TOKEN in process.env, no matter how the user set it. That — not the
// `setx`-after-Claude-Code-started ordering story this module's predecessor told — is the primary
// cause of every "I set a setup token and Beezi says there is none" report.
//
// Also verified: a `settings.json` `env` entry lands in Claude Code's OWN process.env and is then
// scrubbed on the way out again, which is why lib/claude-settings-env.mjs has to READ the settings
// file rather than trust inheritance. This module is the same move one layer down.
//
// THIS STEPS OVER A FENCE ANTHROPIC PUT UP ON PURPOSE. They scrub the variable so a setup token
// does not spread into arbitrary child processes, and reading it back out of the registry defeats
// that for this one process. It is done knowingly, for one narrow purpose (naming the subscription
// behind the key a human just asked about), and the discipline that makes it defensible is kept
// absolutely: the raw value NEVER leaves this process. Only the existing prefix/last4/length
// fingerprint is ever persisted or sent — see oauth-identity.mjs. It is also never put in argv:
// only the variable NAME crosses a command line, because process listings are world-readable.
//
// NOT PROOF OF WHAT CLAUDE CODE AUTHENTICATED WITH. A registry value may have been rotated after
// the session started, so a recovered token describes the machine's configuration, not the
// session's credential. No branch guards that, and none can — the fingerprint is the only local
// signal that moves when the token does (see oauth-identity.mjs), and a stale fingerprint is still
// a better answer than the "no key at all" the scrub would otherwise produce.
//
// THIS RUNS ON HOOK PATHS, so the budget is the design constraint. It reaches the PostToolUse-Bash
// checkpoint (lib/checkpoint.mjs) and SessionStart, where the whole hook has 10s and the identity
// stamp is the reason the token has to get here at all. Measured on Windows 11 (26200):
//
//   no token set (the common case)  2 reg queries, ~56ms total (31ms HKCU + 25ms HKLM), no PowerShell
//   token in User scope             1 reg query, 38ms median (34.8-46.0, n=8, fresh process each)
//   reg.exe unusable                + ~261ms for the PowerShell fallback — the rare path only
//   linux / other                   0 spawns
//   darwin                          1 launchctl call, ~10ms
//
// Keeping the no-token case off PowerShell is the whole point of the stderr capture in defaultRun;
// before it, every Bash tool call on a token-less Windows machine paid the full ~316ms to learn
// nothing. On top of that the module-level cache below makes this ONE probe per process, so a hook
// pays it at most once no matter how many callers ask.
//
// CALLER CONTRACT, and it is load-bearing for that cache: PRODUCTION CALLERS PASS NO DEPS. Call it
// as `osEnvOauthToken()`. Injecting anything — `env`, `platform` or `run` — bypasses the cache by
// design, because an injected deps object describes a different machine. `deps.env` in particular
// is only the map that %VAR% references expand against, and it already defaults to process.env, so
// there is never a reason to forward a caller's env into it; doing so would quietly turn "one probe
// per hook process" back into two reg queries per call. Only tests inject.

const VAR = 'CLAUDE_CODE_OAUTH_TOKEN';

// Absolute paths — never a bare name. A bare `reg.exe` / `powershell.exe` is resolved against the
// child's current directory first, so a file dropped into a repo the user opens could be executed
// instead. Same pinning lib/credential-backends.mjs already does; the bare name is the last resort for a
// machine with no SystemRoot at all, where there is nothing better to pin to.
function systemBinary(...parts) {
  const root = process.env.SystemRoot;
  return root ? path.join(root, 'System32', ...parts) : parts[parts.length - 1];
}

const REG = systemBinary('reg.exe');
const POWERSHELL = systemBinary('WindowsPowerShell', 'v1.0', 'powershell.exe');

// `-NoProfile` is load-bearing, not hygiene: without it a user profile script runs first and can
// change what the child prints. `-NonInteractive` so a profile that prompts cannot wedge it.
// User scope is read first and Machine only as a fallback, matching Windows' own resolution order.
const PS_SCRIPT = `$v=[Environment]::GetEnvironmentVariable('${VAR}','User');`
  + `if(-not $v){$v=[Environment]::GetEnvironmentVariable('${VAR}','Machine')};`
  + 'if($v){$v}';

const HKCU_ENV = 'HKCU\\Environment';
const HKLM_ENV = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';

function text(value) {
  if (typeof value === 'string') return value;
  // execFileSync attaches Buffers when the encoding did not apply; String() on one is its content.
  return value == null ? '' : String(value);
}

// Run with no shell (argv array) and never throw — { ok, stdout, stderr } so every caller can just
// fall through to the next probe. Modelled on defaultRun in lib/credential-backends.mjs, with one
// deliberate difference: stderr is CAPTURED, not discarded.
//
// That capture is what makes this module cheap enough for a hook path. `reg query` exits non-zero
// both for "there is no such value" and for "I could not run", and with stderr dropped those two
// are indistinguishable — which used to force the 260ms PowerShell fallback on every machine that
// simply has no token, i.e. most of them. The child's own error text separates them; see
// REG_NOT_FOUND below.
//
// On a non-zero exit execFileSync throws but has already collected what the child printed, so
// err.stdout / err.stderr carry the answer. They are absent when the process never ran at all
// (ENOENT) or was killed on the timeout — which is exactly the case that should reach PowerShell.
function defaultRun(file, args) {
  try {
    const stdout = execFileSync(file, args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 3000,
      killSignal: 'SIGKILL',
    });
    return { ok: true, stdout: text(stdout), stderr: '' };
  } catch (err) {
    return {
      ok: false,
      stdout: text(err == null ? null : err.stdout),
      stderr: text(err == null ? null : err.stderr),
    };
  }
}

// Case-insensitive %NAME% expansion out of the given env. Unknown names are left LITERAL, exactly
// as Windows does — an unexpandable reference is not an empty string, and blanking it would hand a
// caller a corrupted value that still looks plausible.
//
// No String.prototype.replaceAll and no Object.hasOwn here: both are above this plugin's Node 13.2
// floor. The scan over Object.keys is fine — an env block is tens of entries, not thousands.
function expandPercentRefs(value, env) {
  return value.replace(/%([^%]+)%/g, (whole, name) => {
    const wanted = name.toLowerCase();
    const keys = Object.keys(env == null ? {} : env);
    for (let i = 0; i < keys.length; i += 1) {
      if (keys[i].toLowerCase() === wanted) {
        const found = env[keys[i]];
        if (typeof found === 'string') return found;
      }
    }
    return whole;
  });
}

// Pull the value out of `reg query` output. The shape is a leading blank line, the resolved key
// path, then indented `name    type    data` lines:
//
//     (blank)
//     HKEY_CURRENT_USER\Environment
//         CLAUDE_CODE_OAUTH_TOKEN    REG_SZ    sk-ant-oat01-xxxx
//
// Split on the FIRST TWO runs of whitespace only. A naive split(/\s+/) would take the third field
// as the whole value and silently truncate any data containing spaces — and env values do contain
// spaces (`C:\Program Files\...`). Anchoring `\s+` immediately after the name is also what keeps a
// sibling like CLAUDE_CODE_OAUTH_TOKEN_OLD from matching.
//
// VERIFIED: `reg query` does NOT expand REG_EXPAND_SZ — it prints the raw `%NAME%` text — so that
// type is expanded here. Any other type (REG_DWORD and friends) is not a credential in any reading
// and yields null rather than a stringified number.
function parseRegValue(stdout, env) {
  const lines = String(stdout == null ? '' : stdout).split('\n');
  const pattern = new RegExp(`^\\s*${VAR}\\s+(REG_[A-Z_]+)\\s+([\\s\\S]*)$`);
  for (let i = 0; i < lines.length; i += 1) {
    const m = pattern.exec(lines[i]);
    if (m == null) continue;
    const type = m[1];
    // Only the trailing CR (and any trailing run of blanks reg pads with); leading whitespace was
    // already eaten by the `\s+` before the capture.
    const data = m[2].replace(/[\s\r]+$/, '');
    if (data === '') return null;
    if (type === 'REG_SZ') return data;
    if (type === 'REG_EXPAND_SZ') return expandPercentRefs(data, env);
    return null;
  }
  return null;
}

// A recovered candidate is only a token if the rest of the codebase would call it one. keyFingerprint
// is that shared gate (>= 20 characters after trimming); truthiness is not enough, because an empty
// `setx CLAUDE_CODE_OAUTH_TOKEN ""` or a placeholder identifies nothing and would only mislead the
// user standing at the prompt.
function accept(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return keyFingerprint(trimmed) == null ? null : trimmed;
}

// reg.exe's own words for "that value is not there". VERIFIED on Windows 11 (26200), for both an
// absent VALUE under an existing key and an absent KEY: exit code 1, empty-ish stdout, and stderr
// exactly `ERROR: The system was unable to find the specified registry key or value.` The two
// looser alternatives are carried because this string is localized and has been reworded across
// Windows versions; a machine whose reg speaks another language simply falls through to PowerShell,
// which is the safe direction to be wrong in.
const REG_NOT_FOUND = /unable to find|cannot find|ERROR: The system was unable/i;

// One reg query, resolved into the distinction that matters: did reg ANSWER the question?
//
//   { answered: true,  token }  — reg ran. Either it printed a usable value, or it authoritatively
//                                 said there is none. Nothing else needs to be asked.
//   { answered: false, token: null } — reg never ran (ENOENT, timeout, killed) or failed in a way
//                                 its own stderr does not explain. Only this earns a fallback.
function regProbe(run, key, env) {
  const r = run(REG, ['query', key, '/v', VAR]);
  if (r.ok) return { answered: true, token: accept(parseRegValue(r.stdout, env)) };
  if (REG_NOT_FOUND.test(r.stderr == null ? '' : r.stderr)) return { answered: true, token: null };
  return { answered: false, token: null };
}

// Windows: User scope, then Machine scope, then PowerShell.
//
// The PowerShell step is deliberately narrow — it runs only when NEITHER reg query answered at all.
// A machine that simply has no token set is NOT that case: reg answers it, twice, and this returns
// null having spawned nothing else. That is the difference between ~56ms and ~316ms on every hook
// process, and it is why the stderr capture in defaultRun is load-bearing rather than tidy.
function fromWindows(run, env) {
  const user = regProbe(run, HKCU_ENV, env);
  if (user.token != null) return user.token;
  const machine = regProbe(run, HKLM_ENV, env);
  if (machine.token != null) return machine.token;
  // If either probe answered, the question is settled — a second opinion from PowerShell would cost
  // a quarter of a second to reproduce a "no" we already have.
  if (user.answered || machine.answered) return null;

  const ps = run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT]);
  return ps.ok ? accept(ps.stdout) : null;
}

// macOS: launchctl, and nothing else.
//
// `launchctl getenv` is cheap (~10ms) and it is the only persistent, non-shell env store macOS has
// — there is no registry equivalent. Be honest about what that buys: it returns ONLY values set
// with `launchctl setenv`, and NEVER reflects an export in ~/.zshrc, ~/.zshenv or ~/.bash_profile.
// In practice it is usually empty.
//
// DELIBERATELY NOT DONE: spawning `$SHELL -lc 'printf %s "$CLAUDE_CODE_OAUTH_TOKEN"'`. That would
// execute the user's entire login profile — arbitrary code, banners, version managers, anything
// that prompts and hangs — and costs 100–800ms for the privilege. It has no place in a plugin that
// also lives under a 10s hook budget, and "run the user's shell config to read a secret" is not a
// thing to do quietly. So a token that exists only as a shell `export` on macOS is NOT recoverable
// here. That is an accepted limitation, not an oversight.
function fromDarwin(run) {
  const r = run('/bin/launchctl', ['getenv', VAR]);
  return r.ok ? accept(r.stdout) : null;
}

function probe(deps) {
  const platform = deps.platform == null ? process.platform : deps.platform;
  const env = deps.env == null ? process.env : deps.env;
  const run = deps.run == null ? defaultRun : deps.run;

  if (platform === 'win32') return fromWindows(run, env);
  if (platform === 'darwin') return fromDarwin(run);
  // Linux and the rest: no OS-level persistent env store to read, so nothing is spawned at all.
  return null;
}

// One probe per process, the cached result including a cached NULL — null is the common case and
// re-probing it would spawn the whole chain again on every call. A plain `cached == null` check
// could not tell "not probed yet" from "probed, found nothing", hence the separate flag; that is
// the one place this departs from the cachedSettingsEnv shape in lib/claude-settings-env.mjs.
let probed = false;
let cachedToken = null;

// The persisted setup token, or null. Never throws; every failure is "nothing known".
//
// Only the no-deps path is cached: an injected deps object describes a different machine under
// test and must never be answered out of another one's cache.
export function osEnvOauthToken(deps = {}) {
  if (deps != null && (deps.platform != null || deps.env != null || deps.run != null)) {
    return probe(deps);
  }
  if (!probed) {
    cachedToken = probe(deps == null ? {} : deps);
    probed = true;
  }
  return cachedToken;
}

// Test seam: the process-lifetime cache above would otherwise leak one test's machine into the next.
export function resetOsEnvTokenCache() {
  probed = false;
  cachedToken = null;
}
