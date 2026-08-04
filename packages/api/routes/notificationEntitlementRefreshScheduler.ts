import type { NextFunction, Request, Response } from 'express';
import type { Knex } from 'knex';
import {
  getNotificationRepositoryEntitlementTtlMs,
  logger,
  withNotificationDeadline,
} from '@propr/core';
import {
  loadRecoverableEntitlementCredentials,
} from './notificationEntitlementSessionRecovery.js';
import {
  activateNotificationRepositoryEntitlements,
  ensureEntitlementRefreshRegistration,
} from './notificationEntitlementFencing.js';
import { createSessionAuthGeneration } from '../authSessionGeneration.js';
import {
  DEFAULT_TIMER_SCHEDULER,
  getMaxScheduledRefreshes,
  hasEntitlementRefreshRegistration,
  rememberEntitlementSessionCredential,
  updateEntitlementSessionCredential,
  type EntitlementRefreshTimer,
  type NotificationEntitlementRefreshMiddleware,
  type RefreshInput,
  type ScheduledEntitlementRefreshOptions,
} from './notificationEntitlementRefreshSchedulerSupport.js';
import { invalidateScheduledEntitlementRefresh }
  from './notificationEntitlementRefreshInvalidation.js';
export type {
  EntitlementRefreshTimer,
  EntitlementRefreshTimerScheduler,
  NotificationEntitlementRefreshMiddleware,
} from './notificationEntitlementRefreshSchedulerSupport.js';
export {
  activateNotificationRepositoryEntitlements,
  ensureEntitlementRefreshRegistration,
  invalidateNotificationRepositoryEntitlements,
} from './notificationEntitlementFencing.js';

const REFRESH_RETRY_DELAY_MS = 60_000;
const RECOVERY_CONCURRENCY = 4;
const REFRESH_SHUTDOWN_TIMEOUT_MS = 5_000;

interface ScheduledRefresh {
  accessToken: string;
  authGeneration?: string;
  credentials: Map<string, string>;
  timer?: EntitlementRefreshTimer;
  controller?: AbortController;
  registrationEstablished: boolean;
  registration?: Promise<boolean>;
  retry: boolean;
}

interface ScheduleOptions {
  retry?: boolean;
  registrationEstablished?: boolean;
  authGeneration?: string;
}

/** Keeps refreshing observed authenticated users after request traffic stops. */
export function createScheduledEntitlementRefreshMiddleware(
  database: Knex,
  refresh: (options: RefreshInput) => Promise<unknown>,
  options: ScheduledEntitlementRefreshOptions = {}
): NotificationEntitlementRefreshMiddleware {
  const scheduled = new Map<string, ScheduledRefresh>();
  const activeAuthGenerations = new Map<string, string>();
  const maxScheduledRefreshes = options.maxScheduledRefreshes ?? getMaxScheduledRefreshes();
  const timerScheduler = options.timerScheduler ?? DEFAULT_TIMER_SCHEDULER;
  const ensureRegistration = options.ensureRegistration ?? ensureEntitlementRefreshRegistration;
  const loadRecoveryCredentials = options.loadRecoveryCredentials
    ?? ((recoveryDatabase, maxCredentials) => loadRecoverableEntitlementCredentials(
      recoveryDatabase,
      { maxCredentials }
    ));
  if (!Number.isSafeInteger(maxScheduledRefreshes) || maxScheduledRefreshes <= 0) {
    throw new TypeError('maxScheduledRefreshes must be a positive safe integer');
  }
  let closed = false;
  const activeRefreshes = new Set<Promise<void>>();

  const rememberAuthGeneration = (userId: string, authGeneration: string): void => {
    // Activation precedes the first request carrying the new session's OAuth
    // credential. Remember the generation without retargeting an existing
    // schedule to a credential that still belongs to an older session.
    activeAuthGenerations.delete(userId);
    activeAuthGenerations.set(userId, authGeneration);
    if (activeAuthGenerations.size > maxScheduledRefreshes) {
      const oldestUserId = activeAuthGenerations.keys().next().value as string | undefined;
      if (oldestUserId) activeAuthGenerations.delete(oldestUserId);
    }
  };

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
      schedule(userId, entry.accessToken, {
        retry: result === false,
        registrationEstablished: entry.registrationEstablished,
      });
    } catch (error) {
      if (closed || scheduled.get(userId) !== entry || controller.signal.aborted) return;
      if (entry.controller === controller) entry.controller = undefined;
      logger.warn({ error: error instanceof Error ? error.message : String(error) },
        'Repository notification access refresh failed');
      schedule(userId, entry.accessToken, {
        retry: true,
        registrationEstablished: entry.registrationEstablished,
      });
    }
  };

  const startRefresh = (userId: string, entry: ScheduledRefresh): Promise<void> => {
    const operation = runRefresh(userId, entry);
    activeRefreshes.add(operation);
    void operation.then(
      () => activeRefreshes.delete(operation),
      () => activeRefreshes.delete(operation)
    );
    return operation;
  };

  const schedule = (
    userId: string,
    accessToken: string,
    options: ScheduleOptions = {}
  ): void => {
    const { retry, registrationEstablished, authGeneration: observedAuthGeneration } = options;
    if (closed) return;
    const previous = scheduled.get(userId);
    if (previous) {
      const pendingGeneration = activeAuthGenerations.get(userId);
      if (observedAuthGeneration) {
        rememberEntitlementSessionCredential(previous, observedAuthGeneration, accessToken);
        // The request may land on a different replica from the OAuth callback.
        // Durable registration validation below rejects stale generations before
        // their next scan; locally, bind the credential to the observed session.
        previous.authGeneration = observedAuthGeneration;
        previous.accessToken = accessToken;
        if (pendingGeneration === observedAuthGeneration) {
          activeAuthGenerations.delete(userId);
        }
      } else {
        previous.accessToken = accessToken;
        if (previous.authGeneration) {
          rememberEntitlementSessionCredential(
            previous,
            previous.authGeneration,
            accessToken
          );
        }
      }
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
      authGeneration: observedAuthGeneration,
      credentials: new Map(),
      retry: retry ?? false,
      registrationEstablished: retainedRegistration,
    };
    if (observedAuthGeneration) {
      rememberEntitlementSessionCredential(entry, observedAuthGeneration, accessToken);
      if (activeAuthGenerations.get(userId) === observedAuthGeneration) {
        activeAuthGenerations.delete(userId);
      }
    }
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
          void startRefresh(userId, entry);
        })
        .catch((error) => {
          logger.warn({ error: error instanceof Error ? error.message : String(error) },
            'Scheduled repository notification access refresh failed');
          if (!closed && scheduled.get(userId) === entry) {
            schedule(userId, entry.accessToken, {
              retry: true,
              registrationEstablished: entry.registrationEstablished,
            });
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
        registered = await hasEntitlementRefreshRegistration({
          database,
          userId,
          retry: entry.retry,
          authGeneration: entry.authGeneration,
        });
        if (!registered && entry.registrationEstablished) return false;
      }
      if (!registered) registered = await ensureRegistration(database, userId);
      if (registered && entry.authGeneration) {
        registered = await hasEntitlementRefreshRegistration({
          database,
          userId,
          retry: true,
          authGeneration: entry.authGeneration,
        });
      }
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
    const authGeneration = typeof req.sessionID === 'string' && req.sessionID.trim()
      ? createSessionAuthGeneration(req.sessionID)
      : undefined;
    schedule(userId, accessToken, { authGeneration });
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
          void startRefresh(userId, entry);
        }
      })
      .catch((error) => {
        logger.warn({ error: error instanceof Error ? error.message : String(error) },
          'Failed to register repository notification access refresh');
        if (!closed && scheduled.get(userId) === entry) {
          if (entry.timer) timerScheduler.clearTimeout(entry.timer);
          entry.timer = undefined;
          schedule(userId, entry.accessToken, { retry: true, registrationEstablished: false });
        }
      });
    next();
  };
  middleware.invalidate = async (userId: string, authGeneration: string): Promise<void> => {
    const entry = scheduled.get(userId);
    await invalidateScheduledEntitlementRefresh({
      database,
      userId,
      authGeneration,
      entry,
      pendingAuthGeneration: activeAuthGenerations.get(userId),
      isClosed: () => closed,
      forgetPendingGeneration: () => activeAuthGenerations.delete(userId),
      removeEntry: target => removeEntry(userId, target as ScheduledRefresh),
      restoreEntry: session => {
        schedule(userId, session.accessToken, {
          retry: session.retry,
          registrationEstablished: session.registrationEstablished,
          authGeneration: session.authGeneration,
        });
        const replacementEntry = scheduled.get(userId);
        if (replacementEntry) replacementEntry.credentials = session.credentials;
      },
    });
  };
  middleware.activate = async (userId: string, authGeneration: string): Promise<void> => {
    await activateNotificationRepositoryEntitlements(database, userId, authGeneration);
    if (!closed) rememberAuthGeneration(userId, authGeneration.trim());
  };
  middleware.updateCredential = (
    userId: string,
    accessToken: string,
    authGeneration?: string
  ): void => {
    const entry = scheduled.get(userId);
    if (entry) updateEntitlementSessionCredential(entry, accessToken, authGeneration);
  };
  middleware.recover = async (): Promise<void> => {
    const available = Math.max(0, maxScheduledRefreshes - scheduled.size);
    if (closed || available === 0) return;
    const credentials = await loadRecoveryCredentials(database, available);
    if (closed) return;
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
        schedule(credential.userId, credential.accessToken, {
          retry: false,
          registrationEstablished: true,
          authGeneration: credential.authGeneration,
        });
        const entry = scheduled.get(credential.userId);
        if (!entry) return;
        recovered++;
        await startRefresh(credential.userId, entry);
      }));
    }
    logger.info({ recovered, skipped }, 'Recovered repository entitlement refresh schedules');
  };
  middleware.close = async (): Promise<void> => {
    closed = true;
    for (const [userId, entry] of scheduled) removeEntry(userId, entry);
    scheduled.clear();
    activeAuthGenerations.clear();
    try {
      await withNotificationDeadline(
        Promise.allSettled([...activeRefreshes]),
        REFRESH_SHUTDOWN_TIMEOUT_MS,
        'draining repository entitlement refreshes'
      );
    } catch (error) {
      logger.warn({
        activeRefreshes: activeRefreshes.size,
        error: error instanceof Error ? error.message : String(error),
      }, 'Timed out draining repository entitlement refreshes');
    }
  };
  return middleware;
}
