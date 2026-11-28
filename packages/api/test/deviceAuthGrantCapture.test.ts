/**
 * Device sign-in (#3867): the credential a device sign-in captures is the
 * durable grant desktop, MCP and agent runs use. GitHub hands its refresh
 * token to this instance, not to the relay, so the grant must renew by
 * sending that refresh token to the relay (`/auth/instance-grants/refresh`),
 * never by relay-held renewal (`/instance-auth/renew`), which names only the
 * user and works only for credentials the relay issued itself. Run with:
 * `NODE_ENV=test npx tsx --test packages/api/test/deviceAuthGrantCapture.test.ts`
 */
import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, test } from 'node:test';
import knex, { type Knex } from 'knex';
import { closeConnection } from '@propr/core';
import { up as createGitHubUserGrants } from '../../core/src/db/migrations/20260908000000_create_github_user_grants.js';
import { up as addGitHubOAuthGrantRevision } from '../../core/src/db/migrations/20260908010000_add_github_oauth_grant_revision.js';
import { up as addRelayRenewal } from '../../core/src/db/migrations/20261029180000_add_github_user_grant_relay_renewal.js';
import type { GitHubUser } from '../authTypes.js';
import { isRelayRenewable, type RenewableGrantRow } from '../connectGrantRenewer.js';
import { GitHubUserGrantService } from '../githubUserGrantService.js';
import { ACCESS_TOKEN, Browser, REFRESH_TOKEN, startHarness } from './deviceAuthHarness.js';

const RELAY = 'https://relay.example.test/v1';
const environment = { SESSION_SECRET: 'device-grant-capture-secret', PROPR_GH_RELAY_URL: RELAY, PROPR_GH_RELAY_TOKEN: 'prt_relay' };
const USER_ID = '583231';
const RENEWED_ACCESS = 'ghu_renewed_device_access_token';
const RENEWED_REFRESH = 'ghr_renewed_device_refresh_token';

interface RelayCall { url: string; authorization: string | null; body: unknown }
let database: Knex;
let service: GitHubUserGrantService;
let relayCalls: RelayCall[];

/** The relay: refreshes a presented refresh token; relay-held renewal knows no device grant. */
const relayFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  relayCalls.push({ url: request.url, authorization: request.headers.get('authorization'), body: await request.json() });
  if (request.url === `${RELAY}/auth/instance-grants/refresh`) {
    return Response.json({ access_token: RENEWED_ACCESS, refresh_token: RENEWED_REFRESH, expires_in: 28_800, refresh_token_expires_in: 15_897_600 });
  }
  if (request.url === `${RELAY}/instance-auth/renew`) return Response.json({ error: 'renewal_unavailable' }, { status: 409 });
  throw new Error(`Unexpected relay URL ${request.url}`);
};

beforeEach(async () => {
  database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await createGitHubUserGrants(database);
  await addGitHubOAuthGrantRevision(database);
  await addRelayRenewal(database);
  relayCalls = [];
  service = new GitHubUserGrantService(database, environment, relayFetch);
});

afterEach(async () => {
  await database.destroy();
});

after(async () => {
  await closeConnection();
});

type GrantRow = RenewableGrantRow & { refresh_token_encrypted: string | null };

async function signIn(tokenAnswer: Record<string, unknown>): Promise<GrantRow> {
  const harness = await startHarness({}, async req => {
    await service.capture(req.user as GitHubUser);
  });
  // Real time, so the captured expiry is the one the grant service renews against.
  harness.clock.now = Date.now();
  const browser = new Browser(harness.origin);
  try {
    const start = await browser.post('/api/auth/device/start');
    harness.clock.now += 5_000;
    harness.github.tokenAnswers.push(tokenAnswer);
    const done = await browser.post('/api/auth/device/poll', { attempt: start.body.attempt });
    assert.deepEqual(done.body, { status: 'complete' }, done.text);
  } finally {
    await harness.close();
  }
  const row = await database('github_user_grants').where({ github_user_id: USER_ID }).first() as GrantRow | undefined;
  assert.ok(row, 'the sign-in captured a durable grant');
  return row;
}

/** An answer whose access token is already inside the renewal window. */
const nearlyExpired = { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_in: 120, refresh_token_expires_in: 15_897_600 };

function assertRenewedWithDeviceRefreshToken(): void {
  assert.equal(relayCalls.some(call => call.url === `${RELAY}/instance-auth/renew`), false, 'relay-held renewal is never asked for a device grant');
  assert.deepEqual(relayCalls, [{
    url: `${RELAY}/auth/instance-grants/refresh`,
    authorization: 'Bearer prt_relay',
    body: { refresh_token: REFRESH_TOKEN },
  }]);
}

test('device sign-in: the captured grant keeps its refresh token and is not relay-held', async () => {
  const row = await signIn({ access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_in: 28_800, refresh_token_expires_in: 15_897_600 });
  assert.equal(row.source, 'connect');
  assert.equal(row.renewal, null);
  assert.equal(isRelayRenewable(row), false);
  assert.ok(row.refresh_token_encrypted, 'the refresh token is stored (encrypted) for renewal');
  assert.equal(relayCalls.length, 0);
});

test('device sign-in: a device-only user renews by sending its refresh token to the relay', async () => {
  await signIn(nearlyExpired);
  const resolved = await service.resolve(USER_ID);
  assertRenewedWithDeviceRefreshToken();
  assert.equal(resolved.status, 'active');
  assert.equal(resolved.status === 'active' && resolved.accessToken, RENEWED_ACCESS);
  assert.equal(resolved.status === 'active' && resolved.refreshToken, RENEWED_REFRESH);
  const row = await database('github_user_grants').where({ github_user_id: USER_ID }).first() as GrantRow;
  assert.equal(row.status, 'active');
  assert.equal(row.renewal, null);
  // The rotated refresh token is what the next renewal sends.
  relayCalls = [];
  await database('github_user_grants').where({ github_user_id: USER_ID }).update({ access_token_expires_at_ms: Date.now() + 60_000 });
  const again = await service.resolve(USER_ID);
  assert.equal(again.status, 'active');
  assert.deepEqual(relayCalls.map(call => call.body), [{ refresh_token: RENEWED_REFRESH }]);
});

test('device sign-in: replacing a relay-held Connect grant switches it to refresh-token renewal', async () => {
  await service.capture({
    id: USER_ID, login: 'octocat', username: 'octocat', displayName: 'octocat', email: null, avatarUrl: null,
    accessToken: 'ghu_older_connect_token', refreshToken: 'ghr_older_connect_refresh', tokenExpiresAt: Date.now() + 60_000,
    oauthSource: 'connect', connectRenewal: 'relay',
  });
  const row = await signIn(nearlyExpired);
  assert.equal(row.renewal, null);
  assert.equal(isRelayRenewable(row), false);
  const resolved = await service.resolve(USER_ID);
  assertRenewedWithDeviceRefreshToken();
  assert.equal(resolved.status === 'active' && resolved.accessToken, RENEWED_ACCESS);
});

test('device sign-in: a non-expiring token without a refresh token is not renewed', async () => {
  const row = await signIn({ access_token: ACCESS_TOKEN });
  assert.equal(row.source, 'connect');
  assert.equal(row.renewal, null);
  assert.equal(row.access_token_expires_at_ms, null);
  const resolved = await service.resolve(USER_ID);
  assert.equal(resolved.status === 'active' && resolved.accessToken, ACCESS_TOKEN);
  assert.equal(relayCalls.length, 0);
});
