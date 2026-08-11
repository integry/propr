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

test('Connect authorization URL carries the exact callback and CSRF state', () => {
  const url = new URL(buildConnectAuthorizationUrl({
    callbackUrl: 'https://t-abc.propr.dev/api/auth/github/callback',
    state: 'random-state',
  }));
  assert.equal(url.origin, 'https://connect.propr.dev');
  assert.equal(url.pathname, '/instance-login');
  assert.equal(url.searchParams.get('callback_url'), 'https://t-abc.propr.dev/api/auth/github/callback');
  assert.equal(url.searchParams.get('state'), 'random-state');
});

test('redeems a Connect code server-to-server without exposing the relay token in the body', async () => {
  let request: Request | undefined;
  const user = await redeemConnectAuthorizationCode({
    code: 'pia_code',
    relayUrl: 'https://webhook.propr.dev/v1',
    relayToken: 'prt_relay_secret',
    fetchImpl: (async (input, init) => {
      request = new Request(input, init);
      return Response.json({
        username: 'octocat',
        avatar_url: 'https://avatar.test/1',
        access_token: 'gho_user_secret',
      });
    }) as typeof fetch,
  });

  assert.equal(request?.url, 'https://webhook.propr.dev/v1/auth/instance-grants/redeem');
  assert.equal(request?.headers.get('authorization'), 'Bearer prt_relay_secret');
  assert.deepEqual(JSON.parse(await request!.text()), { code: 'pia_code' });
  assert.equal(user.username, 'octocat');
  assert.equal(user.accessToken, 'gho_user_secret');
});
