import { test } from 'node:test';
import assert from 'node:assert/strict';

// BEEZI_ENV is computed at import time, so this file only exercises the shipped default
// (env.json name '' → prod). The BEEZI_ENV override lives in its own test file — node --test
// runs each file in a fresh process, which is what makes the import-time constant testable.
delete process.env.BEEZI_ENV;
delete process.env.BEEZI_HOME;
delete process.env.BEEZI_API_URL;

const paths = await import('../lib/paths.mjs');
const config = await import('../lib/config.mjs');

test('shipped env.json reads as prod identity', () => {
  assert.equal(paths.BEEZI_ENV, '');
  assert.equal(paths.envSuffix(), '');
  assert.ok(paths.beeziHome().endsWith('.beezi'));
});

test('shipped env.json points apiBase at prod', () => {
  assert.equal(config.apiBase(), 'https://beezi-api-prod.azurewebsites.net/api');
});

test('BEEZI_API_URL overrides the baked apiBase at call time', () => {
  process.env.BEEZI_API_URL = 'https://example.test/api';
  try {
    assert.equal(config.apiBase(), 'https://example.test/api');
  } finally {
    delete process.env.BEEZI_API_URL;
  }
});
