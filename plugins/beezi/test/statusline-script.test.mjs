import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/statusline.mjs runs as a process Claude Code KILLS rather than waits for: every
// re-render aborts the one still in flight, and the abort arrives as a SIGTERM to the process
// group (cli.js spawns status-line commands detached). These tests drive the real script the
// same way, so the ordering of capture vs. render is pinned by behaviour and not by reading.

const SCRIPT = fileURLToPath(new URL('../scripts/statusline.mjs', import.meta.url));

const PAYLOAD = JSON.stringify({
  model: { display_name: 'Opus 5' },
  workspace: { current_dir: '/tmp' },
  rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
    seven_day: { used_percentage: 71, resets_at: 1738857600 },
  },
});

// The chain is run through spawnSync(shell: true) — cmd.exe on Windows, /bin/sh elsewhere — so a
// fixture written in one shell's syntax silently does nothing in the other. cmd has no `;`
// sequencing and no `sleep`, and it cannot find an unquoted interpreter path containing spaces
// ("C:\Program Files\nodejs\node.exe"). What these tests pin — capture-before-render ordering and
// a chained line larger than the pipe buffer — is platform-independent, so the fixtures name both
// shells rather than skipping the coverage.
const isWindows = process.platform === 'win32';

// Always quoted: harmless for /bin/sh, required for the spaces in the Windows install path.
const NODE = `"${process.execPath}"`;

// Emit exact bytes with no trailing newline, without depending on a `printf` binary existing.
const emit = (text) => `${NODE} -e "process.stdout.write('${text}')"`;

// Signals that it started, then stays running until the process group is killed. This is the slow
// custom status line (git-heavy repo, npx-launched line) whose observation the ordering bug lost.
const blockUntilKilled = (marker) => (isWindows
  ? `echo started> "${marker}" & ping -n 30 127.0.0.1 > nul`
  : `printf started > '${marker}'; sleep 5; printf CHAINED`);

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const usageFile = (home) => path.join(home, 'statusline-usage.json');

const pendingRows = (home) => {
  const file = usageFile(home);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf-8')).pending;
};

// Runs the script exactly as the shim does. `killOnMarker` waits for the chained command to
// signal that it started, then SIGTERMs the whole group — reproducing a superseding render
// without racing a timer.
function runStatusline({ home, chain, killOnMarker = null }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, BEEZI_HOME: home, BEEZI_ENV: '' };
    if (chain == null) delete env.BEEZI_STATUSLINE_CHAIN;
    else env.BEEZI_STATUSLINE_CHAIN = chain;

    const child = spawn(process.execPath, [SCRIPT], { env, detached: true, stdio: 'pipe' });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stdin.on('error', () => { /* killed before stdin drained */ });
    child.stdin.end(PAYLOAD);

    let killed = false;
    let waiting = null;
    if (killOnMarker) {
      const deadline = Date.now() + 10000;
      waiting = setInterval(() => {
        if (fs.existsSync(killOnMarker)) {
          clearInterval(waiting);
          waiting = null;
          killed = true;
          try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ }
        } else if (Date.now() > deadline) {
          clearInterval(waiting);
          waiting = null;
          reject(new Error('chained command never started'));
        }
      }, 5);
    }

    child.on('error', reject);
    child.on('close', () => {
      if (waiting) clearInterval(waiting);
      resolve({ stdout, killed });
    });
  });
}

test('statusline script — the capture survives a kill landing while the chained line runs', async (t) => {
  const home = tmpDir(t, 'statusline-kill-');
  const marker = path.join(tmpDir(t, 'statusline-marker-'), 'started');
  const chain = blockUntilKilled(marker);

  const { stdout, killed } = await runStatusline({ home, chain, killOnMarker: marker });

  assert.equal(killed, true, 'the run must have been killed mid-chain');
  assert.equal(stdout, '', 'a killed chain renders nothing — that part is expected');
  const pending = pendingRows(home);
  assert.ok(pending, 'the observation must be recorded before the chain is given the process');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].five_hour_pct, 23.5);
  assert.equal(pending[0].seven_day_pct, 71);
});

test('statusline script — an uninterrupted chain still renders byte-for-byte and captures', async (t) => {
  const home = tmpDir(t, 'statusline-chain-');
  const { stdout } = await runStatusline({ home, chain: emit('my custom line') });

  assert.equal(stdout, 'my custom line');
  const pending = pendingRows(home);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].five_hour_pct, 23.5);
});

test('statusline script — a chained line larger than the pipe buffer arrives whole', async (t) => {
  // stdout is a pipe, so anything past the ~64KB buffer is still queued when the script ends.
  // Exiting with process.exit() would drop the remainder and silently clip someone's line.
  const home = tmpDir(t, 'statusline-big-');
  const size = 200000;
  const chain = `${NODE} -e "process.stdout.write('x'.repeat(${size}))"`;

  const { stdout } = await runStatusline({ home, chain });

  assert.equal(stdout.length, size);
  assert.equal(pendingRows(home).length, 1);
});

test('statusline script — with no chain the default line renders and the capture lands', async (t) => {
  const home = tmpDir(t, 'statusline-nochain-');
  const { stdout } = await runStatusline({ home, chain: null });

  assert.ok(stdout.length > 0, 'an absent statusLine is a disabled one, so we draw our own');
  assert.equal(pendingRows(home).length, 1);
});

test('statusline script — a capture that throws never blanks the chained line', async (t) => {
  // BEEZI_HOME under a regular file: every write path inside the capture raises ENOTDIR.
  const blocker = path.join(tmpDir(t, 'statusline-blocked-'), 'not-a-dir');
  fs.writeFileSync(blocker, 'x');
  const home = path.join(blocker, 'home');

  const { stdout } = await runStatusline({ home, chain: emit('still rendered') });

  assert.equal(stdout, 'still rendered');
  assert.equal(fs.existsSync(usageFile(home)), false);
});
