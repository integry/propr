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
});

afterEach(async () => database.destroy());

function createManualTimers(): {
  scheduler: EntitlementRefreshTimerScheduler;
  runNext(): boolean;
  runAll(): void;
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
    runAll() {
      for (const timer of [...timers]) {
        if (timer.cancelled) continue;
        timer.cancelled = true;
        timer.callback();
      }
    },
  };
}

async function waitForSignal(signal: Promise<void>, description: string): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), 1_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

for (const initialOutcome of ['false', 'reject'] as const) {
  test(`initial entitlement refresh ${initialOutcome} uses the short retry schedule`, async () => {
    const userId = `initial-${initialOutcome}`;
    let refreshes = 0;
    let markFirst!: () => void;
    let markSecond!: () => void;
    const first = new Promise<void>(resolve => { markFirst = resolve; });
    const second = new Promise<void>(resolve => { markSecond = resolve; });
    const timers = createManualTimers();
    const middleware = createNotificationEntitlementRefreshMiddleware(database, {
      timerScheduler: timers.scheduler,
      refresh: async () => {
        refreshes++;
        if (refreshes === 1) markFirst();
        if (refreshes === 2) markSecond();
        if (refreshes !== 1) return true;
        if (initialOutcome === 'reject') throw new Error('temporary GitHub failure');
        return false;
      },
    });
    try {
      middleware({ user: { id: userId, accessToken: 'token' }, path: '/config/repos' } as never,
        {} as never, () => undefined);
      await waitForSignal(first, 'the initial entitlement refresh');
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(timers.runNext(), true);
      await waitForSignal(second, `the retry after ${initialOutcome}`);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(refreshes, 2);
    } finally {
      middleware.close();
    }
  });
}

test('entitlement refresh capacity uses recently observed users as LRU', async () => {
  const now = new Date().toISOString();
  await database('notification_repository_entitlement_snapshots').insert(
    ['lru-1', 'lru-2', 'lru-3'].map(userId => ({
      user_id: userId, verified_at: now, expires_at: new Date(Date.now() + 1_000).toISOString(),
    }))
  );
  const refreshed = new Set<string>();
  let markExpected!: () => void;
  const expected = new Promise<void>(resolve => { markExpected = resolve; });
  const timers = createManualTimers();
  const middleware = createNotificationEntitlementRefreshMiddleware(database, {
    maxScheduledRefreshes: 2,
    timerScheduler: timers.scheduler,
    refresh: async ({ userId }) => {
      refreshed.add(userId);
      if (refreshed.has('lru-1') && refreshed.has('lru-3')) markExpected();
      return true;
    },
  });
  const observe = (userId: string) => middleware({
    user: { id: userId, accessToken: `token-${userId}` }, path: '/github/repos',
  } as never, {} as never, () => undefined);
  try {
    for (const userId of ['lru-1', 'lru-2', 'lru-1', 'lru-3']) observe(userId);
    timers.runAll();
    await waitForSignal(expected, 'the retained LRU refreshes');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(refreshed.has('lru-2'), false);
    assert.equal(refreshed.has('lru-1'), true);
    assert.equal(refreshed.has('lru-3'), true);
  } finally {
    middleware.close();
  }
});

test('ordinary traffic preserves an active repository entitlement refresh', async () => {
  let releaseRefresh!: () => void;
  let markStarted!: () => void;
  let markFinished!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const finished = new Promise<void>(resolve => { markFinished = resolve; });
  let refreshes = 0;
  let signal: AbortSignal | undefined;
  const middleware = createNotificationEntitlementRefreshMiddleware(database, {
    timerScheduler: createManualTimers().scheduler,
    refresh: async (options) => {
      refreshes++;
      signal = options.signal;
      markStarted();
      await new Promise<void>(resolve => { releaseRefresh = resolve; });
      markFinished();
      return true;
    },
  });
  const request = (token: string) => middleware({
    user: { id: 'polling-user', accessToken: token }, path: '/config/repos',
  } as never, {} as never, () => undefined);
  try {
    request('token-0');
    await waitForSignal(started, 'the slow entitlement scan');
    for (let index = 1; index <= 100; index++) request(`token-${index}`);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(refreshes, 1);
    assert.equal(signal?.aborted, false);
    releaseRefresh();
    await waitForSignal(finished, 'the preserved entitlement scan');
  } finally {
    middleware.close();
  }
});

test('ordinary traffic does not reschedule or rerun a fresh entitlement refresh', async () => {
  let refreshes = 0;
  let registrations = 0;
  let markInitial!: () => void;
  const initial = new Promise<void>(resolve => { markInitial = resolve; });
  const timers = createManualTimers();
  const middleware = createNotificationEntitlementRefreshMiddleware(database, {
    timerScheduler: timers.scheduler,
    ensureRegistration: async () => { registrations++; return true; },
    refresh: async () => { refreshes++; markInitial(); return true; },
  });
  const request = () => middleware({
    user: { id: 'fresh-traffic-user', accessToken: 'token' }, path: '/config/repos',
  } as never, {} as never, () => undefined);
  try {
    request();
    await waitForSignal(initial, 'the initial entitlement refresh');
    await new Promise(resolve => setImmediate(resolve));
    for (let index = 0; index < 100; index++) request();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(registrations, 1);
    assert.equal(refreshes, 1);
  } finally {
    middleware.close();
  }
});

test('credential rotation updates a scheduled refresh after request traffic stops', async () => {
  await database('notification_repository_entitlement_snapshots').insert({
    user_id: 'rotated-token-user',
    verified_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  const tokens: string[] = [];
  let markInitial!: () => void;
  let markScheduled!: () => void;
  const initial = new Promise<void>(resolve => { markInitial = resolve; });
  const scheduled = new Promise<void>(resolve => { markScheduled = resolve; });
  const timers = createManualTimers();
  const middleware = createNotificationEntitlementRefreshMiddleware(database, {
    timerScheduler: timers.scheduler,
    refresh: async ({ accessToken }) => {
      tokens.push(accessToken);
      if (tokens.length === 1) markInitial();
      if (tokens.length === 2) markScheduled();
      return true;
    },
  });
  try {
    middleware({
      user: { id: 'rotated-token-user', accessToken: 'old-token' },
      path: '/config/repos',
    } as never, {} as never, () => undefined);
    await waitForSignal(initial, 'the initial refresh with the old token');
    middleware.updateCredential('rotated-token-user', 'new-token');
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(timers.runNext(), true);
    await waitForSignal(scheduled, 'the scheduled refresh with the rotated token');
    assert.deepEqual(tokens, ['old-token', 'new-token']);
  } finally {
    middleware.close();
  }
});

test('restart recovery rebuilds durable session schedules with bounded concurrency', async () => {
  let active = 0;
  let peakActive = 0;
  const refreshedUsers: string[] = [];
  const credentials = Array.from({ length: 6 }, (_, index) => ({
    userId: `recovered-${index}`,
    accessToken: `recovered-token-${index}`,
    sessionExpiresAt: Date.now() + 60_000 - index,
  }));
  const middleware = createNotificationEntitlementRefreshMiddleware(database, {
    maxScheduledRefreshes: 6,
    timerScheduler: createManualTimers().scheduler,
    loadRecoveryCredentials: async () => credentials,
    refresh: async ({ userId }) => {
      active++;
      peakActive = Math.max(peakActive, active);
      await new Promise(resolve => setImmediate(resolve));
      refreshedUsers.push(userId);
      active--;
      return true;
    },
  });
  try {
    await middleware.recover();
    assert.equal(peakActive, 4);
    assert.deepEqual(refreshedUsers.sort(), credentials.map(value => value.userId).sort());
  } finally {
    middleware.close();
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
      return new Promise<boolean>(resolve => {
        options.signal?.addEventListener('abort', () => resolve(false), { once: true });
      });
    },
  });
  middleware({
    user: { id: 'shutdown-user', accessToken: 'shutdown-token' }, path: '/config/repos',
  } as never, {} as never, () => undefined);
  await started;
  middleware.close();
  assert.equal(signal?.aborted, true);
});
