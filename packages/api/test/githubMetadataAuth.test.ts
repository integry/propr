import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, test } from 'node:test';
import type { Request, Response } from 'express';
import knex, { type Knex } from 'knex';
import { closeConnection } from '@propr/core';
import { up as createGitHubUserGrants } from '../../core/src/db/migrations/20260908000000_create_github_user_grants.js';
import { up as addGitHubOAuthGrantRevision } from '../../core/src/db/migrations/20260908010000_add_github_oauth_grant_revision.js';
import { GitHubUserGrantService } from '../githubUserGrantService.js';
import {
  GitHubMetadataAuthorizationError,
  resolveGitHubMetadataToken,
} from '../githubMetadataAuth.js';
import { createGitHubRoutes } from '../routes/githubRoutes.js';
import { createGetRepositoryInfoHandler } from '../routes/plannerHelpers/handlers/repositoryHandlers.js';
import { createGenerateHandler } from '../routes/plannerActionHandlers.js';
import type { GitHubUser } from '../authTypes.js';

let database: Knex;
const originalFetch = globalThis.fetch;

const desktopUser: GitHubUser = {
  id: '123', login: 'developer', username: 'developer', displayName: 'Developer',
  email: null, avatarUrl: null,
};

function responseRecorder() {
  const record: { status: number; body?: unknown } = { status: 200 };
  const response = {
    status(code: number) { record.status = code; return response; },
    json(body: unknown) { record.body = body; return response; },
  } as unknown as Response;
  return { response, record };
}

function browserRequest(body: Record<string, unknown> = {}): Request & { saveCalls: number } {
  const request = {
    user: {
      ...desktopUser,
      accessToken: 'revoked-browser-token',
      refreshToken: 'browser-refresh-token',
      tokenExpiresAt: Date.now() + 60 * 60_000,
      oauthSource: 'github' as const,
    },
    authenticationMethod: 'session',
    sessionID: `browser-session-${Math.random()}`,
    body,
    params: {},
    query: {},
    saveCalls: 0,
    session: {
      save(callback: (error?: Error) => void) {
        request.saveCalls += 1;
        callback();
      },
    },
  };
  return request as unknown as Request & { saveCalls: number };
}

beforeEach(async () => {
  database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await createGitHubUserGrants(database);
  await addGitHubOAuthGrantRevision(database);
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await database.destroy();
});
after(async () => closeConnection());

test('resolves an encrypted matching user grant for a desktop bearer identity', async () => {
  const service = new GitHubUserGrantService(database, { SESSION_SECRET: 'test-secret' });
  await service.capture({
    ...desktopUser,
    accessToken: 'ghu_user-access-secret',
    refreshToken: 'ghr_user-refresh-secret',
    tokenExpiresAt: Date.now() + 60 * 60_000,
    oauthSource: 'connect',
  });

  const token = await resolveGitHubMetadataToken({
    user: desktopUser,
    authenticationMethod: 'instance_token',
  } as Request, service);

  assert.equal(token, 'ghu_user-access-secret');
  assert.doesNotMatch(JSON.stringify(await database('github_user_grants').first()), /user-(?:access|refresh)-secret/);
});

test('does not resolve another user grant or installation visibility as user authority', async () => {
  const service = new GitHubUserGrantService(database, { SESSION_SECRET: 'test-secret' });
  await service.capture({ ...desktopUser, accessToken: 'gho_user-secret', oauthSource: 'github' });

  await assert.rejects(
    resolveGitHubMetadataToken({
      user: { ...desktopUser, id: '456', username: 'other-user' },
      authenticationMethod: 'instance_token',
    } as Request, service),
    (error: unknown) => error instanceof GitHubMetadataAuthorizationError
      && error.code === 'GITHUB_AUTHORIZATION_REQUIRED'
      && /browser/.test(error.message),
  );
});

test('denies expired and revoked grants with reauthorization guidance', async () => {
  const expired = new GitHubUserGrantService(database, { SESSION_SECRET: 'test-secret' });
  await expired.capture({
    ...desktopUser, accessToken: 'gho_expired-secret', tokenExpiresAt: Date.now() - 1, oauthSource: 'github',
  });
  assert.deepEqual(await expired.resolve(desktopUser.id), { status: 'reauth_required' });

  await expired.capture({
    ...desktopUser,
    accessToken: 'ghu_revoked-secret',
    refreshToken: 'ghr_revoked-secret',
    tokenExpiresAt: Date.now() + 60_000,
    oauthSource: 'connect',
  });
  const revoked = new GitHubUserGrantService(
    database,
    { SESSION_SECRET: 'test-secret', PROPR_GH_RELAY_URL: 'https://relay.example.test', PROPR_GH_RELAY_TOKEN: 'relay-secret' },
    (async () => Response.json({ error: 'invalid_grant' })) as typeof fetch,
  );
  assert.deepEqual(await revoked.resolve(desktopUser.id, true), { status: 'reauth_required' });
});

test('preserves the browser session token path without consulting stored grants', async () => {
  let resolved = false;
  const token = await resolveGitHubMetadataToken({
    user: { ...desktopUser, accessToken: 'gho_browser-secret' },
    authenticationMethod: 'session',
  } as Request, {
    resolve: async () => { resolved = true; return { status: 'missing' }; },
  } as never);

  assert.equal(token, 'gho_browser-secret');
  assert.equal(resolved, false);
});

test('desktop repository listing and branch metadata use the resolved user credential', async () => {
  const seenTokens: string[] = [];
  const routes = createGitHubRoutes({
    redisClient: {} as never,
    taskQueue: {} as never,
    db: database,
    resolveMetadataToken: async () => 'ghu_resolved-user-secret',
    createMetadataOctokit: token => {
      seenTokens.push(token);
      return {
        request: async () => ({ data: { default_branch: 'desktop-acceptance' } }),
        paginate: {
          iterator: async function* (route: string) {
            if (route === 'GET /user/repos') yield { data: [{ full_name: 'integry/propr-desktop-acceptance-20260908' }] };
            else yield { data: [{ name: 'main' }, { name: 'desktop-acceptance' }] };
          },
        },
      } as never;
    },
  });
  const request = { user: desktopUser, authenticationMethod: 'instance_token' } as Request;
  const repos = responseRecorder();
  await routes.getRepos(request, repos.response);
  const branches = responseRecorder();
  await routes.getBranches({
    ...request, params: { owner: 'integry', repo: 'propr-desktop-acceptance-20260908' },
  } as never, branches.response);

  assert.deepEqual(repos.record.body, { repos: ['integry/propr-desktop-acceptance-20260908'] });
  assert.deepEqual(branches.record.body, {
    branches: ['desktop-acceptance', 'main'], defaultBranch: 'desktop-acceptance',
  });
  assert.deepEqual(seenTokens, ['ghu_resolved-user-secret', 'ghu_resolved-user-secret']);
});

test('planner repository branch metadata uses the same resolved desktop authority', async () => {
  let usedToken = '';
  const handler = createGetRepositoryInfoHandler({
    verifyOwnership: async () => ({ authorized: true }),
    resolveMetadataToken: async () => 'ghu_planner-user-secret',
    createMetadataOctokit: token => {
      usedToken = token;
      return {
        request: async (route: string) => route.endsWith('/branches')
          ? { data: [{ name: 'desktop-acceptance' }] }
          : { data: { default_branch: 'desktop-acceptance', private: true, description: 'Acceptance fixture' } },
      } as never;
    },
  });
  const recorder = responseRecorder();

  await handler({
    user: desktopUser,
    authenticationMethod: 'instance_token',
    params: {},
    query: { repository: 'integry/propr-desktop-acceptance-20260908' },
  } as never, recorder.response);

  assert.equal(usedToken, 'ghu_planner-user-secret');
  assert.deepEqual(recorder.record.body, {
    repository: 'integry/propr-desktop-acceptance-20260908',
    defaultBranch: 'desktop-acceptance',
    branches: ['desktop-acceptance'],
    isPrivate: true,
    description: 'Acceptance fixture',
  });
});

test('planner metadata refreshes a browser token rejected before its recorded expiry', async () => {
  globalThis.fetch = async () => Response.json({
    access_token: 'refreshed-browser-token',
    refresh_token: 'refreshed-browser-refresh-token',
    expires_in: 3600,
  });
  const handler = createGetRepositoryInfoHandler({
    verifyOwnership: async () => ({ authorized: true }),
    createMetadataOctokit: () => ({
      request: async () => {
        throw Object.assign(new Error('Bad credentials'), { status: 401 });
      },
    } as never),
  });
  const request = browserRequest();
  request.query = { repository: 'integry/propr' };
  const recorder = responseRecorder();

  await handler(request as never, recorder.response);

  assert.equal(recorder.record.status, 401);
  assert.deepEqual(recorder.record.body, {
    error: 'Token refreshed',
    code: 'TOKEN_REFRESHED',
    message: 'Your GitHub token has been refreshed. Please retry your request.',
  });
  assert.equal(request.user?.accessToken, 'refreshed-browser-token');
  assert.equal(request.saveCalls, 1);
});

test('planner authorization refreshes a browser token rejected before its recorded expiry', async () => {
  await database.schema.createTable('task_drafts', table => {
    table.text('draft_id').primary();
    table.text('user_id').notNullable();
    table.text('repository').notNullable();
    table.text('context_config');
    table.text('status');
  });
  await database('task_drafts').insert({
    draft_id: 'browser-draft',
    user_id: desktopUser.id,
    repository: 'integry/propr',
    context_config: JSON.stringify({}),
    status: 'review',
  });
  globalThis.fetch = async () => Response.json({
    access_token: 'refreshed-planner-token',
    refresh_token: 'refreshed-planner-refresh-token',
    expires_in: 3600,
  });
  let setupCalls = 0;
  const handler = createGenerateHandler(database, {
    hasRunningContainer: async () => false,
    verifyRepositoryAccess: async () => {
      throw Object.assign(new Error('Bad credentials'), { status: 401 });
    },
    setupRepository: async () => {
      setupCalls += 1;
      return { repository: 'integry/propr', authToken: 'unused', worktreePath: '/tmp/unused' };
    },
  });
  const request = browserRequest({ draftId: 'browser-draft' });
  const recorder = responseRecorder();

  await handler(request, recorder.response);

  assert.equal(recorder.record.status, 401);
  assert.deepEqual(recorder.record.body, {
    error: 'Token refreshed',
    code: 'TOKEN_REFRESHED',
    message: 'Your GitHub token has been refreshed. Please retry your request.',
  });
  assert.equal(request.user?.accessToken, 'refreshed-planner-token');
  assert.equal(request.saveCalls, 1);
  assert.equal(setupCalls, 0);
});

test('inaccessible private repository metadata remains denied', async () => {
  const routes = createGitHubRoutes({
    redisClient: {} as never,
    taskQueue: {} as never,
    db: database,
    resolveMetadataToken: async () => 'ghu_user-secret',
    createMetadataOctokit: () => ({
      request: async () => { throw Object.assign(new Error('Not Found'), { status: 404 }); },
      paginate: {
        iterator: async function* () {
          yield await Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
        },
      },
    } as never),
  });
  const recorder = responseRecorder();

  await routes.getBranches({
    user: desktopUser,
    authenticationMethod: 'instance_token',
    params: { owner: 'private-owner', repo: 'private-repo' },
  } as never, recorder.response);

  assert.equal(recorder.record.status, 404);
  assert.equal((recorder.record.body as { code: string }).code, 'REPOSITORY_NOT_ACCESSIBLE');
});
