import type { NextFunction, Request, Response } from 'express';
import type { Knex } from 'knex';
import { getNotificationRepositoryEntitlementTtlMs, logger } from '@propr/core';
import {
  loadRecoverableEntitlementCredentials,
  type RecoveredEntitlementCredential,
} from './notificationEntitlementSessionRecovery.js';
import {
  activateNotificationRepositoryEntitlements,
  ensureEntitlementRefreshRegistration,
  ENTITLEMENT_REFRESH_LEASE_TABLE,
  invalidateNotificationRepositoryEntitlements,
} from './notificationEntitlementFencing.js';
export {
  activateNotificationRepositoryEntitlements,
  ensureEntitlementRefreshRegistration,
  invalidateNotificationRepositoryEntitlements,
} from './notificationEntitlementFencing.js';

const REFRESH_RETRY_DELAY_MS = 60_000;
const MAX_SCHEDULED_REFRESHES = 1_000;
const MAX_SCHEDULED_REFRESHES_ENV = 'NOTIFICATION_ENTITLEMENT_MAX_SCHEDULED_REFRESHES';
const RECOVERY_CONCURRENCY = 4;

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
  loadRecoveryCredentials?: (database: Knex) => Promise<RecoveredEntitlementCredential[]>;
}

const DEFAULT_TIMER_SCHEDULER: EntitlementRefreshTimerScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
};

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
    .hasTable(ENTITLEMENT_REFRESH_LEASE_TABLE)) return false;
  const retryLeaseQuery = database(ENTITLEMENT_REFRESH_LEASE_TABLE).where({ user_id: userId });
  if (await database.schema.hasColumn(ENTITLEMENT_REFRESH_LEASE_TABLE, 'invalidated_at')) {
    retryLeaseQuery.whereNull('invalidated_at');
  }
  const retryLease = await retryLeaseQuery
    .first('user_id');
  return retryLease !== undefined;
}

export interface NotificationEntitlementRefreshMiddleware {
  (req: Request, res: Response, next: NextFunction): void;
  invalidate(userId: string, authGeneration: string): Promise<void>;
  activate(userId: string, authGeneration: string): Promise<void>;
  updateCredential(userId: string, accessToken: string): void;
  recover(): Promise<void>;
  close(): void;
}

function getMaxScheduledRefreshes(): number {
  const configured = process.env[MAX_SCHEDULED_REFRESHES_ENV];
  if (configured === undefined) return MAX_SCHEDULED_REFRESHES;
  const parsed = Number(configured);
  if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  logger.warn({ value: configured, fallback: MAX_SCHEDULED_REFRESHES },
    `${MAX_SCHEDULED_REFRESHES_ENV} must be a positive safe integer`);
  return MAX_SCHEDULED_REFRESHES;
}

/** Keeps refreshing observed authenticated users after request traffic stops. */
export function createScheduledEntitlementRefreshMiddleware(
  database: Knex,
  refresh: (options: RefreshInput) => Promise<unknown>,
  options: ScheduledEntitlementRefreshOptions = {}
): NotificationEntitlementRefreshMiddleware {
  const scheduled = new Map<string, ScheduledRefresh>();
  const maxScheduledRefreshes = options.maxScheduledRefreshes ?? getMaxScheduledRefreshes();
  const timerScheduler = options.timerScheduler ?? DEFAULT_TIMER_SCHEDULER;
  const ensureRegistration = options.ensureRegistration ?? ensureEntitlementRefreshRegistration;
  const loadRecoveryCredentials = options.loadRecoveryCredentials
    ?? loadRecoverableEntitlementCredentials;
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

  const runRefresh = async (userId: string, entry: ScheduledRefresh): Promise<void> => {
    if (closed || scheduled.get(userId) !== entry || entry.controller) return;
    if (entry.timer) timerScheduler.clearTimeout(entry.timer);
    entry.timer = undefined;
    const controller = new AbortController();
    entry.controller = controller;
    try {
      const result = await refresh({
        userId,
        accessToken: entry.accessToken,
        database,
        signal: controller.signal,
      });
      if (closed || scheduled.get(userId) !== entry || controller.signal.aborted) return;
      if (entry.controller === controller) entry.controller = undefined;
      schedule(userId, entry.accessToken, result === false, entry.registrationEstablished);
    } catch (error) {
      if (closed || scheduled.get(userId) !== entry || controller.signal.aborted) return;
      if (entry.controller === controller) entry.controller = undefined;
      logger.warn({ error: error instanceof Error ? error.message : String(error) },
        'Repository notification access refresh failed');
      schedule(userId, entry.accessToken, true, entry.registrationEstablished);
    }
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
          void runRefresh(userId, entry);
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
          void runRefresh(userId, entry);
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
  middleware.invalidate = async (userId: string, authGeneration: string): Promise<void> => {
    const entry = scheduled.get(userId);
    if (entry) removeEntry(userId, entry);
    await invalidateNotificationRepositoryEntitlements(database, userId, authGeneration);
  };
  middleware.activate = (userId: string, authGeneration: string): Promise<void> =>
    activateNotificationRepositoryEntitlements(database, userId, authGeneration);
  middleware.updateCredential = (userId: string, accessToken: string): void => {
    const entry = scheduled.get(userId);
    if (entry && accessToken) entry.accessToken = accessToken;
  };
  middleware.recover = async (): Promise<void> => {
    const credentials = await loadRecoveryCredentials(database);
    if (closed) return;
    const available = Math.max(0, maxScheduledRefreshes - scheduled.size);
    const retained = credentials.slice(0, available);
    let skipped = credentials.length - retained.length;
    if (skipped > 0) {
      logger.warn({ recoveredCandidates: credentials.length, capacity: maxScheduledRefreshes, skipped },
        'Repository entitlement restart recovery exceeded configured capacity');
    }
    let recovered = 0;
    for (let offset = 0; offset < retained.length && !closed; offset += RECOVERY_CONCURRENCY) {
      await Promise.all(retained.slice(offset, offset + RECOVERY_CONCURRENCY).map(async credential => {
        if (closed || scheduled.has(credential.userId)) return;
        if (scheduled.size >= maxScheduledRefreshes) {
          skipped++;
          return;
        }
        schedule(credential.userId, credential.accessToken, false, true);
        const entry = scheduled.get(credential.userId);
        if (!entry) return;
        recovered++;
        await runRefresh(credential.userId, entry);
      }));
    }
    logger.info({ recovered, skipped }, 'Recovered repository entitlement refresh schedules');
  };
  middleware.close = (): void => {
    closed = true;
    for (const [userId, entry] of scheduled) removeEntry(userId, entry);
    scheduled.clear();
  };
  return middleware;
}
