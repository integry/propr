import type { NextFunction, Request, Response } from 'express';
import type { Knex } from 'knex';
import { getNotificationRepositoryEntitlementTtlMs, logger } from '@propr/core';

const REFRESH_RETRY_DELAY_MS = 60_000;
const MAX_SCHEDULED_REFRESHES = 1_000;

interface ScheduledRefresh {
  accessToken: string;
  timer: NodeJS.Timeout;
}

interface RefreshInput {
  userId: string;
  accessToken: string;
  database: Knex;
}

async function hasEntitlementSnapshot(database: Knex, userId: string): Promise<boolean> {
  const snapshot = await database('notification_repository_entitlement_snapshots')
    .where({ user_id: userId })
    .first('user_id');
  return snapshot !== undefined;
}

export interface NotificationEntitlementRefreshMiddleware {
  (req: Request, res: Response, next: NextFunction): void;
  close(): void;
}

/** Keeps refreshing observed authenticated users after request traffic stops. */
export function createScheduledEntitlementRefreshMiddleware(
  database: Knex,
  refresh: (options: RefreshInput) => Promise<unknown>
): NotificationEntitlementRefreshMiddleware {
  const scheduled = new Map<string, ScheduledRefresh>();
  let closed = false;

  const schedule = (userId: string, accessToken: string, retry = false): void => {
    if (closed) return;
    const previous = scheduled.get(userId);
    if (previous) clearTimeout(previous.timer);
    if (!previous && scheduled.size >= MAX_SCHEDULED_REFRESHES) {
      const oldestUserId = scheduled.keys().next().value as string | undefined;
      if (oldestUserId) {
        clearTimeout(scheduled.get(oldestUserId)!.timer);
        scheduled.delete(oldestUserId);
      }
    }
    const ttlMs = getNotificationRepositoryEntitlementTtlMs();
    const delayMs = retry
      ? Math.max(1, Math.min(REFRESH_RETRY_DELAY_MS, Math.floor(ttlMs / 4)))
      : Math.max(1, Math.floor(ttlMs / 2));
    const entry: ScheduledRefresh = {
      accessToken,
      timer: setTimeout(() => {
        if (closed || scheduled.get(userId) !== entry) return;
        void hasEntitlementSnapshot(database, userId)
          .then(async (registered) => {
            if (closed || scheduled.get(userId) !== entry) return;
            // Logout and auth-failure invalidation delete this snapshot. Do not
            // resurrect authorization later with a token retained by the timer.
            if (!registered) {
              if (scheduled.get(userId) === entry) scheduled.delete(userId);
              return;
            }
            const result = await refresh({ userId, accessToken: entry.accessToken, database });
            schedule(userId, entry.accessToken, result === false);
          })
          .catch((error) => {
            logger.warn({ error: error instanceof Error ? error.message : String(error) },
              'Scheduled repository notification access refresh failed');
            schedule(userId, entry.accessToken, true);
          });
      }, delayMs),
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
    if (req.path !== '/github/repos') {
      void refresh({ userId, accessToken, database }).catch((error) => {
        logger.warn({ error: error instanceof Error ? error.message : String(error) },
          'Failed to refresh repository notification access');
      });
    }
    next();
  };
  middleware.close = (): void => {
    closed = true;
    for (const entry of scheduled.values()) clearTimeout(entry.timer);
    scheduled.clear();
  };
  return middleware;
}
