import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, runAudit, shouldFinalize } from '../lib/session-audit.mjs';
import { BackfillSessionStatus, BackfillHalt } from '../lib/audit-flush.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ─── helpers ────────────────────────────────────────────────────────────────

const transcript = (sessionId, mtimeMs = 1_000) => ({
  sessionId,
  transcriptPath: `C:/projects/${sessionId}.jsonl`,
  projectDir: 'C:/projects',
  mtimeMs,
  size: 1024,
});

const report = (sessionId) => ({ segmentId: `${sessionId}:0-1`, sessionId, remote: 'r', branch: 'main' });

const flushResult = (over = {}) => ({
  chunks: 1,
  stored: 0,
  skipped: 0,
  timelines: 0,
  timelinesDropped: 0,
  itemErrors: 0,
  retryableFailures: 0,
  permanentRejections: 0,
  unattributed: 0,
  bySession: new Map(),
  halt: null,
  lastError: null,
  ...over,
});

// Sibling of flushResult for the other shape the audit consumes: a test states only the skip
// reason it is about, and a new field costs one edit here instead of one per test.
const checkpointResult = (skipped = {}) => ({
  enqueued: 0,
  flush: null,
  sessionErrors: [],
  skipped: { noRemote: 0, emitFailed: 0, deltaFailed: false, ...skipped },
});

// A flush double that accepts everything it is handed and records the call.
function fakeFlush(statusFor = () => BackfillSessionStatus.ACCEPTED) {
  const calls = [];
  const impl = async (groups, _token, _deps, options) => {
    calls.push({ groups, options });
    const bySession = new Map();
    let stored = 0;
    let retryableFailures = 0;
    for (const g of groups) {
      const status = statusFor(g.sessionId);
      bySession.set(g.sessionId, { status, reason: null });
      if (status === BackfillSessionStatus.ACCEPTED || status === BackfillSessionStatus.PARTIAL) {
        stored += g.reports.length;
      }
      if (status === BackfillSessionStatus.FAILED) retryableFailures += 1;
    }
    return flushResult({ stored, retryableFailures, bySession });
  };
  return { impl, calls };
}

function makeDeps(overrides = {}) {
  const events = [];
  const saved = [];
  const ledger = { version: 1, identity: null, sessions: {}, unreadable: {}, complete: false, updatedAt: null };
  const deps = {
    env: {},
    now: () => 10 * 60 * 60 * 1000, // fixed clock, far past every fixture mtime + the 30min window
    getAccessToken: async () => 'tok',
    whoamiImpl: async () => ({ valid: true, trackingMode: 'live', backfillCompleted: false }),
    recordWhoamiImpl: () => {},
    listTranscripts: () => [transcript('s1')],
    firstRecordedCwd: () => 'C:/work/app',
    readTrackingStateImpl: () => null,
    markBackfillCompletedImpl: () => events.push('mark-completed'),
    completeBackfillImpl: async () => {
      events.push('complete');
      return { completed: true, code: null };
    },
    runCheckpointImpl: async (input, _d, options) => {
      options.sink(report(input.session_id));
      return { enqueued: 1, flush: null, sessionErrors: [] };
    },
    flushBackfillChunksImpl: async (groups) => {
      events.push('flush');
      const bySession = new Map(
        groups.map((g) => [g.sessionId, { status: BackfillSessionStatus.ACCEPTED, reason: null }]),
      );
      return flushResult({
        stored: groups.length,
        timelines: groups.filter((g) => g.timeline).length,
        bySession,
      });
    },
    loadLedgerImpl: () => ledger,
    saveLedgerImpl: (l) => saved.push(JSON.parse(JSON.stringify(l))),
    computeSessionTimelineImpl: () => ({ periods: [{ state: 'working' }], plan_events: [], subagents: [] }),
    postSessionErrorImpl: async () => { events.push('error'); return { reported: true }; },
    ...overrides,
  };
  return { deps, events, saved, ledger };
}

// ─── parseArgs ──────────────────────────────────────────────────────────────

test('1. parses all three flags', () => {
  const args = parseArgs(['--force', '--dry-run', '--since', '2026-01-31']);

  assert.equal(args.force, true);
  assert.equal(args.dryRun, true);
  assert.equal(args.since, '2026-01-31');
  assert.equal(args.sinceMs, Date.parse('2026-01-31'));
});

test('2. defaults to no flags', () => {
  assert.deepEqual(parseArgs([]), {});
});

test('3. rejects a malformed --since with a user-facing error', () => {
  assert.throws(() => parseArgs(['--since', 'last tuesday']), (error) => {
    assert.equal(error.userFacing, true);
    assert.match(error.message, /--since expects a date/);
    return true;
  });
});

test('4. rejects a well-formatted but impossible --since date', () => {
  assert.throws(() => parseArgs(['--since', '2026-13-45']), /--since expects a date/);
});

// ─── candidate selection ────────────────────────────────────────────────────

test('5. bails without a token and never scans', async () => {
  const { deps } = makeDeps({ getAccessToken: async () => null, listTranscripts: () => { throw new Error('scanned'); } });

  const result = await runAudit(deps, {});

  assert.equal(result.reason, 'no-token');
  assert.equal(result.ok, false);
});

// The live session's hooks own its state file concurrently, and it is already tracked.
test('6. excludes the live session named by CLAUDE_CODE_SESSION_ID', async () => {
  const { deps } = makeDeps({
    env: { CLAUDE_CODE_SESSION_ID: 's1' },
    listTranscripts: () => [transcript('s1'), transcript('s2')],
  });

  const result = await runAudit(deps, {});

  assert.equal(result.live, 1);
  assert.equal(result.candidates, 1);
});

test('7. falls back to the resolved transcript when the env var is absent', async () => {
  const { deps } = makeDeps({
    listTranscripts: () => [transcript('s1'), transcript('s2')],
    resolveSessionTranscriptImpl: () => ({ sessionId: 's2', transcriptPath: 'x' }),
  });

  const result = await runAudit(deps, {});

  assert.equal(result.live, 1);
  assert.equal(result.candidates, 1);
});

test('8. excludes sessions already in the ledger', async () => {
  const { deps, ledger } = makeDeps({ listTranscripts: () => [transcript('s1'), transcript('s2')] });
  ledger.sessions['s1'] = { outcome: 'accepted' };

  const result = await runAudit(deps, {});

  assert.equal(result.alreadyImported, 1);
  assert.equal(result.candidates, 1);
});

test('9. --force ignores the ledger', async () => {
  const flush = fakeFlush();
  const { deps, ledger } = makeDeps({ flushBackfillChunksImpl: flush.impl });
  ledger.sessions['s1'] = { outcome: 'accepted' };

  const result = await runAudit(deps, { force: true });

  assert.equal(result.alreadyImported, 0);
  assert.equal(result.candidates, 1);
  assert.equal(flush.calls.length, 1);
});

// A transcript touched inside the recency window is probably an OPEN session in another window —
// backfilling it would re-segment lines its next live checkpoint also reports.
test('10. skips recently-active transcripts', async () => {
  const NOW = 10 * 60 * 60 * 1000;
  const { deps } = makeDeps({
    now: () => NOW,
    listTranscripts: () => [transcript('old', 1_000), transcript('open', NOW - 60_000)],
  });

  const result = await runAudit(deps, {});

  assert.equal(result.active, 1);
  assert.equal(result.candidates, 1);
});

// Live-tracking tenants: everything after the machine link was tracked live; re-sending it
// through the audit would re-segment on different boundaries and double-count.
test('11. live-mode tenants only upload transcripts predating the machine link', async () => {
  const { deps } = makeDeps({
    readTrackingStateImpl: () => ({ trackingMode: 'live', backfillCompleted: false }),
    statImpl: () => ({ mtimeMs: 5_000 }),
    listTranscripts: () => [transcript('before-link', 1_000), transcript('after-link', 9_000)],
  });

  const result = await runAudit(deps, {});

  assert.equal(result.liveTracked, 1);
  assert.equal(result.candidates, 1);
});

// The stamp is the real signal; the credentials mtime is only a fallback for links made before it
// existed. On CredMan/Keychain/secret-tool machines that file never exists, so a stat-only cutoff
// returned null and the guard above silently never fired.
test('11b. the link cutoff comes from the tracking stamp, not the credentials file', async () => {
  const { deps } = makeDeps({
    readTrackingStateImpl: () => ({
      trackingMode: 'live',
      backfillCompleted: false,
      linkedAt: new Date(5_000).toISOString(),
    }),
    // No credentials file on this machine — the old implementation gave up here.
    statImpl: () => { throw new Error('ENOENT'); },
    listTranscripts: () => [transcript('before-link', 1_000), transcript('after-link', 9_000)],
  });

  const result = await runAudit(deps, {});

  assert.equal(result.liveTracked, 1);
  assert.equal(result.candidates, 1);
});

// Every candidate that yields no report used to vanish between `candidates` and
// `sessionsImported` with nothing printed — the run said it read 593 and uploaded 576, and the
// missing 17 had no name anywhere. Each cause now has its own counter.
test('11c. a candidate with no usage data counts as empty, not as a loss', async () => {
  const { deps } = makeDeps({
    listTranscripts: () => [transcript('has-usage'), transcript('no-usage')],
    runCheckpointImpl: async (input, _d, options) => {
      if (input.session_id === 'has-usage') options.sink(report(input.session_id));
      return checkpointResult();
    },
  });

  const result = await runAudit(deps, {});

  assert.equal(result.candidates, 2);
  assert.equal(result.sessionsImported, 1);
  assert.equal(result.empty, 1);
  assert.equal(result.noRemote, 0);
  assert.equal(result.unreadable, 0);
  // Nothing to upload is not a failure — it must not hold the one-time pull open.
  assert.equal(result.finalized, true);
});

test('11d. a candidate with no resolvable repository is reported separately from empty', async () => {
  const { deps } = makeDeps({
    listTranscripts: () => [transcript('no-remote')],
    runCheckpointImpl: async () => checkpointResult({ noRemote: 2 }),
  });

  const result = await runAudit(deps, {});

  assert.equal(result.noRemote, 1);
  assert.equal(result.empty, 0);
  // Deterministic: a transcript with no recorded cwd will have none next run either, so gating
  // the seal on it would hold the pull open forever.
  assert.equal(result.finalized, true);
});

// The seal is one-time per account and tool, and --force skips only the local caches. Sealing
// over a transcript we merely failed to READ loses that session permanently.
test('11e. an unreadable transcript is counted and keeps the pull open', async () => {
  const { deps } = makeDeps({
    listTranscripts: () => [transcript('unreadable')],
    runCheckpointImpl: async () => checkpointResult({ deltaFailed: true }),
  });

  const result = await runAudit(deps, {});

  assert.equal(result.unreadable, 1);
  assert.equal(result.empty, 0);
  assert.equal(result.finalized, false);
});

test('11f. a throwing checkpoint counts as unreadable and keeps the pull open', async () => {
  const { deps } = makeDeps({
    listTranscripts: () => [transcript('boom')],
    runCheckpointImpl: async () => { throw new Error('ENOENT'); },
  });

  const result = await runAudit(deps, {});

  assert.equal(result.unreadable, 1);
  assert.equal(result.sessionsImported, 0);
  assert.equal(result.finalized, false);
});

// A session we failed to prepare must never be reported as "held no usage data" — that sentence
// is the silent-loss-dressed-as-normal outcome this whole change set exists to end.
test('11h. a session whose segments all failed to emit is not reported as empty', async () => {
  const { deps } = makeDeps({
    listTranscripts: () => [transcript('emit-boom')],
    runCheckpointImpl: async () => checkpointResult({ emitFailed: 2 }),
  });

  const result = await runAudit(deps, {});

  assert.equal(result.emitFailed, 1);
  assert.equal(result.empty, 0);
});

// EACCES reads exactly like transient I/O at the call site. Without a bound, one such file would
// hold the pull open on every future login and the summary would tell the user to re-run forever.
test('11g. a transcript that fails twice stops blocking the seal on the second run', async () => {
  const ledger = { version: 1, identity: null, sessions: {}, unreadable: {}, complete: false, updatedAt: null };
  const make = () =>
    makeDeps({
      listTranscripts: () => [transcript('always-broken')],
      runCheckpointImpl: async () => { throw new Error('EACCES'); },
      loadLedgerImpl: () => ledger,
      saveLedgerImpl: () => {},
    }).deps;

  const first = await runAudit(make(), {});
  assert.equal(first.unreadable, 1);
  assert.equal(first.retriableUnreadable, 1);
  assert.equal(first.finalized, false, 'first failure earns a retry');

  const second = await runAudit(make(), {});
  assert.equal(second.unreadable, 1, 'still reported to the user');
  assert.equal(second.retriableUnreadable, 0, 'but no longer blocking');
  assert.equal(second.finalized, true, 'the pull can seal');
});

test('12. --since drops transcripts older than the cutoff', async () => {
  const { deps } = makeDeps({
    listTranscripts: () => [transcript('old', 1_000), transcript('new', 9_000)],
  });

  const result = await runAudit(deps, { sinceMs: 5_000 });

  assert.equal(result.candidates, 1);
});

test('13. skips a transcript too large to parse safely', async () => {
  const { deps } = makeDeps({
    listTranscripts: () => [{ ...transcript('huge'), size: 128 * 1024 * 1024 }],
  });

  const result = await runAudit(deps, {});

  assert.equal(result.oversize, 1);
  assert.equal(result.candidates, 0);
});

test('14. an unreadable transcript is skipped without ending the run', async () => {
  const flush = fakeFlush();
  const { deps } = makeDeps({
    listTranscripts: () => [transcript('bad'), transcript('good')],
    flushBackfillChunksImpl: flush.impl,
    runCheckpointImpl: async (input, _d, options) => {
      if (input.session_id === 'bad') throw new Error('unreadable');
      options.sink(report(input.session_id));
      return { enqueued: 1, flush: null, sessionErrors: [] };
    },
  });

  const result = await runAudit(deps, {});

  assert.equal(result.sessionsImported, 1);
  assert.deepEqual(flush.calls[0].groups.map((g) => g.sessionId), ['good']);
});

// ─── identity binding ───────────────────────────────────────────────────────

// A ledger recorded under another login must be ignored — replaying it would find zero
// candidates and seal the NEW tenant's pull empty.
test('15. a foreign-identity ledger is discarded, never trusted into a seal', async () => {
  let askedIdentity = 'unset';
  const { deps, events } = makeDeps({
    loadLedgerImpl: (identity) => {
      askedIdentity = identity;
      // loadLedger's contract: a mismatched identity yields a FRESH ledger.
      return { version: 1, identity, sessions: {}, complete: false, updatedAt: null };
    },
    listTranscripts: () => [transcript('s1')],
  });

  const result = await runAudit(deps, {});

  assert.notEqual(askedIdentity, 'unset');
  assert.equal(result.candidates, 1);
  assert.ok(events.includes('flush'));
});

// ─── server-side already-used verification ─────────────────────────

// The server is the authority: wiping ~/.beezi (or a fresh reinstall) must not let the pull
// run again once it was used. Nothing is scanned — the run stops on the whoami verdict.
test('15a. a server-sealed pull stops before scanning and heals the local cache', async () => {
  const events = [];
  const { deps } = makeDeps({
    whoamiImpl: async () => ({ valid: true, trackingMode: 'backfill_only', backfillCompleted: true }),
    markBackfillCompletedImpl: () => events.push('mark-completed'),
    listTranscripts: () => { throw new Error('must not scan'); },
  });

  const result = await runAudit(deps, {});

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'already-completed');
  assert.equal(result.upgradeAdvised, true, 'a dark workspace gets the upgrade suggestion');
  assert.deepEqual(events, ['mark-completed']);
});

test('15b. --force never bypasses the server verdict', async () => {
  const { deps } = makeDeps({
    whoamiImpl: async () => ({ valid: true, trackingMode: 'backfill_only', backfillCompleted: true }),
    listTranscripts: () => { throw new Error('must not scan'); },
  });

  const result = await runAudit(deps, { force: true });

  assert.equal(result.reason, 'already-completed');
});

test('15c. a live-tracking tenant with a sealed pull gets no upgrade nag', async () => {
  const { deps } = makeDeps({
    whoamiImpl: async () => ({ valid: true, trackingMode: 'live', backfillCompleted: true }),
    listTranscripts: () => { throw new Error('must not scan'); },
  });

  const result = await runAudit(deps, {});

  assert.equal(result.reason, 'already-completed');
  assert.equal(result.upgradeAdvised, false);
});

// Offline or pre-audit server: the check is advisory — the run proceeds and the chunk-level
// ALREADY_COMPLETED guard remains the backstop.
test('15d. an unreachable whoami never blocks the run', async () => {
  const { deps } = makeDeps({ whoamiImpl: async () => { throw new Error('offline'); } });

  const result = await runAudit(deps, {});

  assert.equal(result.ok, true);
  assert.equal(result.sessionsImported, 1);
  assert.equal(result.finalized, true);
});

// ─── delivery + follow-ups ──────────────────────────────────────────────────

// Timelines ride IN the chunk payload: the flush sees them attached to their session group,
// and the run still finalizes off the flush verdicts alone.
test('16. attaches the computed timeline to its session group, then finalizes', async () => {
  let seenGroups = null;
  const { deps, events } = makeDeps();
  const base = deps.flushBackfillChunksImpl;
  deps.flushBackfillChunksImpl = async (groups, ...rest) => {
    seenGroups = groups;
    return base(groups, ...rest);
  };

  const result = await runAudit(deps, {});

  assert.deepEqual(events, ['flush', 'complete', 'mark-completed']);
  assert.equal(seenGroups.length, 1);
  assert.equal(seenGroups[0].timeline.sessionId, 's1');
  assert.deepEqual(seenGroups[0].timeline.periods, [{ state: 'working' }]);
  assert.equal(result.timelines, 1);
});

test('17. an empty timeline is not attached at all', async () => {
  let seenGroups = null;
  const { deps } = makeDeps({
    computeSessionTimelineImpl: () => ({ periods: [], plan_events: [], subagents: [] }),
  });
  const base = deps.flushBackfillChunksImpl;
  deps.flushBackfillChunksImpl = async (groups, ...rest) => {
    seenGroups = groups;
    return base(groups, ...rest);
  };

  const result = await runAudit(deps, {});

  assert.equal(seenGroups[0].timeline, null);
  assert.equal(result.timelines, 0);
  assert.equal(result.sessionsImported, 1);
});

test('18. posts buffered rate-limit errors after the flush', async () => {
  const { deps, events } = makeDeps({
    runCheckpointImpl: async (input, _d, options) => {
      options.sink(report(input.session_id));
      return { enqueued: 1, flush: null, sessionErrors: [{ sessionId: input.session_id, error: 'rate_limit' }] };
    },
  });

  const result = await runAudit(deps, {});

  assert.deepEqual(events.slice(0, 2), ['flush', 'error']);
  assert.equal(result.sessionErrors, 1);
});

// Dark-mode tenants: the timeline/errors routes are tracking-gated — their audit is usage-only.
test('19. follow-ups are skipped entirely when tracking is not live', async () => {
  const { deps, events } = makeDeps({
    readTrackingStateImpl: () => ({ trackingMode: 'backfill_only', backfillCompleted: false }),
    runCheckpointImpl: async (input, _d, options) => {
      options.sink(report(input.session_id));
      return { enqueued: 1, flush: null, sessionErrors: [{ sessionId: input.session_id, error: 'rate_limit' }] };
    },
  });

  const result = await runAudit(deps, {});

  assert.ok(!events.includes('timeline'));
  assert.ok(!events.includes('error'));
  assert.equal(result.followupsAllowed, false);
  assert.equal(result.sessionsImported, 1);
});

// A broken transcript's timeline must never block the usage upload: the group ships without it.
test('20. a timeline that fails to compute never blocks the upload', async () => {
  let seenGroups = null;
  const { deps } = makeDeps({
    computeSessionTimelineImpl: () => { throw new Error('unparseable transcript'); },
  });
  const base = deps.flushBackfillChunksImpl;
  deps.flushBackfillChunksImpl = async (groups, ...rest) => {
    seenGroups = groups;
    return base(groups, ...rest);
  };

  const result = await runAudit(deps, {});

  assert.equal(seenGroups[0].timeline, null);
  assert.equal(result.sessionsImported, 1);
  assert.equal(result.finalized, true);
});

// The one-deep pipeline: while a batch is in flight, the loop keeps parsing the next
// sessions instead of idling on the upload.
test('20b. parsing continues while a dispatched batch is in flight', async () => {
  const order = [];
  const sessions = Array.from({ length: 51 }, (_u, i) => transcript(`s${i}`));
  const { deps } = makeDeps({
    listTranscripts: () => sessions,
    runCheckpointImpl: async (input, _d, options) => {
      order.push(`parse:${input.session_id}`);
      options.sink(report(input.session_id));
      return { enqueued: 1, flush: null, sessionErrors: [] };
    },
    flushBackfillChunksImpl: async (groups) => {
      order.push(`flush-start:${groups.length}`);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      order.push(`flush-end:${groups.length}`);
      const bySession = new Map(
        groups.map((g) => [g.sessionId, { status: BackfillSessionStatus.ACCEPTED, reason: null }]),
      );
      return flushResult({ stored: groups.length, bySession });
    },
  });

  const result = await runAudit(deps, {});

  assert.equal(result.sessionsImported, 51);
  assert.equal(result.finalized, true);
  const firstStart = order.indexOf('flush-start:50');
  const firstEnd = order.indexOf('flush-end:50');
  assert.ok(firstStart >= 0 && firstEnd > firstStart, 'first batch was dispatched');
  const overlapped = order
    .slice(firstStart + 1, firstEnd)
    .some((event) => event.startsWith('parse:'));
  assert.ok(overlapped, 'no session was parsed while the first batch was in flight');
});

test('21. drives runCheckpoint with the audit seams and the recorded cwd', async () => {
  let seen = null;
  const { deps } = makeDeps({
    runCheckpointImpl: async (input, _d, options) => {
      seen = { input, options };
      options.sink(report(input.session_id));
      return { enqueued: 1, flush: null, sessionErrors: [] };
    },
  });

  await runAudit(deps, {});

  assert.equal(seen.input.cwd, 'C:/work/app');
  assert.equal(seen.options.skipFlush, true);
  assert.equal(seen.options.collectSessionErrors, true);
  // The cursor must not advance before delivery is confirmed, or a failed run leaves the session
  // both unledgered and unreadable.
  assert.equal(seen.options.persistState, false);
  // The audit runs while the tenant gate is closed — the flag must be explicit.
  assert.equal(seen.options.skipLiveTrackingGate, true);
});

// ─── ledger ─────────────────────────────────────────────────────────────────

test('22. ledgers a rejected session so it is not resent every run', async () => {
  const flush = fakeFlush(() => BackfillSessionStatus.REJECTED);
  const { deps, saved } = makeDeps({ flushBackfillChunksImpl: flush.impl });

  await runAudit(deps, {});

  assert.equal(saved.at(-1).sessions['s1'].outcome, BackfillSessionStatus.REJECTED);
});

test('23. does NOT ledger a session the server never judged', async () => {
  const flush = fakeFlush(() => BackfillSessionStatus.FAILED);
  const { deps, saved } = makeDeps({ flushBackfillChunksImpl: flush.impl });

  await runAudit(deps, {});

  assert.equal(saved.at(-1)?.sessions['s1'], undefined);
});

// ─── finalization ───────────────────────────────────────────────────────────

test('24. a fully clean run calls /complete exactly once and marks completion', async () => {
  const { deps, events, saved } = makeDeps();

  const result = await runAudit(deps, {});

  assert.equal(events.filter((e) => e === 'complete').length, 1);
  assert.equal(result.finalized, true);
  assert.equal(saved.at(-1).complete, true);
});

test('25. a run with a retryable failure does not finalize', async () => {
  const flush = fakeFlush(() => BackfillSessionStatus.FAILED);
  const { deps, events } = makeDeps({ flushBackfillChunksImpl: flush.impl });

  const result = await runAudit(deps, {});

  assert.ok(!events.includes('complete'));
  assert.equal(result.finalized, false);
});

test('26. per-item rejections (unconnected repo) do NOT block finalization', async () => {
  const flush = fakeFlush(() => BackfillSessionStatus.REJECTED);
  const { deps, events } = makeDeps({ flushBackfillChunksImpl: flush.impl });

  const result = await runAudit(deps, {});

  assert.ok(events.includes('complete'));
  assert.equal(result.finalized, true);
});

test('27. whole-chunk permanent rejections DO block finalization', async () => {
  const { deps, events } = makeDeps({
    flushBackfillChunksImpl: async (groups) => {
      const bySession = new Map(
        groups.map((g) => [g.sessionId, { status: BackfillSessionStatus.REJECTED, reason: 'HTTP 413' }]),
      );
      return flushResult({ permanentRejections: 1, bySession });
    },
  });

  const result = await runAudit(deps, {});

  assert.ok(!events.includes('complete'));
  assert.equal(result.finalized, false);
});

test('28. an unattributed chunk blocks finalization', async () => {
  const { deps, events } = makeDeps({
    flushBackfillChunksImpl: async (groups) => {
      const bySession = new Map(
        groups.map((g) => [g.sessionId, { status: BackfillSessionStatus.UNATTRIBUTED, reason: 'unreadable-response' }]),
      );
      return flushResult({ unattributed: 1, bySession });
    },
  });

  const result = await runAudit(deps, {});

  assert.ok(!events.includes('complete'));
  assert.equal(result.finalized, false);
});

test('29. --since never finalizes (a scoped run must not seal a partial dataset)', async () => {
  const { deps, events } = makeDeps({ listTranscripts: () => [transcript('new', 9_000)] });

  const result = await runAudit(deps, { sinceMs: 5_000 });

  assert.ok(!events.includes('complete'));
  assert.equal(result.finalized, false);
});

// One lost finalize POST must not strand the pull IN_PROGRESS forever.
test('30. a clean all-ledgered run retries /complete exactly once', async () => {
  const { deps, events, ledger } = makeDeps();
  ledger.sessions['s1'] = { outcome: 'accepted' };

  const result = await runAudit(deps, {});

  assert.equal(result.candidates, 0);
  assert.deepEqual(events, ['complete', 'mark-completed']);
  assert.equal(result.finalized, true);
});

test('31. the fast path exits before scanning once completion is recorded', async () => {
  const { deps } = makeDeps({
    readTrackingStateImpl: () => ({ trackingMode: 'backfill_only', backfillCompleted: true }),
    listTranscripts: () => { throw new Error('must not scan'); },
  });

  const result = await runAudit(deps, {});

  assert.equal(result.reason, 'already-completed');
  assert.equal(result.ok, true);
});

test('32. --force bypasses the fast path so the reinstall heal stays reachable', async () => {
  const flush = fakeFlush();
  const { deps } = makeDeps({
    readTrackingStateImpl: () => ({ trackingMode: 'live', backfillCompleted: true }),
    flushBackfillChunksImpl: flush.impl,
  });

  const result = await runAudit(deps, { force: true });

  assert.equal(result.reason, null);
  assert.equal(flush.calls.length, 1);
});

// The reinstall path: server says the pull is sealed → heal the local ledger and stop.
test('33. ALREADY_COMPLETED halts, heals the ledger and marks completion', async () => {
  const { deps, events, saved } = makeDeps({
    listTranscripts: () => [transcript('s1'), transcript('s2')],
    flushBackfillChunksImpl: async (groups) => {
      events.push('flush');
      return flushResult({ halt: BackfillHalt.ALREADY_COMPLETED, bySession: new Map() });
    },
  });

  const result = await runAudit(deps, {});

  assert.equal(result.halt, BackfillHalt.ALREADY_COMPLETED);
  assert.equal(saved.at(-1).complete, true);
  assert.ok(events.includes('mark-completed'));
  // Halted — the finalize POST must not fire on top of the server's own seal.
  assert.ok(!events.includes('complete'));
});

// ─── dry run ────────────────────────────────────────────────────────────────

test('34. --dry-run sends nothing, writes no ledger, never finalizes', async () => {
  const flush = fakeFlush();
  const { deps, saved, events } = makeDeps({
    flushBackfillChunksImpl: flush.impl,
    listTranscripts: () => [transcript('s1'), transcript('s2')],
  });

  const result = await runAudit(deps, { dryRun: true });

  assert.equal(flush.calls.length, 0);
  assert.deepEqual(events, []);
  assert.deepEqual(saved, []);
  assert.equal(result.plannedReports, 2);
  assert.equal(result.plannedChunks, 1);
  assert.equal(result.ok, true);
  assert.equal(result.finalized, false);
});

test('35. a session that yields no reports is not sent', async () => {
  const flush = fakeFlush();
  const { deps } = makeDeps({
    flushBackfillChunksImpl: flush.impl,
    runCheckpointImpl: async () => ({ enqueued: 0, flush: null, sessionErrors: [] }),
  });

  const result = await runAudit(deps, {});

  assert.equal(flush.calls.length, 0);
  assert.equal(result.sessionsImported, 0);
  assert.equal(result.ok, true);
});

// ─── shouldFinalize truth table ─────────────────────────────────────────────

test('36. shouldFinalize truth table', () => {
  const clean = {
    ok: true,
    halt: null,
    reportsFailed: 0,
    unattributed: 0,
    permanentRejections: 0,
  };
  assert.equal(shouldFinalize(clean, {}), true);
  assert.equal(shouldFinalize({ ...clean, ok: false }, {}), false);
  assert.equal(shouldFinalize({ ...clean, halt: BackfillHalt.NOT_ALLOWED }, {}), false);
  assert.equal(shouldFinalize({ ...clean, reportsFailed: 1 }, {}), false);
  assert.equal(shouldFinalize({ ...clean, unattributed: 1 }, {}), false);
  assert.equal(shouldFinalize({ ...clean, permanentRejections: 1 }, {}), false);
  assert.equal(shouldFinalize(clean, { sinceMs: 123 }), false);
  assert.equal(shouldFinalize(clean, { dryRun: true }), false);
});

// ─── the backfill path carries advisor legs ─────────────────────────────────
//
// /beezi:login's history pull and /beezi:sync both run the REAL runCheckpoint (session-audit
// only overrides it in unit tests), so they inherit whatever delta.mjs reads. This drives the
// audit end to end over a transcript on disk — no runCheckpointImpl double — and asserts the
// advisor leg inside `usage.iterations` reaches the payload handed to the flush.

function advisorTranscript(dir) {
  const line = {
    type: 'assistant',
    gitBranch: 'main',
    cwd: dir,
    timestamp: '2024-01-01T10:00:00.000Z',
    effort: 'high',
    message: {
      id: 'msg_adv',
      model: 'model-a',
      usage: {
        input_tokens: 4,
        output_tokens: 60,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 100,
        iterations: [
          { type: 'message', input_tokens: 4, output_tokens: 60, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100 },
          { type: 'advisor_message', model: 'advisor-b', input_tokens: 61696, output_tokens: 4008, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        ],
      },
    },
  };
  const p = path.join(dir, 'sess-adv.jsonl');
  fs.writeFileSync(p, JSON.stringify(line), 'utf-8');
  return p;
}

test('backfill — the audit path uploads advisor_message tokens, not just top-level usage', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-adv-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const prevHome = process.env.BEEZI_HOME;
  process.env.BEEZI_HOME = dir;
  t.after(() => {
    if (prevHome === undefined) delete process.env.BEEZI_HOME;
    else process.env.BEEZI_HOME = prevHome;
  });

  const transcriptPath = advisorTranscript(dir);

  let captured = null;
  // `undefined` deliberately: makeDeps spreads overrides last, and session-audit resolves the
  // impl with `== null`, so this hands the run the real runCheckpoint.
  const { deps } = makeDeps({
    runCheckpointImpl: undefined,
    listTranscripts: () => [{ sessionId: 'sess-adv', transcriptPath, projectDir: dir, mtimeMs: 1000, size: 256 }],
    firstRecordedCwd: () => dir,
    flushBackfillChunksImpl: async (groups) => {
      captured = groups;
      const bySession = new Map(
        groups.map((g) => [g.sessionId, { status: BackfillSessionStatus.ACCEPTED, reason: null }]),
      );
      return flushResult({ stored: groups.length, bySession });
    },
  });

  await runAudit(deps, {});

  assert.ok(captured != null && captured.length > 0, 'the audit reached the flush with a group');
  const reports = captured[0].reports;
  assert.equal(reports.length, 1, 'one segment for the one-line transcript');
  const models = reports[0].models;

  assert.ok(models['advisor-b'], 'the advisor leg reaches the uploaded payload');
  assert.equal(models['advisor-b'].token_input, 61696);
  assert.equal(models['advisor-b'].token_output, 4008);
  assert.equal(models['advisor-b'].requests, 1);
  assert.equal(models['advisor-b'].by_effort.high.token_input, 61696);

  assert.equal(models['model-a'].token_input, 4, 'the parent tally still comes off top-level usage');
  assert.equal(models['model-a'].token_output, 60);
});
