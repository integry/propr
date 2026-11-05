import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, afterEach, beforeEach, test } from 'node:test';
import knex, { type Knex } from 'knex';
import { closeConnection } from '@propr/core';
import { up as mcpMigration } from '../../core/src/db/migrations/20260910220000_add_mcp.js';
import { up as lifecycleMigration } from '../../core/src/db/migrations/20261001000000_add_mcp_operation_lifecycle.js';
import { up as grantsMigration } from '../../core/src/db/migrations/20260908000000_create_github_user_grants.js';
import { up as grantRevisionMigration } from '../../core/src/db/migrations/20260908010000_add_github_oauth_grant_revision.js';
import { McpStore, digest } from '../mcp/store.js';
import { McpOAuthProvider } from '../mcp/oauth.js';
import { McpPolicy } from '../mcp/policy.js';
import { GitHubUserGrantService } from '../githubUserGrantService.js';
import { configureDemoMode } from '../demoMode.js';
import type { GitHubUser } from '../authTypes.js';

after(async () => closeConnection());

const OWNER = '123';
const environment = { SESSION_SECRET: 'fixture-session-secret', GH_OAUTH_CLIENT_ID: 'client', GH_OAUTH_CLIENT_SECRET: 'secret' };
const config = { origin: 'https://instance.example', resource: 'https://instance.example/api/mcp', instanceId: 'instance-1234567890', encryptionKey: randomBytes(32) };
const bearer = 'propr_mcp_fixture';

/**
 * GitHub's side of rotating user tokens: each refresh token works once, and
 * only the most recently issued access token is accepted.
 */
class FakeGitHub {
  refreshes = 0;
  validAccessToken = 'ghu_initial';
  unavailable = false;
  beforeVerify?: (token: string | undefined) => Promise<void>;
  private validRefreshToken = 'refresh-1';

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    if (request.url === 'https://api.github.com/user') {
      const token = request.headers.get('authorization')?.replace(/^(?:token|bearer) /i, '');
      await this.beforeVerify?.(token);
      if (token !== this.validAccessToken) return Response.json({ message: 'Bad credentials' }, { status: 401 });
      return Response.json({ id: Number(OWNER), login: 'tester' });
    }
    if (request.url !== 'https://github.com/login/oauth/access_token') throw new Error(`Unexpected URL ${request.url}`);
    if (this.unavailable) return new Response('unavailable', { status: 502 });
    const body = await request.json() as { refresh_token: string };
    await new Promise(resolve => setTimeout(resolve, 20));
    if (body.refresh_token !== this.validRefreshToken) return Response.json({ error: 'bad_refresh_token' });
    this.refreshes += 1;
    this.validAccessToken = `ghu_rotated_${this.refreshes}`;
    this.validRefreshToken = `refresh-${this.refreshes + 1}`;
    return Response.json({ access_token: this.validAccessToken, refresh_token: this.validRefreshToken, expires_in: 28_800, refresh_token_expires_in: 15_897_600 });
  };
}

let db: Knex;
let fake: FakeGitHub;
let grants: GitHubUserGrantService;
let store: McpStore;
let policy: McpPolicy;
let originalFetch: typeof fetch;
const originalEnv = { ...process.env };

const user = (overrides: Partial<GitHubUser> = {}): GitHubUser => ({
  id: OWNER, username: 'tester', login: 'tester', displayName: 'Test', email: null, avatarUrl: null, oauthSource: 'github',
  accessToken: 'ghu_initial', refreshToken: 'refresh-1', tokenExpiresAt: Date.now() + 3_600_000, refreshTokenExpiresAt: Date.now() + 86_400_000,
  ...overrides,
} as GitHubUser);

beforeEach(async () => {
  configureDemoMode(false);
  Object.assign(process.env, environment, { GITHUB_USER_WHITELIST: 'tester' });
  db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await db.schema.createTable('task_drafts', table => table.string('draft_id').primary());
  await mcpMigration(db);
  await lifecycleMigration(db); await grantsMigration(db); await grantRevisionMigration(db);
  await db.schema.createTable('instance_members', table => { table.string('github_user_id').primary(); table.string('role'); table.string('source'); });
  await db('instance_members').insert({ github_user_id: OWNER, role: 'member', source: 'local' });
  fake = new FakeGitHub();
  // Octokit (GET /user) and MCP's own refresh use the global fetch.
  originalFetch = globalThis.fetch;
  globalThis.fetch = fake.fetch as typeof fetch;
  grants = new GitHubUserGrantService(db, process.env, fake.fetch);
  store = new McpStore(db, config.encryptionKey);
  policy = new McpPolicy(new McpOAuthProvider(store, config), config, grants);
  await store.put('grant', 'grant-1', { id: 'grant-1', ownerId: OWNER, clientId: 'client-1', clientName: 'Test', instanceId: config.instanceId, resource: config.resource,
    scopes: ['read'], repositories: ['acme/repo'], createdAt: Date.now(), expiresAt: Date.now() + 86_400_000, revoked: false, membershipSource: 'local' });
  await store.put('access', digest(bearer), { grantId: 'grant-1', clientId: 'client-1', scopes: ['read'], expiresAt: Date.now() + 600_000 }, { expiresAt: Date.now() + 600_000 });
  // Signing in stores the same token pair for the browser and for MCP.
  await grants.capture(user());
  await store.put('credential', OWNER, user());
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  for (const key of [...Object.keys(environment), 'GITHUB_USER_WHITELIST']) {
    if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key];
  }
  await db.destroy();
});

const expireSharedGrant = () => db('github_user_grants').where({ github_user_id: OWNER }).update({ access_token_expires_at_ms: Date.now() - 1000 });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('MCP keeps working after the browser rotated the shared GitHub token pair', async () => {
  // The browser session refreshes first and spends refresh-1.
  assert.equal((await grants.resolve(OWNER, true)).status, 'active');
  assert.equal(fake.refreshes, 1);
  // MCP's copy still holds ghu_initial/refresh-1 and has expired: before the
  // fix, MCP refreshed it with the spent token and needed a new sign-in.
  await store.put('credential', OWNER, user({ tokenExpiresAt: Date.now() - 1000 }));

  const principal = await policy.authenticate(bearer);
  assert.equal(principal.user.accessToken, 'ghu_rotated_1');
  assert.equal(fake.refreshes, 1, 'MCP must not spend a refresh token of its own');
  assert.equal((await store.get<GitHubUser>('credential', OWNER))?.accessToken, 'ghu_rotated_1', 'MCP copy is brought up to date');
});

test('concurrent MCP calls share one refresh of an expired grant', async () => {
  await expireSharedGrant();
  await store.put('credential', OWNER, user({ tokenExpiresAt: Date.now() - 1000 }));

  const results = await Promise.all([policy.authenticate(bearer), policy.authenticate(bearer), policy.authenticate(bearer)]);
  assert.deepEqual(results.map(result => result.user.accessToken), ['ghu_rotated_1', 'ghu_rotated_1', 'ghu_rotated_1']);
  assert.equal(fake.refreshes, 1);
  const shared = await grants.resolve(OWNER);
  assert.equal(shared.status === 'active' && shared.accessToken, 'ghu_rotated_1', 'the browser sees the rotation too');
});

test('a token GitHub rejects before its expiry is renewed once through the shared grant', async () => {
  fake.validAccessToken = 'ghu_revoked_elsewhere';
  const principal = await policy.authenticate(bearer);
  assert.equal(principal.user.accessToken, 'ghu_rotated_1');
  assert.equal(fake.refreshes, 1);
});

test('staggered GitHub rejections reuse the shared refresh without invalidating the first retry', { timeout: 5000 }, async () => {
  fake.validAccessToken = 'ghu_revoked_elsewhere';
  const bothInitialRequests = deferred();
  const firstRetry = deferred();
  const secondRetry = deferred();
  let initialRequests = 0;
  let retries = 0;
  fake.beforeVerify = async token => {
    if (token === 'ghu_initial') {
      initialRequests += 1;
      if (initialRequests === 1) await bothInitialRequests.promise;
      else {
        bothInitialRequests.resolve();
        // B's rejection arrives after A's refresh has completed.
        await firstRetry.promise;
      }
    } else {
      retries += 1;
      if (retries === 1) {
        firstRetry.resolve();
        // Check A's token only after B has handled its stale rejection.
        await secondRetry.promise;
      } else secondRetry.resolve();
    }
  };

  const results = await Promise.allSettled([policy.authenticate(bearer), policy.authenticate(bearer)]);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled']);
  assert.deepEqual(results.map(result => result.status === 'fulfilled' && result.value.user.accessToken), ['ghu_rotated_1', 'ghu_rotated_1']);
  assert.equal(fake.refreshes, 1);
  assert.equal((await store.get<GitHubUser>('credential', OWNER))?.accessToken, 'ghu_rotated_1');
  const shared = await grants.resolve(OWNER);
  assert.equal(shared.status === 'active' && shared.accessToken, 'ghu_rotated_1');
});

test('MCP reuses a browser rotation completed while GitHub verification was pending', async () => {
  fake.beforeVerify = async token => {
    if (token === 'ghu_initial') assert.equal((await grants.resolve(OWNER, true)).status, 'active');
  };

  const principal = await policy.authenticate(bearer);
  assert.equal(principal.user.accessToken, 'ghu_rotated_1');
  assert.equal(fake.refreshes, 1);
  assert.equal((await store.get<GitHubUser>('credential', OWNER))?.accessToken, 'ghu_rotated_1');
});

test('a GitHub outage during refresh is reported as temporary, not as a sign-in requirement', async () => {
  await expireSharedGrant();
  fake.unavailable = true;
  await assert.rejects(policy.authenticate(bearer), { code: 'GITHUB_UNAVAILABLE', status: 503 });
});

test('without a shared grant MCP still refreshes its own credential', async () => {
  await db('github_user_grants').delete();
  await store.put('credential', OWNER, user({ tokenExpiresAt: Date.now() - 1000 }));
  const principal = await policy.authenticate(bearer);
  assert.equal(principal.user.accessToken, 'ghu_rotated_1');
  assert.equal(fake.refreshes, 1);
});
