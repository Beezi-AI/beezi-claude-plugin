import { test } from 'node:test';
import assert from 'node:assert/strict';
import { friendlyMessage, UserError } from '../lib/friendly-error.mjs';

const NO_DEBUG = { env: {} };

test('UserError message passes through verbatim', () => {
  const msg = "Unknown plan 'ultra'. Valid: pro, max_5x.";
  assert.equal(friendlyMessage(new UserError(msg), NO_DEBUG), msg);
});

test('any error tagged userFacing passes through verbatim', () => {
  const e = Object.assign(new Error('Login timed out before approval.'), { userFacing: true });
  assert.equal(friendlyMessage(e, NO_DEBUG), 'Login timed out before approval.');
});

test("Node fetch's TypeError('fetch failed') becomes the network sentence", () => {
  const out = friendlyMessage(new TypeError('fetch failed'), NO_DEBUG);
  assert.match(out, /reach the Beezi server/i);
  assert.doesNotMatch(out, /fetch failed/);
});

test('a wrapped network cause (ENOTFOUND) is classified as network', () => {
  const e = new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
  assert.match(friendlyMessage(e, NO_DEBUG), /reach the Beezi server/i);
});

test('a direct network code (ECONNREFUSED) is classified as network', () => {
  const out = friendlyMessage(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), NO_DEBUG);
  assert.match(out, /reach the Beezi server/i);
  assert.doesNotMatch(out, /ECONNREFUSED/);
});

test('an undici timeout code (UND_ERR_*) is classified as network', () => {
  const e = new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
  assert.match(friendlyMessage(e, NO_DEBUG), /reach the Beezi server/i);
});

test('a filesystem code (ENOENT) is classified as filesystem and names the code', () => {
  const e = Object.assign(new Error("ENOENT: no such file or directory, open '/x'"), { code: 'ENOENT' });
  const out = friendlyMessage(e, NO_DEBUG);
  assert.match(out, /local data/i);
  assert.match(out, /ENOENT/);
  assert.doesNotMatch(out, /no such file/);
});

test('a JSON parse SyntaxError becomes the unexpected-response sentence', () => {
  const out = friendlyMessage(new SyntaxError('Unexpected token < in JSON at position 0'), NO_DEBUG);
  assert.match(out, /unexpected response/i);
  assert.doesNotMatch(out, /Unexpected token/);
});

test('an unknown error is generic and never leaks the raw message', () => {
  const out = friendlyMessage(new Error('Cannot read properties of undefined (reading foo)'), NO_DEBUG);
  assert.match(out, /BEEZI_DEBUG/);
  assert.doesNotMatch(out, /Cannot read properties/);
});

test('BEEZI_DEBUG surfaces the raw message for an unknown error', () => {
  const out = friendlyMessage(new Error('boom internal detail'), { env: { BEEZI_DEBUG: '1' } });
  assert.match(out, /boom internal detail/);
});

test('a null/undefined error still yields a safe generic sentence', () => {
  assert.match(friendlyMessage(null, NO_DEBUG), /Something went wrong/i);
  assert.match(friendlyMessage(undefined, NO_DEBUG), /Something went wrong/i);
});
