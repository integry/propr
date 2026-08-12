import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildConnectAuthorizationUrl,
  redeemConnectAuthorizationCode,
  resolveBrowserAuthMode,
} from '../connectAuth.js';

test('relay tunnel mode uses Connect without local OAuth credentials', () => {
  assert.equal(resolveBrowserAuthMode({
    PROPR_UI_TUNNEL_ENABLED: 'true',
    PROPR_GH_RELAY_URL: 'https://webhook.propr.dev/v1',
    PROPR_GH_RELAY_TOKEN: 'prt_secret',
  }), 'connect');
});

test('local relay mode uses Connect without a per-instance OAuth App', () => {
  assert.equal(resolveBrowserAuthMode({
    PROPR_UI_TUNNEL_ENABLED: 'false',
    PROPR_GH_RELAY_URL: 'https://webhook.propr.dev/v1',
    PROPR_GH_RELAY_TOKEN: 'prt_secret',
    GH_OAUTH_CALLBACK_URL: 'http://localhost:4000/api/auth/github/callback',
  }), 'connect');
});

test('off-tunnel relay inference rejects callbacks outside the exact loopback allowlist', () => {
  for (const callbackUrl of [
    'https://api.example.com/api/auth/github/callback',
    'https://localhost:4000/api/auth/github/callback',
    'http://127.0.0.2:4000/api/auth/github/callback',
    'http://localhost:4000/not-the-auth-callback',
  ]) {
    assert.equal(resolveBrowserAuthMode({
      PROPR_UI_TUNNEL_ENABLED: 'false',
      PROPR_GH_RELAY_URL: 'https://webhook.propr.dev/v1',
      PROPR_GH_RELAY_TOKEN: 'prt_secret',
      GH_OAUTH_CALLBACK_URL: callbackUrl,
    }), 'disabled', callbackUrl);
  }
});

test('off-tunnel custom relay enrollment does not infer hosted Connect auth', () => {
  assert.equal(resolveBrowserAuthMode({
    PROPR_UI_TUNNEL_ENABLED: 'false',
    PROPR_GH_RELAY_URL: 'https://relay.example.com/v1',
    PROPR_GH_RELAY_TOKEN: 'prt_secret',
    GH_OAUTH_CALLBACK_URL: 'http://localhost:4000/api/auth/github/callback',
  }), 'disabled');
});

test('literal example OAuth placeholders do not enable GitHub web auth', () => {
  assert.equal(resolveBrowserAuthMode({
    GH_OAUTH_CLIENT_ID: 'your_github_oauth_client_id',
    GH_OAUTH_CLIENT_SECRET: 'your_github_oauth_client_secret',
  }), 'disabled');
});

test('explicit custom GitHub web auth remains supported', () => {
  assert.equal(resolveBrowserAuthMode({
    GH_OAUTH_CLIENT_ID: 'real-client-id',
    GH_OAUTH_CLIENT_SECRET: 'real-client-secret',
  }), 'github');
});

test('explicit custom GitHub web auth wins over relay inference off-tunnel', () => {
  assert.equal(resolveBrowserAuthMode({
    PROPR_GH_RELAY_URL: 'https://webhook.propr.dev/v1',
    PROPR_GH_RELAY_TOKEN: 'prt_secret',
    GH_OAUTH_CLIENT_ID: 'real-client-id',
    GH_OAUTH_CLIENT_SECRET: 'real-client-secret',
  }), 'github');
});

test('Connect authorization URL carries the exact callback and CSRF state', () => {
  const url = new URL(buildConnectAuthorizationUrl({
    callbackUrl: 'https://t-abc.propr.dev/api/auth/github/callback',
    state: 'random-state',
    installationId: '123',
  }));
  assert.equal(url.origin, 'https://connect.propr.dev');
  assert.equal(url.pathname, '/instance-login');
  assert.equal(url.searchParams.get('callback_url'), 'https://t-abc.propr.dev/api/auth/github/callback');
  assert.equal(url.searchParams.get('state'), 'random-state');
  assert.equal(url.searchParams.get('installation_id'), '123');
});

test('redeems a Connect code server-to-server without exposing the relay token in the body', async () => {
  let relayRequest: Request | undefined;
  let githubRequest: Request | undefined;
  const user = await redeemConnectAuthorizationCode({
    code: 'pia_code',
    relayUrl: 'https://webhook.propr.dev/v1',
    relayToken: 'prt_relay_secret',
    fetchImpl: (async (input, init) => {
      const request = new Request(input, init);
      if (request.url === 'https://api.github.com/user') {
        githubRequest = request;
        return Response.json({ id: 583231, login: 'octocat' });
      }
      relayRequest = request;
      return Response.json({
        username: 'octocat',
        avatar_url: 'https://avatar.test/1',
        access_token: 'gho_user_secret',
      });
    }) as typeof fetch,
  });

  assert.equal(relayRequest?.url, 'https://webhook.propr.dev/v1/auth/instance-grants/redeem');
  assert.equal(relayRequest?.headers.get('authorization'), 'Bearer prt_relay_secret');
  assert.deepEqual(JSON.parse(await relayRequest!.text()), { code: 'pia_code' });
  assert.equal(githubRequest?.headers.get('authorization'), 'Bearer gho_user_secret');
  assert.equal(user.id, '583231');
  assert.equal(user.username, 'octocat');
  assert.equal(user.accessToken, 'gho_user_secret');
});

test('binds the Connect identity username to the validated token owner', async () => {
  const user = await redeemConnectAuthorizationCode({
    code: 'pia_code',
    relayUrl: 'https://webhook.propr.dev/v1',
    relayToken: 'prt_relay_secret',
    fetchImpl: (async (input) => {
      if (String(input) === 'https://api.github.com/user') {
        return Response.json({ id: 583231, login: 'verified-owner' });
      }
      return Response.json({
        username: 'different-relay-user',
        avatar_url: null,
        access_token: 'gho_user_secret',
      });
    }) as typeof fetch,
  });

  assert.equal(user.login, 'verified-owner');
  assert.equal(user.username, 'verified-owner');
  assert.equal(user.displayName, 'verified-owner');
});
