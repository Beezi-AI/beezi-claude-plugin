import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { beeziHome, claudeHome } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';

// Installs the status-line wrapper that feeds lib/statusline-usage.mjs. Claude Code has no
// plugin component for status lines (only hooks/commands/skills/MCP), so the live rate-limit
// capture only exists once `settings.json → statusLine` points at a script of ours. That is a
// USER setting — this module is only ever run from /beezi:login after the user agrees.
//
// The wrapper is a tiny shim at a STABLE path (beeziHome()) — sh on macOS/Linux, PowerShell on
// Windows — because the plugin's own path is versioned and changes on every update. The shim
// re-resolves the newest installed plugin at render time and chains the status line the user
// already had, byte-for-byte (statusline.mjs runs the chain via BEEZI_STATUSLINE_CHAIN).

export function statuslineShimFile(platform = process.platform) {
  return path.join(beeziHome(), platform === 'win32' ? 'statusline.ps1' : 'statusline.sh');
}

// The statusLine object that was replaced, kept for uninstall: { statusLine: <object|null> }.
function originalFile() {
  return path.join(beeziHome(), 'statusline-original.json');
}

function settingsFile() {
  return path.join(claudeHome(), 'settings.json');
}

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const psQuote = (s) => `'${String(s).replace(/'/g, `''`)}'`;

// Any Beezi variant's shim (~/.beezi/statusline.sh, ~/.beezi-staging/statusline.ps1, a
// powershell.exe invocation wrapping one, …). Never chained — wrapping a wrapper would stack
// captures on every re-login.
const isBeeziShim = (command) =>
  typeof command === 'string' && /[/\\]\.beezi[^/\\]*[/\\]statusline\.(sh|ps1)(?:"|$)/.test(command);

const commandUsesShim = (command, shim) => typeof command === 'string' && command.includes(shim);

// The command object's statusline command string, or null when it is not a command statusLine.
function commandOf(statusLine) {
  if (statusLine == null || statusLine.type !== 'command') return null;
  return typeof statusLine.command === 'string' ? statusLine.command : null;
}

// Where the capture script lives: marketplace cache layout is <plugin>/<version>/…, so a glob
// over the sibling versions of this install picks the newest file across plugin updates. The
// absolute path of THIS install is the fallback for repo checkouts outside the cache.
function captureScriptPaths(deps) {
  const self = deps.selfPath == null ? fileURLToPath(import.meta.url) : deps.selfPath;
  const pluginRoot = path.dirname(path.dirname(self));
  return {
    glob: path.join(path.dirname(pluginRoot), '*', 'scripts', 'statusline.mjs'),
    current: path.join(pluginRoot, 'scripts', 'statusline.mjs'),
  };
}

function shShimContent(chainCommand, deps) {
  const { glob, current } = captureScriptPaths(deps);
  const chainEnv = chainCommand ? `BEEZI_STATUSLINE_CHAIN=${shQuote(chainCommand)} ` : '';
  // Degraded modes never blank a status line the user already had: no node or no plugin
  // falls back to running the chained command directly (or printing nothing if there was none).
  const fallback = chainCommand ? `printf '%s' "$input" | ${chainCommand}` : ':';
  return `#!/bin/sh
# Beezi status line shim — installed by /beezi:login. Records the rate-limit state Claude Code
# hands every render, then draws your previous status line unchanged.
# Remove with: /beezi:login → decline, or node <plugin>/scripts/statusline-install.mjs --uninstall
input=$(cat)
script=$(ls -t ${glob} 2>/dev/null | head -n 1)
[ -n "$script" ] || script=${shQuote(current)}
if [ -f "$script" ] && command -v node >/dev/null 2>&1; then
  printf '%s' "$input" | ${chainEnv}node "$script"
else
  ${fallback}
fi
`;
}

function psShimContent(chainCommand, deps) {
  const { glob, current } = captureScriptPaths(deps);
  return `# Beezi status line shim — installed by /beezi:login. Records the rate-limit state Claude Code
# hands every render, then draws your previous status line unchanged.
# Remove with: /beezi:login → decline, or node <plugin>/scripts/statusline-install.mjs --uninstall
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.UTF8Encoding]::new($false)
$in = [Console]::In.ReadToEnd()
$chain = ${psQuote(chainCommand == null ? '' : chainCommand)}
$found = Get-ChildItem -Path ${psQuote(glob)} -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
$script = if ($found) { $found.FullName } else { ${psQuote(current)} }
if ((Test-Path $script) -and (Get-Command node -ErrorAction SilentlyContinue)) {
  if ($chain) { $env:BEEZI_STATUSLINE_CHAIN = $chain }
  $in | node $script
} elseif ($chain) {
  $in | & $env:ComSpec /c $chain
}
`;
}

// A bare `powershell.exe` resolves against the child's current directory first (same hijack
// credentials.mjs pins against), so the settings command names the System32 binary outright.
function windowsShimCommand(shim, env) {
  const ps = env.SystemRoot
    ? path.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
  return `"${ps}" -NoProfile -ExecutionPolicy Bypass -File "${shim}"`;
}

function readSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile(), 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { settings: parsed }
      : { error: 'unexpected shape' };
  } catch (e) {
    return e != null && e.code === 'ENOENT' ? { settings: {} } : { error: 'unreadable' };
  }
}

// settings.json is the user's own file: pretty-printed, default perms, written atomically so a
// crash can never leave Claude Code with half a config.
function writeSettings(settings) {
  const file = settingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.beezi-tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

// Returns { ok, message }. Never throws for expected failures.
export function installStatusline(deps = {}) {
  const platform = deps.platform == null ? process.platform : deps.platform;
  const env = deps.env == null ? process.env : deps.env;

  const { settings, error } = readSettings();
  if (error) {
    return { ok: false, message: `Beezi: could not parse ${settingsFile()} (${error}) — status line left untouched.` };
  }

  const current = settings.statusLine;
  const currentCommand = commandOf(current);
  const shim = statuslineShimFile(platform);
  const alreadyOurs = commandUsesShim(currentCommand, shim);

  // Re-install keeps the ORIGINAL original; a foreign Beezi shim is replaced, never chained.
  let chain = null;
  if (alreadyOurs || isBeeziShim(currentCommand)) {
    const stored = readJson(originalFile());
    chain = commandOf(stored == null ? null : stored.statusLine);
  } else {
    chain = currentCommand;
  }

  fs.mkdirSync(beeziHome(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(shim, platform === 'win32' ? psShimContent(chain, deps) : shShimContent(chain, deps));
  if (platform !== 'win32') fs.chmodSync(shim, 0o755);

  if (alreadyOurs) {
    return { ok: true, message: 'Beezi: status line already installed — live usage capture is on.' };
  }

  if (!isBeeziShim(currentCommand)) {
    writeJsonSecure(originalFile(), { statusLine: current == null ? null : current });
  }
  settings.statusLine = {
    type: 'command',
    command: platform === 'win32' ? windowsShimCommand(shim, env) : shim,
    ...(current != null && typeof current.padding === 'number' ? { padding: current.padding } : {}),
  };
  writeSettings(settings);

  return chain
    ? { ok: true, message: 'Beezi: status line wrapped — live usage capture is on; your existing status line still renders unchanged.' }
    : { ok: true, message: 'Beezi: status line installed — live usage capture is on (folder · model · plan usage).' };
}

// Puts back whatever /beezi:login replaced, but only while settings still point at our shim —
// a status line the user changed since is theirs, not ours to touch.
export function uninstallStatusline(deps = {}) {
  const platform = deps.platform == null ? process.platform : deps.platform;
  const { settings, error } = readSettings();
  if (error) {
    return { ok: false, message: `Beezi: could not parse ${settingsFile()} (${error}) — nothing restored.` };
  }
  const shim = statuslineShimFile(platform);
  const pointsAtUs = commandUsesShim(commandOf(settings.statusLine), shim);

  if (pointsAtUs) {
    const stored = readJson(originalFile());
    const orig = stored == null ? null : stored.statusLine;
    if (orig) settings.statusLine = orig;
    else delete settings.statusLine;
    writeSettings(settings);
  }
  try { fs.unlinkSync(shim); } catch { /* already absent */ }
  try { fs.unlinkSync(originalFile()); } catch { /* already absent */ }
  return {
    ok: true,
    message: pointsAtUs
      ? 'Beezi: status line restored — live usage capture is off.'
      : 'Beezi: status line was not ours to restore — shim removed, settings left untouched.',
  };
}
