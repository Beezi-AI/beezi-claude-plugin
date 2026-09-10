import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

function withHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-telemetry-'));
  const prev = process.env.BEEZI_HOME;
  process.env.BEEZI_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_HOME; else process.env.BEEZI_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const readEvents = (home) => {
  const dir = path.join(home, 'telemetry');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
};

test('records nothing at all until consent is granted', async (t) => {
  const home = withHome(t);
  const { recordIssue } = await import('../lib/telemetry.mjs?a');
  const { DIAGNOSTIC_CODES, DIAGNOSTIC_SOURCES } = await import('../lib/telemetry-codes.mjs?a');
  assert.equal(recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH, source: DIAGNOSTIC_SOURCES.CHECKPOINT, error: new Error('x') }), false);
  assert.deepEqual(readEvents(home), [], 'nothing written without consent');
});

test('a recorded event carries no free text from the error', async (t) => {
  const home = withHome(t);
  const { grantConsent } = await import('../lib/telemetry-consent.mjs?b');
  grantConsent();
  const { recordIssue } = await import('../lib/telemetry.mjs?b');
  const { DIAGNOSTIC_CODES, DIAGNOSTIC_SOURCES } = await import('../lib/telemetry-codes.mjs?b');

  const secret = 'refactor the billing prompt in /Users/someone/secret/app.ts';
  const error = new SyntaxError(secret);
  error.code = 'ERR_PARSE';
  recordIssue({ code: DIAGNOSTIC_CODES.TRANSCRIPT_PARSE_FAILED, source: DIAGNOSTIC_SOURCES.CHECKPOINT, error });

  const events = readEvents(home);
  assert.equal(events.length, 1);
  const raw = JSON.stringify(events[0]);
  assert.equal(raw.includes('secret'), false, 'no message text');
  assert.equal(raw.includes('/Users/someone'), false, 'no foreign path');
  assert.equal(raw.includes('billing prompt'), false, 'no prompt fragment');
  assert.equal(events[0].errorName, 'SyntaxError');
  assert.equal(events[0].errorCode, 'ERR_PARSE');
  assert.equal(events[0].code, DIAGNOSTIC_CODES.TRANSCRIPT_PARSE_FAILED);
  assert.ok(events[0].pluginVersion, 'plugin version stamped');
  assert.equal(typeof events[0].count, 'number');
});

test('identical failures roll up into one event with a count', async (t) => {
  const home = withHome(t);
  const { grantConsent } = await import('../lib/telemetry-consent.mjs?c');
  grantConsent();
  const { recordIssue } = await import('../lib/telemetry.mjs?c');
  const { DIAGNOSTIC_CODES, DIAGNOSTIC_SOURCES } = await import('../lib/telemetry-codes.mjs?c');

  const boom = () => { const e = new TypeError('same'); e.code = 'ESAME'; return e; };
  for (let i = 0; i < 5; i++) recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH, source: DIAGNOSTIC_SOURCES.STOP, error: boom() });

  const events = readEvents(home);
  assert.equal(events.length, 1, 'a crash loop is one row, not five');
  assert.equal(events[0].count, 5);
  assert.ok(events[0].firstSeenAt <= events[0].lastSeenAt);
});

test('an unknown code is refused rather than recorded', async (t) => {
  const home = withHome(t);
  const { grantConsent } = await import('../lib/telemetry-consent.mjs?d');
  grantConsent();
  const { recordIssue } = await import('../lib/telemetry.mjs?d');
  const { DIAGNOSTIC_SOURCES } = await import('../lib/telemetry-codes.mjs?d');
  assert.equal(recordIssue({ code: 'made_up', source: DIAGNOSTIC_SOURCES.STOP, error: new Error('x') }), false);
  assert.deepEqual(readEvents(home), []);
});

test('a prose errorCode or errorName is dropped, not truncated', async (t) => {
  const home = withHome(t);
  const { grantConsent } = await import('../lib/telemetry-consent.mjs?z');
  grantConsent();
  const { recordIssue } = await import('../lib/telemetry.mjs?z');
  const { DIAGNOSTIC_CODES, DIAGNOSTIC_SOURCES } = await import('../lib/telemetry-codes.mjs?z');

  const error = new Error('x');
  error.code = 'failed while reading /Users/someone/secret/app.ts for the billing prompt';
  Object.defineProperty(error.constructor, 'name', { value: 'why did this happen to me' });
  recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH, source: DIAGNOSTIC_SOURCES.STOP, error });

  const events = readEvents(home);
  assert.equal(events.length, 1);
  assert.equal(events[0].errorCode, null, 'prose is dropped whole, never truncated');
  assert.equal(events[0].errorName, null);
  assert.equal(JSON.stringify(events[0]).includes('/Users/someone'), false);
});

test('site keeps only plugin frames', async (t) => {
  withHome(t);
  const { siteFrom } = await import('../lib/telemetry.mjs?e');
  const error = new Error('x');
  error.stack = [
    'Error: x',
    '    at foreign (/Users/someone/other/thing.mjs:9:1)',
    '    at inner (/plugin/root/lib/checkpoint.mjs:412:15)',
  ].join('\n');
  assert.equal(siteFrom(error, '/plugin/root'), 'lib/checkpoint.mjs:412');

  const onlyForeign = new Error('y');
  onlyForeign.stack = 'Error: y\n    at foreign (/Users/someone/other/thing.mjs:9:1)';
  assert.equal(siteFrom(onlyForeign, '/plugin/root'), null, 'never report a path outside the plugin');
});

// The bug: the old regex (`[^()\s]+`) cannot span a space or paren in the plugin root, so it
// matches a shorter, relative-looking fragment of the line instead — which path.relative then
// resolves against process.cwd(), leaking the user's cwd and repo name. The fix's containment
// check (never the regex alone) is what has to hold here.
test('site never leaks a path outside the plugin, whatever the plugin root or stack line look like', async (t) => {
  withHome(t);
  const { siteFrom } = await import('../lib/telemetry.mjs?leak');

  const rootWithSpace = '/Users/First Last/.claude/plugins/beezi';
  const spaceError = new Error('x');
  spaceError.stack = [
    'Error: x',
    `    at inner (${rootWithSpace}/lib/checkpoint.mjs:20:5)`,
  ].join('\n');
  const spaceSite = siteFrom(spaceError, rootWithSpace);
  assert.equal(spaceSite, 'lib/checkpoint.mjs:20', 'a space in the root must not fracture the match');

  const rootWithParens = '/Users/x/Dropbox (Personal)/plugins/beezi';
  const parenError = new Error('y');
  parenError.stack = [
    'Error: y',
    `    at inner (${rootWithParens}/lib/checkpoint.mjs:9:3)`,
  ].join('\n');
  const parenSite = siteFrom(parenError, rootWithParens);
  assert.equal(parenSite, 'lib/checkpoint.mjs:9', 'parens in the root must not fracture the match');

  // The message line (not a stack frame) embeds a plausible path plus a `:N:M` token — it must
  // never be read as a site, whatever it contains.
  const cleanRoot = '/plugin/root';
  const msgError = new Error(`boom near ${cleanRoot}/lib/x.mjs:12:3`);
  msgError.stack = `Error: boom near ${cleanRoot}/lib/x.mjs:12:3`;
  assert.equal(siteFrom(msgError, cleanRoot), null, 'the message line is never read as a frame');

  for (const site of [spaceSite, parenSite]) {
    assert.equal(site.includes('..'), false, 'never a segment that walks out of the plugin');
    assert.equal(path.isAbsolute(site.split(':')[0]), false, 'never an absolute path');
  }
});

// An eval frame's line can carry trailing junk (e.g. `), <anonymous>:1`) that the regex still
// captures as part of match[1] because `.+` is greedy and the line still ends in `:digits`.
// Containment still holds (the result never escapes the plugin directory), but the string is
// not a valid `site` shape, so it must be rejected rather than sent to the server malformed.
test('site is shape-checked, not merely contained, so an eval frame yields null', async (t) => {
  withHome(t);
  const { siteFrom } = await import('../lib/telemetry.mjs?eval');
  const cleanRoot = '/plugin/root';
  const evalError = new Error('x');
  evalError.stack = [
    'Error: x',
    `    at eval (${cleanRoot}/lib/a.mjs:1:2), <anonymous>:1:1)`,
  ].join('\n');
  assert.equal(siteFrom(evalError, cleanRoot), null, 'malformed eval-frame site must not be reported');
});

test('osRelease is shape-checked, not merely truncated', async (t) => {
  const home = withHome(t);
  const { grantConsent } = await import('../lib/telemetry-consent.mjs?os');
  grantConsent();
  const { recordIssue } = await import('../lib/telemetry.mjs?os');
  const { DIAGNOSTIC_CODES, DIAGNOSTIC_SOURCES } = await import('../lib/telemetry-codes.mjs?os');

  recordIssue(
    { code: DIAGNOSTIC_CODES.HOOK_CRASH, source: DIAGNOSTIC_SOURCES.STOP, error: new Error('x') },
    { osRelease: () => 'not a real release, has spaces and a /Users/someone path' },
  );

  const events = readEvents(home);
  assert.equal(events.length, 1);
  assert.equal(events[0].osRelease, null, 'a shape violation drops to null rather than truncating a slice of it');
});

// The bug: the rollup guard only checked `existing.count != null`, so a corrupt string count
// (e.g. from a salvaged file) is treated as truthy and incremented via `+`, which is string
// concatenation for a string operand ("abc1" + 1 === "abc11") rather than arithmetic.
test('a corrupted count restarts the rollup instead of compounding as a string', async (t) => {
  const home = withHome(t);
  const { grantConsent } = await import('../lib/telemetry-consent.mjs?corrupt');
  grantConsent();
  const { recordIssue } = await import('../lib/telemetry.mjs?corrupt');
  const { DIAGNOSTIC_CODES, DIAGNOSTIC_SOURCES } = await import('../lib/telemetry-codes.mjs?corrupt');

  const boom = () => { const e = new TypeError('same'); e.code = 'ESAME'; return e; };
  recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH, source: DIAGNOSTIC_SOURCES.STOP, error: boom() });

  const dir = path.join(home, 'telemetry');
  const [file] = fs.readdirSync(dir);
  const filePath = path.join(dir, file);
  const stored = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  fs.writeFileSync(filePath, JSON.stringify({ ...stored, count: 'abc1' }));

  recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH, source: DIAGNOSTIC_SOURCES.STOP, error: boom() });

  const after = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(after.count, 1, 'a corrupt count restarts the event rather than compounding');
});
