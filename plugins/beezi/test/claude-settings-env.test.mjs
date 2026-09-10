import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  settingsCandidates,
  readSettingsEnv,
  oauthTokenEnv,
  oauthTokenEnvWithOsProbe,
} from '../lib/claude-settings-env.mjs';

const TOKEN = `sk-ant-oat01-${'a'.repeat(60)}`;
const OTHER = `sk-ant-oat01-${'b'.repeat(60)}`;

// A deps object whose disk is a plain map of path → parsed JSON. Nothing here touches the real
// home directory: a developer with a token in their own settings.json must not change a verdict.
const withFiles = (files, env = {}) => ({
  env,
  homedir: '/home/u',
  exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
  readFile: (p) => JSON.stringify(files[p]),
});

const userFile = (name) => path.join('/home/u', '.claude', name);

test('settingsCandidates — user scope only, local last so it wins', () => {
  assert.deepEqual(settingsCandidates({}, '/home/u'), [
    path.join('/home/u', '.claude', 'settings.json'),
    path.join('/home/u', '.claude', 'settings.local.json'),
  ]);
});

test('settingsCandidates — CLAUDE_CONFIG_DIR replaces ~/.claude', () => {
  assert.deepEqual(settingsCandidates({ CLAUDE_CONFIG_DIR: '/cfg' }, '/home/u'), [
    path.join('/cfg', 'settings.json'),
    path.join('/cfg', 'settings.local.json'),
  ]);
});

test('readSettingsEnv — no settings file is not an error', () => {
  assert.deepEqual(readSettingsEnv(withFiles({})), {});
});

test('readSettingsEnv — reads the env block of the user settings file', () => {
  const deps = withFiles({ [userFile('settings.json')]: { env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN } } });
  assert.deepEqual(readSettingsEnv(deps), { CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
});

test('readSettingsEnv — settings.local.json outranks settings.json', () => {
  const deps = withFiles({
    [userFile('settings.json')]: { env: { CLAUDE_CODE_OAUTH_TOKEN: OTHER } },
    [userFile('settings.local.json')]: { env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN } },
  });
  assert.equal(readSettingsEnv(deps).CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
});

test('readSettingsEnv — non-string values and a non-object env block are skipped', () => {
  const deps = withFiles({
    [userFile('settings.json')]: { env: { CLAUDE_CODE_OAUTH_TOKEN: 12345, KEEP: 'yes' } },
    [userFile('settings.local.json')]: { env: 'not-an-object' },
  });
  assert.deepEqual(readSettingsEnv(deps), { KEEP: 'yes' });
});

test('readSettingsEnv — malformed JSON degrades to nothing, never throws', () => {
  const deps = {
    env: {},
    homedir: '/home/u',
    exists: () => true,
    readFile: () => '{ not json',
  };
  assert.deepEqual(readSettingsEnv(deps), {});
});

test('readSettingsEnv — a readFile that throws degrades to nothing', () => {
  const deps = {
    env: {},
    homedir: '/home/u',
    exists: () => true,
    readFile: () => { throw new Error('EACCES'); },
  };
  assert.deepEqual(readSettingsEnv(deps), {});
});

test('oauthTokenEnv — a fingerprintable token in the process env is used verbatim', () => {
  const base = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN };
  const deps = withFiles({ [userFile('settings.json')]: { env: { CLAUDE_CODE_OAUTH_TOKEN: OTHER } } }, base);
  // Same object back: no copy, and the settings file is never allowed to shadow a live export.
  assert.equal(oauthTokenEnv(base, deps), base);
});

test('oauthTokenEnv — fills the hole from the settings file', () => {
  const base = {};
  const deps = withFiles({ [userFile('settings.json')]: { env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN } } }, base);
  const out = oauthTokenEnv(base, deps);
  assert.equal(out.CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
  // The caller's env object is never mutated.
  assert.equal('CLAUDE_CODE_OAUTH_TOKEN' in base, false);
});

test('oauthTokenEnv — a settings token too short to fingerprint is ignored', () => {
  const base = {};
  const deps = withFiles({ [userFile('settings.json')]: { env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01' } } }, base);
  assert.equal(oauthTokenEnv(base, deps), base);
});

test('oauthTokenEnv — an env token too short to fingerprint is replaced by the settings one', () => {
  // Claude Code would apply the settings value over the shell value; a stub export must not win.
  const base = { CLAUDE_CODE_OAUTH_TOKEN: 'x' };
  const deps = withFiles({ [userFile('settings.json')]: { env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN } } }, base);
  assert.equal(oauthTokenEnv(base, deps).CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
});

test('oauthTokenEnv — nothing anywhere returns the same env object', () => {
  const base = { PATH: '/usr/bin' };
  assert.equal(oauthTokenEnv(base, withFiles({}, base)), base);
});

test('oauthTokenEnv — only the token key is taken from the settings env block', () => {
  const base = {};
  const deps = withFiles(
    { [userFile('settings.json')]: { env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN, ANTHROPIC_API_KEY: 'sk-ant-api-nope' } } },
    base,
  );
  const out = oauthTokenEnv(base, deps);
  assert.equal(out.CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
  assert.equal('ANTHROPIC_API_KEY' in out, false);
});

// ─── oauthTokenEnvWithOsProbe: the third tier ─────────────────────────────
// The probe is ALWAYS injected here: the real one spawns `reg query` / `launchctl`, and a test
// that shells out would read the developer's own machine and pass or fail by accident. The same
// deps object also carries the fake disk, which is what makes settingsEnvOnce bypass its
// process-lifetime cache — a deps with only `osEnvOauthToken` would read the real ~/.claude.
const withProbe = (files, base, token) => {
  const calls = [];
  const deps = withFiles(files, base);
  deps.osEnvOauthToken = (d) => { calls.push(d); return token; };
  return { deps, calls };
};

const OS_TOKEN = `sk-ant-oat01-${'c'.repeat(60)}`;

test('oauthTokenEnvWithOsProbe — process.env outranks both the settings file and the OS env', () => {
  const base = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN };
  const { deps, calls } = withProbe(
    { [userFile('settings.json')]: { env: { CLAUDE_CODE_OAUTH_TOKEN: OTHER } } },
    base,
    OS_TOKEN,
  );
  assert.equal(oauthTokenEnvWithOsProbe(base, deps), base);
  // The cost guarantee: a token already in hand must not buy a subprocess.
  assert.equal(calls.length, 0);
});

test('oauthTokenEnvWithOsProbe — the settings file outranks the OS env', () => {
  const base = {};
  const { deps, calls } = withProbe(
    { [userFile('settings.json')]: { env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN } } },
    base,
    OS_TOKEN,
  );
  assert.equal(oauthTokenEnvWithOsProbe(base, deps).CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
  assert.equal(calls.length, 0);
});

test('oauthTokenEnvWithOsProbe — the OS env answers when the first two tiers are empty', () => {
  const base = { PATH: '/usr/bin' };
  const { deps, calls } = withProbe({}, base, OS_TOKEN);
  const out = oauthTokenEnvWithOsProbe(base, deps);
  assert.equal(out.CLAUDE_CODE_OAUTH_TOKEN, OS_TOKEN);
  assert.equal(out.PATH, '/usr/bin');
  // Probed exactly once — not zero (it is the only tier left) and not twice.
  assert.equal(calls.length, 1);
  // The caller's env object is never mutated.
  assert.equal('CLAUDE_CODE_OAUTH_TOKEN' in base, false);
});

test('oauthTokenEnvWithOsProbe — a stub env token is replaced by the OS one', () => {
  // Same rule as the settings tier: `CLAUDE_CODE_OAUTH_TOKEN=x` identifies nothing.
  const base = { CLAUDE_CODE_OAUTH_TOKEN: 'x' };
  const { deps, calls } = withProbe({}, base, OS_TOKEN);
  assert.equal(oauthTokenEnvWithOsProbe(base, deps).CLAUDE_CODE_OAUTH_TOKEN, OS_TOKEN);
  assert.equal(calls.length, 1);
});

test('oauthTokenEnvWithOsProbe — an OS token too short to fingerprint is ignored', () => {
  const base = { PATH: '/usr/bin' };
  const { deps } = withProbe({}, base, 'sk-ant-oat01');
  // Same object back: a value that identifies nothing must not become an identity.
  assert.equal(oauthTokenEnvWithOsProbe(base, deps), base);
});

test('oauthTokenEnvWithOsProbe — nothing anywhere returns the same env object', () => {
  const base = { PATH: '/usr/bin' };
  const { deps, calls } = withProbe({}, base, null);
  assert.equal(oauthTokenEnvWithOsProbe(base, deps), base);
  assert.equal(calls.length, 1);
});

test('oauthTokenEnvWithOsProbe — a probe that throws degrades to nothing, never propagates', () => {
  // Hook paths: a spawn failure must cost the user nothing.
  const base = { PATH: '/usr/bin' };
  const deps = withFiles({}, base);
  deps.osEnvOauthToken = () => { throw new Error('EPERM'); };
  assert.equal(oauthTokenEnvWithOsProbe(base, deps), base);
});

test('oauthTokenEnvWithOsProbe — an injected deps.env never reaches the probe', () => {
  // os-env-token bypasses its module-level cache whenever it sees an injected env/platform/run, so
  // forwarding this module's deps bag would let any caller with an env seam silently disable that
  // cache and re-spawn the whole chain. Only the probe seam crosses.
  const base = { PATH: '/usr/bin' };
  const seen = [];
  const deps = withFiles({}, base);
  deps.osEnvOauthToken = (...args) => { seen.push(args); return null; };
  oauthTokenEnvWithOsProbe(base, deps);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].length, 0, 'the probe is called with no deps at all');
});

test('oauthTokenEnvWithOsProbe — only the token key is taken from the OS env', () => {
  const base = { PATH: '/usr/bin' };
  const { deps } = withProbe({}, base, OS_TOKEN);
  const out = oauthTokenEnvWithOsProbe(base, deps);
  assert.deepEqual(Object.keys(out).sort(), ['CLAUDE_CODE_OAUTH_TOKEN', 'PATH']);
});

// ─── end to end: a settings-only token must reach the wire ───────────────────
// The unit tests above prove the resolver; these prove the WIRING. They run the real modules
// against a temp CLAUDE_CONFIG_DIR with no exported token, which is exactly the reported case.

test('a settings.json token drives identity, billing and the check-in payload', async (t) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-settings-env-'));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  const prevToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CONFIG_DIR = dir;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  t.after(() => {
    if (prev == null) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
    if (prevToken != null) process.env.CLAUDE_CODE_OAUTH_TOKEN = prevToken;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN } }));

  const { resetSettingsEnvCache, oauthTokenEnv: resolve } = await import('../lib/claude-settings-env.mjs');
  resetSettingsEnvCache();
  t.after(resetSettingsEnvCache);

  const env = resolve(process.env);
  const { hasOauthTokenIdentity, keyFingerprint } = await import('../lib/oauth-identity.mjs');
  assert.equal(hasOauthTokenIdentity(env), true);
  assert.equal(keyFingerprint(env.CLAUDE_CODE_OAUTH_TOKEN).last4, TOKEN.slice(-4));

  // billing: a setup token is positive evidence of subscription billing.
  const { detectBillingSource, BillingSource } = await import('../lib/billing.mjs');
  assert.equal(detectBillingSource(env), BillingSource.SUBSCRIPTION);

  // account check-in: the fingerprint travels, and it suppresses the stale uuid/email.
  const { buildAccountSyncPayload } = await import('../lib/account-sync.mjs');
  const payload = buildAccountSyncPayload({
    config: { accountUuid: 'stale-uuid', accountEmail: 'stale@example.com' },
    env,
  });
  assert.equal('accountUuid' in payload, false);
  assert.equal('email' in payload, false);
  assert.equal(payload.keys.length, 1);
  assert.equal(payload.keys[0].kind, 'claude_oauth_token');
  assert.equal(payload.keys[0].last4, TOKEN.slice(-4));
  // The token VALUE never appears on the wire, only its fingerprint.
  assert.equal(JSON.stringify(payload).includes(TOKEN), false);
});

test('no token anywhere leaves the check-in on the stored uuid/email', async (t) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-settings-env-none-'));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  const prevToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CONFIG_DIR = dir;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  t.after(() => {
    if (prev == null) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
    if (prevToken != null) process.env.CLAUDE_CODE_OAUTH_TOKEN = prevToken;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ env: { SOMETHING_ELSE: 'x' } }));

  const { resetSettingsEnvCache, oauthTokenEnv: resolve } = await import('../lib/claude-settings-env.mjs');
  resetSettingsEnvCache();
  t.after(resetSettingsEnvCache);

  const env = resolve(process.env);
  const { buildAccountSyncPayload } = await import('../lib/account-sync.mjs');
  const payload = buildAccountSyncPayload({ config: { accountUuid: 'u-1', accountEmail: 'a@b.c' }, env });
  assert.equal(payload.accountUuid, 'u-1');
  assert.equal(payload.email, 'a@b.c');
  assert.equal('keys' in payload, false);
});
