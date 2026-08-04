import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, test } from 'node:test';
import knex, { type Knex } from 'knex';
import { closeConnection } from '../../core/src/db/connection.js';
import { up as hardenNotificationProjection }
  from '../../core/src/db/migrations/20260802040000_harden_notification_projection.js';
import { up as hardenNotificationFollowup }
  from '../../core/src/db/migrations/20260803020000_harden_notification_followup.js';
import { up as fenceNotificationEntitlements }
  from '../../core/src/db/migrations/20260803030000_fence_notification_entitlement_refreshes.js';
import { createNotificationEntitlementRefreshMiddleware }
  from '../routes/notificationEntitlementRefresh.js';

let database: Knex;

after(async () => closeConnection());

beforeEach(async () => {
  database = knex({
    client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true,
  });
  await hardenNotificationProjection(database);
  await hardenNotificationFollowup(database);
  await fenceNotificationEntitlements(database);
});

afterEach(async () => database.destroy());

for (const initialOutcome of ['false', 'reject'] as const) {
  test(`initial entitlement refresh ${initialOutcome} uses the short retry schedule`, async () => {
    const previousTtl = process.env.NOTIFICATION_REPOSITORY_ENTITLEMENT_TTL_MS;
    process.env.NOTIFICATION_REPOSITORY_ENTITLEMENT_TTL_MS = '80';
    const userId = `initial-${initialOutcome}`;
    let refreshes = 0;
    const middleware = createNotificationEntitlementRefreshMiddleware(database, {
      refresh: async () => {
        refreshes++;
        if (refreshes !== 1) return true;
        if (initialOutcome === 'reject') throw new Error('temporary GitHub failure');
        return false;
      },
    });
    try {
      middleware({ user: { id: userId, accessToken: 'token' }, path: '/config/repos' } as never,
        {} as never, () => undefined);
      await new Promise(resolve => setTimeout(resolve, 35));
      assert.ok(refreshes >= 2, `expected short retry after ${initialOutcome}`);
    } finally {
      middleware.close();
      if (previousTtl === undefined) delete process.env.NOTIFICATION_REPOSITORY_ENTITLEMENT_TTL_MS;
      else process.env.NOTIFICATION_REPOSITORY_ENTITLEMENT_TTL_MS = previousTtl;
    }
  });
}

test('entitlement refresh capacity uses recently observed users as LRU', async () => {
  const previousTtl = process.env.NOTIFICATION_REPOSITORY_ENTITLEMENT_TTL_MS;
  process.env.NOTIFICATION_REPOSITORY_ENTITLEMENT_TTL_MS = '40';
  const now = new Date().toISOString();
  await database('notification_repository_entitlement_snapshots').insert(
    ['lru-1', 'lru-2', 'lru-3'].map(userId => ({
      user_id: userId, verified_at: now, expires_at: new Date(Date.now() + 1_000).toISOString(),
    }))
  );
  const refreshed = new Set<string>();
  const middleware = createNotificationEntitlementRefreshMiddleware(database, {
    maxScheduledRefreshes: 2,
    refresh: async ({ userId }) => { refreshed.add(userId); return true; },
  });
  const observe = (userId: string) => middleware({
    user: { id: userId, accessToken: `token-${userId}` }, path: '/github/repos',
  } as never, {} as never, () => undefined);
  try {
    for (const userId of ['lru-1', 'lru-2', 'lru-1', 'lru-3']) observe(userId);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(refreshed.has('lru-2'), false);
    assert.equal(refreshed.has('lru-1'), true);
    assert.equal(refreshed.has('lru-3'), true);
  } finally {
    middleware.close();
    if (previousTtl === undefined) delete process.env.NOTIFICATION_REPOSITORY_ENTITLEMENT_TTL_MS;
    else process.env.NOTIFICATION_REPOSITORY_ENTITLEMENT_TTL_MS = previousTtl;
  }
});

test('closing entitlement middleware aborts retained OAuth work', async () => {
  let signal: AbortSignal | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const middleware = createNotificationEntitlementRefreshMiddleware(database, {
    refresh: async (options) => {
      signal = options.signal;
      markStarted();
      return new Promise<never>(() => undefined);
    },
  });
  middleware({
    user: { id: 'shutdown-user', accessToken: 'shutdown-token' }, path: '/config/repos',
  } as never, {} as never, () => undefined);
  await started;
  middleware.close();
  assert.equal(signal?.aborted, true);
});
