import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, compareVersions, isNewer } from '../lib/version-compare.mjs';

// The precedence table from the plan. Every row is [a, b, expected, why] and is exercised twice:
// once forwards, once for antisymmetry.
const TABLE = [
  ['0.17.0', '0.17.0', 0, 'identical versions are equal'],
  ['0.20.0', '0.17.9', 1, 'minor beats patch'],
  ['1.0.0', '0.99.99', 1, 'major beats everything below it'],
  ['0.17.0-dev.4938', '0.17.0-dev.4923', 1, 'the real dev-build case'],
  ['0.17.0-dev.2', '0.17.0-dev.10', -1, 'numeric identifiers compare numerically, not lexically'],
  ['0.17.0', '0.17.0-dev.4938', 1, 'a release outranks its own prerelease'],
  ['0.17.0-alpha', '0.17.0-1', 1, 'an alphanumeric identifier outranks a numeric one'],
  ['0.17.0-a.1', '0.17.0-a', 1, 'more prerelease fields beats fewer when the prefix ties'],
  ['0.17.0-dev.4938', '0.17.0-staging.4938', -1, 'alphanumeric identifiers compare by ASCII'],
  ['0.20.0-dev.1', '0.17.0-dev.9999', 1, 'the core version decides before any prerelease does'],
  ['0.17.0+build.5', '0.17.0', 0, 'build metadata never affects precedence'],
  ['v0.20.0', '0.17.0', 1, 'a tag-style leading v is tolerated'],
];

// assert/strict compares with Object.is, under which -0 is not 0 — normalize before negating.
const negate = (value) => (value === 0 ? 0 : -value);

// Every input that must parse to null, and therefore make compareVersions uncomparable.
const GARBAGE = [
  ['not-a-version', 'no core numbers at all'],
  ['0.1', 'a two-part version is not semver'],
  ['', 'the empty string'],
  [null, 'null is not a string'],
  [undefined, 'undefined is not a string'],
  ['0.17.0-', 'a dash with an empty prerelease'],
  ['0.17.0-a..b', 'an empty prerelease identifier'],
  ['01.2.3', 'a leading zero in a core number'],
];

test('compareVersions matches the precedence table', () => {
  for (const [a, b, expected, why] of TABLE) {
    assert.equal(
      compareVersions(a, b),
      expected,
      `compareVersions(${JSON.stringify(a)}, ${JSON.stringify(b)}) should be ${expected} — ${why}`,
    );
  }
});

test('compareVersions is antisymmetric across the whole table', () => {
  for (const [a, b, expected, why] of TABLE) {
    const forward = compareVersions(a, b);
    const backward = compareVersions(b, a);
    assert.equal(
      forward,
      negate(backward),
      `compare(${JSON.stringify(a)}, ${JSON.stringify(b)}) must be the negation of the reverse — ${why}`,
    );
    assert.equal(
      backward,
      negate(expected),
      `reversed compare(${JSON.stringify(b)}, ${JSON.stringify(a)}) should be ${negate(expected)} — ${why}`,
    );
  }
});

test('parseVersion returns null for every malformed input', () => {
  for (const [value, why] of GARBAGE) {
    assert.equal(
      parseVersion(value),
      null,
      `parseVersion(${JSON.stringify(value)}) should be null — ${why}`,
    );
  }
});

test('compareVersions returns null when either side is unparseable', () => {
  for (const [value, why] of GARBAGE) {
    assert.equal(
      compareVersions(value, '0.17.0'),
      null,
      `garbage on the left should be uncomparable — ${why}`,
    );
    assert.equal(
      compareVersions('0.17.0', value),
      null,
      `garbage on the right should be uncomparable — ${why}`,
    );
  }
  assert.equal(compareVersions('nope', 'also-nope'), null, 'garbage on both sides is uncomparable');
});

test('isNewer fails closed in both directions on garbage', () => {
  for (const [value, why] of GARBAGE) {
    assert.equal(
      isNewer(value, '0.17.0'),
      false,
      `an unparseable candidate must never read as newer — ${why}`,
    );
    assert.equal(
      isNewer('99.99.99', value),
      false,
      `an unparseable current version must never produce a nudge — ${why}`,
    );
  }
});

test('isNewer is true only for a strictly greater candidate', () => {
  assert.equal(isNewer('0.20.0', '0.17.0'), true, '0.20.0 is newer than 0.17.0');
  assert.equal(isNewer('0.17.0', '0.17.0'), false, 'an equal version is not newer');
  assert.equal(isNewer('0.17.0', '0.20.0'), false, 'an older version is not newer');
  assert.equal(isNewer('0.17.0', '0.17.0-dev.4938'), true, 'the release is newer than its prerelease');
  assert.equal(isNewer('0.17.0-dev.4938', '0.17.0'), false, 'a prerelease is not newer than its release');
  assert.equal(isNewer('0.17.0+build.9', '0.17.0'), false, 'build metadata alone is not an update');
});

test('parseVersion returns the full shape for a prerelease version', () => {
  assert.deepEqual(
    parseVersion('0.17.0-dev.4938'),
    { major: 0, minor: 17, patch: 0, prerelease: ['dev', '4938'] },
    'core numbers are numbers and the prerelease is split into string identifiers',
  );
  assert.deepEqual(
    parseVersion('1.2.3'),
    { major: 1, minor: 2, patch: 3, prerelease: [] },
    'a plain release carries an empty prerelease list',
  );
  assert.deepEqual(
    parseVersion(' v1.2.3-rc.1+build.7 '),
    { major: 1, minor: 2, patch: 3, prerelease: ['rc', '1'] },
    'surrounding space, a leading v and build metadata are all stripped',
  );
});
