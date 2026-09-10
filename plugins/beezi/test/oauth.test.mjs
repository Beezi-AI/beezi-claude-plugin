import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discover, registerClient, pkcePair, exchangeCode, refreshTokens } from '../lib/oauth.mjs';
import { OAUTH_SCOPES } from '../lib/config.mjs';

const jsonRes = (body, status = 200) => ({
  ok: status < 400, status,
  json: async () => body,
});

test('pkcePair returns base64url verifier and S256 challenge', () => {
  const { verifier, challenge } = pkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(verifier, challenge);
});

test('discover chains protected-resource → authorization-server metadata', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/.well-known/oauth-protected-resource')) {
      return jsonRes({ authorization_servers: ['https://clerk.example.com'] });
    }
    return jsonRes({
      authorization_endpoint: 'https://clerk.example.com/oauth/authorize',
      token_endpoint: 'https://clerk.example.com/oauth/token',
      registration_endpoint: 'https://clerk.example.com/oauth/register',
    });
  };
  const meta = await discover({ fetchImpl, origin: 'https://api.example.com' });
  assert.equal(calls[0], 'https://api.example.com/.well-known/oauth-protected-resource');
  assert.equal(calls[1], 'https://clerk.example.com/.well-known/oauth-authorization-server');
  assert.equal(meta.authorizationEndpoint, 'https://clerk.example.com/oauth/authorize');
  assert.equal(meta.tokenEndpoint, 'https://clerk.example.com/oauth/token');
  assert.equal(meta.registrationEndpoint, 'https://clerk.example.com/oauth/register');
});

test('discover throws a friendly error when the portal has no OAuth metadata', async () => {
  const fetchImpl = async () => jsonRes({}, 404);
  await assert.rejects(
    discover({ fetchImpl, origin: 'https://api.example.com' }),
    /OAuth discovery failed/,
  );
});

test('registerClient POSTs DCR metadata and returns client_id', async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    sent = JSON.parse(init.body);
    return jsonRes({ client_id: 'cid_123' }, 201);
  };
  const id = await registerClient('https://clerk.example.com/oauth/register',
    'http://127.0.0.1:49152/callback', { fetchImpl, hostname: 'my-mac' });
  assert.equal(id, 'cid_123');
  assert.equal(sent.client_name, 'Beezi Claude Code plugin — my-mac');
  assert.deepEqual(sent.redirect_uris, ['http://127.0.0.1:49152/callback']);
  assert.equal(sent.token_endpoint_auth_method, 'none');
  assert.deepEqual(sent.grant_types, ['authorization_code', 'refresh_token']);
});

test('exchangeCode posts urlencoded grant and returns tokens', async () => {
  let sentBody;
  const fetchImpl = async (url, init) => {
    sentBody = new URLSearchParams(init.body);
    return jsonRes({ access_token: 'at', refresh_token: 'rt', expires_in: 86400 });
  };
  const tokens = await exchangeCode({
    tokenEndpoint: 'https://clerk.example.com/oauth/token',
    clientId: 'cid', redirectUri: 'http://127.0.0.1:1/callback', code: 'c', verifier: 'v',
  }, { fetchImpl });
  assert.equal(tokens.access_token, 'at');
  assert.equal(sentBody.get('grant_type'), 'authorization_code');
  assert.equal(sentBody.get('code_verifier'), 'v');
  assert.equal(sentBody.get('client_id'), 'cid');
  assert.equal(sentBody.get('redirect_uri'), 'http://127.0.0.1:1/callback');
});

test('refreshTokens flags invalid_grant', async () => {
  const fetchImpl = async () => jsonRes({ error: 'invalid_grant' }, 400);
  const r = await refreshTokens(
    { tokenEndpoint: 'https://x/oauth/token', clientId: 'cid', refreshToken: 'rt' },
    { fetchImpl },
  );
  assert.equal(r.invalidGrant, true);
});

test('refreshTokens returns null tokens on network failure', async () => {
  const fetchImpl = async () => { throw new Error('offline'); };
  const r = await refreshTokens(
    { tokenEndpoint: 'https://x/oauth/token', clientId: 'cid', refreshToken: 'rt' },
    { fetchImpl },
  );
  assert.equal(r.tokens, null);
  assert.ok(!r.invalidGrant);
});

// Regression for finding 5 (docs/oauth-session-investigation/reproduce.mjs): the refresh deadline
// used to end at response headers, so a body that streamed past it still succeeded.
test('the refresh deadline covers body consumption, not just the headers', async () => {
  let signal;
  let releaseBody;
  const bodyGate = new Promise((resolve) => { releaseBody = resolve; });
  const r = await refreshTokens(
    { tokenEndpoint: 'https://x/oauth/token', clientId: 'cid', refreshToken: 'rt' },
    {
      timeoutMs: 5,
      fetchImpl: async (_url, init) => {
        signal = init.signal;
        // Headers are here; the body only settles once the deadline has already fired.
        return { ok: true, status: 200, json: () => bodyGate.then(() => ({ access_token: 'at' })) };
      },
    },
  );
  assert.equal(signal.aborted, true);
  assert.equal(r.tokens, null);
  assert.equal(r.failure, 'timeout');
  releaseBody();
});

test('refreshTokens classifies a transport failure as network and a 5xx as server', async () => {
  const grant = { tokenEndpoint: 'https://x/oauth/token', clientId: 'cid', refreshToken: 'rt' };
  const offline = await refreshTokens(grant, { fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(offline.failure, 'network');
  const boom = await refreshTokens(grant, { fetchImpl: async () => jsonRes({}, 502) });
  assert.equal(boom.failure, 'server');
  const unparseable = await refreshTokens(grant, {
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => { throw new SyntaxError('nope'); } }),
  });
  assert.equal(unparseable.failure, 'server');
  assert.ok(!unparseable.invalidGrant);
});

// A 400/401 whose `error` is not a named revocation reads the body and then falls through to the
// drain. On the compatibility transport the stream has already ended, so a second read attaches
// an `end` listener that never fires, and the deadline that could have aborted it was cleared by
// the first read — the refresh would hang until the worker's 30s budget while holding the
// namespace lock. This models a real once-only body rather than a fake with no `.text`.
test('a 400 with a non-revocation error settles instead of hanging on the drain', { timeout: 5000 }, async () => {
  let reads = 0;
  const onceOnlyBody = (payload) => ({
    ok: false,
    status: 400,
    json: async () => {
      reads += 1;
      if (reads > 1) return new Promise(() => {}); // a consumed stream never emits `end` again
      return payload;
    },
    text: async () => {
      reads += 1;
      if (reads > 1) return new Promise(() => {});
      return JSON.stringify(payload);
    },
  });
  const r = await refreshTokens(
    { tokenEndpoint: 'https://x/oauth/token', clientId: 'cid', refreshToken: 'rt' },
    { timeoutMs: 50_000, fetchImpl: async () => onceOnlyBody({ error: 'invalid_request' }) },
  );
  assert.equal(r.failure, 'server');
  assert.ok(!r.invalidGrant);
  assert.equal(reads, 1, 'the body is read once; the drain is a no-op afterwards');
});

test('refreshTokens refuses to submit a missing refresh token', async () => {
  for (const refreshToken of [undefined, null, '', 'undefined']) {
    const r = await refreshTokens(
      { tokenEndpoint: 'https://x/oauth/token', clientId: 'cid', refreshToken },
      { fetchImpl: async () => { throw new Error('must not be called'); } },
    );
    assert.equal(r.failure, 'missing_refresh_token');
    assert.equal(r.tokens, null);
  }
});

test('refreshTokens names the rejected grant error', async () => {
  const r = await refreshTokens(
    { tokenEndpoint: 'https://x/oauth/token', clientId: 'cid', refreshToken: 'rt' },
    { fetchImpl: async () => jsonRes({ error: 'invalid_client' }, 401) },
  );
  assert.equal(r.invalidGrant, true);
  assert.equal(r.error, 'invalid_client');
});

test('registration and authorization both request offline_access', async () => {
  let sent;
  await registerClient('https://clerk.example.com/oauth/register', 'http://127.0.0.1:1/callback', {
    fetchImpl: async (_url, init) => { sent = JSON.parse(init.body); return jsonRes({ client_id: 'cid' }, 201); },
    hostname: 'my-mac',
  });
  assert.match(sent.scope, /\boffline_access\b/);
  assert.equal(sent.scope, OAUTH_SCOPES);
  assert.match(OAUTH_SCOPES, /\boffline_access\b/);
});

test('discover exposes the revocation endpoint, defaulting beside the token endpoint', async () => {
  const meta = async (extra) => discover({
    origin: 'https://api.example.com',
    fetchImpl: async (url) => (String(url).endsWith('/.well-known/oauth-protected-resource')
      ? jsonRes({ authorization_servers: ['https://clerk.example.com'] })
      : jsonRes({
        authorization_endpoint: 'https://clerk.example.com/oauth/authorize',
        token_endpoint: 'https://clerk.example.com/oauth/token',
        registration_endpoint: 'https://clerk.example.com/oauth/register',
        ...extra,
      })),
  });
  const advertised = await meta({ revocation_endpoint: 'https://clerk.example.com/oauth/revoke_me' });
  assert.equal(advertised.revocationEndpoint, 'https://clerk.example.com/oauth/revoke_me');
  const defaulted = await meta({});
  assert.equal(defaulted.revocationEndpoint, 'https://clerk.example.com/oauth/token/revoke');
});
