import fs from 'fs';
import path from 'path';
import { beeziHome } from './paths.mjs';
import { detectPermissionMode, isPlanMode, isAutoMode } from './permission-mode.mjs';

// Can this session actually create the files /beezi:login has to write?
//
// This is a real write, not an inference. Claude Code's Bash sandbox (macOS, Linux and WSL2 —
// native Windows has none) allows writes only inside the working directory and $TMPDIR, so
// ~/.beezi is out of reach and the credential and billing files silently fail to land. Nothing
// in the environment reliably says "you are sandboxed", and the permission mode does not: the
// sandbox is a separate feature that combines with any mode. Writing a byte answers it directly
// and stays correct for every other cause too — a read-only home, a locked-down CI image, a
// BEEZI_HOME pointed somewhere unwritable.
//
// Returns { ok, dir, code }; `code` is the errno ('EPERM', 'EACCES', …) when the write failed.
export function probeStateWritable() {
  const dir = beeziHome();
  const probe = path.join(dir, `.write-probe-${process.pid}`);
  try {
    // 0o700 like statusline-install.mjs: credentials.json lives in this directory, and on a fresh
    // machine the preflight is what creates it first.
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(probe, '', 'utf-8');
  } catch (error) {
    return { ok: false, dir, code: error == null || !error.code ? 'unknown' : error.code };
  }
  // Best effort: a probe file left behind is harmless next to the queue and state dirs, and a
  // failure to unlink is not a reason to refuse a login that can plainly write.
  try {
    fs.unlinkSync(probe);
  } catch { /* ignore */ }
  return { ok: true, dir, code: null };
}

// Whether /beezi:login can run to completion in this session.
//
// Three independent blockers, all observed rather than assumed:
//   'plan_mode'        — Claude Code gates the shell commands the flow is made of.
//   'auto_mode'        — the permission classifier denies the plugin's node scripts mid-flow.
//   'state_unwritable' — the link's own files cannot be written (sandbox, or an unwritable home).
//
// The mode checks come first and cost nothing; the probe is the one that catches a sandbox, which
// no mode can tell you about — the Bash sandbox is a separate feature that combines with any mode.
//
// Fails OPEN on an undetectable mode: only a mode actually read as plan or auto blocks.
// Returns { ok, reason, mode, dir, code }.
export function preflightLogin({ env = process.env } = {}) {
  const mode = detectPermissionMode({ env });
  if (isPlanMode(mode)) return { ok: false, reason: 'plan_mode', mode, dir: null, code: null };
  if (isAutoMode(mode)) return { ok: false, reason: 'auto_mode', mode, dir: null, code: null };

  const probe = probeStateWritable();
  if (!probe.ok) {
    return { ok: false, reason: 'state_unwritable', mode, dir: probe.dir, code: probe.code };
  }
  return { ok: true, reason: null, mode, dir: probe.dir, code: null };
}
