import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { readJson, writeJsonSecure } from './fs-store.mjs';

// Stable names recorded in the store's control record, so a reader can follow the committed
// generation to the exact backend that holds it.
export const BACKENDS = Object.freeze({
  KEYCHAIN: 'keychain',
  SECRET_SERVICE: 'secret-service',
  CREDENTIAL_MANAGER: 'credential-manager',
  DPAPI_FILE: 'dpapi-file',
  FILE: 'file',
});

// An entry names one stored secret: `service`/`account` in the OS stores, `target` for the
// Credential Manager (CredDelete keys on it alone, so it carries the generation), `file` for the
// file-backed stores.

// Absolute path to PowerShell — never a bare name. On Windows a bare `powershell.exe`
// is resolved against the child's current directory first, so an attacker file dropped
// in a repo the user opens could be executed (and would receive the plaintext token on
// stdin). Pinning the system path closes that hijack.
const POWERSHELL = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

// Bound the spawn: a locked keychain / hung helper must not block the hook.
const RUN_TIMEOUT_MS = 5000;

// Reads get their own caps, because a read is the operation that races. On Windows every read
// spawns PowerShell, which costs ~1.1s of startup before it runs a line; measured on a developer
// machine one read alone takes 1.6–5.8s depending on load, two at once ~4.2s, and eight at once
// 7.0–8.3s. Hooks fire on every tool call — twice over when a second Beezi variant is installed —
// so losing that race is the normal case, not an exotic one.
//
// The two callers have different budgets, so they get different caps:
//
//   HOOK — killed at 10s and has real work to do after the read (bind, delta, enqueue). 6s buys
//   most of the contended distribution while still leaving several seconds to finish that work;
//   spending the whole 10s on the read alone would trade a fast wrong answer for a slow no answer.
//
//   INTERACTIVE — a human is waiting and nothing kills it, so it takes the full measured worst
//   case and, above this layer, one retry.
//
// Neither cap is load-bearing for correctness any more: a read that is killed now reports
// BACKEND_TIMEOUT, which never reads as "this machine is not linked".
const HOOK_READ_TIMEOUT_MS = 6000;
const INTERACTIVE_READ_TIMEOUT_MS = 8000;

// Run a command with no shell (argv array), optional stdin. Never throws — returns
// { ok, stdout, timedOut } so callers can fall back to the file store on any failure.
//
// `timedOut` separates "the helper was KILLED before it answered" from "the helper answered no".
// Collapsing the two is what let a slow read masquerade as a deleted credential.
function defaultRun(file, args, input, options) {
  try {
    const stdout = execFileSync(file, args, {
      input: input == null ? undefined : input,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: options == null || options.timeoutMs == null ? RUN_TIMEOUT_MS : options.timeoutMs,
      killSignal: 'SIGKILL',
    });
    return { ok: true, stdout: stdout == null ? '' : stdout, timedOut: false };
  } catch (error) {
    // Node reports the timeout kill as a signalled child; ETIMEDOUT covers the platforms that
    // surface it as an error code instead. Everything else is a real answer.
    const timedOut = error != null
      && (error.code === 'ETIMEDOUT' || (error.killed === true && error.signal != null));
    return { ok: false, stdout: '', timedOut };
  }
}

// Turn a run() result into a trimmed token, or null.
function tokenFrom(r) {
  const t = r.ok ? r.stdout.trim() : '';
  return t || null;
}

// One attempt, on the cap the caller's budget allows. Retrying is the STORE's decision, not the
// backend's (see readCredentials): only the caller knows whether it is a hook with a 10s budget
// that must fail fast, or an interactive command with a human waiting that can afford a second
// try. A retry here would have applied to both, and two attempts in a hook overrun the budget
// without ever reporting anything.
function runRead(run, file, args, input, options) {
  const interactive = options != null && options.interactive === true;
  return run(file, args, input, {
    timeoutMs: interactive ? INTERACTIVE_READ_TIMEOUT_MS : HOOK_READ_TIMEOUT_MS,
  });
}

// { token, timedOut } from a read attempt, so the store can tell an absent credential from one it
// simply could not get to in time.
function readResult(r) {
  return { token: tokenFrom(r), timedOut: r.timedOut === true };
}

// ── file store: the always-available fallback, and where the Windows DPAPI
//    ciphertext is kept (0600; on Windows the user profile ACL also applies). ──

function fileDelete(file) {
  try { fs.unlinkSync(file); } catch { /* already absent */ }
}

// Every backend defines read(entry) -> { token, timedOut }; get(entry) -> string|null is derived
// from it, so the many callers that only want a token keep working unchanged.
function withGet(backend) {
  backend.get = (entry, options) => backend.read(entry, options).token;
  return backend;
}

// ── backends. Each: { name, kind, available(), read(entry) -> { token, timedOut },
//    get(entry) -> string|null,
//    set(entry, secret) -> where|false, delete(entry) }.

function macBackend(run) {
  return withGet({
    name: BACKENDS.KEYCHAIN,
    kind: 'os',
    available: () => true, // `security` ships with macOS
    read(entry, options) {
      return readResult(runRead(
        run, 'security', ['find-generic-password', '-s', entry.service, '-a', entry.account, '-w'],
        undefined, options,
      ));
    },
    set(entry, secret) {
      return run('security', ['add-generic-password', '-U', '-s', entry.service, '-a', entry.account, '-w', secret]).ok
        ? 'the macOS keychain' : false;
    },
    delete(entry) {
      run('security', ['delete-generic-password', '-s', entry.service, '-a', entry.account]);
    },
  });
}

function secretToolBackend(run) {
  const attrs = (entry) => ['service', entry.service, 'account', entry.account];
  return withGet({
    name: BACKENDS.SECRET_SERVICE,
    kind: 'os',
    available: () => run('secret-tool', ['--version']).ok, // libsecret often absent
    read(entry, options) {
      return readResult(runRead(run, 'secret-tool', ['lookup', ...attrs(entry)], undefined, options));
    },
    set(entry, secret) {
      // secret-tool reads the secret from stdin — keeps it out of the process list.
      return run('secret-tool', ['store', `--label=${entry.service}`, ...attrs(entry)], secret).ok
        ? 'the OS secret service (libsecret)' : false;
    },
    delete(entry) {
      run('secret-tool', ['clear', ...attrs(entry)]);
    },
  });
}

// Windows: the primary store is the Credential Manager, reached via a P/Invoke to advapi32
// (CredWrite/CredRead/CredDelete) — the token then appears under Control Panel → Credential
// Manager → Windows Credentials, keyed by the entry's target. The `cmdkey` CLI can *store* but
// not read a secret back, so we call the Win32 API directly through PowerShell. Should that ever
// fail (locked-down box, PowerShell missing) we fall back to DPAPI (user-bound OS crypto) with the
// ciphertext kept in the 0600 file, and finally to a plaintext 0600 file.
const DPAPI_ENC = "$in=[Console]::In.ReadToEnd();Add-Type -AssemblyName System.Security;"
  + "$b=[Text.Encoding]::UTF8.GetBytes($in);"
  + "$e=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser');"
  + '[Convert]::ToBase64String($e)';
const DPAPI_DEC = "$in=[Console]::In.ReadToEnd().Trim();Add-Type -AssemblyName System.Security;"
  + "$b=[Convert]::FromBase64String($in);"
  + "$d=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');"
  + '[Text.Encoding]::UTF8.GetString($d)';

function powershell(run, script, input) {
  return run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], input);
}

// ── Windows Credential Manager via advapi32 P/Invoke (the primary Windows store) ──
// The CREDENTIAL struct is shared by the read and write scripts. CharSet=Unicode marshals
// TargetName/UserName as wide strings; the secret blob is written/read as UTF-16 so it
// round-trips any character (verified against '&', '=', '.'). Target and account names are
// plain [a-z0-9/-] identifiers, safe inside the single-quoted literals below.
const CRED_STRUCT = `
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
public struct CREDENTIAL {
  public uint Flags; public uint Type;
  public string TargetName; public string Comment;
  public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
  public uint CredentialBlobSize; public IntPtr CredentialBlob;
  public uint Persist; public uint AttributeCount; public IntPtr Attributes;
  public string TargetAlias; public string UserName;
}`;

// Reads the secret from stdin (never an argv element, so it can't leak via the process list),
// writes a GENERIC credential with LOCAL_MACHINE persistence, prints 'OK' on success.
const credWrite = (entry) => `$in=[Console]::In.ReadToEnd()
Add-Type @"
using System; using System.Runtime.InteropServices;
public class BeeziCredW {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredWrite([In] ref CREDENTIAL c, uint flags);${CRED_STRUCT}
}
"@
$bytes=[Text.Encoding]::Unicode.GetBytes($in)
$blob=[Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
[Runtime.InteropServices.Marshal]::Copy($bytes,0,$blob,$bytes.Length)
$c=New-Object BeeziCredW+CREDENTIAL
$c.Type=1; $c.TargetName='${entry.target}'; $c.UserName='${entry.account}'
$c.CredentialBlob=$blob; $c.CredentialBlobSize=$bytes.Length; $c.Persist=2
$ok=[BeeziCredW]::CredWrite([ref]$c,0)
[Runtime.InteropServices.Marshal]::FreeHGlobal($blob)
if($ok){'OK'}else{exit 1}`;

// Reads the GENERIC credential back and writes the plaintext secret to stdout; exits non-zero
// when the target is absent (fresh machine, or token stored by the DPAPI fallback instead).
const credRead = (entry) => `Add-Type @"
using System; using System.Runtime.InteropServices;
public class BeeziCredR {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, uint type, uint flags, out IntPtr cred);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);${CRED_STRUCT}
}
"@
$ptr=[IntPtr]::Zero
if(-not [BeeziCredR]::CredRead('${entry.target}',1,0,[ref]$ptr)){exit 1}
$cred=[Runtime.InteropServices.Marshal]::PtrToStructure($ptr,[Type][BeeziCredR+CREDENTIAL])
$size=$cred.CredentialBlobSize
if($size -gt 0){
  $bytes=New-Object byte[] $size
  [Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob,$bytes,0,$size)
  [Console]::Out.Write([Text.Encoding]::Unicode.GetString($bytes))
}
[BeeziCredR]::CredFree($ptr)`;

const credDelete = (entry) => `Add-Type @"
using System; using System.Runtime.InteropServices;
public class BeeziCredD {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredDelete(string target, uint type, uint flags);
}
"@
[void][BeeziCredD]::CredDelete('${entry.target}',1,0)`;

function credManBackend(run) {
  return withGet({
    name: BACKENDS.CREDENTIAL_MANAGER,
    kind: 'os',
    available: () => true, // advapi32 + PowerShell ship with Windows; failures fall through
    read(entry, options) {
      return readResult(runRead(
        run, POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', credRead(entry)],
        undefined, options,
      ));
    },
    set(entry, secret) {
      const r = powershell(run, credWrite(entry), secret);
      return r.ok && r.stdout.trim() === 'OK' ? 'the Windows Credential Manager' : false;
    },
    delete(entry) {
      powershell(run, credDelete(entry));
    },
  });
}

function dpapiFileBackend(run) {
  return withGet({
    name: BACKENDS.DPAPI_FILE,
    kind: 'file',
    available: () => true, // PowerShell ships with Windows; DPAPI failures fall back below
    read(entry, options) {
      const obj = readJson(entry.file);
      if (!obj) return { token: null, timedOut: false };
      if (typeof obj.enc === 'string') {
        return readResult(runRead(
          run, POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', DPAPI_DEC], obj.enc, options,
        ));
      }
      // plaintext (DPAPI was down at set)
      return { token: typeof obj.token === 'string' ? obj.token : null, timedOut: false };
    },
    set(entry, secret) {
      const r = powershell(run, DPAPI_ENC, secret);
      if (r.ok && r.stdout.trim()) { writeJsonSecure(entry.file, { enc: r.stdout.trim() }); return 'Windows DPAPI (encrypted at rest)'; }
      writeJsonSecure(entry.file, { token: secret }); // DPAPI unavailable → plaintext, still 0600
      return 'a restricted local file';
    },
    delete(entry) { fileDelete(entry.file); },
  });
}

function fileBackend() {
  return withGet({
    name: BACKENDS.FILE,
    kind: 'file',
    available: () => true,
    read(entry) {
      const obj = readJson(entry.file);
      return { token: obj && typeof obj.token === 'string' ? obj.token : null, timedOut: false };
    },
    set(entry, secret) { writeJsonSecure(entry.file, { token: secret }); return 'a restricted local file'; },
    delete(entry) { fileDelete(entry.file); },
  });
}

// Preferred backend chain for the platform; the plaintext file is always the tail.
export function backendsFor(deps = {}) {
  const run = deps.run == null ? defaultRun : deps.run;
  const platform = deps.platform == null ? process.platform : deps.platform;
  const file = fileBackend();
  if (platform === 'darwin') return [macBackend(run), file];
  if (platform === 'linux') return [secretToolBackend(run), file];
  if (platform === 'win32') return [credManBackend(run), dpapiFileBackend(run), file];
  return [file];
}

// The named backend when this platform's chain offers it, else null.
export function backendByName(name, deps = {}) {
  for (const b of backendsFor(deps)) {
    if (b.name === name) return b;
  }
  return null;
}
