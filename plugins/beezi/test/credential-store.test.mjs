// Regression tests for the generation-versioned credential store. The storage/fallback cases were
// converted from docs/oauth-session-investigation/reproduce.mjs (finding 3): they now assert the
// FIXED behaviour instead of characterising the defect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readCredentials, commitCredentials, deleteCredentialGeneration,
  getCredentials, setCredentials, deleteCredentials,
  CREDENTIAL_STATUS, UNAVAILABLE_REASONS, COMMIT_STATUS, DELETE_STATUS,
} from '../lib/credentials.mjs';
import { acquireCredentialLock, releaseCredentialLock, readCredentialLockOwner } from '../lib/credential-lock.mjs';
import { credentialService, legacyCredentialService, homeSuffix, envSuffix } from '../lib/paths.mjs';

const OLD = {
  client_id: 'fake-client', redirect_uri: 'http://127.0.0.1:12345/callback',
  token_endpoint: 'https://fake.invalid/oauth/token',
  access_token: 'fake-old-access', refresh_token: 'fake-old-refresh', expires_at: 0,
};
const NEW = { ...OLD, access_token: 'fake-new-access', refresh_token: 'fake-new-refresh', expires_at: 4102444800000 };
const LOGIN = { ...NEW, client_id: 'fake-login-client', access_token: 'fake-login-access', refresh_token: 'fake-login-refresh' };

// Custom BEEZI_HOME → hashed namespace; legacy OS entries are NOT consulted for it.
function customHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-store-'));
  const prev = process.env.BEEZI_HOME;
  process.env.BEEZI_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_HOME;
    else process.env.BEEZI_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

// Default namespace (BEEZI_HOME unset) with the user's home relocated into a temp dir, so the
// legacy OS entry and ~/.beezi/credentials.json migration paths run against fakes only.
function defaultHome(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-home-'));
  const prev = { BEEZI_HOME: process.env.BEEZI_HOME, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  delete process.env.BEEZI_HOME;
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return path.join(root, '.beezi');
}

const controlPath = (dir) => path.join(dir, 'credentials', 'control.json');
const genPath = (dir, n) => path.join(dir, 'credentials', `gen-${n}.json`);
const legacyPath = (dir) => path.join(dir, 'credentials.json');
const readControl = (dir) => JSON.parse(fs.readFileSync(controlPath(dir), 'utf8'));

// In-memory macOS keychain keyed on service+account, so generations and namespaces stay distinct.
function fakeKeychain() {
  const items = new Map();
  const state = { readable: true, writable: true, items };
  const key = (args) => `${args[args.indexOf('-s') + 1]}/${args[args.indexOf('-a') + 1]}`;
  state.run = (file, args) => {
    if (file !== 'security') return { ok: false, stdout: '' };
    if (args[0] === 'find-generic-password') {
      return state.readable && items.has(key(args)) ? { ok: true, stdout: items.get(key(args)) + '\n' } : { ok: false, stdout: '' };
    }
    if (args[0] === 'add-generic-password') {
      if (!state.writable) return { ok: false, stdout: '' };
      items.set(key(args), args[args.indexOf('-w') + 1]);
      return { ok: true, stdout: '' };
    }
    if (args[0] === 'delete-generic-password') { items.delete(key(args)); return { ok: true, stdout: '' }; }
    return { ok: false, stdout: '' };
  };
  state.has = (service, account) => items.has(`${service}/${account}`);
  state.get = (service, account) => JSON.parse(items.get(`${service}/${account}`));
  state.set = (service, account, value) => items.set(`${service}/${account}`, typeof value === 'string' ? value : JSON.stringify(value));
  return state;
}

const fileOnly = { platform: 'unknown', run: () => ({ ok: false, stdout: '' }) };

// Commit under a freshly acquired lock, the way login's final write does.
async function commitUnderLock(creds, options, deps) {
  const lock = await acquireCredentialLock({ waitMs: 0 }, deps);
  assert.ok(lock, 'lock available');
  try { return await commitCredentials(creds, { lock, ...options }, deps); } finally { releaseCredentialLock(lock); }
}

// ── layout ────────────────────────────────────────────────────────────────────────────────────

test('commit writes an immutable generation entry and publishes an atomic control record', async (t) => {
  const dir = customHome(t);
  const keychain = fakeKeychain();
  const deps = { platform: 'darwin', run: keychain.run };
  const r = await commitUnderLock(OLD, { expectedGeneration: null }, deps);
  assert.deepEqual(r, { status: COMMIT_STATUS.COMMITTED, generation: 1, backend: 'keychain', where: 'the macOS keychain' });
  assert.deepEqual(readControl(dir), { version: 1, generation: 1, backend: 'keychain', highestGeneration: 1, committedAt: readControl(dir).committedAt });
  assert.equal(keychain.has(credentialService(), 'gen-1'), true);
  assert.equal(keychain.has(legacyCredentialService(), 'token'), false, 'legacy location untouched');
  assert.equal(fs.existsSync(legacyPath(dir)), false, 'legacy file untouched');
  const read = await readCredentials(deps);
  assert.deepEqual(read, { status: CREDENTIAL_STATUS.READY, generation: 1, backend: 'keychain', credentials: OLD });
});

test('a custom BEEZI_HOME derives its own OS-store namespace; the default keeps the plain name', async (t) => {
  customHome(t);
  assert.match(homeSuffix(), /^-h[0-9a-f]{8}$/);
  assert.equal(credentialService(), `beezi-credentials${envSuffix()}${homeSuffix()}`);
  assert.equal(legacyCredentialService(), `beezi-analytics${envSuffix()}`, 'the legacy name never carries the home');
  const first = credentialService();
  customHome(t);
  assert.notEqual(credentialService(), first, 'two homes never share an OS entry');
  defaultHome(t);
  assert.equal(homeSuffix(), '');
  assert.equal(credentialService(), `beezi-credentials${envSuffix()}`);
});

test('generation numbers stay monotonic across a delete', async (t) => {
  const dir = customHome(t);
  await commitUnderLock(OLD, { expectedGeneration: null }, fileOnly);
  const lock = await acquireCredentialLock({ waitMs: 0 }, fileOnly);
  assert.deepEqual(await deleteCredentialGeneration({ lock, expectedGeneration: 1 }, fileOnly), { status: DELETE_STATUS.DELETED, generation: 1 });
  releaseCredentialLock(lock);
  assert.deepEqual(await readCredentials(fileOnly), { status: CREDENTIAL_STATUS.NONE });
  assert.equal(fs.existsSync(genPath(dir, 1)), false);
  const r = await commitUnderLock(NEW, { expectedGeneration: null }, fileOnly);
  assert.equal(r.generation, 2, 'gen-1 is never reused');
});

// ── finding 3: fallback must never hide the newest credentials ───────────────────────────────

test('failed keychain write + successful file write → NEW is committed and read back', async (t) => {
  const dir = customHome(t);
  const keychain = fakeKeychain();
  const deps = { platform: 'darwin', run: keychain.run };
  await setCredentials(OLD, deps);
  keychain.writable = false;
  assert.equal(await setCredentials(NEW, deps), 'a restricted local file');
  assert.equal(readControl(dir).backend, 'file');
  assert.equal(JSON.parse(JSON.parse(fs.readFileSync(genPath(dir, 2), 'utf8')).token).refresh_token, NEW.refresh_token);
  const read = await readCredentials(deps);
  assert.equal(read.status, CREDENTIAL_STATUS.READY);
  assert.equal(read.generation, 2);
  assert.equal(read.credentials.refresh_token, NEW.refresh_token, 'the keychain copy of OLD is not preferred');
  assert.equal((await getCredentials(deps)).refresh_token, NEW.refresh_token);
});

test('temporarily unreadable keychain → unavailable, never an older copy; recovers without a login', async (t) => {
  const dir = customHome(t);
  const keychain = fakeKeychain();
  const deps = { platform: 'darwin', run: keychain.run };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(legacyPath(dir), JSON.stringify({ token: JSON.stringify(OLD) })); // stale legacy file
  await setCredentials(NEW, deps);
  keychain.readable = false;
  const read = await readCredentials(deps);
  assert.deepEqual(read, { status: CREDENTIAL_STATUS.UNAVAILABLE, reason: UNAVAILABLE_REASONS.BACKEND_UNREADABLE, generation: 1, backend: 'keychain' });
  assert.equal(await getCredentials(deps), null, 'legacy accessor reports no usable credentials');
  keychain.readable = true;
  assert.equal((await readCredentials(deps)).credentials.access_token, NEW.access_token);
});

test('a stale file copy cannot reappear when the OS store is temporarily unreadable', async (t) => {
  const dir = customHome(t);
  const keychain = fakeKeychain();
  const deps = { platform: 'darwin', run: keychain.run };
  keychain.writable = false;
  await setCredentials(OLD, deps); // gen 1 → file
  assert.equal(readControl(dir).backend, 'file');
  keychain.writable = true;
  await setCredentials(NEW, deps); // gen 2 → keychain
  assert.equal(readControl(dir).backend, 'keychain');
  assert.equal(fs.existsSync(genPath(dir, 1)), false, 'superseded file entry retired');
  keychain.readable = false;
  assert.equal((await readCredentials(deps)).status, CREDENTIAL_STATUS.UNAVAILABLE);
  keychain.readable = true;
  assert.equal((await readCredentials(deps)).credentials.access_token, NEW.access_token);
});

test('a malformed committed OS value → unavailable (entry_malformed), never a file fallback', async (t) => {
  const dir = customHome(t);
  const keychain = fakeKeychain();
  const deps = { platform: 'darwin', run: keychain.run };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(legacyPath(dir), JSON.stringify({ token: JSON.stringify(OLD) }));
  await setCredentials(NEW, deps);
  keychain.set(credentialService(), 'gen-1', '{not json');
  const read = await readCredentials(deps);
  assert.deepEqual(read, { status: CREDENTIAL_STATUS.UNAVAILABLE, reason: UNAVAILABLE_REASONS.ENTRY_MALFORMED, generation: 1, backend: 'keychain' });
});

test('a committed backend that is no longer available → unavailable (backend_missing)', async (t) => {
  customHome(t);
  const keychain = fakeKeychain();
  await setCredentials(NEW, { platform: 'darwin', run: keychain.run });
  const read = await readCredentials({ platform: 'linux', run: () => ({ ok: false, stdout: '' }) });
  assert.equal(read.status, CREDENTIAL_STATUS.UNAVAILABLE);
  assert.equal(read.reason, UNAVAILABLE_REASONS.BACKEND_MISSING);
});

// ── compare-and-swap commit / delete ─────────────────────────────────────────────────────────

test('commit with a stale expected generation is superseded and leaves the store untouched', async (t) => {
  customHome(t);
  await commitUnderLock(OLD, { expectedGeneration: null }, fileOnly);
  await commitUnderLock(NEW, { expectedGeneration: 1 }, fileOnly);
  const stale = await commitUnderLock({ ...OLD, access_token: 'from-stale-refresh' }, { expectedGeneration: 1 }, fileOnly);
  assert.deepEqual(stale, { status: COMMIT_STATUS.SUPERSEDED, generation: 2 });
  assert.equal((await readCredentials(fileOnly)).credentials.access_token, NEW.access_token);
});

test('a stale invalid_grant delete for a superseded generation does not delete the current one', async (t) => {
  customHome(t);
  await commitUnderLock(OLD, { expectedGeneration: null }, fileOnly);
  await commitUnderLock(NEW, { expectedGeneration: 1 }, fileOnly);
  const lock = await acquireCredentialLock({ waitMs: 0 }, fileOnly);
  assert.deepEqual(await deleteCredentialGeneration({ lock, expectedGeneration: 1 }, fileOnly), { status: DELETE_STATUS.SUPERSEDED, generation: 2 });
  releaseCredentialLock(lock);
  assert.equal((await readCredentials(fileOnly)).credentials.access_token, NEW.access_token);
});

test('commit and delete refuse a lock the caller no longer owns', async (t) => {
  customHome(t);
  const lock = await acquireCredentialLock({ waitMs: 0 }, fileOnly);
  releaseCredentialLock(lock);
  assert.deepEqual(await commitCredentials(OLD, { lock, force: true }, fileOnly), { status: COMMIT_STATUS.LOCK_LOST });
  assert.deepEqual(await deleteCredentialGeneration({ lock, force: true }, fileOnly), { status: DELETE_STATUS.LOCK_LOST });
  assert.deepEqual(await readCredentials(fileOnly), { status: CREDENTIAL_STATUS.NONE });
});

// finding 1(b): the lock-lost branch must not delete by name. Two waiters can derive the same
// generation number, so the entry it would delete may be the one the new holder just wrote.
test('a commit that loses the lock mid-write leaves its entry in place and publishes nothing', async (t) => {
  const dir = customHome(t);
  const keychain = fakeKeychain();
  const deps = { platform: 'darwin', run: keychain.run };
  await setCredentials(OLD, deps); // gen 1
  const lock = await acquireCredentialLock({ waitMs: 0 }, deps);
  const inner = keychain.run;
  // Stands in for another process reclaiming the lock while our write is inside the OS store.
  deps.run = (file, args) => {
    const out = inner(file, args);
    if (args[0] === 'add-generic-password') releaseCredentialLock(lock);
    return out;
  };
  assert.deepEqual(await commitCredentials(NEW, { lock, expectedGeneration: 1 }, deps), { status: COMMIT_STATUS.LOCK_LOST });
  assert.equal(keychain.has(credentialService(), 'gen-2'), true, 'the orphan entry stays: a by-name delete could remove a new holder entry');
  assert.equal(readControl(dir).generation, 1, 'nothing published');
  assert.equal((await readCredentials(deps)).credentials.access_token, OLD.access_token);
});

test('commit requires exactly one of expectedGeneration / force', async (t) => {
  customHome(t);
  const lock = await acquireCredentialLock({ waitMs: 0 }, fileOnly);
  try {
    await assert.rejects(() => commitCredentials(OLD, { lock }, fileOnly), TypeError);
    await assert.rejects(() => commitCredentials(OLD, { lock, force: true, expectedGeneration: null }, fileOnly), TypeError);
    await assert.rejects(() => deleteCredentialGeneration({ lock }, fileOnly), TypeError);
    await assert.rejects(() => commitCredentials(OLD, { force: true }, fileOnly), TypeError, 'a lock handle is mandatory');
  } finally {
    releaseCredentialLock(lock);
  }
});

test('force commit replaces whatever is committed (the login path)', async (t) => {
  customHome(t);
  await commitUnderLock(OLD, { expectedGeneration: null }, fileOnly);
  const r = await commitUnderLock(LOGIN, { force: true }, fileOnly);
  assert.equal(r.status, COMMIT_STATUS.COMMITTED);
  assert.equal(r.generation, 2);
  assert.equal((await readCredentials(fileOnly)).credentials.client_id, LOGIN.client_id);
});

// ── legacy migration ─────────────────────────────────────────────────────────────────────────

test('a single legacy keychain entry migrates into generation 1 and is left in place', async (t) => {
  const dir = defaultHome(t);
  const keychain = fakeKeychain();
  const deps = { platform: 'darwin', run: keychain.run };
  keychain.set(legacyCredentialService(), 'token', OLD);
  const read = await readCredentials(deps);
  // `migrated` is the restart signal: this read is the one that moved a pre-generation store, so a
  // legacy process may still be refreshing the old grant until Claude Code restarts.
  assert.deepEqual(read, { status: CREDENTIAL_STATUS.READY, generation: 1, backend: 'keychain', credentials: OLD, migrated: true });
  assert.equal(readControl(dir).generation, 1);
  assert.equal(keychain.has(credentialService(), 'gen-1'), true);
  assert.equal(keychain.has(legacyCredentialService(), 'token'), true, 'an older plugin may still be running');
  assert.equal(readCredentialLockOwner(), null, 'migration released the lock');
});

test('the migrated flag is set only on the read that performed the migration', async (t) => {
  const dir = defaultHome(t);
  const keychain = fakeKeychain();
  const deps = { platform: 'darwin', run: keychain.run };
  keychain.set(legacyCredentialService(), 'token', OLD);
  assert.equal((await readCredentials(deps)).migrated, true);
  const later = await readCredentials(deps);
  assert.equal('migrated' in later, false, 'a later read in this or any process carries no flag');
  assert.equal(readControl(dir).generation, 1);
  // A plain commit is not a migration either.
  const r = await commitUnderLock(NEW, { expectedGeneration: 1 }, deps);
  assert.equal(r.status, COMMIT_STATUS.COMMITTED);
  assert.equal('migrated' in (await readCredentials(deps)), false);
});

test('a single legacy file migrates into generation 1 and is left in place', async (t) => {
  const dir = defaultHome(t);
  const keychain = fakeKeychain();
  const deps = { platform: 'darwin', run: keychain.run };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(legacyPath(dir), JSON.stringify({ token: JSON.stringify(OLD) }));
  const read = await readCredentials(deps);
  assert.equal(read.status, CREDENTIAL_STATUS.READY);
  assert.equal(read.backend, 'keychain', 'migrated into the preferred backend');
  assert.deepEqual(read.credentials, OLD);
  assert.equal(fs.existsSync(legacyPath(dir)), true);
});

test('identical legacy copies migrate; differing copies → storage_conflict, both preserved', async (t) => {
  const dir = defaultHome(t);
  const keychain = fakeKeychain();
  const deps = { platform: 'darwin', run: keychain.run };
  fs.mkdirSync(dir, { recursive: true });
  keychain.set(legacyCredentialService(), 'token', OLD);
  fs.writeFileSync(legacyPath(dir), JSON.stringify({ token: JSON.stringify(OLD) }));
  assert.equal((await readCredentials(deps)).status, CREDENTIAL_STATUS.READY);
  fs.unlinkSync(controlPath(dir)); // pretend the migration never happened, with copies that now differ
  fs.writeFileSync(legacyPath(dir), JSON.stringify({ token: JSON.stringify(NEW) }));
  const read = await readCredentials(deps);
  assert.deepEqual(read, { status: CREDENTIAL_STATUS.STORAGE_CONFLICT, sources: ['keychain', 'file'] });
  assert.equal(fs.existsSync(controlPath(dir)), false, 'nothing is picked');
  assert.deepEqual(keychain.get(legacyCredentialService(), 'token'), OLD);
  assert.equal(JSON.parse(JSON.parse(fs.readFileSync(legacyPath(dir), 'utf8')).token).access_token, NEW.access_token);
  assert.equal(await getCredentials(deps), null);
  // An interactive login resolves the conflict by committing a new generation.
  await setCredentials(LOGIN, deps);
  assert.equal((await readCredentials(deps)).credentials.client_id, LOGIN.client_id);
});

test('no legacy copies → none, and nothing is persisted (a locked keychain must not be sealed out)', async (t) => {
  const dir = defaultHome(t);
  const keychain = fakeKeychain();
  const deps = { platform: 'darwin', run: keychain.run };
  assert.deepEqual(await readCredentials(deps), { status: CREDENTIAL_STATUS.NONE });
  assert.equal(fs.existsSync(controlPath(dir)), false);
  keychain.set(legacyCredentialService(), 'token', OLD); // becomes readable later
  assert.equal((await readCredentials(deps)).status, CREDENTIAL_STATUS.READY);
});

test('malformed legacy copies are ignored, as before', async (t) => {
  const dir = defaultHome(t);
  const keychain = fakeKeychain();
  const deps = { platform: 'darwin', run: keychain.run };
  fs.mkdirSync(dir, { recursive: true });
  keychain.set(legacyCredentialService(), 'token', 'bzi_legacy_device_token');
  fs.writeFileSync(legacyPath(dir), JSON.stringify({ token: '{not json' }));
  assert.deepEqual(await readCredentials(deps), { status: CREDENTIAL_STATUS.NONE });
});

test('a custom BEEZI_HOME migrates only its own credentials.json, never the shared legacy OS entry', async (t) => {
  const dir = customHome(t);
  const keychain = fakeKeychain();
  const deps = { platform: 'darwin', run: keychain.run };
  keychain.set(legacyCredentialService(), 'token', OLD);
  assert.deepEqual(await readCredentials(deps), { status: CREDENTIAL_STATUS.NONE });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(legacyPath(dir), JSON.stringify({ token: JSON.stringify(NEW) }));
  const read = await readCredentials(deps);
  assert.equal(read.status, CREDENTIAL_STATUS.READY);
  assert.equal(read.credentials.access_token, NEW.access_token);
});

test('migration waits for the namespace lock and reports unavailable (locked) when it stays held', async (t) => {
  const dir = defaultHome(t);
  const keychain = fakeKeychain();
  const deps = { platform: 'darwin', run: keychain.run, lockWaitMs: 30 };
  keychain.set(legacyCredentialService(), 'token', OLD);
  fs.mkdirSync(path.join(dir, 'credentials.lock'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'credentials.lock', 'owner.json'), JSON.stringify({ pid: process.pid, nonce: 'ff'.repeat(16), acquiredAt: Date.now() }));
  assert.deepEqual(await readCredentials(deps), { status: CREDENTIAL_STATUS.UNAVAILABLE, reason: UNAVAILABLE_REASONS.LOCKED });
  assert.equal(fs.existsSync(controlPath(dir)), false);
});

test('an unreadable control record → unavailable (control_unreadable)', async (t) => {
  const dir = customHome(t);
  await setCredentials(OLD, fileOnly);
  fs.writeFileSync(controlPath(dir), '{broken');
  assert.deepEqual(await readCredentials(fileOnly), { status: CREDENTIAL_STATUS.UNAVAILABLE, reason: UNAVAILABLE_REASONS.CONTROL_UNREADABLE });
});

// ── legacy wrappers (login/logout still call these until Task 3 rewires them) ───────────────

test('setCredentials takes the namespace lock and throws instead of overwriting when it cannot', async (t) => {
  customHome(t);
  const lock = await acquireCredentialLock({ waitMs: 0 }, fileOnly);
  try {
    await assert.rejects(() => setCredentials(OLD, { ...fileOnly, lockWaitMs: 30 }), /another Beezi process/);
    assert.deepEqual(await readCredentials(fileOnly), { status: CREDENTIAL_STATUS.NONE });
  } finally {
    releaseCredentialLock(lock);
  }
});

test('deleteCredentials clears the committed generation and the legacy copies (logout)', async (t) => {
  const dir = defaultHome(t);
  const keychain = fakeKeychain();
  const deps = { platform: 'darwin', run: keychain.run };
  fs.mkdirSync(dir, { recursive: true });
  keychain.set(legacyCredentialService(), 'token', OLD);
  fs.writeFileSync(legacyPath(dir), JSON.stringify({ token: JSON.stringify(OLD) }));
  await setCredentials(NEW, deps);
  await deleteCredentials(deps);
  assert.deepEqual(await readCredentials(deps), { status: CREDENTIAL_STATUS.NONE });
  assert.equal(keychain.has(credentialService(), 'gen-1'), false);
  assert.equal(keychain.has(legacyCredentialService(), 'token'), false);
  assert.equal(fs.existsSync(legacyPath(dir)), false);
  assert.equal(readControl(dir).highestGeneration, 1);
});
