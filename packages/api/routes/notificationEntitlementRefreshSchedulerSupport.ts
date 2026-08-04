import type { NextFunction, Request, Response } from 'express';
import type { Knex } from 'knex';
import { logger, recordNotificationInstanceEligibility } from '@propr/core';
import type { RecoveredEntitlementCredential }
  from './notificationEntitlementSessionRecovery.js';
import {
  ensureEntitlementRefreshRegistration,
  ENTITLEMENT_REFRESH_LEASE_TABLE,
} from './notificationEntitlementFencing.js';

const MAX_SCHEDULED_REFRESHES = 1_000;
const MAX_SCHEDULED_REFRESHES_ENV = 'NOTIFICATION_ENTITLEMENT_MAX_SCHEDULED_REFRESHES';
const ELIGIBILITY_WRITE_INTERVAL_MS = 60_000;

export interface RefreshInput {
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

export interface ScheduledEntitlementRefreshOptions {
  maxScheduledRefreshes?: number;
  timerScheduler?: EntitlementRefreshTimerScheduler;
  ensureRegistration?: typeof ensureEntitlementRefreshRegistration;
  loadRecoveryCredentials?: (
    database: Knex,
    maxCredentials: number
  ) => Promise<RecoveredEntitlementCredential[]>;
}

export interface NotificationEntitlementRefreshMiddleware {
  (req: Request, res: Response, next: NextFunction): void;
  invalidate(userId: string, authGeneration: string): Promise<void>;
  activate(userId: string, authGeneration: string): Promise<void>;
  updateCredential(userId: string, accessToken: string, authGeneration?: string): void;
  recover(): Promise<void>;
  close(): Promise<void>;
}

export const DEFAULT_TIMER_SCHEDULER: EntitlementRefreshTimerScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
};

export function getMaxScheduledRefreshes(): number {
  const configured = process.env[MAX_SCHEDULED_REFRESHES_ENV];
  if (configured === undefined) return MAX_SCHEDULED_REFRESHES;
  const parsed = Number(configured);
  if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  logger.warn({ value: configured, fallback: MAX_SCHEDULED_REFRESHES },
    `${MAX_SCHEDULED_REFRESHES_ENV} must be a positive safe integer`);
  return MAX_SCHEDULED_REFRESHES;
}

export function recordCurrentNotificationInstanceEligibility(options: {
  database: Knex;
  userId: string;
  githubUsername: string;
  recordedAt: Map<string, number>;
  capacity: number;
}): void {
  const observedAt = Date.now();
  if (observedAt - (options.recordedAt.get(options.userId) ?? 0)
      < ELIGIBILITY_WRITE_INTERVAL_MS) return;
  options.recordedAt.delete(options.userId);
  options.recordedAt.set(options.userId, observedAt);
  if (options.recordedAt.size > options.capacity) {
    const oldestUserId = options.recordedAt.keys().next().value as string | undefined;
    if (oldestUserId) options.recordedAt.delete(oldestUserId);
  }
  void recordNotificationInstanceEligibility({
    database: options.database,
    userId: options.userId,
    githubUsername: options.githubUsername,
    observedAt,
  }).catch((error) => {
    if (options.recordedAt.get(options.userId) === observedAt) {
      options.recordedAt.delete(options.userId);
    }
    logger.warn({ userId: options.userId,
      error: error instanceof Error ? error.message : String(error) },
    'Failed to record current notification instance eligibility');
  });
}

export async function hasEntitlementRefreshRegistration(options: {
  database: Knex;
  userId: string;
  retry: boolean;
  authGeneration?: string;
}): Promise<boolean> {
  const { database, userId, retry, authGeneration } = options;
  if (authGeneration
      && await database.schema.hasTable(ENTITLEMENT_REFRESH_LEASE_TABLE)
      && await database.schema.hasColumn(ENTITLEMENT_REFRESH_LEASE_TABLE, 'auth_generation')) {
    const generationLease = database(ENTITLEMENT_REFRESH_LEASE_TABLE).where({
      user_id: userId,
      auth_generation: authGeneration,
    });
    if (await database.schema.hasColumn(ENTITLEMENT_REFRESH_LEASE_TABLE, 'invalidated_at')) {
      generationLease.whereNull('invalidated_at');
    }
    if (!await generationLease.first('user_id')) return false;
  }
  const snapshot = await database('notification_repository_entitlement_snapshots')
    .where({ user_id: userId })
    .first('user_id');
  if (snapshot !== undefined) return true;
  if (!retry || !await database.schema.hasTable(ENTITLEMENT_REFRESH_LEASE_TABLE)) return false;
  const retryLeaseQuery = database(ENTITLEMENT_REFRESH_LEASE_TABLE).where({ user_id: userId });
  if (await database.schema.hasColumn(ENTITLEMENT_REFRESH_LEASE_TABLE, 'invalidated_at')) {
    retryLeaseQuery.whereNull('invalidated_at');
  }
  return await retryLeaseQuery.first('user_id') !== undefined;
}

export function rememberEntitlementSessionCredential(
  entry: { authGeneration?: string; credentials: Map<string, string> },
  authGeneration: string,
  accessToken: string
): void {
  entry.credentials.delete(authGeneration);
  entry.credentials.set(authGeneration, accessToken);
}

export function rememberRecoveredEntitlementSessionCredentials(
  entry: { authGeneration?: string; credentials: Map<string, string> },
  recovered: RecoveredEntitlementCredential
): void {
  for (const credential of recovered.sessionCredentials ?? []) {
    rememberEntitlementSessionCredential(
      entry,
      credential.authGeneration,
      credential.accessToken
    );
  }
}

export function updateEntitlementSessionCredential(
  entry: { accessToken: string; authGeneration?: string; credentials: Map<string, string> },
  accessToken: string,
  authGeneration?: string
): void {
  if (!accessToken) return;
  const generation = authGeneration?.trim();
  if (generation) {
    rememberEntitlementSessionCredential(entry, generation, accessToken);
    if (entry.authGeneration === generation) entry.accessToken = accessToken;
    return;
  }
  entry.accessToken = accessToken;
  if (entry.authGeneration) {
    rememberEntitlementSessionCredential(entry, entry.authGeneration, accessToken);
  }
}
