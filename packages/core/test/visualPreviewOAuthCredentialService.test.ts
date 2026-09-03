import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, test } from 'node:test';
import knex, { type Knex } from 'knex';
import { db as defaultDatabase } from '../src/db/connection.js';
import { up as createVisualPreviewOAuthCredentials } from '../src/db/migrations/20260903000000_create_visual_preview_oauth_credentials.js';
import {
  VisualPreviewCredentialError,
  VisualPreviewOAuthCredentialService,
} from '../src/services/visualPreviewOAuthCredentialService.js';

let database: Knex;

beforeEach(async () => {
  database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await createVisualPreviewOAuthCredentials(database);
});

afterEach(async () => database.destroy());
after(async () => defaultDatabase.destroy());

function createService(fetchImpl: typeof fetch = fetch) {
  return new VisualPreviewOAuthCredentialService(database, {
    SYSTEM_TASK_SECRET: 'test-only-shared-encryption-secret',
    GH_OAUTH_CLIENT_ID: 'client-id',
    GH_OAUTH_CLIENT_SECRET: 'client-secret',
  }, fetchImpl);
}

test('encrypts a captured administrator credential and resolves it for a worker', async () => {
  const service = createService();
  assert.equal(await service.captureFromLogin({
    githubUserId: '1',
    githubUsername: 'admin',
    source: 'github',
    accessToken: 'gho_access-secret',
    refreshToken: 'ghr_refresh-secret',
  }), true);

  const row = await database('visual_preview_oauth_credentials').first();
  assert.equal(String(row.access_token_encrypted).includes('gho_access-secret'), false);
  assert.equal(String(row.refresh_token_encrypted).includes('ghr_refresh-secret'), false);
  assert.equal(await service.resolveUploadToken(), 'gho_access-secret');
});

test('rejects GitHub App user and installation tokens before storing them', async () => {
  const service = createService();
  for (const accessToken of ['ghu_user-access', 'ghs_installation']) {
    await assert.rejects(service.replace({
      githubUserId: '1', githubUsername: 'admin', source: 'github', accessToken,
    }), /GitHub App user and installation tokens are not supported/);
  }
  assert.equal((await service.getStatus()).status, 'missing');
});

test('does not silently replace a healthy credential when another admin logs in', async () => {
  const service = createService();
  await service.captureFromLogin({
    githubUserId: '1', githubUsername: 'first', source: 'github', accessToken: 'gho_first',
  });
  assert.equal(await service.captureFromLogin({
    githubUserId: '2', githubUsername: 'second', source: 'github', accessToken: 'gho_second',
  }), false);
  assert.equal(await service.resolveUploadToken(), 'gho_first');

  await service.replace({
    githubUserId: '2', githubUsername: 'second', source: 'github', accessToken: 'gho_second',
  });
  assert.equal(await service.resolveUploadToken(), 'gho_second');
});

test('refreshes an expiring OAuth grant and rotates both persisted tokens', async () => {
  let refreshBody: Record<string, string> | undefined;
  const service = createService((async (_input, init) => {
    refreshBody = JSON.parse(String(init?.body)) as Record<string, string>;
    return Response.json({
      access_token: 'gho_rotated-access',
      refresh_token: 'ghr_rotated-refresh',
      expires_in: 28_800,
      refresh_token_expires_in: 15_897_600,
    });
  }) as typeof fetch);
  await service.replace({
    githubUserId: '1',
    githubUsername: 'admin',
    source: 'github',
    accessToken: 'gho_old-access',
    refreshToken: 'ghr_old-refresh',
    accessTokenExpiresAt: Date.now() + 30_000,
  });

  assert.equal(await service.refreshIfNeeded(), 'refreshed');
  assert.equal(refreshBody?.refresh_token, 'ghr_old-refresh');
  assert.equal(await service.resolveUploadToken(), 'gho_rotated-access');
  const row = await database('visual_preview_oauth_credentials').first();
  assert.equal(String(row.refresh_token_encrypted).includes('ghr_rotated-refresh'), false);
  assert.ok(row.last_refreshed_at);
});

test('marks an unrecoverable refresh failure for administrator reconnection', async () => {
  const service = createService((async () => Response.json({ error: 'bad_refresh_token' })) as typeof fetch);
  await service.replace({
    githubUserId: '1',
    githubUsername: 'admin',
    source: 'github',
    accessToken: 'gho_old-access',
    refreshToken: 'ghr_old-refresh',
    accessTokenExpiresAt: Date.now() - 1,
  });

  assert.equal(await service.refreshIfNeeded(), 'reauth-required');
  await assert.rejects(
    service.resolveUploadToken(),
    (error: unknown) => error instanceof VisualPreviewCredentialError
      && error.code === 'VISUAL_PREVIEW_AUTH_REAUTH_REQUIRED',
  );
});

test('serializes refreshes across service instances sharing SQLite', async () => {
  let refreshRequests = 0;
  const fetchImpl = (async () => {
    refreshRequests += 1;
    await new Promise(resolve => setTimeout(resolve, 50));
    return Response.json({
      access_token: 'gho_once-access',
      refresh_token: 'ghr_once-refresh',
      expires_in: 28_800,
      refresh_token_expires_in: 15_897_600,
    });
  }) as typeof fetch;
  const first = createService(fetchImpl);
  const second = createService(fetchImpl);
  await first.replace({
    githubUserId: '1',
    githubUsername: 'admin',
    source: 'github',
    accessToken: 'gho_old-access',
    refreshToken: 'ghr_old-refresh',
    accessTokenExpiresAt: Date.now() + 30_000,
  });

  await Promise.all([first.refreshIfNeeded(), second.refreshIfNeeded()]);
  assert.equal(refreshRequests, 1);
  assert.equal(await second.resolveUploadToken(), 'gho_once-access');
});
