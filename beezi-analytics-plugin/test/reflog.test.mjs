import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCheckoutEvents, buildBranchTimeline, branchAt } from '../lib/reflog.mjs';

const SAMPLE = [
  'a1 HEAD@{2026-07-03T10:10:00+00:00}: checkout: moving from feature/task-A to main',
  'b2 HEAD@{2026-07-03T10:05:00+00:00}: commit: wip',
  'c3 HEAD@{2026-07-03T10:00:00+00:00}: checkout: moving from main to feature/task-A',
  'd4 HEAD@{2026-07-03T09:50:00+00:00}: reset: moving to HEAD~1',
].join('\n');

const fakeGit = (out) => () => out;
const t = (iso) => Date.parse(iso);

test('readCheckoutEvents — only checkout lines, ascending by ms', () => {
  const events = readCheckoutEvents(fakeGit(SAMPLE), 'x');
  assert.equal(events.length, 2);
  assert.equal(events[0].from, 'main');
  assert.equal(events[0].to, 'feature/task-A');
  assert.equal(events[1].from, 'feature/task-A');
  assert.equal(events[1].to, 'main');
  assert.ok(events[0].ms < events[1].ms);
});

test('buildBranchTimeline — sentinel is first event.from; boundaries ordered', () => {
  const tl = buildBranchTimeline(readCheckoutEvents(fakeGit(SAMPLE), 'x'));
  assert.equal(tl[0].ms, -Infinity);
  assert.equal(tl[0].branch, 'main');
  assert.equal(tl[1].branch, 'feature/task-A');
  assert.equal(tl[2].branch, 'main');
});

test('buildBranchTimeline — null when no checkout events', () => {
  assert.equal(buildBranchTimeline([]), null);
  const commitsOnly = readCheckoutEvents(fakeGit('x1 HEAD@{2026-07-03T10:00:00+00:00}: commit: y'), 'x');
  assert.equal(buildBranchTimeline(commitsOnly), null);
});

test('branchAt — resolves by timestamp; checkout second belongs to the new branch', () => {
  const tl = buildBranchTimeline(readCheckoutEvents(fakeGit(SAMPLE), 'x'));
  assert.equal(branchAt(tl, t('2026-07-03T09:00:00+00:00')), 'main');
  assert.equal(branchAt(tl, t('2026-07-03T10:00:00+00:00')), 'feature/task-A');
  assert.equal(branchAt(tl, t('2026-07-03T10:03:00+00:00')), 'feature/task-A');
  assert.equal(branchAt(tl, t('2026-07-03T10:10:00+00:00')), 'main');
  assert.equal(branchAt(tl, t('2026-07-03T11:00:00+00:00')), 'main');
});

test('readCheckoutEvents — detached HEAD (to = sha) preserved verbatim', () => {
  const out = 'z9 HEAD@{2026-07-03T10:00:00+00:00}: checkout: moving from main to 1a2b3c4';
  const events = readCheckoutEvents(fakeGit(out), 'x');
  assert.equal(events[0].to, '1a2b3c4');
});
