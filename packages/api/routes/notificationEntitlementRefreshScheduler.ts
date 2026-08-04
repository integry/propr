import type { NextFunction, Request, Response } from 'express';
import type { Knex } from 'knex';
import { getNotificationRepositoryEntitlementTtlMs, logger } from '@propr/core';

const REFRESH_RETRY_DELAY_MS = 60_000;
const MAX_SCHEDULED_REFRESHES = 1_000;

interface ScheduledRefresh {
  accessToken: string;
  timer: NodeJS.Timeout;
  controller?: AbortController;
  registrationEstablished: boolean;
  retry: boolean;
}

interface RefreshInput {
  userId: string;
  accessToken: string;
  database: Knex;
  signal?: AbortSignal;
}

interface ScheduledEntitlementRefreshOptions {
  maxScheduledRefreshes?: number;
}

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
    .hasTable('notification_repository_entitlement_refresh_leases')) return false;
  const retryLease = await database('notification_repository_entitlement_refresh_leases')
    .where({ user_id: userId })
    .first('user_id');
  return retryLease !== undefined;
}

async function ensureEntitlementRefreshRegistration(
  database: Knex,
  userId: string
): Promise<boolean> {
  if (!await database.schema
    .hasTable('notification_repository_entitlement_refresh_leases')) return false;
  await database('notification_repository_entitlement_refresh_leases').insert({
    user_id: userId,
    lease_token: 'notification-scheduler-registration',
    expires_at: new Date(0).toISOString(),
  }).onConflict('user_id').ignore();
  return true;
}

export interface NotificationEntitlementRefreshMiddleware {
  (req: Request, res: Response, next: NextFunction): void;
  invalidate(userId: string): Promise<void>;
  close(): void;
}

export async function invalidateNotificationRepositoryEntitlements(
  database: Knex,
  userId: string
): Promise<void> {
  try {
    const hasRefreshLeases = await database.schema
      .hasTable('notification_repository_entitlement_refresh_leases');
    await database.transaction(async (transaction) => {
      await transaction('notification_repository_entitlements').where({ user_id: userId }).delete();
      await transaction('notification_repository_entitlement_snapshots').where({ user_id: userId }).delete();
      if (hasRefreshLeases) {
        await transaction('notification_repository_entitlement_refresh_leases')
          .where({ user_id: userId }).delete();
      }
    });
  } catch (error) {
    logger.warn({ userId, error: error instanceof Error ? error.message : String(error) },
      'Failed to invalidate cached repository notification access');
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
  if (!Number.isSafeInteger(maxScheduledRefreshes) || maxScheduledRefreshes <= 0) {
    throw new TypeError('maxScheduledRefreshes must be a positive safe integer');
  }
  let closed = false;

  const removeEntry = (userId: string, entry: ScheduledRefresh): void => {
    if (scheduled.get(userId) === entry) scheduled.delete(userId);
    clearTimeout(entry.timer);
    entry.controller?.abort();
  };

  const runRefresh = (userId: string, entry: ScheduledRefresh): void => {
    if (closed || scheduled.get(userId) !== entry) return;
    const controller = new AbortController();
    entry.controller?.abort();
    entry.controller = controller;
    void refresh({
      userId,
      accessToken: entry.accessToken,
      database,
      signal: controller.signal,
    }).then((result) => {
      if (closed || scheduled.get(userId) !== entry || controller.signal.aborted) return;
      entry.controller = undefined;
      schedule(userId, entry.accessToken, result === false, entry.registrationEstablished);
    }).catch((error) => {
      if (closed || scheduled.get(userId) !== entry || controller.signal.aborted) return;
      entry.controller = undefined;
      logger.warn({ error: error instanceof Error ? error.message : String(error) },
        'Repository notification access refresh failed');
      schedule(userId, entry.accessToken, true, entry.registrationEstablished);
    });
  };

  const schedule = (
    userId: string,
    accessToken: string,
    retry = false,
    registrationEstablished?: boolean
  ): void => {
    if (closed) return;
    const previous = scheduled.get(userId);
    const retainedRegistration = registrationEstablished
      ?? previous?.registrationEstablished
      ?? false;
    if (previous) removeEntry(userId, previous);
    if (scheduled.size >= maxScheduledRefreshes) {
      const oldestUserId = scheduled.keys().next().value as string | undefined;
      if (oldestUserId) {
        const oldest = scheduled.get(oldestUserId)!;
        removeEntry(oldestUserId, oldest);
        logger.warn({ evictedUserId: oldestUserId, capacity: maxScheduledRefreshes },
          'Evicted least-recently-observed repository entitlement refresh');
      }
    }
    const ttlMs = getNotificationRepositoryEntitlementTtlMs();
    const delayMs = retry
      ? Math.max(1, Math.min(REFRESH_RETRY_DELAY_MS, Math.floor(ttlMs / 4)))
      : Math.max(1, Math.floor(ttlMs / 2));
    const entry: ScheduledRefresh = {
      accessToken,
      retry,
      timer: setTimeout(() => {
        if (closed || scheduled.get(userId) !== entry) return;
        void hasEntitlementRefreshRegistration(database, userId, entry.retry)
          .then(async (registered) => {
            if (closed || scheduled.get(userId) !== entry) return;
            // Logout and auth-failure invalidation delete this snapshot. Do not
            // resurrect authorization later with a token retained by the timer.
            if (!registered) {
              if (entry.registrationEstablished) {
                removeEntry(userId, entry);
                return;
              }
              entry.registrationEstablished =
                await ensureEntitlementRefreshRegistration(database, userId);
              if (!entry.registrationEstablished) {
                removeEntry(userId, entry);
                return;
              }
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
      }, delayMs),
      registrationEstablished: retainedRegistration,
    };
    entry.timer.unref();
    scheduled.set(userId, entry);
  };

  const middleware = (req: Request, _res: Response, next: NextFunction): void => {
    const userId = req.user?.id;
    const accessToken = req.user?.accessToken;
    if (!userId || !accessToken) {
      next();
      return;
    }
    schedule(userId, accessToken);
    const entry = scheduled.get(userId)!;
    const refreshImmediately = req.path !== '/github/repos';
    void ensureEntitlementRefreshRegistration(database, userId)
      .then((registered) => {
        if (closed || scheduled.get(userId) !== entry) return;
        entry.registrationEstablished = registered;
        if (refreshImmediately) {
          runRefresh(userId, entry);
        }
      })
      .catch((error) => {
        logger.warn({ error: error instanceof Error ? error.message : String(error) },
          'Failed to register repository notification access refresh');
        if (!closed && scheduled.get(userId) === entry) {
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
  middleware.close = (): void => {
    closed = true;
    for (const [userId, entry] of scheduled) removeEntry(userId, entry);
    scheduled.clear();
  };
  return middleware;
}
