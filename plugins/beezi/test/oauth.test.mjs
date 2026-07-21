import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discover, registerClient, pkcePair, exchangeCode, refreshTokens } from '../lib/oauth.mjs';

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
