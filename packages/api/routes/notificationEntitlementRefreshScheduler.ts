import type { NextFunction, Request, Response } from 'express';
import type { Knex } from 'knex';
import { getNotificationRepositoryEntitlementTtlMs, logger } from '@propr/core';

const REFRESH_RETRY_DELAY_MS = 60_000;
const MAX_SCHEDULED_REFRESHES = 1_000;

interface ScheduledRefresh {
  accessToken: string;
  timer?: EntitlementRefreshTimer;
  controller?: AbortController;
  registrationEstablished: boolean;
  registration?: Promise<boolean>;
  retry: boolean;
}

interface RefreshInput {
  userId: string;
  accessToken: string;
  database: Knex;
  signal?: AbortSignal;
}

export interface EntitlementRefreshTimer {
  unref(): void;
}

export interface EntitlementRefreshTimerScheduler {
  setTimeout(callback: () => void, delayMs: number): EntitlementRefreshTimer;
  clearTimeout(timer: EntitlementRefreshTimer): void;
}

interface ScheduledEntitlementRefreshOptions {
  maxScheduledRefreshes?: number;
  timerScheduler?: EntitlementRefreshTimerScheduler;
  ensureRegistration?: typeof ensureEntitlementRefreshRegistration;
}

const DEFAULT_TIMER_SCHEDULER: EntitlementRefreshTimerScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
};

const LEASE_TABLE = 'notification_repository_entitlement_refresh_leases';
const REGISTRATION_TOKEN = 'notification-scheduler-registration';
const INVALIDATION_TOKEN = 'notification-logout-tombstone';
const tombstoneSupport = new WeakMap<object, Promise<boolean>>();

async function hasEntitlementRefreshRegistration(
  database: Knex,
  userId: string,
  retry: boolean
): Promise<boolean> {
  const snapshot = await database('notification_repository_entitlement_snapshots')
    .where({ user_id: userId })
    .first('user_id');
  if (snapshot !== undefined) return true;
  if (!retry || !await database.schema
    .hasTable(LEASE_TABLE)) return false;
  const retryLeaseQuery = database(LEASE_TABLE).where({ user_id: userId });
  if (await database.schema.hasColumn(LEASE_TABLE, 'invalidated_at')) {
    retryLeaseQuery.whereNull('invalidated_at');
  }
  const retryLease = await retryLeaseQuery
    .first('user_id');
  return retryLease !== undefined;
}

export async function ensureEntitlementRefreshRegistration(
  database: Knex,
  userId: string
): Promise<boolean> {
  if (!await database.schema.hasTable(LEASE_TABLE)) return false;
  await database(LEASE_TABLE).insert({
    user_id: userId,
    lease_token: REGISTRATION_TOKEN,
    expires_at: new Date(0).toISOString(),
  }).onConflict('user_id').ignore();
  const registration = database(LEASE_TABLE).where({ user_id: userId });
  if (await database.schema.hasColumn(LEASE_TABLE, 'invalidated_at')) {
    registration.whereNull('invalidated_at');
  }
  return await registration.first('user_id') !== undefined;
}

export interface NotificationEntitlementRefreshMiddleware {
  (req: Request, res: Response, next: NextFunction): void;
  invalidate(userId: string): Promise<void>;
  activate(userId: string): Promise<void>;
  close(): void;
}

async function supportsEntitlementInvalidationTombstones(database: Knex): Promise<boolean> {
  let supported = tombstoneSupport.get(database);
  if (!supported) {
    supported = (async () => await database.schema.hasTable(LEASE_TABLE)
      && await database.schema.hasColumn(LEASE_TABLE, 'fencing_token')
      && await database.schema.hasColumn(LEASE_TABLE, 'retry_after')
      && await database.schema.hasColumn(LEASE_TABLE, 'invalidated_at'))();
    tombstoneSupport.set(database, supported);
    void supported.then(
      (value) => { if (!value && tombstoneSupport.get(database) === supported) {
        tombstoneSupport.delete(database);
      } },
      () => { if (tombstoneSupport.get(database) === supported) {
        tombstoneSupport.delete(database);
      } }
    );
  }
  return supported;
}

export async function activateNotificationRepositoryEntitlements(
  database: Knex,
  userId: string
): Promise<void> {
  if (!await supportsEntitlementInvalidationTombstones(database)) {
    await ensureEntitlementRefreshRegistration(database, userId);
    return;
  }
  const expiresAt = new Date(0).toISOString();
  await database(LEASE_TABLE).insert({
    user_id: userId,
    lease_token: REGISTRATION_TOKEN,
    fencing_token: 1,
    expires_at: expiresAt,
    retry_after: null,
    invalidated_at: null,
  }).onConflict('user_id').merge({
    lease_token: REGISTRATION_TOKEN,
    fencing_token: database.raw(`${LEASE_TABLE}.fencing_token + 1`),
    expires_at: expiresAt,
    retry_after: null,
    invalidated_at: null,
  }).whereNotNull('invalidated_at');
}

export async function invalidateNotificationRepositoryEntitlements(
  database: Knex,
  userId: string
): Promise<void> {
  try {
    const hasRefreshLeases = await database.schema.hasTable(LEASE_TABLE);
    const hasTombstones = hasRefreshLeases
      && await supportsEntitlementInvalidationTombstones(database);
    await database.transaction(async (transaction) => {
      await transaction('notification_repository_entitlements').where({ user_id: userId }).delete();
      await transaction('notification_repository_entitlement_snapshots').where({ user_id: userId }).delete();
      if (hasTombstones) {
        const invalidatedAt = new Date().toISOString();
        const expiresAt = new Date(0).toISOString();
        await transaction(LEASE_TABLE).insert({
          user_id: userId,
          lease_token: INVALIDATION_TOKEN,
          fencing_token: 1,
          expires_at: expiresAt,
          retry_after: null,
          invalidated_at: invalidatedAt,
        }).onConflict('user_id').merge({
          lease_token: INVALIDATION_TOKEN,
          fencing_token: transaction.raw(`${LEASE_TABLE}.fencing_token + 1`),
          expires_at: expiresAt,
          retry_after: null,
          invalidated_at: invalidatedAt,
        });
      } else if (hasRefreshLeases) {
        await transaction(LEASE_TABLE).where({ user_id: userId }).delete();
      }
    });
  } catch (error) {
    logger.warn({ userId, error: error instanceof Error ? error.message : String(error) },
      'Failed to invalidate cached repository notification access');
    throw error;
  }
}

/** Keeps refreshing observed authenticated users after request traffic stops. */
export function createScheduledEntitlementRefreshMiddleware(
  database: Knex,
  refresh: (options: RefreshInput) => Promise<unknown>,
  options: ScheduledEntitlementRefreshOptions = {}
): NotificationEntitlementRefreshMiddleware {
  const scheduled = new Map<string, ScheduledRefresh>();
  const maxScheduledRefreshes = options.maxScheduledRefreshes ?? MAX_SCHEDULED_REFRESHES;
  const timerScheduler = options.timerScheduler ?? DEFAULT_TIMER_SCHEDULER;
  const ensureRegistration = options.ensureRegistration ?? ensureEntitlementRefreshRegistration;
  if (!Number.isSafeInteger(maxScheduledRefreshes) || maxScheduledRefreshes <= 0) {
    throw new TypeError('maxScheduledRefreshes must be a positive safe integer');
  }
  let closed = false;

  const removeEntry = (userId: string, entry: ScheduledRefresh): void => {
    if (scheduled.get(userId) === entry) scheduled.delete(userId);
    if (entry.timer) timerScheduler.clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.controller?.abort();
    entry.controller = undefined;
  };

  const runRefresh = (userId: string, entry: ScheduledRefresh): void => {
    if (closed || scheduled.get(userId) !== entry || entry.controller) return;
    if (entry.timer) timerScheduler.clearTimeout(entry.timer);
    entry.timer = undefined;
    const controller = new AbortController();
    entry.controller = controller;
    void refresh({
      userId,
      accessToken: entry.accessToken,
      database,
      signal: controller.signal,
    }).then((result) => {
      if (closed || scheduled.get(userId) !== entry || controller.signal.aborted) return;
      if (entry.controller === controller) entry.controller = undefined;
      schedule(userId, entry.accessToken, result === false, entry.registrationEstablished);
    }).catch((error) => {
      if (closed || scheduled.get(userId) !== entry || controller.signal.aborted) return;
      if (entry.controller === controller) entry.controller = undefined;
      logger.warn({ error: error instanceof Error ? error.message : String(error) },
        'Repository notification access refresh failed');
      schedule(userId, entry.accessToken, true, entry.registrationEstablished);
    });
  };

  const schedule = (
    userId: string,
    accessToken: string,
    retry?: boolean,
    registrationEstablished?: boolean
  ): void => {
    if (closed) return;
    const previous = scheduled.get(userId);
    if (previous) {
      previous.accessToken = accessToken;
      if (retry !== undefined) previous.retry = retry;
      if (registrationEstablished !== undefined) {
        previous.registrationEstablished = registrationEstablished;
      }
      // Refresh Map insertion order for bounded LRU accounting without
      // cancelling work that is already scanning GitHub.
      scheduled.delete(userId);
      scheduled.set(userId, previous);
      if (!previous.controller && !previous.timer) armTimer(userId, previous);
      return;
    }
    const retainedRegistration = registrationEstablished
      ?? false;
    if (scheduled.size >= maxScheduledRefreshes) {
      const oldestUserId = scheduled.keys().next().value as string | undefined;
      if (oldestUserId) {
        const oldest = scheduled.get(oldestUserId)!;
        removeEntry(oldestUserId, oldest);
        logger.warn({ evictedUserId: oldestUserId, capacity: maxScheduledRefreshes },
          'Evicted least-recently-observed repository entitlement refresh');
      }
    }
    const entry: ScheduledRefresh = {
      accessToken,
      retry: retry ?? false,
      registrationEstablished: retainedRegistration,
    };
    scheduled.set(userId, entry);
    armTimer(userId, entry);
  };

  const armTimer = (userId: string, entry: ScheduledRefresh): void => {
    if (closed || scheduled.get(userId) !== entry || entry.controller) return;
    if (entry.timer) return;
    const ttlMs = getNotificationRepositoryEntitlementTtlMs();
    const delayMs = entry.retry
      ? Math.max(1, Math.min(REFRESH_RETRY_DELAY_MS, Math.floor(ttlMs / 4)))
      : Math.max(1, Math.floor(ttlMs / 2));
    entry.timer = timerScheduler.setTimeout(() => {
      entry.timer = undefined;
      if (closed || scheduled.get(userId) !== entry) return;
      void establishRegistration(userId, entry, true)
        .then((registered) => {
          if (closed || scheduled.get(userId) !== entry) return;
          if (!registered) {
            removeEntry(userId, entry);
            return;
          }
          runRefresh(userId, entry);
        })
        .catch((error) => {
          logger.warn({ error: error instanceof Error ? error.message : String(error) },
            'Scheduled repository notification access refresh failed');
          if (!closed && scheduled.get(userId) === entry) {
            schedule(userId, entry.accessToken, true, entry.registrationEstablished);
          }
        });
    }, delayMs);
    entry.timer.unref();
  };

  const establishRegistration = (
    userId: string,
    entry: ScheduledRefresh,
    checkExisting: boolean
  ): Promise<boolean> => {
    if (!checkExisting && entry.registrationEstablished) return Promise.resolve(true);
    if (entry.registration) return entry.registration;
    const registration = (async () => {
      let registered = false;
      if (checkExisting) {
        registered = await hasEntitlementRefreshRegistration(database, userId, entry.retry);
        if (!registered && entry.registrationEstablished) return false;
      }
      if (!registered) registered = await ensureRegistration(database, userId);
      if (!closed && scheduled.get(userId) === entry) {
        entry.registrationEstablished = registered;
      }
      return registered;
    })();
    entry.registration = registration;
    void registration.then(
      () => { if (entry.registration === registration) entry.registration = undefined; },
      () => { if (entry.registration === registration) entry.registration = undefined; }
    );
    return registration;
  };

  const middleware = (req: Request, _res: Response, next: NextFunction): void => {
    const userId = req.user?.id;
    const accessToken = req.user?.accessToken;
    if (!userId || !accessToken) {
      next();
      return;
    }
    const alreadyScheduled = scheduled.has(userId);
    schedule(userId, accessToken);
    const entry = scheduled.get(userId)!;
    const refreshImmediately = req.path !== '/github/repos';
    if (alreadyScheduled) {
      next();
      return;
    }
    void establishRegistration(userId, entry, false)
      .then((registered) => {
        if (closed || scheduled.get(userId) !== entry) return;
        if (!registered) {
          removeEntry(userId, entry);
        } else if (refreshImmediately) {
          runRefresh(userId, entry);
        }
      })
      .catch((error) => {
        logger.warn({ error: error instanceof Error ? error.message : String(error) },
          'Failed to register repository notification access refresh');
        if (!closed && scheduled.get(userId) === entry) {
          if (entry.timer) timerScheduler.clearTimeout(entry.timer);
          entry.timer = undefined;
          schedule(userId, entry.accessToken, true, false);
        }
      });
    next();
  };
  middleware.invalidate = async (userId: string): Promise<void> => {
    const entry = scheduled.get(userId);
    if (entry) removeEntry(userId, entry);
    await invalidateNotificationRepositoryEntitlements(database, userId);
  };
  middleware.activate = (userId: string): Promise<void> =>
    activateNotificationRepositoryEntitlements(database, userId);
  middleware.close = (): void => {
    closed = true;
    for (const [userId, entry] of scheduled) removeEntry(userId, entry);
    scheduled.clear();
  };
  return middleware;
}
