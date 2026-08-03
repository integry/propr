import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, test } from 'node:test';
import knex, { type Knex } from 'knex';
import { closeConnection } from '../../core/src/db/connection.js';
import { up as hardenNotificationProjection } from '../../core/src/db/migrations/20260802040000_harden_notification_projection.js';
import {
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
