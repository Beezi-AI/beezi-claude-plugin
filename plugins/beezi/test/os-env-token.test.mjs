import { test } from 'node:test';
import assert from 'node:assert/strict';
import { osEnvOauthToken, resetOsEnvTokenCache } from '../lib/os-env-token.mjs';

const USER_TOKEN = `sk-ant-oat01-${'a'.repeat(60)}`;
const MACHINE_TOKEN = `sk-ant-oat01-${'b'.repeat(60)}`;

// Exactly what `reg query` prints: a leading blank line, the resolved key path, then the indented
// name/type/data row. Nothing in this suite may spawn anything — `run` is always injected.
const regOut = (hive, type, data) => `\r\n${hive}\r\n    CLAUDE_CODE_OAUTH_TOKEN    ${type}    ${data}\r\n\r\n`;

const HKCU = 'HKEY_CURRENT_USER\\Environment';
const HKLM = 'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';

// reg.exe's real answer for an absent value AND for an absent key, captured verbatim from Windows
// 11 (26200): exit 1, stdout blank-ish, and this exact line on stderr. This is reg ANSWERING, not
// failing, and the module must not spend a PowerShell spawn re-asking.
const REG_ABSENT = {
  ok: false,
  stdout: '\r\n',
  stderr: 'ERROR: The system was unable to find the specified registry key or value.\r\n',
};

// reg never ran, or died before printing anything — the only case that earns the fallback.
const CANNOT_RUN = { ok: false, stdout: '', stderr: '' };

// A runner scripted by call order, recording what it was asked to execute.
function runner(results) {
  const calls = [];
  let i = 0;
  const run = (file, args) => {
    calls.push({ file, args });
    const r = results[i];
    i += 1;
    return r == null ? CANNOT_RUN : r;
  };
  return { run, calls };
}

const explode = () => { throw new Error('run must not be called'); };

test('osEnvOauthToken — other platforms spawn nothing at all', () => {
  assert.equal(osEnvOauthToken({ platform: 'linux', run: explode }), null);
  assert.equal(osEnvOauthToken({ platform: 'freebsd', run: explode }), null);
  assert.equal(osEnvOauthToken({ platform: 'aix', run: explode }), null);
});

test('osEnvOauthToken — win32 reads the User scope value', () => {
  const { run, calls } = runner([{ ok: true, stdout: regOut(HKCU, 'REG_SZ', USER_TOKEN) }]);
  assert.equal(osEnvOauthToken({ platform: 'win32', env: {}, run }), USER_TOKEN);
  // One probe only: a User hit must not go on to ask the Machine hive.
  assert.equal(calls.length, 1);
  assert.match(calls[0].file, /reg\.exe$/);
  assert.deepEqual(calls[0].args, ['query', 'HKCU\\Environment', '/v', 'CLAUDE_CODE_OAUTH_TOKEN']);
});

test('osEnvOauthToken — falls through to the Machine scope when the User scope has none', () => {
  const { run, calls } = runner([REG_ABSENT, { ok: true, stdout: regOut(HKLM, 'REG_SZ', MACHINE_TOKEN) }]);
  assert.equal(osEnvOauthToken({ platform: 'win32', env: {}, run }), MACHINE_TOKEN);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args[1], 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment');
});

test('osEnvOauthToken — User scope wins over Machine scope, as Windows itself resolves it', () => {
  const { run } = runner([
    { ok: true, stdout: regOut(HKCU, 'REG_SZ', USER_TOKEN) },
    { ok: true, stdout: regOut(HKLM, 'REG_SZ', MACHINE_TOKEN) },
  ]);
  assert.equal(osEnvOauthToken({ platform: 'win32', env: {}, run }), USER_TOKEN);
});

test('osEnvOauthToken — REG_EXPAND_SZ is expanded here, because reg query does not expand it', () => {
  const { run } = runner([{ ok: true, stdout: regOut(HKCU, 'REG_EXPAND_SZ', '%TOKEN_PREFIX%-%TAIL%') }]);
  const env = { token_prefix: 'sk-ant-oat01', TAIL: 'c'.repeat(40) };
  // Case-insensitive on the name: Windows env lookups are, and the injected map may be any casing.
  assert.equal(osEnvOauthToken({ platform: 'win32', env, run }), `sk-ant-oat01-${'c'.repeat(40)}`);
});

test('osEnvOauthToken — an unknown %VAR% is left literal, never blanked', () => {
  const { run } = runner([{ ok: true, stdout: regOut(HKCU, 'REG_EXPAND_SZ', `${USER_TOKEN}%NOPE%`) }]);
  assert.equal(osEnvOauthToken({ platform: 'win32', env: {}, run }), `${USER_TOKEN}%NOPE%`);
});

test('osEnvOauthToken — a value containing spaces is not truncated at the third field', () => {
  const spaced = `sk-ant-oat01 ${'d'.repeat(20)} tail`;
  const { run } = runner([{ ok: true, stdout: regOut(HKCU, 'REG_SZ', spaced) }]);
  assert.equal(osEnvOauthToken({ platform: 'win32', env: {}, run }), spaced);
});

test('osEnvOauthToken — a non-string registry type is not a credential', () => {
  const { run } = runner([
    { ok: true, stdout: regOut(HKCU, 'REG_DWORD', '0x1') },
    { ok: true, stdout: regOut(HKLM, 'REG_DWORD', '0x1') },
  ]);
  assert.equal(osEnvOauthToken({ platform: 'win32', env: {}, run }), null);
});

test('osEnvOauthToken — a sibling value name does not match', () => {
  const out = `\r\n${HKCU}\r\n    CLAUDE_CODE_OAUTH_TOKEN_OLD    REG_SZ    ${USER_TOKEN}\r\n`;
  const { run } = runner([{ ok: true, stdout: out }, { ok: true, stdout: out }]);
  assert.equal(osEnvOauthToken({ platform: 'win32', env: {}, run }), null);
});

test('osEnvOauthToken — reg answering "not found" is authoritative: no PowerShell', () => {
  // The budget case. A machine with no token set is the common one, and it must cost two reg
  // queries and nothing else — a PowerShell spawn here is ~261ms on every hook process.
  const { run, calls } = runner([REG_ABSENT, REG_ABSENT]);
  assert.equal(osEnvOauthToken({ platform: 'win32', env: {}, run }), null);
  assert.equal(calls.length, 2);
});

test('osEnvOauthToken — one scope absent and the other unrunnable still skips PowerShell', () => {
  // Either probe having ANSWERED settles it; PowerShell would only reproduce a "no" we have.
  const { run, calls } = runner([REG_ABSENT, CANNOT_RUN]);
  assert.equal(osEnvOauthToken({ platform: 'win32', env: {}, run }), null);
  assert.equal(calls.length, 2);
});

test('osEnvOauthToken — reg that could not run at all (ENOENT/timeout) reaches PowerShell', () => {
  const { run, calls } = runner([CANNOT_RUN, CANNOT_RUN, { ok: true, stdout: `${USER_TOKEN}\r\n` }]);
  assert.equal(osEnvOauthToken({ platform: 'win32', env: {}, run }), USER_TOKEN);
  assert.equal(calls.length, 3);
  assert.match(calls[2].file, /powershell\.exe$/);
  assert.equal(calls[2].args[0], '-NoProfile');
  assert.equal(calls[2].args[1], '-NonInteractive');
  assert.equal(calls[2].args[2], '-Command');
  // The variable NAME may cross a command line; a value never may.
  assert.ok(calls[2].args[3].indexOf('CLAUDE_CODE_OAUTH_TOKEN') !== -1);
});

test('osEnvOauthToken — a reg query that RAN and found nothing usable skips PowerShell', () => {
  const { run, calls } = runner([{ ok: true, stdout: `\r\n${HKCU}\r\n\r\n` }, REG_ABSENT]);
  assert.equal(osEnvOauthToken({ platform: 'win32', env: {}, run }), null);
  assert.equal(calls.length, 2);
});

test('osEnvOauthToken — a non-zero exit with unrecognised stderr is not an answer', () => {
  // "Access is denied", a localized reg, a policy-blocked hive — none of those say the value is
  // absent, so the fallback is exactly right. Being wrong in this direction costs latency, not
  // a false negative.
  const denied = { ok: false, stdout: '', stderr: 'ERROR: Access is denied.\r\n' };
  const { run, calls } = runner([denied, denied, { ok: true, stdout: `${MACHINE_TOKEN}\n` }]);
  assert.equal(osEnvOauthToken({ platform: 'win32', env: {}, run }), MACHINE_TOKEN);
  assert.equal(calls.length, 3);
  assert.match(calls[2].file, /powershell\.exe$/);
});

test('osEnvOauthToken — PowerShell printing nothing is no token', () => {
  const { run } = runner([CANNOT_RUN, CANNOT_RUN, { ok: true, stdout: '\r\n' }]);
  assert.equal(osEnvOauthToken({ platform: 'win32', env: {}, run }), null);
});

test('osEnvOauthToken — a value too short to fingerprint is not a token', () => {
  const { run } = runner([
    { ok: true, stdout: regOut(HKCU, 'REG_SZ', 'x') },
    { ok: true, stdout: regOut(HKLM, 'REG_SZ', 'placeholder') },
  ]);
  assert.equal(osEnvOauthToken({ platform: 'win32', env: {}, run }), null);
});

test('osEnvOauthToken — darwin asks launchctl and nothing else', () => {
  const { run, calls } = runner([{ ok: true, stdout: `${USER_TOKEN}\n` }]);
  assert.equal(osEnvOauthToken({ platform: 'darwin', env: {}, run }), USER_TOKEN);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, '/bin/launchctl');
  assert.deepEqual(calls[0].args, ['getenv', 'CLAUDE_CODE_OAUTH_TOKEN']);
});

test('osEnvOauthToken — darwin with an unset launchctl value is null, still one call', () => {
  const empty = runner([{ ok: true, stdout: '\n' }]);
  assert.equal(osEnvOauthToken({ platform: 'darwin', env: {}, run: empty.run }), null);
  assert.equal(empty.calls.length, 1);

  const failed = runner([CANNOT_RUN]);
  assert.equal(osEnvOauthToken({ platform: 'darwin', env: {}, run: failed.run }), null);
  // No PowerShell, no reg, no login shell — there is no second probe on macOS.
  assert.equal(failed.calls.length, 1);
});

test('osEnvOauthToken — injected deps bypass the process cache every time', () => {
  resetOsEnvTokenCache();
  let n = 0;
  const run = () => { n += 1; return { ok: true, stdout: regOut(HKCU, 'REG_SZ', USER_TOKEN) }; };
  assert.equal(osEnvOauthToken({ platform: 'win32', env: {}, run }), USER_TOKEN);
  assert.equal(osEnvOauthToken({ platform: 'win32', env: {}, run }), USER_TOKEN);
  assert.equal(n, 2);
  resetOsEnvTokenCache();
});
