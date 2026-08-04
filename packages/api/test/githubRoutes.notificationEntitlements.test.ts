/* eslint-disable max-lines -- entitlement coordination races share one migration-backed fixture */
import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, test } from 'node:test';
import knex, { type Knex } from 'knex';
import { closeConnection } from '../../core/src/db/connection.js';
import { up as hardenNotificationProjection } from '../../core/src/db/migrations/20260802040000_harden_notification_projection.js';
import { up as hardenNotificationFollowup } from '../../core/src/db/migrations/20260803020000_harden_notification_followup.js';
import { up as fenceNotificationEntitlements } from '../../core/src/db/migrations/20260803030000_fence_notification_entitlement_refreshes.js';
import { up as fenceEntitlementInvalidation } from '../../core/src/db/migrations/20260804000000_fence_notification_entitlement_invalidation.js';
import { replaceNotificationRepositoryEntitlements } from '@propr/core';
import {
  createGitHubRoutes,
  createNotificationEntitlementRefreshMiddleware,
  persistNotificationRepositoryEntitlementsBestEffort,
  refreshNotificationRepositoryEntitlements,
} from '../routes/githubRoutes.js';
import { configureDemoMode, resetConfiguredDemoMode } from '../demoMode.js';
import {
  ensureEntitlementRefreshRegistration,
  type EntitlementRefreshTimerScheduler,
} from '../routes/notificationEntitlementRefreshScheduler.js';

let database: Knex;

beforeEach(async () => {
  database = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  await hardenNotificationProjection(database);
  await hardenNotificationFollowup(database);
  await fenceNotificationEntitlements(database);
  await fenceEntitlementInvalidation(database);
});

afterEach(async () => {
  await database.destroy();
});

after(async () => {
  await closeConnection();
});

function createManualTimers(): {
  scheduler: EntitlementRefreshTimerScheduler;
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
  let markRefreshStarted!: () => void;
  const refreshStarted = new Promise<void>(resolve => { markRefreshStarted = resolve; });
  let refreshFinished = false;
  const middleware = createNotificationEntitlementRefreshMiddleware(database, {
    refresh: async () => {
      markRefreshStarted();
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
  await refreshStarted;
  finishRefresh();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshFinished, true);
  middleware.close();
});

test('scheduled entitlement refresh continues after authenticated traffic stops', async () => {
  await database('notification_repository_entitlement_snapshots').insert({
    user_id: 'inactive-user',
    verified_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 1_000).toISOString(),
  });
  let refreshes = 0;
  let markInitial!: () => void;
  let markScheduled!: () => void;
  const initial = new Promise<void>(resolve => { markInitial = resolve; });
  const scheduled = new Promise<void>(resolve => { markScheduled = resolve; });
  const timers = createManualTimers();
  const middleware = createNotificationEntitlementRefreshMiddleware(database, {
    timerScheduler: timers.scheduler,
    refresh: async () => {
      refreshes++;
      if (refreshes === 1) markInitial();
      if (refreshes === 2) markScheduled();
      return true;
    },
  });
  try {
    middleware({
      user: { id: 'inactive-user', accessToken: 'token' },
      path: '/config/repos',
    } as never, {} as never, () => undefined);

    await waitForSignal(initial, 'the initial entitlement refresh');
    await new Promise(resolve => setImmediate(resolve));
    timers.runAll();
    await waitForSignal(scheduled, 'the scheduled entitlement refresh');
    assert.equal(refreshes, 2);
  } finally {
    middleware.close();
  }
});

test('scheduled entitlement refresh does not resurrect an invalidated user', async () => {
  await database('notification_repository_entitlement_snapshots').insert({
    user_id: 'logged-out-user',
    verified_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 1_000).toISOString(),
  });
  await database('notification_repository_entitlements').insert({
    user_id: 'logged-out-user',
    repository: 'acme/private',
    verified_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 1_000).toISOString(),
  });
  let refreshes = 0;
  const timers = createManualTimers();
  const refreshingReplica = createNotificationEntitlementRefreshMiddleware(database, {
    timerScheduler: timers.scheduler,
    refresh: async () => { refreshes++; return true; },
  });
  const logoutReplica = createNotificationEntitlementRefreshMiddleware(database);
  try {
    refreshingReplica({
      user: { id: 'logged-out-user', accessToken: 'token' },
      path: '/github/repos',
    } as never, {} as never, () => undefined);
    let registration: unknown;
    for (let attempt = 0; attempt < 10 && !registration; attempt++) {
      registration = await database('notification_repository_entitlement_refresh_leases')
        .where({ user_id: 'logged-out-user' }).first('user_id');
      if (!registration) await new Promise(resolve => setImmediate(resolve));
    }
    assert.ok(registration, 'refreshing replica should register its retained token durably');
    await logoutReplica.invalidate('logged-out-user');

    timers.runAll();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(refreshes, 0);
    assert.equal(await database('notification_repository_entitlements').count({ count: '*' }).first()
      .then(row => Number(row?.count)), 0);
    assert.equal(await database('notification_repository_entitlement_snapshots').count({ count: '*' }).first()
      .then(row => Number(row?.count)), 0);
    assert.equal(await database('notification_repository_entitlement_refresh_leases')
      .whereNotNull('invalidated_at')
      .count({ count: '*' }).first().then(row => Number(row?.count)), 1);
  } finally {
    refreshingReplica.close();
    logoutReplica.close();
  }
});

test('a registration that completes after cross-replica logout cannot clear the tombstone', async () => {
  let releaseRegistration!: () => void;
  let markRegistrationStarted!: () => void;
  const registrationStarted = new Promise<void>(resolve => { markRegistrationStarted = resolve; });
  const registrationGate = new Promise<void>(resolve => { releaseRegistration = resolve; });
  let refreshes = 0;
  const refreshingReplica = createNotificationEntitlementRefreshMiddleware(database, {
    timerScheduler: createManualTimers().scheduler,
    ensureRegistration: async (registrationDatabase, userId) => {
      markRegistrationStarted();
      await registrationGate;
      return ensureEntitlementRefreshRegistration(registrationDatabase, userId);
    },
    refresh: async () => { refreshes++; return true; },
  });
  const logoutReplica = createNotificationEntitlementRefreshMiddleware(database);
  try {
    refreshingReplica({
      user: { id: 'registration-race-user', accessToken: 'retained-token' },
      path: '/config/repos',
    } as never, {} as never, () => undefined);
    await waitForSignal(registrationStarted, 'the delayed scheduler registration');

    await logoutReplica.invalidate('registration-race-user');
    releaseRegistration();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(refreshes, 0);
    assert.equal(await ensureEntitlementRefreshRegistration(
      database,
      'registration-race-user'
    ), false);
    const tombstone = await database('notification_repository_entitlement_refresh_leases')
      .where({ user_id: 'registration-race-user' })
      .first('invalidated_at');
    assert.equal(typeof tombstone.invalidated_at, 'string');
  } finally {
    refreshingReplica.close();
    logoutReplica.close();
  }
});

test('cross-replica logout fences an in-flight repository scan commit', async () => {
  let releaseScan!: () => void;
  let markScanStarted!: () => void;
  const scanStarted = new Promise<void>(resolve => { markScanStarted = resolve; });
  const logoutReplica = createNotificationEntitlementRefreshMiddleware(database);
  const scan = refreshNotificationRepositoryEntitlements({
    userId: 'logout-scan-race-user',
    accessToken: 'retained-token',
    database,
    force: true,
    listRepositories: async () => {
      markScanStarted();
      await new Promise<void>(resolve => { releaseScan = resolve; });
      return ['acme/revoked'];
    },
  });
  try {
    await waitForSignal(scanStarted, 'the in-flight entitlement scan');
    await logoutReplica.invalidate('logout-scan-race-user');
    releaseScan();

    assert.equal(await scan, false);
    assert.equal(await database('notification_repository_entitlements')
      .where({ user_id: 'logout-scan-race-user' })
      .count({ count: '*' }).first().then(row => Number(row?.count)), 0);
    assert.equal(await database('notification_repository_entitlement_snapshots')
      .where({ user_id: 'logout-scan-race-user' })
      .count({ count: '*' }).first().then(row => Number(row?.count)), 0);
  } finally {
    logoutReplica.close();
  }
});

test('a successful login activation clears a prior entitlement tombstone', async () => {
  const middleware = createNotificationEntitlementRefreshMiddleware(database);
  try {
    await middleware.invalidate('returning-user');
    assert.equal(await ensureEntitlementRefreshRegistration(database, 'returning-user'), false);

    await middleware.activate('returning-user');

    assert.equal(await ensureEntitlementRefreshRegistration(database, 'returning-user'), true);
    const row = await database('notification_repository_entitlement_refresh_leases')
      .where({ user_id: 'returning-user' })
      .first('invalidated_at');
    assert.equal(row.invalidated_at, null);
  } finally {
    middleware.close();
  }
});

test('repeated authenticated activation does not rotate an active entitlement fence', async () => {
  const middleware = createNotificationEntitlementRefreshMiddleware(database);
  try {
    await middleware.activate('active-session-user');
    const before = await database('notification_repository_entitlement_refresh_leases')
      .where({ user_id: 'active-session-user' })
      .first('lease_token', 'fencing_token', 'invalidated_at');

    await middleware.activate('active-session-user');

    const afterActivation = await database('notification_repository_entitlement_refresh_leases')
      .where({ user_id: 'active-session-user' })
      .first('lease_token', 'fencing_token', 'invalidated_at');
    assert.deepEqual(afterActivation, before);
  } finally {
    middleware.close();
  }
});

test('repository listing returns a retry error when a forced refresh never scans GitHub', async () => {
  configureDemoMode(false);
  let scans = 0;
  let statusCode = 200;
  let responseBody: unknown;
  const response = {
    status(code: number) { statusCode = code; return this; },
    json(body: unknown) { responseBody = body; return this; },
  };
  const routes = createGitHubRoutes({
    redisClient: {} as never,
    taskQueue: {} as never,
    db: database,
    refreshNotificationEntitlements: async () => false,
    listNotificationRepositories: async () => { scans++; return []; },
  });
  try {
    await routes.getRepos({
      user: { id: 'fenced-user', accessToken: 'valid-token' },
    } as never, response as never);

    assert.equal(scans, 0);
    assert.equal(statusCode, 503);
    assert.deepEqual(responseBody, {
      error: 'Repository entitlement refresh unavailable',
      code: 'ENTITLEMENT_REFRESH_UNAVAILABLE',
      message: 'Repository access could not be refreshed. Please retry shortly.',
    });
  } finally {
    resetConfiguredDemoMode();
  }
});

test('a hung repository scan is aborted and releases its durable lease', async () => {
  let signal: AbortSignal | undefined;
  await assert.rejects(refreshNotificationRepositoryEntitlements({
    userId: 'hung-scan-user',
    accessToken: 'token',
    database,
    force: true,
    operationTimeoutMs: 20,
    listRepositories: async (_token, operationSignal) => {
      signal = operationSignal;
      return new Promise<string[]>(() => undefined);
    },
  }), /exceeded 20ms/);

  assert.equal(signal?.aborted, true);
  const lease = await database('notification_repository_entitlement_refresh_leases')
    .where({ user_id: 'hung-scan-user' })
    .first('expires_at');
  assert.ok(Date.parse(lease.expires_at) <= Date.now());
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
  const lease = await database('notification_repository_entitlement_refresh_leases')
    .where({ user_id: 'backoff-user' })
    .first('retry_after');
  assert.ok(Date.parse(lease.retry_after) > Date.now());
  await refreshNotificationRepositoryEntitlements(options);
  assert.equal(scans, 1);

  await assert.rejects(
    refreshNotificationRepositoryEntitlements({ ...options, force: true }),
    /GitHub unavailable/
  );
  assert.equal(scans, 2);
});

test('a newer forced scan fences an older in-process scan', async () => {
  let releaseOlder!: () => void;
  let olderStarted!: () => void;
  let newerStarted!: () => void;
  const started = new Promise<void>(resolve => { olderStarted = resolve; });
  const newerScanning = new Promise<void>(resolve => { newerStarted = resolve; });
  const older = refreshNotificationRepositoryEntitlements({
    userId: 'serialized-user',
    accessToken: 'old-token',
    database,
    force: true,
    listRepositories: async () => {
      olderStarted();
      await new Promise<void>(resolve => { releaseOlder = resolve; });
      return ['acme/revoked'];
    },
  });
  await started;
  const newer = refreshNotificationRepositoryEntitlements({
    userId: 'serialized-user',
    accessToken: 'new-token',
    database,
    force: true,
    listRepositories: async () => {
      newerStarted();
      return ['acme/current'];
    },
  });
  await newerScanning;
  releaseOlder();
  await Promise.all([older, newer]);

  assert.deepEqual(
    await database('notification_repository_entitlements').pluck('repository'),
    ['acme/current']
  );
});

test('an expired older scan cannot commit after a newer fencing token', async () => {
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  await database('notification_repository_entitlement_refresh_leases').insert({
    user_id: 'fenced-user',
    lease_token: 'new-lease',
    fencing_token: 2,
    expires_at: expiresAt,
    retry_after: null,
  });
  assert.equal(await replaceNotificationRepositoryEntitlements({
    userId: 'fenced-user',
    repositories: ['acme/current'],
    database,
    fence: { leaseToken: 'new-lease', fencingToken: 2 },
  }), true);
  assert.equal(await replaceNotificationRepositoryEntitlements({
    userId: 'fenced-user',
    repositories: ['acme/revoked'],
    database,
    fence: { leaseToken: 'old-lease', fencingToken: 1 },
  }), false);
  assert.deepEqual(
    await database('notification_repository_entitlements').pluck('repository'),
    ['acme/current']
  );
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

test('entitlement invalidation surfaces persistence failures to session cleanup', async () => {
  const middleware = createNotificationEntitlementRefreshMiddleware(database);
  await database.schema.dropTable('notification_repository_entitlements');
  try {
    await assert.rejects(middleware.invalidate('logout-failure-user'), /no such table/);
  } finally {
    middleware.close();
  }
});
