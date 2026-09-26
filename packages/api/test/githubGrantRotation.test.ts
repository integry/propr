import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, test } from 'node:test';
import knex, { type Knex } from 'knex';
import { closeConnection } from '@propr/core';
import { up as createGitHubUserGrants } from '../../core/src/db/migrations/20260908000000_create_github_user_grants.js';
import { up as createVisualPreviewOAuthCredentials } from '../../core/src/db/migrations/20260903000000_create_visual_preview_oauth_credentials.js';
import { up as addGitHubOAuthGrantRevision } from '../../core/src/db/migrations/20260908010000_add_github_oauth_grant_revision.js';
import { VisualPreviewOAuthCredentialService } from '../../core/src/services/visualPreviewOAuthCredentialService.js';
import type { GitHubUser } from '../authTypes.js';
import { GitHubUserGrantService } from '../githubUserGrantService.js';

let database: Knex;

const desktopUser: GitHubUser = {
  id: '123', login: 'developer', username: 'developer', displayName: 'Developer',
  email: null, avatarUrl: null,
};

beforeEach(async () => {
  database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await createGitHubUserGrants(database);
  await createVisualPreviewOAuthCredentials(database);
  await addGitHubOAuthGrantRevision(database);
});

afterEach(async () => database.destroy());
after(async () => closeConnection());

test('desktop-first rotation updates the shared scheduler grant and durable user grant once', async () => {
  let refreshRequests = 0;
  const fetchImpl = (async () => {
    refreshRequests += 1;
    return Response.json({
      access_token: 'gho_desktop-first-access',
      refresh_token: 'ghr_desktop-first-refresh',
      expires_in: 28_800,
    });
  }) as typeof fetch;
  const environment = {
    SESSION_SECRET: 'test-secret',
    GH_OAUTH_CLIENT_ID: 'client-id',
    GH_OAUTH_CLIENT_SECRET: 'client-secret',
  };
  const shared = new VisualPreviewOAuthCredentialService(database, environment, fetchImpl);
  const durable = new GitHubUserGrantService(database, environment, fetchImpl, shared);
  const login = {
    ...desktopUser,
    accessToken: 'gho_old-access',
    refreshToken: 'ghr_old-refresh',
    tokenExpiresAt: Date.now() - 1,
    oauthSource: 'github' as const,
  };
  const loginRevision = 100;
  await shared.replace({
    githubUserId: login.id,
    githubUsername: login.username,
    source: 'github',
    accessToken: login.accessToken,
    refreshToken: login.refreshToken,
    accessTokenExpiresAt: login.tokenExpiresAt,
    grantRevision: loginRevision,
  });
  await durable.capture(login, loginRevision);

  const resolved = await durable.resolve(login.id);

  assert.equal(resolved.status === 'active' && resolved.accessToken, 'gho_desktop-first-access');
  assert.equal((await shared.refreshAndGetForOwner(login.id))?.accessToken, 'gho_desktop-first-access');
  assert.equal(refreshRequests, 1);
});

test('scheduler-first rotation is adopted by desktop without reusing its stale refresh token', async () => {
  const seenRefreshTokens: string[] = [];
  const fetchImpl = (async (_input, init) => {
    seenRefreshTokens.push((JSON.parse(String(init?.body)) as { refresh_token: string }).refresh_token);
    return Response.json({
      access_token: 'gho_scheduler-first-access',
      refresh_token: 'ghr_scheduler-first-refresh',
      expires_in: 28_800,
    });
  }) as typeof fetch;
  const environment = {
    SESSION_SECRET: 'test-secret',
    GH_OAUTH_CLIENT_ID: 'client-id',
    GH_OAUTH_CLIENT_SECRET: 'client-secret',
  };
  const shared = new VisualPreviewOAuthCredentialService(database, environment, fetchImpl);
  const durable = new GitHubUserGrantService(database, environment, fetchImpl, shared);
  const login = {
    ...desktopUser,
    accessToken: 'gho_old-access',
    refreshToken: 'ghr_old-refresh',
    tokenExpiresAt: Date.now() - 1,
    oauthSource: 'github' as const,
  };
  const loginRevision = 100;
  await shared.replace({
    githubUserId: login.id,
    githubUsername: login.username,
    source: 'github',
    accessToken: login.accessToken,
    refreshToken: login.refreshToken,
    accessTokenExpiresAt: login.tokenExpiresAt,
    grantRevision: loginRevision,
  });
  await durable.capture(login, loginRevision);

  assert.equal(await shared.refreshIfNeeded(), 'refreshed');
  const resolved = await durable.resolve(login.id);

  assert.equal(resolved.status === 'active' && resolved.accessToken, 'gho_scheduler-first-access');
  assert.deepEqual(seenRefreshTokens, ['ghr_old-refresh']);
});

test('scheduler refresh cannot promote an older shared login over a newer durable login', async () => {
  let refreshRequests = 0;
  const environment = {
    SESSION_SECRET: 'test-secret',
    GH_OAUTH_CLIENT_ID: 'client-id',
    GH_OAUTH_CLIENT_SECRET: 'client-secret',
  };
  const shared = new VisualPreviewOAuthCredentialService(database, environment, (async () => {
    refreshRequests += 1;
    return Response.json({
      access_token: 'gho_rotated-stale-shared-access',
      refresh_token: 'ghr_rotated-stale-shared-refresh',
      expires_in: 28_800,
    });
  }) as typeof fetch);
  await shared.replace({
    githubUserId: desktopUser.id,
    githubUsername: desktopUser.username,
    source: 'github',
    accessToken: 'gho_stale-shared-access',
    refreshToken: 'ghr_stale-shared-refresh',
    accessTokenExpiresAt: Date.now() - 1,
    grantRevision: 100,
  });
  const durable = new GitHubUserGrantService(database, environment, fetch, shared);
  await durable.capture({
    ...desktopUser,
    accessToken: 'gho_new-login-access',
    refreshToken: 'ghr_new-login-refresh',
    tokenExpiresAt: Date.now() + 28_800_000,
    oauthSource: 'github',
  }, 200);

  const beforeScheduler = await durable.resolve(desktopUser.id);
  assert.equal(beforeScheduler.status === 'active' && beforeScheduler.accessToken, 'gho_new-login-access');

  assert.equal(await shared.refreshIfNeeded(), 'refreshed');
  const refreshedSharedRow = await database('visual_preview_oauth_credentials').first();
  assert.ok(Number(refreshedSharedRow.grant_revision) > 200);
  assert.equal(Number(refreshedSharedRow.login_revision), 100);
  const afterScheduler = await durable.resolve(desktopUser.id);

  assert.equal(afterScheduler.status === 'active' && afterScheduler.accessToken, 'gho_new-login-access');
  assert.equal((await shared.getForOwner(desktopUser.id))?.accessToken, 'gho_rotated-stale-shared-access');
  assert.equal(refreshRequests, 1);
});

test('stale desktop refresh failure adopts a concurrent login instead of marking reauthorization', async () => {
  let refreshStarted!: () => void;
  const started = new Promise<void>(resolve => { refreshStarted = resolve; });
  let answerRefresh!: () => void;
  const answer = new Promise<void>(resolve => { answerRefresh = resolve; });
  const service = new GitHubUserGrantService(
    database,
    { SESSION_SECRET: 'test-secret', GH_OAUTH_CLIENT_ID: 'client-id', GH_OAUTH_CLIENT_SECRET: 'client-secret' },
    (async () => {
      refreshStarted();
      await answer;
      return Response.json({ error: 'invalid_grant' });
    }) as typeof fetch,
  );
  await service.capture({
    ...desktopUser,
    accessToken: 'gho_old-access',
    refreshToken: 'ghr_old-refresh',
    tokenExpiresAt: Date.now() - 1,
    oauthSource: 'github',
  });

  const staleResolution = service.resolve(desktopUser.id, true);
  await started;
  await service.capture({
    ...desktopUser,
    accessToken: 'gho_new-login-access',
    refreshToken: 'ghr_new-login-refresh',
    tokenExpiresAt: Date.now() + 28_800_000,
    oauthSource: 'github',
  });
  answerRefresh();

  assert.equal((await staleResolution).status, 'active');
  assert.equal((await service.resolve(desktopUser.id)).status, 'active');
  assert.equal((await service.resolve(desktopUser.id) as { accessToken?: string }).accessToken, 'gho_new-login-access');
});

test('shared preview owner isolation keeps another users desktop refresh on its own grant', async () => {
  const environment = {
    SESSION_SECRET: 'test-secret',
    GH_OAUTH_CLIENT_ID: 'client-id',
    GH_OAUTH_CLIENT_SECRET: 'client-secret',
  };
  const shared = new VisualPreviewOAuthCredentialService(database, environment);
  await shared.replace({
    githubUserId: 'owner-1',
    githubUsername: 'first-admin',
    source: 'github',
    accessToken: 'gho_first-admin',
    refreshToken: 'ghr_first-admin',
    accessTokenExpiresAt: Date.now() + 28_800_000,
  });
  const durable = new GitHubUserGrantService(database, environment, (async () => Response.json({
    access_token: 'gho_second-user-refreshed',
    refresh_token: 'ghr_second-user-refreshed',
    expires_in: 28_800,
  })) as typeof fetch, shared);
  await durable.capture({
    ...desktopUser,
    id: 'owner-2',
    accessToken: 'gho_second-user-old',
    refreshToken: 'ghr_second-user-old',
    tokenExpiresAt: Date.now() - 1,
    oauthSource: 'github',
  });

  const result = await durable.resolve('owner-2');

  assert.equal(result.status === 'active' && result.accessToken, 'gho_second-user-refreshed');
  assert.equal(await shared.resolveUploadToken(), 'gho_first-admin');
});
