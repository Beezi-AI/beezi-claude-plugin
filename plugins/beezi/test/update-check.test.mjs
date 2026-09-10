import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  STATE_VERSION,
  checkForUpdate,
  composeNudge,
  readLocalPlugin,
  readUpdateCheck,
} from '../lib/update-check.mjs';

// Every test gets its own BEEZI_HOME and its own plugin root, so the cache file cannot leak
// between tests or touch ~/.beezi, and the version under comparison is never this repo's real one.
// BEEZI_UPDATE_MANIFEST_URL is saved/cleared/restored too: a developer who exported it while
// running the plan's live end-to-end check would otherwise have it leak into every case that
// exercises config resolution.
async function withHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-updchk-'));
  const home = path.join(dir, 'home');
  const root = path.join(dir, 'root');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  const prevHome = process.env.BEEZI_HOME;
  const prevUrl = process.env.BEEZI_UPDATE_MANIFEST_URL;
  process.env.BEEZI_HOME = home;
  delete process.env.BEEZI_UPDATE_MANIFEST_URL;
  try {
    return await fn({ home, root });
  } finally {
    if (prevHome === undefined) delete process.env.BEEZI_HOME;
    else process.env.BEEZI_HOME = prevHome;
    if (prevUrl === undefined) delete process.env.BEEZI_UPDATE_MANIFEST_URL;
    else process.env.BEEZI_UPDATE_MANIFEST_URL = prevUrl;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A real .claude-plugin/plugin.json, because readLocalPlugin deliberately has no readJsonImpl seam
// — the installed identity always comes off the filesystem.
function writePlugin(root, manifest) {
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest));
}

function cacheFile(home) {
  return path.join(home, 'update-check.json');
}

function seedCache(home, record) {
  fs.writeFileSync(cacheFile(home), JSON.stringify(record));
}

const NOW = new Date('2026-08-31T12:00:00.000Z');
const at = (offsetMs) => new Date(NOW.getTime() + offsetMs).toISOString();
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const URL_OK = 'https://raw.example.invalid/.claude-plugin/marketplace.json';
const LOCAL = { name: 'beezi-dev', version: '0.19.0-dev.4900' };
const manifestWith = (version, name = 'beezi-internal') => ({
  name,
  plugins: [
    { name: 'beezi-staging', version: '9.9.9' },
    { name: 'beezi-dev', version },
  ],
});

// Records every call and answers with `body`. Used where a fetch IS expected.
function stubFetch(body, status = 200) {
  const impl = async (url, opts) => {
    impl.calls.push({ url, opts });
    return { status, json: async () => body };
  };
  impl.calls = [];
  return impl;
}

// Used where a fetch must NOT happen. It answers with a NEWER version rather than throwing: a
// throw would be swallowed by checkForUpdate and the case would pass for the wrong reason, while a
// newer answer turns an unwanted fetch into a visible nudge.
function neverFetch(version = '9.9.9') {
  const impl = stubFetch(manifestWith(version));
  return impl;
}

function baseDeps(ctx, over) {
  return { pluginRoot: ctx.root, manifestUrl: URL_OK, now: NOW, ...over };
}

// ---------------------------------------------------------------- cached readings

test('a fresh cached reading of a newer version nudges without touching the network', async () => {
  await withHome(async (ctx) => {
    writePlugin(ctx.root, LOCAL);
    seedCache(ctx.home, {
      version: STATE_VERSION,
      checkedAt: at(-MINUTE),
      pluginName: 'beezi-dev',
      latestVersion: '0.20.0-dev.5000',
      marketplaceName: 'beezi-internal',
    });
    const fetchImpl = neverFetch();
    const message = await checkForUpdate(baseDeps(ctx, { fetchImpl }));
    assert.match(message, /0\.19\.0-dev\.4900 → 0\.20\.0-dev\.5000/);
    assert.equal(fetchImpl.calls.length, 0);
  });
});

test('a cached reading of the same version says nothing and asks nothing', async () => {
  await withHome(async (ctx) => {
    writePlugin(ctx.root, LOCAL);
    seedCache(ctx.home, {
      version: STATE_VERSION,
      checkedAt: at(-MINUTE),
      pluginName: 'beezi-dev',
      latestVersion: '0.19.0-dev.4900',
      marketplaceName: 'beezi-internal',
    });
    const fetchImpl = neverFetch();
    assert.equal(await checkForUpdate(baseDeps(ctx, { fetchImpl })), null);
    assert.equal(fetchImpl.calls.length, 0);
  });
});

test('a published version OLDER than the installed one stays quiet', async () => {
  await withHome(async (ctx) => {
    writePlugin(ctx.root, LOCAL);
    seedCache(ctx.home, {
      version: STATE_VERSION,
      checkedAt: at(-MINUTE),
      pluginName: 'beezi-dev',
      latestVersion: '0.18.0',
      marketplaceName: 'beezi-internal',
    });
    const fetchImpl = neverFetch();
    assert.equal(await checkForUpdate(baseDeps(ctx, { fetchImpl })), null);
    assert.equal(fetchImpl.calls.length, 0);
  });
});

test('a user who already took the update goes silent immediately, inside the TTL', async () => {
  await withHome(async (ctx) => {
    // The cache still holds the reading that produced yesterday's nudge; the plugin is now that
    // very version. A cached VERDICT would keep nagging for the rest of the hour.
    writePlugin(ctx.root, { name: 'beezi-dev', version: '0.20.0' });
    seedCache(ctx.home, {
      version: STATE_VERSION,
      checkedAt: at(-MINUTE),
      pluginName: 'beezi-dev',
      latestVersion: '0.20.0',
      marketplaceName: 'beezi-internal',
    });
    const fetchImpl = neverFetch();
    assert.equal(await checkForUpdate(baseDeps(ctx, { fetchImpl })), null);
    assert.equal(fetchImpl.calls.length, 0, 'the fresh cache must still have been used');
  });
});

// ---------------------------------------------------------------- fetching

test('a cache miss fetches once, records the remote FACTS and nudges', async () => {
  await withHome(async (ctx) => {
    writePlugin(ctx.root, LOCAL);
    const fetchImpl = stubFetch(manifestWith('0.20.0-dev.5000'));
    const message = await checkForUpdate(baseDeps(ctx, { fetchImpl }));

    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fetchImpl.calls[0].url, URL_OK);
    assert.equal(fetchImpl.calls[0].opts.method, 'GET');
    assert.equal(
      Object.keys(fetchImpl.calls[0].opts.headers).some((k) => k.toLowerCase() === 'authorization'),
      false,
      'the Beezi bearer token must never reach the manifest host',
    );
    assert.match(message, /0\.20\.0-dev\.5000/);

    const written = JSON.parse(fs.readFileSync(cacheFile(ctx.home), 'utf-8'));
    assert.deepEqual(written, {
      version: STATE_VERSION,
      checkedAt: NOW.toISOString(),
      pluginName: 'beezi-dev',
      latestVersion: '0.20.0-dev.5000',
      marketplaceName: 'beezi-internal',
    });
    // Facts only — no boolean verdict may be persisted.
    assert.equal(
      Object.values(written).some((v) => typeof v === 'boolean'),
      false,
    );
    assert.equal(readUpdateCheck().latestVersion, '0.20.0-dev.5000');
  });
});

test('a reading older than the 1h TTL is refetched', async () => {
  await withHome(async (ctx) => {
    writePlugin(ctx.root, LOCAL);
    seedCache(ctx.home, {
      version: STATE_VERSION,
      checkedAt: at(-2 * HOUR),
      pluginName: 'beezi-dev',
      latestVersion: '0.19.0-dev.4900',
      marketplaceName: 'beezi-internal',
    });
    const fetchImpl = stubFetch(manifestWith('0.21.0-dev.6000'));
    const message = await checkForUpdate(baseDeps(ctx, { fetchImpl }));
    assert.equal(fetchImpl.calls.length, 1);
    assert.match(message, /0\.21\.0-dev\.6000/);
  });
});

test('a reading stamped in the future is a clock change, not freshness', async () => {
  await withHome(async (ctx) => {
    writePlugin(ctx.root, LOCAL);
    seedCache(ctx.home, {
      version: STATE_VERSION,
      checkedAt: at(5 * HOUR),
      pluginName: 'beezi-dev',
      latestVersion: '0.19.0-dev.4900',
      marketplaceName: 'beezi-internal',
    });
    const fetchImpl = stubFetch(manifestWith('0.21.0-dev.6000'));
    const message = await checkForUpdate(baseDeps(ctx, { fetchImpl }));
    assert.equal(fetchImpl.calls.length, 1);
    assert.match(message, /0\.21\.0-dev\.6000/);
  });
});

test('a record from another STATE_VERSION is ignored and refetched', async () => {
  await withHome(async (ctx) => {
    writePlugin(ctx.root, LOCAL);
    seedCache(ctx.home, {
      version: STATE_VERSION + 1,
      checkedAt: at(-MINUTE),
      pluginName: 'beezi-dev',
      latestVersion: '0.19.0-dev.4900',
      marketplaceName: 'beezi-internal',
    });
    assert.equal(readUpdateCheck(), null);
    const fetchImpl = stubFetch(manifestWith('0.21.0-dev.6000'));
    assert.match(await checkForUpdate(baseDeps(ctx, { fetchImpl })), /0\.21\.0-dev\.6000/);
    assert.equal(fetchImpl.calls.length, 1);
  });
});

test('a reading about a different plugin name (variant swap) is refetched', async () => {
  await withHome(async (ctx) => {
    writePlugin(ctx.root, LOCAL);
    seedCache(ctx.home, {
      version: STATE_VERSION,
      checkedAt: at(-MINUTE),
      pluginName: 'beezi-staging',
      latestVersion: '9.9.9',
      marketplaceName: 'beezi-internal',
    });
    const fetchImpl = stubFetch(manifestWith('0.21.0-dev.6000'));
    const message = await checkForUpdate(baseDeps(ctx, { fetchImpl }));
    assert.equal(fetchImpl.calls.length, 1);
    assert.match(message, /0\.21\.0-dev\.6000/);
    assert.equal(message.includes('9.9.9'), false);
  });
});

// ---------------------------------------------------------------- remote failure modes

test('a 404 says nothing and writes no record', async () => {
  await withHome(async (ctx) => {
    writePlugin(ctx.root, LOCAL);
    const fetchImpl = stubFetch(manifestWith('0.21.0'), 404);
    assert.equal(await checkForUpdate(baseDeps(ctx, { fetchImpl })), null);
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fs.existsSync(cacheFile(ctx.home)), false);
  });
});

test('a 500 says nothing', async () => {
  await withHome(async (ctx) => {
    writePlugin(ctx.root, LOCAL);
    const fetchImpl = stubFetch(manifestWith('0.21.0'), 500);
    assert.equal(await checkForUpdate(baseDeps(ctx, { fetchImpl })), null);
    assert.equal(fs.existsSync(cacheFile(ctx.home)), false);
  });
});

test('offline and timed-out both say nothing', async () => {
  await withHome(async (ctx) => {
    writePlugin(ctx.root, LOCAL);
    const offline = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
    assert.equal(await checkForUpdate(baseDeps(ctx, { fetchImpl: offline })), null);

    const aborted = async () => {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      throw error;
    };
    assert.equal(await checkForUpdate(baseDeps(ctx, { fetchImpl: aborted })), null);
    assert.equal(fs.existsSync(cacheFile(ctx.home)), false);
  });
});

test('a body that is not JSON says nothing', async () => {
  await withHome(async (ctx) => {
    writePlugin(ctx.root, LOCAL);
    const fetchImpl = async () => ({
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token < in JSON'); },
    });
    assert.equal(await checkForUpdate(baseDeps(ctx, { fetchImpl })), null);
    assert.equal(fs.existsSync(cacheFile(ctx.home)), false);
  });
});

test('a manifest with no plugins array says nothing', async () => {
  await withHome(async (ctx) => {
    writePlugin(ctx.root, LOCAL);
    for (const body of [{ name: 'beezi-internal' }, { name: 'x', plugins: {} }, null, 'nope']) {
      const fetchImpl = stubFetch(body);
      assert.equal(await checkForUpdate(baseDeps(ctx, { fetchImpl })), null);
    }
    assert.equal(fs.existsSync(cacheFile(ctx.home)), false);
  });
});

test('a manifest with no entry for this plugin says nothing', async () => {
  await withHome(async (ctx) => {
    writePlugin(ctx.root, LOCAL);
    const fetchImpl = stubFetch({
      name: 'beezi-internal',
      plugins: [{ name: 'beezi-staging', version: '9.9.9' }],
    });
    assert.equal(await checkForUpdate(baseDeps(ctx, { fetchImpl })), null);
    assert.equal(fs.existsSync(cacheFile(ctx.home)), false);
  });
});

test('an entry whose version is not a string says nothing', async () => {
  await withHome(async (ctx) => {
    writePlugin(ctx.root, LOCAL);
    const fetchImpl = stubFetch({
      name: 'beezi-internal',
      plugins: [{ name: 'beezi-dev', version: 20 }],
    });
    assert.equal(await checkForUpdate(baseDeps(ctx, { fetchImpl })), null);
    assert.equal(fs.existsSync(cacheFile(ctx.home)), false);
  });
});

test('a manifest with no name falls back to /plugin and never prints @undefined', async () => {
  await withHome(async (ctx) => {
    writePlugin(ctx.root, LOCAL);
    const fetchImpl = stubFetch({ plugins: [{ name: 'beezi-dev', version: '0.20.0-dev.5000' }] });
    const message = await checkForUpdate(baseDeps(ctx, { fetchImpl }));
    assert.equal(
      message,
      'Beezi: a newer beezi-dev is published — 0.19.0-dev.4900 → 0.20.0-dev.5000.'
      + ' Run /plugin to update it, then restart Claude Code to apply it.',
    );
    assert.equal(/@undefined/.test(message), false);
    assert.equal(/@null/.test(message), false);
  });
});

// ---------------------------------------------------------------- configuration gates

test('no configured manifest URL means no fetch at all', async () => {
  await withHome(async (ctx) => {
    writePlugin(ctx.root, LOCAL);
    const fetchImpl = neverFetch();
    assert.equal(await checkForUpdate(baseDeps(ctx, { manifestUrl: null, fetchImpl })), null);
    assert.equal(fetchImpl.calls.length, 0);
    assert.equal(fs.existsSync(cacheFile(ctx.home)), false);
  });
});

test('a non-https manifest URL is a misconfiguration, not a question', async () => {
  await withHome(async (ctx) => {
    writePlugin(ctx.root, LOCAL);
    for (const url of ['http://raw.example.invalid/marketplace.json', 'file:///tmp/m.json', '']) {
      const fetchImpl = neverFetch();
      assert.equal(await checkForUpdate(baseDeps(ctx, { manifestUrl: url, fetchImpl })), null);
      assert.equal(fetchImpl.calls.length, 0);
    }
    assert.equal(fs.existsSync(cacheFile(ctx.home)), false);
  });
});

test('BEEZI_UPDATE_MANIFEST_URL wins over the baked env.json value, at call time', async () => {
  await withHome(async (ctx) => {
    writePlugin(ctx.root, LOCAL);
    process.env.BEEZI_UPDATE_MANIFEST_URL = 'https://override.example.invalid/marketplace.json';
    const fetchImpl = stubFetch(manifestWith('0.20.0-dev.5000'));
    // No manifestUrl in deps: resolution goes through config.updateManifestUrl().
    const message = await checkForUpdate({ pluginRoot: ctx.root, now: NOW, fetchImpl });
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fetchImpl.calls[0].url, 'https://override.example.invalid/marketplace.json');
    assert.match(message, /0\.20\.0-dev\.5000/);
  });
});

// ---------------------------------------------------------------- local manifest

test('an unreadable or incomplete plugin.json means no question and no fetch', async () => {
  await withHome(async (ctx) => {
    const variants = [
      null,                                     // no .claude-plugin/plugin.json at all
      { version: '0.19.0' },                    // no name
      { name: 'beezi-dev' },                    // no version
      { name: 'beezi-dev', version: 19 },       // version not a string
      { name: '', version: '0.19.0' },          // empty name
    ];
    for (const manifest of variants) {
      const root = fs.mkdtempSync(path.join(ctx.home, 'root-'));
      if (manifest != null) writePlugin(root, manifest);
      const fetchImpl = neverFetch();
      assert.equal(readLocalPlugin({ pluginRoot: root }), null);
      // No localPlugin injected — readLocalPlugin must actually read this root.
      assert.equal(
        await checkForUpdate({ pluginRoot: root, manifestUrl: URL_OK, now: NOW, fetchImpl }),
        null,
      );
      assert.equal(fetchImpl.calls.length, 0);
    }
  });
});

test('readLocalPlugin reads .claude-plugin/plugin.json, not package.json', async () => {
  await withHome(async (ctx) => {
    // The variant build rewrites plugin.json only, so package.json holds the wrong version.
    writePlugin(ctx.root, { name: 'beezi-dev', version: '0.19.0-dev.4900' });
    fs.writeFileSync(
      path.join(ctx.root, 'package.json'),
      JSON.stringify({ name: 'beezi', version: '0.19.0' }),
    );
    assert.deepEqual(readLocalPlugin({ pluginRoot: ctx.root }), LOCAL);
  });
});

// ---------------------------------------------------------------- resilience

test('a read-only home costs the cache write, not the nudge', async () => {
  await withHome(async (ctx) => {
    writePlugin(ctx.root, LOCAL);
    const fetchImpl = stubFetch(manifestWith('0.20.0-dev.5000'));
    const message = await checkForUpdate(baseDeps(ctx, {
      fetchImpl,
      writeJsonImpl: () => { throw new Error('EROFS: read-only file system'); },
    }));
    assert.match(message, /0\.20\.0-dev\.5000/);
    assert.equal(fs.existsSync(cacheFile(ctx.home)), false);
  });
});

test('checkForUpdate never rejects, whatever it is handed', async () => {
  await withHome(async (ctx) => {
    writePlugin(ctx.root, LOCAL);
    const hostile = [
      // manifestUrl: null everywhere it is not the point — no case may reach the real network.
      { manifestUrl: null },
      { pluginRoot: ctx.root, now: 'not a date', manifestUrl: URL_OK, fetchImpl: neverFetch() },
      {
        pluginRoot: ctx.root,
        manifestUrl: URL_OK,
        now: NOW,
        readJsonImpl: () => { throw new Error('boom'); },
        fetchImpl: neverFetch(),
      },
      {
        pluginRoot: ctx.root,
        manifestUrl: URL_OK,
        now: NOW,
        fetchImpl: () => { throw new Error('sync throw, not a rejection'); },
      },
      { localPlugin: { name: 'beezi-dev', version: 'not-a-version' }, manifestUrl: URL_OK, now: NOW,
        fetchImpl: stubFetch(manifestWith('also-not-a-version')) },
    ];
    for (const deps of hostile) {
      // Also proves an unparseable version pair fails CLOSED rather than nagging.
      await assert.doesNotReject(async () => {
        const out = await checkForUpdate(deps);
        assert.equal(out == null || typeof out === 'string', true);
      });
    }
    assert.equal(
      await checkForUpdate({
        localPlugin: { name: 'beezi-dev', version: 'not-a-version' },
        manifestUrl: URL_OK,
        now: NOW,
        fetchImpl: stubFetch(manifestWith('0.20.0')),
      }),
      null,
    );
  });
});

// ---------------------------------------------------------------- wording

test('the dev-shape nudge is byte-exact', async () => {
  await withHome(async (ctx) => {
    writePlugin(ctx.root, { name: 'beezi-dev', version: '0.17.0-dev.4938' });
    const fetchImpl = stubFetch({
      name: 'beezi-internal',
      plugins: [{ name: 'beezi-dev', version: '0.17.0-dev.4952' }],
    });
    assert.equal(
      await checkForUpdate(baseDeps(ctx, { fetchImpl })),
      'Beezi: a newer beezi-dev is published — 0.17.0-dev.4938 → 0.17.0-dev.4952.'
      + ' Run: claude plugin marketplace update beezi-internal,'
      + ' then claude plugin update beezi-dev@beezi-internal'
      + ' — then restart Claude Code to apply it.',
    );
  });
});

test('composeNudge is a pure function of the two facts', () => {
  assert.equal(
    composeNudge({ name: 'beezi', version: '0.17.0' }, { latestVersion: '0.20.0', marketplaceName: null }),
    'Beezi: a newer beezi is published — 0.17.0 → 0.20.0.'
    + ' Run /plugin to update it, then restart Claude Code to apply it.',
  );
});
