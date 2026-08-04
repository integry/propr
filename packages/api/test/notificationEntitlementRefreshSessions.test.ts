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
import { up as fenceEntitlementInvalidation }
  from '../../core/src/db/migrations/20260804000000_fence_notification_entitlement_invalidation.js';
import { up as fenceSessionGenerations }
  from '../../core/src/db/migrations/20260804020000_fence_notification_session_generations.js';
import { up as retainSessionGenerations }
  from '../../core/src/db/migrations/20260804060000_retain_notification_entitlement_generations.js';
import { createSessionAuthGeneration } from '../authSessionGeneration.js';
import { createNotificationEntitlementRefreshMiddleware }
  from '../routes/notificationEntitlementRefresh.js';
import type { EntitlementRefreshTimerScheduler }
  from '../routes/notificationEntitlementRefreshScheduler.js';

let database: Knex;

after(async () => closeConnection());

beforeEach(async () => {
  database = knex({
    client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true,
  });
  await hardenNotificationProjection(database);
  await hardenNotificationFollowup(database);
  await fenceNotificationEntitlements(database);
  await fenceEntitlementInvalidation(database);
  await fenceSessionGenerations(database);
  await retainSessionGenerations(database);
});

afterEach(async () => database.destroy());

function createManualTimers(): {
  scheduler: EntitlementRefreshTimerScheduler;
  runNext(): boolean;
} {
  const timers: Array<{ callback: () => void; cancelled: boolean; unref(): void }> = [];
  return {
    scheduler: {
      setTimeout(callback) {
        const timer = { callback, cancelled: false, unref: () => undefined };
        timers.push(timer);
        return timer;
      },
      clearTimeout(timer) {
        (timer as typeof timers[number]).cancelled = true;
      },
    },
    runNext() {
      const timer = timers.find(candidate => !candidate.cancelled);
      if (!timer) return false;
      timer.cancelled = true;
      timer.callback();
      return true;
    },
  };
}

async function addFreshSnapshot(userId: string): Promise<void> {
  const now = new Date().toISOString();
  await database('notification_repository_entitlement_snapshots').insert({
    user_id: userId,
    verified_at: now,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
}

test('logging out the newest session resumes refreshes with an older live credential', async () => {
  const userId = 'generation-fallback-user';
  const olderSessionId = 'generation-fallback-older';
  const newerSessionId = 'generation-fallback-newer';
  const olderGeneration = createSessionAuthGeneration(olderSessionId);
  const newerGeneration = createSessionAuthGeneration(newerSessionId);
  await addFreshSnapshot(userId);
  const refreshedTokens: string[] = [];
  let markRefreshed!: () => void;
  const refreshed = new Promise<void>(resolve => { markRefreshed = resolve; });
  const timers = createManualTimers();
  const middleware = createNotificationEntitlementRefreshMiddleware(database, {
    timerScheduler: timers.scheduler,
    refresh: async ({ accessToken }) => {
      refreshedTokens.push(accessToken);
      markRefreshed();
      return true;
    },
  });
  try {
    await middleware.activate(userId, olderGeneration);
    middleware({ user: { id: userId, accessToken: 'older-token' },
      sessionID: olderSessionId, path: '/github/repos' } as never,
    {} as never, () => undefined);
    await new Promise(resolve => setImmediate(resolve));

    await middleware.activate(userId, newerGeneration);
    middleware({ user: { id: userId, accessToken: 'newer-token' },
      sessionID: newerSessionId, path: '/github/repos' } as never,
    {} as never, () => undefined);
    await middleware.invalidate(userId, newerGeneration);

    assert.equal(timers.runNext(), true);
    await refreshed;
    assert.deepEqual(refreshedTokens, ['older-token']);
  } finally {
    await middleware.close();
  }
});

test('a schedule cannot refresh through a generation owned by another replica', async () => {
  const userId = 'generation-cross-replica-user';
  const olderSessionId = 'generation-cross-replica-older';
  const olderGeneration = createSessionAuthGeneration(olderSessionId);
  const newerGeneration = createSessionAuthGeneration('generation-cross-replica-newer');
  await addFreshSnapshot(userId);
  let refreshes = 0;
  const timers = createManualTimers();
  const middleware = createNotificationEntitlementRefreshMiddleware(database, {
    timerScheduler: timers.scheduler,
    refresh: async () => { refreshes++; return true; },
  });
  const loginReplica = createNotificationEntitlementRefreshMiddleware(database);
  try {
    await middleware.activate(userId, olderGeneration);
    middleware({ user: { id: userId, accessToken: 'older-token' },
      sessionID: olderSessionId, path: '/github/repos' } as never,
    {} as never, () => undefined);
    await new Promise(resolve => setImmediate(resolve));
    await loginReplica.activate(userId, newerGeneration);

    assert.equal(timers.runNext(), true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(refreshes, 0);
  } finally {
    await Promise.all([middleware.close(), loginReplica.close()]);
  }
});
