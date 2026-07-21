import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getCredentials, setCredentials, deleteCredentials } from '../lib/credentials.mjs';

// Point BEEZI_HOME at a temp dir and restore it afterward.
function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creds-'));
  const prev = process.env.BEEZI_HOME;
  process.env.BEEZI_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_HOME;
    else process.env.BEEZI_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const credsPath = (dir) => path.join(dir, 'credentials.json');

// Minimal valid credentials object; access_token varies per test for traceability.
const creds = (accessToken) => ({
  client_id: 'cid',
  redirect_uri: 'http://127.0.0.1:49152/callback',
  token_endpoint: 'https://clerk.example.com/oauth/token',
  access_token: accessToken,
  refresh_token: 'rt',
  expires_at: 123,
});

// Stored access_token, or null — the round-trip observable in these tests.
const storedToken = async (deps) => (await getCredentials(deps))?.access_token ?? null;

// ── fake OS tools (in-memory), injected via deps.run ──────────────────────────

function macRun(store) {
  return (file, args) => {
    if (file !== 'security') return { ok: false, stdout: '' };
    const sub = args[0];
    if (sub === 'find-generic-password') {
      return store.has('k') ? { ok: true, stdout: store.get('k') + '\n' } : { ok: false, stdout: '' };
    }
    if (sub === 'add-generic-password') { store.set('k', args[args.indexOf('-w') + 1]); return { ok: true, stdout: '' }; }
    if (sub === 'delete-generic-password') { store.delete('k'); return { ok: true, stdout: '' }; }
    return { ok: false, stdout: '' };
  };
}

function secretToolRun(store, installed) {
  return (file, args, input) => {
    if (file !== 'secret-tool') return { ok: false, stdout: '' };
    if (!installed) return { ok: false, stdout: '' };
    const sub = args[0];
    if (sub === '--version') return { ok: true, stdout: 'secret-tool 0.20.5\n' };
    if (sub === 'lookup') return store.has('k') ? { ok: true, stdout: store.get('k') + '\n' } : { ok: false, stdout: '' };
    if (sub === 'store') { store.set('k', input); return { ok: true, stdout: '' }; }
    if (sub === 'clear') { store.delete('k'); return { ok: true, stdout: '' }; }
    return { ok: false, stdout: '' };
  };
}

// Fakes the two Windows PowerShell paths: the Credential Manager P/Invoke (CredWrite/Read/
// Delete) and the DPAPI fallback (Protect/Unprotect, modeled as reversible base64). Toggle
// each independently to exercise the backend chain: credMan → DPAPI-file → plaintext-file.
function winRun({ credMan = true, dpapi = true } = {}) {
  const credStore = new Map(); // stands in for the OS Credential Manager
  return (file, args, input) => {
    // The backend invokes PowerShell by absolute path; match on the basename.
    if (path.basename(String(file)).toLowerCase() !== 'powershell.exe') return { ok: false, stdout: '' };
    const script = args[args.indexOf('-Command') + 1];
    // Credential Manager (primary). CredWrite/CredRead/CredDelete are disjoint substrings.
    if (script.includes('CredWrite')) {
      if (!credMan) return { ok: false, stdout: '' };
      credStore.set('k', input); return { ok: true, stdout: 'OK\n' };
    }
    if (script.includes('CredDelete')) { credStore.delete('k'); return { ok: true, stdout: '' }; }
    if (script.includes('CredRead')) {
      return credMan && credStore.has('k') ? { ok: true, stdout: credStore.get('k') } : { ok: false, stdout: '' };
    }
    // DPAPI fallback. Note: 'Unprotect'.includes('Protect') is true — check Unprotect FIRST.
    if (!dpapi) return { ok: false, stdout: '' };
    if (script.includes('Unprotect')) return { ok: true, stdout: Buffer.from(input.trim(), 'base64').toString('utf-8') + '\n' };
    if (script.includes('Protect')) return { ok: true, stdout: Buffer.from(input, 'utf-8').toString('base64') + '\n' };
    return { ok: true, stdout: '' };
  };
}

// ── credentials blob semantics ────────────────────────────────────────────────

test('round-trips a credentials object through the file store', async (t) => {
  tmpHome(t);
  const deps = { platform: 'unknown', run: () => ({ ok: false, stdout: '' }) };
  await setCredentials(creds('at'), deps);
  assert.deepEqual(await getCredentials(deps), creds('at'));
});

test('legacy bare device token reads as null (not linked)', async (t) => {
  const dir = tmpHome(t);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(credsPath(dir), JSON.stringify({ token: 'bzi_legacy' }));
  const deps = { platform: 'unknown', run: () => ({ ok: false, stdout: '' }) };
  assert.equal(await getCredentials(deps), null);
});

test('malformed stored JSON reads as null', async (t) => {
  const dir = tmpHome(t);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(credsPath(dir), JSON.stringify({ token: '{not json' }));
  const deps = { platform: 'unknown', run: () => ({ ok: false, stdout: '' }) };
  assert.equal(await getCredentials(deps), null);
});

// ── macOS ─────────────────────────────────────────────────────────────────────

test('macOS — security keychain round-trip; nothing written to disk', async (t) => {
  const dir = tmpHome(t);
  const deps = { platform: 'darwin', run: macRun(new Map()) };
  await setCredentials(creds('mac-tok'), deps);
  assert.equal(fs.existsSync(credsPath(dir)), false, 'keychain used, no file');
  assert.equal(await storedToken(deps), 'mac-tok');
  await deleteCredentials(deps);
  assert.equal(await storedToken(deps), null);
});

// ── Linux ──────────────────────────────────────────────────────────────────────

test('Linux — secret-tool round-trip when libsecret is installed', async (t) => {
  const dir = tmpHome(t);
  const deps = { platform: 'linux', run: secretToolRun(new Map(), true) };
  await setCredentials(creds('lin-tok'), deps);
  assert.equal(fs.existsSync(credsPath(dir)), false, 'keychain used, no file');
  assert.equal(await storedToken(deps), 'lin-tok');
  await deleteCredentials(deps);
  assert.equal(await storedToken(deps), null);
});

test('Linux — no secret-tool → falls back to the 0600 file', async (t) => {
  const dir = tmpHome(t);
  const deps = { platform: 'linux', run: secretToolRun(new Map(), false) };
  await setCredentials(creds('lin-file'), deps);
  assert.equal(fs.existsSync(credsPath(dir)), true, 'file fallback written');
  const raw = JSON.parse(fs.readFileSync(credsPath(dir), 'utf-8')).token;
  assert.equal(JSON.parse(raw).access_token, 'lin-file');
  assert.equal(await storedToken(deps), 'lin-file');
});

// ── Windows ─────────────────────────────────────────────────────────────────────

test('Windows — Credential Manager round-trip (primary); nothing written to disk', async (t) => {
  const dir = tmpHome(t);
  const deps = { platform: 'win32', run: winRun() };
  const where = await setCredentials(creds('win-cred'), deps);
  assert.equal(where, 'the Windows Credential Manager');
  assert.equal(fs.existsSync(credsPath(dir)), false, 'Credential Manager used, no file');
  assert.equal(await storedToken(deps), 'win-cred');
  await deleteCredentials(deps);
  assert.equal(await storedToken(deps), null);
});

test('Windows — Credential Manager unavailable → DPAPI encrypts at rest (no plaintext in file)', async (t) => {
  const dir = tmpHome(t);
  const deps = { platform: 'win32', run: winRun({ credMan: false, dpapi: true }) };
  await setCredentials(creds('win-tok'), deps);
  const raw = fs.readFileSync(credsPath(dir), 'utf-8');
  const obj = JSON.parse(raw);
  assert.ok(obj.enc, 'ciphertext stored under "enc"');
  assert.equal(obj.token, undefined, 'no plaintext token field');
  assert.ok(!raw.includes('win-tok'), 'plaintext token absent from file');
  assert.equal(await storedToken(deps), 'win-tok', 'decrypts on read');
});

test('Windows — Credential Manager + DPAPI unavailable → plaintext 0600 file fallback', async (t) => {
  const dir = tmpHome(t);
  const deps = { platform: 'win32', run: winRun({ credMan: false, dpapi: false }) };
  await setCredentials(creds('win-plain'), deps);
  const raw = JSON.parse(fs.readFileSync(credsPath(dir), 'utf-8')).token;
  assert.equal(JSON.parse(raw).access_token, 'win-plain');
  assert.equal(await storedToken(deps), 'win-plain');
});

test('Windows — legacy DPAPI-file credentials still read when Credential Manager is empty', async (t) => {
  tmpHome(t);
  // Simulate a user who linked before the Credential Manager backend existed: credentials live
  // in the DPAPI file only. A later session (credMan present but empty) must still find them.
  await setCredentials(creds('legacy-dpapi'), { platform: 'win32', run: winRun({ credMan: false, dpapi: true }) });
  assert.equal(await storedToken({ platform: 'win32', run: winRun({ credMan: true, dpapi: true }) }), 'legacy-dpapi');
});

// ── cross-cutting ────────────────────────────────────────────────────────────────

test('unknown platform → file store round-trip', async (t) => {
  const dir = tmpHome(t);
  const deps = { platform: 'sunos', run: () => ({ ok: false, stdout: '' }) };
  await setCredentials(creds('generic'), deps);
  assert.equal(fs.existsSync(credsPath(dir)), true);
  assert.equal(await storedToken(deps), 'generic');
});

test('keychain empty but file credentials exist → file fallback on read', async (t) => {
  tmpHome(t);
  await setCredentials(creds('legacy-file'), { platform: 'sunos', run: () => ({ ok: false, stdout: '' }) }); // file
  const deps = { platform: 'darwin', run: macRun(new Map()) };                                                // empty keychain
  assert.equal(await storedToken(deps), 'legacy-file');
});

test('no credentials anywhere → null, never throws', async (t) => {
  tmpHome(t);
  const deps = { platform: 'darwin', run: macRun(new Map()) };
  await assert.doesNotReject(() => getCredentials(deps));
  assert.equal(await getCredentials(deps), null);
});

test('deleteCredentials clears both keychain and any file copy', async (t) => {
  const dir = tmpHome(t);
  // Seed a stale file copy AND a keychain copy.
  await setCredentials(creds('file-one'), { platform: 'sunos', run: () => ({ ok: false, stdout: '' }) });
  const store = new Map();
  const deps = { platform: 'darwin', run: macRun(store) };
  await setCredentials(creds('key-one'), deps);
  await deleteCredentials(deps);
  assert.equal(store.has('k'), false, 'keychain cleared');
  assert.equal(fs.existsSync(credsPath(dir)), false, 'file cleared');
  assert.equal(await getCredentials(deps), null);
});

test('file store uses restricted 0600 permissions (posix only)', { skip: process.platform === 'win32' }, async (t) => {
  const dir = tmpHome(t);
  await setCredentials(creds('x'), { platform: 'linux', run: secretToolRun(new Map(), false) });
  const mode = fs.statSync(credsPath(dir)).mode & 0o777;
  assert.equal(mode, 0o600);
});
