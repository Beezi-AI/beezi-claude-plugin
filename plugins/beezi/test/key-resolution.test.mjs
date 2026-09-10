import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  fetchKeyResolution,
  submitKeyPlan,
  submitKeyLink,
  formatLinkOutcome,
} from '../lib/key-resolution.mjs';

// This module keeps no cache file, but postJson spreads machineHeaders(), which can read/write the
// machine client id under BEEZI_HOME. A stubbed fetchImpl alone does not guarantee we are off disk.
async function withTempHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-keyres-'));
  const prev = process.env.BEEZI_HOME;
  process.env.BEEZI_HOME = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.BEEZI_HOME; else process.env.BEEZI_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const TOKEN = `sk-ant-oat01-${'y'.repeat(40)}`;
const MIDDLE = TOKEN.slice(12, -4);
const envWithToken = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN };
const FINGERPRINT = { prefix: 'sk-ant-oat01', last4: 'yyyy', length: TOKEN.length };

const respond = (body, status = 200) => async () => ({ status, json: async () => body });

const PAYLOAD = {
  status: 'unlinked',
  accountId: 'acc_1',
  subscriptionPlan: null,
  planSource: null,
  selectablePlans: [{ plan: 'max_20x', label: 'Max 20x', monthlyUsd: 200 }],
  subscriptions: [{ target: 'a@b.com', label: 'Team', plan: 'max_5x' }],
};

test('no setup token means no question — nothing is sent', async () => {
  await withTempHome(async () => {
    let called = false;
    const fetchImpl = async () => { called = true; return { status: 200, json: async () => PAYLOAD }; };
    assert.equal(await fetchKeyResolution('tok', { env: {}, fetchImpl }), null);
    assert.equal((await submitKeyPlan('tok', 'max_20x', { env: {}, fetchImpl })).ok, false);
    assert.equal((await submitKeyLink('tok', 'a@b.com', { env: {}, fetchImpl })).ok, false);
    assert.equal(called, false);
  });
});

test('a setup token too short to fingerprint is not asked about', async () => {
  await withTempHome(async () => {
    let called = false;
    const deps = {
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01' },
      fetchImpl: async () => { called = true; return { status: 200, json: async () => PAYLOAD }; },
    };
    assert.equal(await fetchKeyResolution('tok', deps), null);
    assert.equal((await submitKeyPlan('tok', 'max_20x', deps)).ok, false);
    assert.equal(called, false);
  });
});

test('no Beezi token short-circuits the writes without a request', async () => {
  await withTempHome(async () => {
    let called = false;
    const deps = { env: envWithToken, fetchImpl: async () => { called = true; return { status: 200, json: async () => ({}) }; } };
    const plan = await submitKeyPlan(null, 'max_20x', deps);
    assert.equal(plan.ok, false);
    assert.match(plan.message, /\/beezi:login/);
    assert.equal(called, false);
  });
});

test('only the fingerprint travels — nested under key, and never the token itself', async () => {
  await withTempHome(async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body), headers: opts.headers });
      return { status: 200, json: async () => PAYLOAD };
    };
    await fetchKeyResolution('beezi-access-token', { env: envWithToken, fetchImpl });
    await submitKeyPlan('beezi-access-token', 'max_20x', { env: envWithToken, fetchImpl });
    await submitKeyLink('beezi-access-token', 'a@b.com', { env: envWithToken, fetchImpl });

    assert.deepEqual(calls[0].body, { key: FINGERPRINT });
    assert.deepEqual(calls[1].body, { key: FINGERPRINT, plan: 'max_20x' });
    assert.deepEqual(calls[2].body, { key: FINGERPRINT, target: 'a@b.com' });
    for (const call of calls) {
      assert.equal(JSON.stringify(call.body).includes(MIDDLE), false, 'the middle of the token must never leave the machine');
      assert.equal(JSON.stringify(call.headers).includes(MIDDLE), false, 'nor may it hide in a header');
      assert.match(call.url, /\/me\/cli-agent\/key-resolution/);
    }
  });
});

test('the payload is normalized and junk entries are dropped', async () => {
  await withTempHome(async () => {
    const payload = await fetchKeyResolution('tok', {
      env: envWithToken,
      fetchImpl: respond({
        status: 'unlinked',
        subscriptionPlan: 7,
        selectablePlans: [{ label: 'no plan field' }, { plan: 'max_5x' }, null],
        subscriptions: 'not an array',
      }),
    });
    assert.equal(payload.status, 'unlinked');
    assert.equal(payload.subscriptionPlan, null, 'a non-string plan is not a plan');
    assert.deepEqual(payload.selectablePlans, [{ plan: 'max_5x', label: 'max_5x', monthlyUsd: null }]);
    assert.deepEqual(payload.subscriptions, []);
    assert.deepEqual(payload.key, FINGERPRINT);
  });
});

test('an unrecognized status becomes null rather than being echoed as fact', async () => {
  await withTempHome(async () => {
    const payload = await fetchKeyResolution('tok', { env: envWithToken, fetchImpl: respond({ status: 'whatever' }) });
    assert.equal(payload.status, null);
  });
});

test('an unreachable portal answers null, not "unresolved"', async () => {
  await withTempHome(async () => {
    const payload = await fetchKeyResolution('tok', {
      env: envWithToken,
      fetchImpl: async () => { throw new Error('offline'); },
    });
    assert.equal(payload, null);
  });
});

test('an older server with no such route answers null', async () => {
  await withTempHome(async () => {
    assert.equal(await fetchKeyResolution('tok', { env: envWithToken, fetchImpl: respond({}, 404) }), null);
  });
});

test('a non-2xx surfaces the server’s own message, since the user acts on it', async () => {
  await withTempHome(async () => {
    const plan = await submitKeyPlan('tok', 'max_20x', {
      env: envWithToken,
      fetchImpl: respond({ message: 'That plan is not available on your subscription.' }, 400),
    });
    assert.deepEqual(plan, { ok: false, message: 'That plan is not available on your subscription.' });

    const link = await submitKeyLink('tok', 'a@b.com', {
      env: envWithToken,
      fetchImpl: respond({ error: 'No such subscription.' }, 409),
    });
    assert.deepEqual(link, { ok: false, message: 'No such subscription.' });
  });
});

test('a bad gateway with an unreadable body still reports the status, not a mystery', async () => {
  await withTempHome(async () => {
    const result = await submitKeyPlan('tok', 'max_20x', {
      env: envWithToken,
      fetchImpl: async () => ({ status: 502, json: async () => { throw new SyntaxError('Unexpected token <'); } }),
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /502/);
  });
});

test('a network throw is a clean failure, never an exception', async () => {
  await withTempHome(async () => {
    const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
    const plan = await submitKeyPlan('tok', 'max_20x', { env: envWithToken, fetchImpl });
    const link = await submitKeyLink('tok', 'a@b.com', { env: envWithToken, fetchImpl });
    assert.equal(plan.ok, false);
    assert.match(plan.message, /Could not reach the Beezi server/);
    assert.equal(link.ok, false);
  });
});

test('a plan write reports what the server stored', async () => {
  await withTempHome(async () => {
    const result = await submitKeyPlan('tok', 'max_20x', {
      env: envWithToken,
      fetchImpl: respond({ status: 'resolved', subscriptionPlan: 'max_20x', planSource: 'manual' }),
    });
    assert.deepEqual(result, { ok: true, subscriptionPlan: 'max_20x' });
  });
});

test('a plan write that echoes nothing back still reports the plan it wrote', async () => {
  await withTempHome(async () => {
    const result = await submitKeyPlan('tok', 'max_5x', { env: envWithToken, fetchImpl: respond({}) });
    assert.deepEqual(result, { ok: true, subscriptionPlan: 'max_5x' });
  });
});

test('linked and claimed are different outcomes and must read differently', async () => {
  await withTempHome(async () => {
    const linked = await submitKeyLink('tok', 'a@b.com', {
      env: envWithToken,
      fetchImpl: respond({ outcome: 'linked', targetAccountId: 'acc_1' }),
    });
    const claimed = await submitKeyLink('tok', 'nobody@b.com', {
      env: envWithToken,
      fetchImpl: respond({ outcome: 'claimed', targetAccountId: 'acc_2' }),
    });
    assert.equal(linked.outcome, 'linked');
    assert.equal(claimed.outcome, 'claimed');

    const linkedLine = formatLinkOutcome(linked);
    const claimedLine = formatLinkOutcome(claimed);
    assert.notEqual(linkedLine, claimedLine);
    assert.match(linkedLine, /existing subscription/);
    assert.match(claimedLine, /no existing subscription matched/);
    // "merged" describes an event that did not happen on the claimed path.
    assert.equal(/merge/i.test(claimedLine), false);
  });
});

// Neither outcome may be invented. Defaulting to 'linked' would be worse than defaulting to
// 'claimed': it is the stronger claim, asserting a merge that may never have happened.
test('an outcome the server did not name is reported as neither', async () => {
  await withTempHome(async () => {
    const result = await submitKeyLink('tok', 'a@b.com', { env: envWithToken, fetchImpl: respond({}) });
    assert.equal(result.ok, true);
    assert.equal(result.outcome, null);
    assert.equal(result.targetAccountId, null);

    const line = formatLinkOutcome(result);
    assert.match(line, /^✓/, 'the write did succeed, so it is not a failure line');
    assert.equal(/\/beezi:/.test(line), false, 'no command is named, since none is known to re-read this');
    assert.equal(/existing subscription/.test(line), false);
    assert.equal(/no existing subscription matched/.test(line), false);
  });
});

test('a silent 401 on a write points at /beezi:login instead of the status code', async () => {
  await withTempHome(async () => {
    const result = await submitKeyPlan('tok', 'max_20x', { env: envWithToken, fetchImpl: respond({}, 401) });
    assert.equal(result.ok, false);
    assert.match(result.message, /\/beezi:login/);
    assert.equal(/401/.test(result.message), false);
  });
});

// The server's own words outrank our fallback on EVERY status, 401 included: only it knows which
// rejection it made, and a re-link line would send the user to fix something that is not broken.
test('a 401 that carries a message surfaces the message, not the re-link line', async () => {
  await withTempHome(async () => {
    const result = await submitKeyLink('tok', 'a@b.com', {
      env: envWithToken,
      fetchImpl: respond({ message: 'That key belongs to another account.' }, 401),
    });
    assert.deepEqual(result, { ok: false, message: 'That key belongs to another account.' });
  });
});

test('formatLinkOutcome renders a failure as a ✗ line carrying the message', () => {
  assert.equal(formatLinkOutcome({ ok: false, message: 'Nope.' }), '✗ Nope.');
});
