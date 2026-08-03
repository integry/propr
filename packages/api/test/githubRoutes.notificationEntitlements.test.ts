import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, test } from 'node:test';
import knex, { type Knex } from 'knex';
import { closeConnection } from '../../core/src/db/connection.js';
import { up as hardenNotificationProjection } from '../../core/src/db/migrations/20260802040000_harden_notification_projection.js';
import { up as hardenNotificationFollowup } from '../../core/src/db/migrations/20260803020000_harden_notification_followup.js';
import {
  createNotificationEntitlementRefreshMiddleware,
  persistNotificationRepositoryEntitlementsBestEffort,
  refreshNotificationRepositoryEntitlements,
} from '../routes/githubRoutes.js';

let database: Knex;

beforeEach(async () => {
  database = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  await hardenNotificationProjection(database);
  await hardenNotificationFollowup(database);
});

afterEach(async () => {
  await database.destroy();
});

after(async () => {
  await closeConnection();
});

test('ordinary authenticated refresh creates and renews repository entitlement snapshots', async () => {
  let scans = 0;
  const listRepositories = async () => {
    scans++;
    return scans === 1 ? ['acme/alpha'] : ['acme/beta'];
  };

  await refreshNotificationRepositoryEntitlements({
    userId: 'user-1',
    accessToken: 'token',
    database,
    listRepositories,
  });
  assert.deepEqual(await database('notification_repository_entitlements').pluck('repository'), ['acme/alpha']);
  assert.equal(scans, 1);

  // A fresh snapshot suppresses redundant GitHub scans on every API request.
  await refreshNotificationRepositoryEntitlements({
    userId: 'user-1',
    accessToken: 'token',
    database,
    listRepositories,
  });
  assert.equal(scans, 1);

  await database('notification_repository_entitlement_snapshots')
    .where({ user_id: 'user-1' })
    .update({
      verified_at: '2000-01-01T00:00:00.000Z',
      expires_at: '2000-01-01T01:00:00.000Z',
    });
  await refreshNotificationRepositoryEntitlements({
    userId: 'user-1',
    accessToken: 'token',
    database,
    listRepositories,
  });
  assert.deepEqual(await database('notification_repository_entitlements').pluck('repository'), ['acme/beta']);
  assert.equal(scans, 2);
});

test('an empty access snapshot remains refreshable without repeatedly scanning GitHub', async () => {
  let scans = 0;
  const listRepositories = async () => { scans++; return []; };

  await refreshNotificationRepositoryEntitlements({
    userId: 'user-with-no-repos',
    accessToken: 'token',
    database,
    listRepositories,
  });
  await refreshNotificationRepositoryEntitlements({
    userId: 'user-with-no-repos',
    accessToken: 'token',
    database,
    listRepositories,
  });

  assert.equal(scans, 1);
  assert.equal(await database('notification_repository_entitlements').count({ count: '*' }).first()
    .then(row => Number(row?.count)), 0);
  assert.equal(await database('notification_repository_entitlement_snapshots').count({ count: '*' }).first()
    .then(row => Number(row?.count)), 1);
});

test('a reduced entitlement TTL immediately shortens an older snapshot', async () => {
  const previousTtl = process.env.NOTIFICATION_REPOSITORY_ENTITLEMENT_TTL_MS;
  try {
    const verifiedAt = new Date(Date.now() - 30_000).toISOString();
    await database('notification_repository_entitlement_snapshots').insert({
      user_id: 'shorter-ttl-user',
      verified_at: verifiedAt,
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    process.env.NOTIFICATION_REPOSITORY_ENTITLEMENT_TTL_MS = '10000';
    let scans = 0;
    await refreshNotificationRepositoryEntitlements({
      userId: 'shorter-ttl-user',
      accessToken: 'token',
      database,
      listRepositories: async () => { scans++; return ['Acme/Alpha']; },
    });

    assert.equal(scans, 1);
    assert.deepEqual(
      await database('notification_repository_entitlements').pluck('repository'),
      ['acme/alpha']
    );
  } finally {
    if (previousTtl === undefined) delete process.env.NOTIFICATION_REPOSITORY_ENTITLEMENT_TTL_MS;
    else process.env.NOTIFICATION_REPOSITORY_ENTITLEMENT_TTL_MS = previousTtl;
  }
});

test('a live database refresh lease coalesces work across API replicas', async () => {
  await database('notification_repository_entitlement_refresh_leases').insert({
    user_id: 'leased-user',
    lease_token: 'other-replica',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  let scans = 0;
  const refresh = () => refreshNotificationRepositoryEntitlements({
    userId: 'leased-user',
    accessToken: 'token',
    database,
    listRepositories: async () => { scans++; return []; },
  });

  await refresh();
  assert.equal(scans, 0);
  await database('notification_repository_entitlement_refresh_leases')
    .where({ user_id: 'leased-user' })
    .update({ expires_at: new Date(Date.now() - 1).toISOString() });
  await refresh();
  assert.equal(scans, 1);
});

test('ordinary API middleware does not await a full entitlement refresh', async () => {
  let finishRefresh!: () => void;
  let refreshFinished = false;
  const middleware = createNotificationEntitlementRefreshMiddleware(database, {
    refresh: async () => {
      await new Promise<void>(resolve => { finishRefresh = resolve; });
      refreshFinished = true;
    },
  });
  let nextCalls = 0;

  middleware({
    user: { id: 'background-user', accessToken: 'token' },
    path: '/config/repos',
  } as never, {} as never, () => { nextCalls++; });

  assert.equal(nextCalls, 1);
  assert.equal(refreshFinished, false);
  finishRefresh();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshFinished, true);
});

test('failed entitlement refreshes are throttled until the retry window', async () => {
  let scans = 0;
  const listRepositories = async (): Promise<string[]> => {
    scans++;
    throw new Error('GitHub unavailable');
  };
  const options = {
    userId: 'backoff-user', accessToken: 'token', database, listRepositories,
  };

  await assert.rejects(refreshNotificationRepositoryEntitlements(options), /GitHub unavailable/);
  await refreshNotificationRepositoryEntitlements(options);
  assert.equal(scans, 1);

  await assert.rejects(
    refreshNotificationRepositoryEntitlements({ ...options, force: true }),
    /GitHub unavailable/
  );
  assert.equal(scans, 2);
});

test('entitlement bookkeeping failure remains best-effort for repository browsing', async () => {
  await database.schema.dropTable('notification_repository_entitlement_snapshots');

  assert.equal(await persistNotificationRepositoryEntitlementsBestEffort({
    userId: 'user-1',
    repositories: ['acme/alpha'],
    database,
  }), false);
  assert.equal(await database('notification_repository_entitlements').count({ count: '*' }).first()
    .then(row => Number(row?.count)), 0);
});
