import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { credentialsFile } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';

import { envSuffix } from './paths.mjs';

// Per-environment credential entry ('beezi-analytics-dev' on the dev variant), so a dev login
// can never overwrite the prod or staging token.
const SERVICE = `beezi-analytics${envSuffix()}`;
const ACCOUNT = 'token';

// Absolute path to PowerShell — never a bare name. On Windows a bare `powershell.exe`
// is resolved against the child's current directory first, so an attacker file dropped
// in a repo the user opens could be executed (and would receive the plaintext token on
// stdin). Pinning the system path closes that hijack.
const POWERSHELL = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

// Run a command with no shell (argv array), optional stdin. Never throws — returns
// { ok, stdout } so callers can fall back to the file store on any failure.
function defaultRun(file, args, input) {
  try {
    const stdout = execFileSync(file, args, {
      input: input == null ? undefined : input,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
      // Bound the spawn: a locked keychain / hung helper must not block the hook.
      timeout: 5000,
      killSignal: 'SIGKILL',
    });
    return { ok: true, stdout: stdout == null ? '' : stdout };
  } catch {
    return { ok: false, stdout: '' };
  }
}

// Turn a run() result into a trimmed token, or null.
function tokenFrom(r) {
  const t = r.ok ? r.stdout.trim() : '';
  return t || null;
}

// ── file store: the always-available fallback, and where the Windows DPAPI
//    ciphertext is kept (0600; on Windows the user profile ACL also applies). ──

function fileRead() {
  return readJson(credentialsFile());
}

function fileWrite(obj) {
  writeJsonSecure(credentialsFile(), obj);
}

function fileDelete() {
  try { fs.unlinkSync(credentialsFile()); } catch { /* already absent */ }
}

// ── backends. Each: { available(), get() -> string|null, set(token) -> boolean, delete() }.

function macBackend(run) {
  return {
    available: () => true, // `security` ships with macOS
    get() {
      return tokenFrom(run('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w']));
    },
    set(token) {
      return run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', ACCOUNT, '-w', token]).ok
        ? 'the macOS keychain' : false;
    },
    delete() {
      run('security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT]);
    },
  };
}

function secretToolBackend(run) {
  const attrs = ['service', SERVICE, 'account', ACCOUNT];
  return {
    available: () => run('secret-tool', ['--version']).ok, // libsecret often absent
    get() {
      return tokenFrom(run('secret-tool', ['lookup', ...attrs]));
    },
    set(token) {
      // secret-tool reads the secret from stdin — keeps it out of the process list.
      return run('secret-tool', ['store', `--label=${SERVICE}`, ...attrs], token).ok
        ? 'the OS secret service (libsecret)' : false;
    },
    delete() {
      run('secret-tool', ['clear', ...attrs]);
    },
  };
}

// Windows: the primary store is the Credential Manager, reached via a P/Invoke to advapi32
// (CredWrite/CredRead/CredDelete) — the token then appears under Control Panel → Credential
// Manager → Windows Credentials, keyed by SERVICE. The `cmdkey` CLI can *store* but not read
// a secret back, so we call the Win32 API directly through PowerShell. Should that ever fail
// (locked-down box, PowerShell missing) we fall back to DPAPI (user-bound OS crypto) with the
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
// round-trips any character (verified against '&', '=', '.').
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
const CRED_WRITE = `$in=[Console]::In.ReadToEnd()
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
$c.Type=1; $c.TargetName='${SERVICE}'; $c.UserName='${ACCOUNT}'
$c.CredentialBlob=$blob; $c.CredentialBlobSize=$bytes.Length; $c.Persist=2
$ok=[BeeziCredW]::CredWrite([ref]$c,0)
[Runtime.InteropServices.Marshal]::FreeHGlobal($blob)
if($ok){'OK'}else{exit 1}`;

// Reads the GENERIC credential back and writes the plaintext secret to stdout; exits non-zero
// when the target is absent (fresh machine, or token stored by the DPAPI fallback instead).
const CRED_READ = `Add-Type @"
using System; using System.Runtime.InteropServices;
public class BeeziCredR {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, uint type, uint flags, out IntPtr cred);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);${CRED_STRUCT}
}
"@
$ptr=[IntPtr]::Zero
if(-not [BeeziCredR]::CredRead('${SERVICE}',1,0,[ref]$ptr)){exit 1}
$cred=[Runtime.InteropServices.Marshal]::PtrToStructure($ptr,[Type][BeeziCredR+CREDENTIAL])
$size=$cred.CredentialBlobSize
if($size -gt 0){
  $bytes=New-Object byte[] $size
  [Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob,$bytes,0,$size)
  [Console]::Out.Write([Text.Encoding]::Unicode.GetString($bytes))
}
[BeeziCredR]::CredFree($ptr)`;

const CRED_DELETE = `Add-Type @"
using System; using System.Runtime.InteropServices;
public class BeeziCredD {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredDelete(string target, uint type, uint flags);
}
"@
[void][BeeziCredD]::CredDelete('${SERVICE}',1,0)`;

function credManBackend(run) {
  return {
    available: () => true, // advapi32 + PowerShell ship with Windows; failures fall through
    get() {
      return tokenFrom(powershell(run, CRED_READ));
    },
    set(token) {
      const r = powershell(run, CRED_WRITE, token);
      return r.ok && r.stdout.trim() === 'OK' ? 'the Windows Credential Manager' : false;
    },
    delete() {
      powershell(run, CRED_DELETE);
    },
  };
}

function dpapiFileBackend(run) {
  return {
    available: () => true, // PowerShell ships with Windows; DPAPI failures fall back below
    get() {
      const obj = fileRead();
      if (!obj) return null;
      if (typeof obj.enc === 'string') return tokenFrom(powershell(run, DPAPI_DEC, obj.enc));
      return typeof obj.token === 'string' ? obj.token : null; // plaintext (DPAPI was down at set)
    },
    set(token) {
      const r = powershell(run, DPAPI_ENC, token);
      if (r.ok && r.stdout.trim()) { fileWrite({ enc: r.stdout.trim() }); return 'Windows DPAPI (encrypted at rest)'; }
      fileWrite({ token }); // DPAPI unavailable → plaintext, still 0600
      return 'a restricted local file';
    },
    delete: fileDelete,
  };
}

function fileBackend() {
  return {
    available: () => true,
    get() {
      const obj = fileRead();
      return obj && typeof obj.token === 'string' ? obj.token : null;
    },
    set(token) { fileWrite({ token }); return 'a restricted local file'; },
    delete: fileDelete,
  };
}

// Preferred backend chain for the platform; the plaintext file is always the tail.
function backends(deps) {
  const run = deps.run == null ? defaultRun : deps.run;
  const platform = deps.platform == null ? process.platform : deps.platform;
  const file = fileBackend();
  if (platform === 'darwin') return [macBackend(run), file];
  if (platform === 'linux') return [secretToolBackend(run), file];
  if (platform === 'win32') return [credManBackend(run), dpapiFileBackend(run), file];
  return [file];
}

// The backends store an opaque string. Since the Clerk OAuth migration that
// string is a JSON credentials object: { client_id, redirect_uri,
// token_endpoint, access_token, refresh_token, expires_at }. Legacy bare
// device tokens fail to parse and read as "not linked".
function parseCredentials(raw) {
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' && typeof obj.access_token === 'string' ? obj : null;
  } catch {
    return null;
  }
}

export async function getCredentials(deps = {}) {
  for (const b of backends(deps)) {
    if (!b.available()) continue;
    const raw = b.get();
    if (raw) return parseCredentials(raw);
  }
  return null;
}

// Returns a human-readable description of where the credentials were actually
// stored, so the caller can report accurately (keychain vs a local file)
// instead of always claiming the keychain.
export async function setCredentials(creds, deps = {}) {
  const raw = JSON.stringify(creds);
  for (const b of backends(deps)) {
    if (!b.available()) continue;
    const where = b.set(raw);
    if (where) return where;
  }
  return 'a restricted local file';
}

export async function deleteCredentials(deps = {}) {
  // Clear every backend that could hold it (keychain + file), best-effort.
  for (const b of backends(deps)) {
    if (b.available()) { try { b.delete(); } catch { /* ignore */ } }
  }
}
