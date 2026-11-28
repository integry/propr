/**
 * Device sign-in (#3867): the credential a device sign-in captures is the
 * durable grant desktop, MCP and agent runs use, and must stay renewable
 * through the relay like a renewable Connect sign-in. Run with:
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

const environment = { SESSION_SECRET: 'device-grant-capture-secret', PROPR_GH_RELAY_URL: 'https://relay.example.test/v1' };
let database: Knex;
let service: GitHubUserGrantService;

beforeEach(async () => {
  database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await createGitHubUserGrants(database);
  await addGitHubOAuthGrantRevision(database);
  await addRelayRenewal(database);
  service = new GitHubUserGrantService(database, environment);
});

afterEach(async () => {
  await database.destroy();
});

after(async () => {
  await closeConnection();
});

async function signIn(tokenAnswer: Record<string, unknown>): Promise<RenewableGrantRow> {
  const harness = await startHarness({}, async req => {
    await service.capture(req.user as GitHubUser);
  });
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
  const row = await database('github_user_grants').where({ github_user_id: '583231' }).first() as RenewableGrantRow | undefined;
  assert.ok(row, 'the sign-in captured a durable grant');
  return row;
}

test('device sign-in: the captured grant is renewable through the relay', async () => {
  const row = await signIn({ access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_in: 28_800, refresh_token_expires_in: 15_897_600 });
  assert.equal(row.source, 'connect');
  assert.equal(row.renewal, 'relay');
  assert.equal(isRelayRenewable(row), true);
});

test('device sign-in: replacing an existing renewable grant keeps it renewable', async () => {
  await service.capture({
    id: '583231', login: 'octocat', username: 'octocat', displayName: 'octocat', email: null, avatarUrl: null,
    accessToken: 'ghu_older_connect_token', refreshToken: 'ghr_older_connect_refresh', tokenExpiresAt: Date.now() + 60_000,
    oauthSource: 'connect', connectRenewal: 'relay',
  });
  const row = await signIn({ access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_in: 28_800 });
  assert.equal(row.renewal, 'relay');
  assert.equal(isRelayRenewable(row), true);
});

test('device sign-in: a non-expiring token without a refresh token is not marked for renewal', async () => {
  const row = await signIn({ access_token: ACCESS_TOKEN });
  assert.equal(row.source, 'connect');
  assert.equal(row.renewal, null);
  assert.equal(row.access_token_expires_at_ms, null);
});
