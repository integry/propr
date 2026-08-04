import type { NextFunction, Request, Response } from 'express';
import type { Knex } from 'knex';
import { logger } from '@propr/core';
import type { RecoveredEntitlementCredential }
  from './notificationEntitlementSessionRecovery.js';
import {
  ensureEntitlementRefreshRegistration,
  ENTITLEMENT_REFRESH_LEASE_TABLE,
} from './notificationEntitlementFencing.js';

const MAX_SCHEDULED_REFRESHES = 1_000;
const MAX_SCHEDULED_REFRESHES_ENV = 'NOTIFICATION_ENTITLEMENT_MAX_SCHEDULED_REFRESHES';
const MAX_SESSION_CREDENTIALS_PER_USER = 32;

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
  if (entry.credentials.size <= MAX_SESSION_CREDENTIALS_PER_USER) return;
  const oldestFallback = [...entry.credentials.keys()]
    .find(generation => generation !== entry.authGeneration);
  if (oldestFallback) entry.credentials.delete(oldestFallback);
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
