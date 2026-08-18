import { test } from 'node:test';
import assert from 'node:assert/strict';

// Set BEFORE the import: BEEZI_ENV is read once at module load. Fresh process per test file
// (node --test) keeps this from leaking into env-identity.test.mjs.
process.env.BEEZI_ENV = 'qa';
delete process.env.BEEZI_HOME;

const paths = await import('../lib/paths.mjs');

test('BEEZI_ENV env var overrides the baked identity and namespaces every path', () => {
  assert.equal(paths.BEEZI_ENV, 'qa');
  assert.equal(paths.envSuffix(), '-qa');
  assert.ok(paths.beeziHome().endsWith('.beezi-qa'));
  assert.ok(paths.credentialsFile().includes('.beezi-qa'));
  assert.ok(paths.queueDir().includes('.beezi-qa'));
});
