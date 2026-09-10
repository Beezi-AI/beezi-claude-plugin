import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLogout } from '../lib/logout.mjs';
import { readCredentials, commitCredentials, deleteCredentials, CREDENTIAL_STATUS } from '../lib/credentials.mjs';
import { acquireCredentialLock, releaseCredentialLock } from '../lib/credential-lock.mjs';

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logout-'));
  const prev = process.env.BEEZI_HOME;
  process.env.BEEZI_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_HOME;
    else process.env.BEEZI_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const CREDS = {
  client_id: 'cid', redirect_uri: 'http://127.0.0.1:1/callback',
  token_endpoint: 'https://clerk.invalid/oauth/token',
  access_token: 'at', refresh_token: 'rt', expires_at: 10_000_000,
};
const META = { revocationEndpoint: 'https://clerk.invalid/oauth/revoke_here' };
const store = { platform: 'unknown', run: () => ({ ok: false, stdout: '' }) };
const committed = () => readCredentials(store);
const FOREIGN = 'ff'.repeat(16);

async function seed() {
  const lock = await acquireCredentialLock({ waitMs: 0 }, store);
  await commitCredentials(CREDS, { lock, force: true }, store);
  releaseCredentialLock(lock);
}

const deps = (overrides = {}) => ({
  ...store,
  base: 'https://api.test',
  discover: async () => META,
  rotateInstallationId: () => {},
  getAuthentication: async () => ({ authState: 'ready', reason: 'ok', accessToken: 'at' }),
  ...overrides,
});

test('a confirmed server unlink is described as one', async (t) => {
  tmpHome(t);
  await seed();
  const lines = await runLogout(deps({ fetchImpl: async () => ({ ok: true, status: 204 }) }));
  assert.match(lines[0], /unlinked from Beezi/);
  assert.equal((await committed()).status, CREDENTIAL_STATUS.NONE);
});

// finding 8: 401/403 on the DELETE means the controller never ran, so nothing was unlinked.
for (const status of [401, 403]) {
  test(`a DELETE refused with ${status} is a failed unlink, and the revocation fallback runs`, async (t) => {
    tmpHome(t);
    await seed();
    const called = [];
    const lines = await runLogout(deps({
      fetchImpl: async (url, init) => {
        called.push(String(url));
        if (init.method === 'DELETE') return { ok: false, status };
        return { ok: true, status: 200 };
      },
    }));
    assert.ok(called.includes(META.revocationEndpoint), 'the discovered revocation endpoint is used');
    assert.doesNotMatch(lines[0], /unlinked from Beezi/);
    assert.match(lines[0], /revoked/);
    assert.equal((await committed()).status, CREDENTIAL_STATUS.NONE);
  });
}

test('an unreachable server and a failed revocation are described honestly', async (t) => {
  tmpHome(t);
  await seed();
  const lines = await runLogout(deps({ fetchImpl: async () => { throw new Error('offline'); } }));
  assert.match(lines[0], /Logged out locally/);
  assert.match(lines.join('\n'), /may still appear linked/);
  assert.equal((await committed()).status, CREDENTIAL_STATUS.NONE);
});

test('a refused DELETE names its status in the message', async (t) => {
  tmpHome(t);
  await seed();
  const lines = await runLogout(deps({
    fetchImpl: async (_url, init) => (init.method === 'DELETE' ? { ok: false, status: 403 } : { ok: false, status: 500 }),
  }));
  assert.match(lines.join('\n'), /HTTP 403/);
});

// The defect at scripts/logout.mjs:73 — the lock timeout was swallowed and "✓ Logged out"
// printed while the credentials were still stored.
test('a lock it cannot take fails loudly instead of claiming a logout', async (t) => {
  const dir = tmpHome(t);
  await seed();
  fs.mkdirSync(path.join(dir, 'credentials.lock'));
  fs.writeFileSync(
    path.join(dir, 'credentials.lock', 'owner.json'),
    JSON.stringify({ pid: process.pid, nonce: FOREIGN, acquiredAt: Date.now() }),
  );
  await assert.rejects(
    runLogout(deps({ lockWaitMs: 30, fetchImpl: async () => ({ ok: true, status: 204 }) })),
    /nothing was removed/,
  );
  assert.equal((await committed()).status, CREDENTIAL_STATUS.READY, 'the credentials are still there');
});

test('logout rotates the diagnostic installation id', async (t) => {
  tmpHome(t);
  await seed();
  let rotated = false;
  await runLogout(deps({
    fetchImpl: async () => ({ ok: true, status: 204 }),
    rotateInstallationId: () => { rotated = true; },
  }));
  assert.equal(rotated, true);
});

test('an unlinked machine has nothing to do', async (t) => {
  tmpHome(t);
  const lines = await runLogout(deps({ fetchImpl: async () => assert.fail('no call') }));
  assert.match(lines[0], /not linked/);
});

// The brief's "clear local authorization": a legacy copy left on disk is a live credential for
// any pre-upgrade Beezi process or a downgraded install, which is exactly the competing-refresh
// problem the generation store exists to stop.
test('logout removes the legacy credentials file, not just the committed generation', async (t) => {
  const dir = tmpHome(t);
  await seed();
  const legacyFile = path.join(dir, 'credentials.json');
  fs.writeFileSync(legacyFile, JSON.stringify({ token: JSON.stringify(CREDS) }));
  await runLogout(deps({ fetchImpl: async () => ({ ok: true, status: 204 }) }));
  assert.equal(fs.existsSync(legacyFile), false, 'the legacy credentials file is gone');
  assert.equal((await committed()).status, CREDENTIAL_STATUS.NONE);
});

// The sweep must be the SAME set Task 2's deleteCredentials wipes — including its namespace
// rule, which leaves the shared un-namespaced OS entry alone under a custom BEEZI_HOME so two
// namespaces never inherit one grant. Comparing the traces is what proves logout did not
// quietly narrow it.
test('logout sweeps exactly the sources deleteCredentials sweeps', async (t) => {
  const trace = (sink) => ({
    platform: 'darwin',
    run: (_file, args) => {
      // The per-home hash on the service name differs between the two temp homes; the point of
      // the comparison is WHICH entries are targeted, not which namespace.
      if (args[0] === 'delete-generic-password') sink.push(args.slice(1).join(' ').replace(/-h[0-9a-f]{8}\b/, ''));
      if (args[0] === 'find-generic-password') return { ok: false, stdout: '' };
      return { ok: true, stdout: '' };
    },
  });

  tmpHome(t);
  const viaLogout = [];
  const logoutStore = trace(viaLogout);
  let lock = await acquireCredentialLock({ waitMs: 0 }, logoutStore);
  await commitCredentials(CREDS, { lock, force: true }, logoutStore);
  releaseCredentialLock(lock);
  const legacyOne = path.join(process.env.BEEZI_HOME, 'credentials.json');
  fs.writeFileSync(legacyOne, JSON.stringify({ token: JSON.stringify(CREDS) }));
  viaLogout.length = 0;
  await runLogout(deps({ ...logoutStore, fetchImpl: async () => ({ ok: true, status: 204 }) }));
  const logoutFileGone = !fs.existsSync(legacyOne);

  // The same fixture, wiped by Task 2's wrapper instead.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'logout-ref-'));
  process.env.BEEZI_HOME = dir2;
  t.after(() => fs.rmSync(dir2, { recursive: true, force: true }));
  const viaWrapper = [];
  const wrapperStore = trace(viaWrapper);
  lock = await acquireCredentialLock({ waitMs: 0 }, wrapperStore);
  await commitCredentials(CREDS, { lock, force: true }, wrapperStore);
  releaseCredentialLock(lock);
  const legacyTwo = path.join(dir2, 'credentials.json');
  fs.writeFileSync(legacyTwo, JSON.stringify({ token: JSON.stringify(CREDS) }));
  viaWrapper.length = 0;
  await deleteCredentials(wrapperStore);

  // A superset, not an exact match: logout also sweeps orphan generation entries, which the
  // wrapper does not. The point is that it cannot NARROW what the wrapper wipes.
  for (const target of viaWrapper) {
    assert.ok(viaLogout.includes(target), `logout also targets ${target}`);
  }
  assert.equal(logoutFileGone, true);
  assert.equal(fs.existsSync(legacyTwo), false);
});

// A generation entry left behind by a lock-lost commit is never read, but a refresh orphan holds
// the freshly ROTATED refresh token — the live one — while the committed generation's is already
// dead. Leaving it is a usable grant in the keychain of a machine the user just signed out of.
test('logout removes every generation entry, orphans included', async (t) => {
  tmpHome(t);
  const entries = new Map();
  const keychain = {
    platform: 'darwin',
    run: (_file, args) => {
      const account = args[args.indexOf('-a') + 1];
      if (args[0] === 'find-generic-password') {
        return { ok: entries.has(account), stdout: entries.get(account) || '' };
      }
      if (args[0] === 'add-generic-password') {
        entries.set(account, args[args.indexOf('-w') + 1]);
        return { ok: true, stdout: '' };
      }
      if (args[0] === 'delete-generic-password') entries.delete(account);
      return { ok: true, stdout: '' };
    },
  };
  let lock = await acquireCredentialLock({ waitMs: 0 }, keychain);
  await commitCredentials(CREDS, { lock, force: true }, keychain);
  // A second, committed generation, then an orphan the control record never named.
  await commitCredentials({ ...CREDS, access_token: 'at2' }, { lock, expectedGeneration: 1 }, keychain);
  releaseCredentialLock(lock);
  entries.set('gen-3', JSON.stringify({ ...CREDS, refresh_token: 'rotated-and-live' }));
  assert.ok(entries.size >= 2, 'the fixture really holds more than the committed entry');

  await runLogout(deps({ ...keychain, fetchImpl: async () => ({ ok: true, status: 204 }) }));

  assert.deepEqual([...entries.keys()], [], 'no generation entry survives the logout');
  assert.equal((await readCredentials(keychain)).status, CREDENTIAL_STATUS.NONE);
});
