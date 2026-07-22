import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBridge, mcpUrl } from '../lib/mcp-bridge.mjs';

const URL_UNDER_TEST = 'https://api.test/api/mcp';

// Each entry in `responses` answers one fetch, in order; an Error entry rejects.
function bridgeWith({ responses = [], token = 'tok' } = {}) {
  const calls = [];
  const out = [];
  const bridge = createBridge({
    url: URL_UNDER_TEST,
    getAccessToken: async () => token,
    fetchImpl: async (url, init) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    write: (line) => out.push(JSON.parse(line)),
    logError: () => {},
    timeoutMs: 1000,
  });
  return { bridge, calls, out };
}

function jsonRes(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function sseRes(messages, { headers = {} } = {}) {
  const body = messages.map((m) => `event: message\ndata: ${JSON.stringify(m)}\n\n`).join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', ...headers },
  });
}

const INIT = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } };
const INIT_RESULT = { jsonrpc: '2.0', id: 0, result: { capabilities: {} } };
const CALL = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'draft_ticket' } };
const CALL_RESULT = { jsonrpc: '2.0', id: 1, result: { content: [] } };

test('mcpUrl honors BEEZI_MCP_URL over the API base', (t) => {
  const prev = process.env.BEEZI_MCP_URL;
  process.env.BEEZI_MCP_URL = 'https://elsewhere/mcp';
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_MCP_URL;
    else process.env.BEEZI_MCP_URL = prev;
  });
  assert.equal(mcpUrl(), 'https://elsewhere/mcp');
});

test('not linked: requests get a /beezi:login error, notifications are dropped', async () => {
  const { bridge, calls, out } = bridgeWith({ token: null });
  await bridge.handleMessage(CALL);
  await bridge.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(calls.length, 0);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 1);
  assert.match(out[0].error.message, /\/beezi:login/);
});

test('forwards with bearer auth and machine identity headers', async () => {
  const { bridge, calls, out } = bridgeWith({ responses: [jsonRes(CALL_RESULT)] });
  await bridge.handleMessage(CALL);
  assert.equal(calls[0].url, URL_UNDER_TEST);
  assert.equal(calls[0].headers.Authorization, 'Bearer tok');
  assert.ok(calls[0].headers['X-Beezi-Host']);
  assert.equal(calls[0].headers['mcp-session-id'], undefined);
  assert.deepEqual(out, [CALL_RESULT]);
});

test('captures the session id from initialize and sends it on later requests', async () => {
  const { bridge, calls, out } = bridgeWith({
    responses: [sseRes([INIT_RESULT], { headers: { 'mcp-session-id': 's1' } }), jsonRes(CALL_RESULT)],
  });
  await bridge.handleMessage(INIT);
  await bridge.handleMessage(CALL);
  assert.deepEqual(out, [INIT_RESULT, CALL_RESULT]);
  assert.equal(calls[1].headers['mcp-session-id'], 's1');
});

test('writes every message of an SSE response', async () => {
  const notification = { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } };
  const { bridge, out } = bridgeWith({ responses: [sseRes([notification, CALL_RESULT])] });
  await bridge.handleMessage(CALL);
  assert.deepEqual(out, [notification, CALL_RESULT]);
});

test('202 for a notification writes nothing', async () => {
  const { bridge, out } = bridgeWith({ responses: [new Response(null, { status: 202 })] });
  await bridge.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(out.length, 0);
});

test('lost session: re-initializes transparently and retries the request', async () => {
  const { bridge, calls, out } = bridgeWith({
    responses: [
      sseRes([INIT_RESULT], { headers: { 'mcp-session-id': 's1' } }),
      jsonRes({ jsonrpc: '2.0', error: { code: -32004, message: 'session not found' }, id: null }, { status: 404 }),
      sseRes([INIT_RESULT], { headers: { 'mcp-session-id': 's2' } }),
      new Response(null, { status: 202 }),
      jsonRes(CALL_RESULT),
    ],
  });
  await bridge.handleMessage(INIT);
  await bridge.handleMessage(CALL);
  // initialize, failed call, replayed initialize, initialized notification, retried call
  assert.equal(calls.length, 5);
  assert.equal(calls[2].body.method, 'initialize');
  assert.equal(calls[2].headers['mcp-session-id'], undefined);
  assert.equal(calls[3].body.method, 'notifications/initialized');
  assert.equal(calls[4].headers['mcp-session-id'], 's2');
  // the replayed initialize response stays hidden from the client
  assert.deepEqual(out, [INIT_RESULT, CALL_RESULT]);
});

test('401 surfaces a relink error', async () => {
  const { bridge, out } = bridgeWith({
    responses: [new Response(null, { status: 401 })],
  });
  await bridge.handleMessage(CALL);
  assert.equal(out.length, 1);
  assert.match(out[0].error.message, /\/beezi:login/);
});

test('server JSON-RPC error bodies pass their message through', async () => {
  const { bridge, out } = bridgeWith({
    responses: [jsonRes({ jsonrpc: '2.0', error: { code: -32005, message: 'session limit reached' }, id: null }, { status: 503 })],
  });
  await bridge.handleMessage(CALL);
  assert.match(out[0].error.message, /session limit reached/);
});

test('network failure produces an error response, not a crash', async () => {
  const { bridge, out } = bridgeWith({ responses: [new Error('socket hang up')] });
  await bridge.handleMessage(CALL);
  assert.equal(out[0].id, 1);
  assert.match(out[0].error.message, /socket hang up/);
});

test('handleLine drops non-JSON input without writing', async () => {
  const { bridge, calls, out } = bridgeWith();
  await bridge.handleLine('not json');
  await bridge.handleLine('   ');
  assert.equal(calls.length, 0);
  assert.equal(out.length, 0);
});
