import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { Octokit } from '@octokit/core';
import { paginateRest } from '@octokit/plugin-paginate-rest';
import {
  getNotificationRepositoryEntitlementTtlMs,
  logger,
  replaceNotificationRepositoryEntitlements,
  type NotificationRepositoryEntitlementFence,
} from '@propr/core';
import {
  createScheduledEntitlementRefreshMiddleware,
  type EntitlementRefreshTimerScheduler,
  type NotificationEntitlementRefreshMiddleware,
} from './notificationEntitlementRefreshScheduler.js';

export type { NotificationEntitlementRefreshMiddleware };
export { invalidateNotificationRepositoryEntitlements }
  from './notificationEntitlementRefreshScheduler.js';

const entitlementRefreshes = new Map<string, Promise<boolean>>();
const legacyRetryAfter = new Map<string, number>();
const ENTITLEMENT_REFRESH_RETRY_DELAY_MS = 60_000;
const ENTITLEMENT_REFRESH_LEASE_MS = 2 * 60_000;
const ENTITLEMENT_REFRESH_LEASE_RENEWAL_MS = Math.floor(ENTITLEMENT_REFRESH_LEASE_MS / 3);
const DEFAULT_ENTITLEMENT_REFRESH_TIMEOUT_MS = 90_000;
const MAX_LEGACY_ENTITLEMENT_REFRESH_BACKOFFS = 1_000;
const LEASE_TABLE = 'notification_repository_entitlement_refresh_leases';

interface EntitlementRefreshLease extends NotificationRepositoryEntitlementFence {
  persisted: boolean;
}

async function withEntitlementRefreshDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  externalSignal?: AbortSignal
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('Repository entitlement refresh timeout must be a positive safe integer');
  }
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  let rejectCancellation: ((error: Error) => void) | undefined;
  const cancel = (): void => {
    controller.abort();
    rejectCancellation?.(new Error('Repository entitlement refresh was cancelled'));
  };
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  if (externalSignal?.aborted) cancel();
  else externalSignal?.addEventListener('abort', cancel, { once: true });
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error(
        `Repository entitlement refresh exceeded ${timeoutMs}ms`
      ));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), deadline, cancellation]);
  } finally {
    if (timeout) clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', cancel);
  }
}

export async function listAccessibleRepositories(
  accessToken: string,
  signal?: AbortSignal
): Promise<string[]> {
  const PaginatedOctokit = Octokit.plugin(paginateRest);
  const octokit = new PaginatedOctokit({ auth: accessToken });
  const repositories: string[] = [];
  for await (const response of octokit.paginate.iterator('GET /user/repos', {
    per_page: 100,
    sort: 'full_name',
    direction: 'asc',
    affiliation: 'owner,collaborator,organization_member',
    ...(signal === undefined ? {} : { request: { signal } }),
  })) {
    for (const repository of response.data) {
      if (repository.full_name) repositories.push(repository.full_name);
    }
  }
  return [...new Set(repositories)].sort((left, right) =>
    left.toLowerCase().localeCompare(right.toLowerCase()));
}

async function notificationEntitlementsNeedRefresh(userId: string, database: Knex): Promise<boolean> {
  const latest = await database('notification_repository_entitlement_snapshots')
    .select('verified_at', 'expires_at')
    .where({ user_id: userId })
    .first() as { verified_at?: string; expires_at?: string } | undefined;
  if (!latest?.verified_at || !latest.expires_at) return true;
  const ttlMs = getNotificationRepositoryEntitlementTtlMs();
  const refreshBefore = Date.now() + Math.floor(ttlMs / 2);
  const verifiedAt = Date.parse(latest.verified_at);
  const expiresAt = Date.parse(latest.expires_at);
  return !Number.isFinite(verifiedAt)
    || !Number.isFinite(expiresAt)
    || Math.min(expiresAt, verifiedAt + ttlMs) <= refreshBefore;
}

async function supportsDurableCoordination(database: Knex): Promise<boolean> {
  return await database.schema.hasTable(LEASE_TABLE)
    && await database.schema.hasColumn(LEASE_TABLE, 'fencing_token')
    && await database.schema.hasColumn(LEASE_TABLE, 'retry_after')
    && await database.schema.hasColumn(LEASE_TABLE, 'invalidated_at');
}

async function acquireEntitlementRefreshLease(options: {
  userId: string;
  database: Knex;
  preempt: boolean;
}): Promise<EntitlementRefreshLease | undefined> {
  const { userId, database, preempt } = options;
  if (!await supportsDurableCoordination(database)) {
    const retryAt = legacyRetryAfter.get(userId) ?? 0;
    if (!preempt && retryAt > Date.now()) return undefined;
    return { leaseToken: randomUUID(), fencingToken: 0, persisted: false };
  }

  const leaseToken = randomUUID();
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + ENTITLEMENT_REFRESH_LEASE_MS).toISOString();
  const update = database(LEASE_TABLE).where({ user_id: userId });
  update.whereNull('invalidated_at');
  if (!preempt) {
    update.where('expires_at', '<=', nowIso).where((eligible) => eligible
      .whereNull('retry_after').orWhere('retry_after', '<=', nowIso));
  }
  const updated = await update.update({
    lease_token: leaseToken,
    expires_at: expiresAt,
    fencing_token: database.raw('fencing_token + 1'),
  }, ['fencing_token']) as Array<{ fencing_token?: unknown }>;
  if (updated.length === 1) {
    return {
      leaseToken,
      fencingToken: Number(updated[0].fencing_token),
      persisted: true,
    };
  }

  try {
    await database(LEASE_TABLE).insert({
      user_id: userId,
      lease_token: leaseToken,
      fencing_token: 1,
      expires_at: expiresAt,
      retry_after: null,
      invalidated_at: null,
    });
    return { leaseToken, fencingToken: 1, persisted: true };
  } catch (error) {
    const existing = await database(LEASE_TABLE)
      .where({ user_id: userId })
      .first('lease_token', 'invalidated_at') as {
        lease_token?: unknown;
        invalidated_at?: unknown;
      } | undefined;
    if (existing) {
      return existing.invalidated_at === null && preempt
        ? acquireEntitlementRefreshLease(options)
        : undefined;
    }
    throw error;
  }
}

async function renewEntitlementRefreshLease(
  userId: string,
  lease: EntitlementRefreshLease,
  database: Knex
): Promise<boolean> {
  if (!lease.persisted) return true;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ENTITLEMENT_REFRESH_LEASE_MS).toISOString();
  const updated = await database(LEASE_TABLE)
    .where({
      user_id: userId,
      lease_token: lease.leaseToken,
      fencing_token: lease.fencingToken,
    })
    .whereRaw("expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
    .update({ expires_at: expiresAt });
  return updated === 1;
}

async function releaseEntitlementRefreshLease(
  userId: string,
  lease: EntitlementRefreshLease,
  database: Knex
): Promise<void> {
  if (!lease.persisted) return;
  await database(LEASE_TABLE)
    .where({
      user_id: userId,
      lease_token: lease.leaseToken,
      fencing_token: lease.fencingToken,
    })
    .update({ expires_at: new Date().toISOString() });
}

async function recordEntitlementRefreshFailure(
  userId: string,
  lease: EntitlementRefreshLease,
  database: Knex
): Promise<void> {
  const retryAfter = new Date(Date.now() + ENTITLEMENT_REFRESH_RETRY_DELAY_MS).toISOString();
  if (!lease.persisted) {
    if (!legacyRetryAfter.has(userId)
        && legacyRetryAfter.size >= MAX_LEGACY_ENTITLEMENT_REFRESH_BACKOFFS) {
      const oldestUserId = legacyRetryAfter.keys().next().value as string | undefined;
      if (oldestUserId) legacyRetryAfter.delete(oldestUserId);
    }
    legacyRetryAfter.set(userId, Date.parse(retryAfter));
    return;
  }
  await database(LEASE_TABLE)
    .where({
      user_id: userId,
      lease_token: lease.leaseToken,
      fencing_token: lease.fencingToken,
    })
    .update({ retry_after: retryAfter });
}

async function clearEntitlementRefreshFailure(
  userId: string,
  lease: EntitlementRefreshLease,
  database: Knex
): Promise<void> {
  legacyRetryAfter.delete(userId);
  if (!lease.persisted) return;
  await database(LEASE_TABLE)
    .where({
      user_id: userId,
      lease_token: lease.leaseToken,
      fencing_token: lease.fencingToken,
    })
    .update({ retry_after: null });
}

export interface RefreshNotificationRepositoryEntitlementsOptions {
  userId: string;
  accessToken: string;
  database: Knex;
  force?: boolean;
  operationTimeoutMs?: number;
  signal?: AbortSignal;
  listRepositories?: (accessToken: string, signal?: AbortSignal) => Promise<string[]>;
}

/** Serialize scans locally, fence them across replicas, and commit only the newest result. */
export async function refreshNotificationRepositoryEntitlements(
  options: RefreshNotificationRepositoryEntitlementsOptions
): Promise<boolean> {
  const existing = entitlementRefreshes.get(options.userId);
  if (existing && !options.force) return existing;

  // Forced /github/repos scans preempt even an in-process background scan by
  // taking the next fencing token. The older scan can finish, but cannot commit.
  const refresh = runEntitlementRefresh(options);
  entitlementRefreshes.set(options.userId, refresh);
  try {
    return await refresh;
  } finally {
    if (entitlementRefreshes.get(options.userId) === refresh) {
      entitlementRefreshes.delete(options.userId);
    }
  }
}

async function runEntitlementRefresh(
  options: RefreshNotificationRepositoryEntitlementsOptions
): Promise<boolean> {
  if (!options.force
      && !await notificationEntitlementsNeedRefresh(options.userId, options.database)) return true;
  const lease = await acquireEntitlementRefreshLease({
    userId: options.userId,
    database: options.database,
    preempt: options.force === true,
  });
  if (!lease) return false;

  let leaseLost = false;
  const renewalTimer = setInterval(() => {
    void renewEntitlementRefreshLease(options.userId, lease, options.database)
      .then((renewed) => { if (!renewed) leaseLost = true; })
      .catch(() => { leaseLost = true; });
  }, ENTITLEMENT_REFRESH_LEASE_RENEWAL_MS);
  renewalTimer.unref();
  try {
    if (!options.force
        && !await notificationEntitlementsNeedRefresh(options.userId, options.database)) return true;
    const repositories = await withEntitlementRefreshDeadline(
      (signal) => (options.listRepositories ?? listAccessibleRepositories)(
        options.accessToken,
        signal
      ),
      options.operationTimeoutMs ?? DEFAULT_ENTITLEMENT_REFRESH_TIMEOUT_MS,
      options.signal
    );
    if (leaseLost || !await renewEntitlementRefreshLease(options.userId, lease, options.database)) {
      return false;
    }
    const committed = await replaceNotificationRepositoryEntitlements({
      userId: options.userId,
      repositories,
      database: options.database,
      ...(lease.persisted ? { fence: lease } : {}),
    });
    if (committed) {
      await clearEntitlementRefreshFailure(options.userId, lease, options.database).catch((error) => {
        logger.warn({ userId: options.userId, error: error instanceof Error ? error.message : String(error) },
          'Failed to clear repository entitlement refresh backoff');
      });
    }
    return committed;
  } catch (error) {
    await recordEntitlementRefreshFailure(options.userId, lease, options.database)
      .catch((backoffError) => {
        logger.warn({
          userId: options.userId,
          error: backoffError instanceof Error ? backoffError.message : String(backoffError),
        }, 'Failed to persist repository entitlement refresh backoff');
      });
    throw error;
  } finally {
    clearInterval(renewalTimer);
    await releaseEntitlementRefreshLease(options.userId, lease, options.database).catch((error) => {
      logger.warn({ userId: options.userId, error: error instanceof Error ? error.message : String(error) },
        'Failed to release repository entitlement refresh lease');
    });
  }
}

export async function persistNotificationRepositoryEntitlementsBestEffort(options: {
  userId: string;
  repositories: readonly string[];
  database: Knex;
}): Promise<boolean> {
  try {
    return await refreshNotificationRepositoryEntitlements({
      userId: options.userId,
      accessToken: '',
      database: options.database,
      force: true,
      listRepositories: async () => [...options.repositories],
    });
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.message : String(error) },
      'Failed to persist repository notification access');
    return false;
  }
}

interface NotificationEntitlementRefreshMiddlewareOptions {
  refresh?: (options: RefreshNotificationRepositoryEntitlementsOptions) => Promise<unknown>;
  maxScheduledRefreshes?: number;
  timerScheduler?: EntitlementRefreshTimerScheduler;
  ensureRegistration?: (database: Knex, userId: string) => Promise<boolean>;
}

/** Schedules authorization refresh without adding GitHub latency to API traffic. */
export function createNotificationEntitlementRefreshMiddleware(
  database: Knex,
  options: NotificationEntitlementRefreshMiddlewareOptions = {}
): NotificationEntitlementRefreshMiddleware {
  const refresh = options.refresh ?? refreshNotificationRepositoryEntitlements;
  return createScheduledEntitlementRefreshMiddleware(database, refresh, {
    maxScheduledRefreshes: options.maxScheduledRefreshes,
    timerScheduler: options.timerScheduler,
    ensureRegistration: options.ensureRegistration,
  });
}
