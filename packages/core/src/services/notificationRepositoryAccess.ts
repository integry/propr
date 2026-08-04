import type { Knex } from 'knex';
import {
    normalizeGithubRepositoryIdentity,
    normalizeISO8601Timestamp
} from '@propr/shared';
import { db } from '../db/connection.js';
import logger from '../utils/logger.js';
import { isNotificationTimerDelay } from './notificationSchedulerTiming.js';

export const DEFAULT_NOTIFICATION_REPOSITORY_ENTITLEMENT_TTL_MS = 60 * 60 * 1000;

const INSERT_CHUNK_SIZE = 200;
type RepositoryAccessDatabase = Knex | Knex.Transaction;

export interface NotificationRepositoryEntitlementFence {
    leaseToken: string;
    fencingToken: number;
}

function positiveIntegerEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    if (isNotificationTimerDelay(value)) return value;
    logger.warn({ name, value: raw }, 'Ignoring invalid notification repository-access configuration');
    return fallback;
}

function normalizedUserId(value: string): string {
    const userId = value.trim();
    if (userId.length === 0 || userId.length > 255) {
        throw new TypeError('userId must be a non-blank string of at most 255 characters');
    }
    return userId;
}

export function normalizeNotificationRepositoryIdentity(value: string): string | undefined {
    return normalizeGithubRepositoryIdentity(value);
}

function normalizedRepositories(values: readonly string[]): string[] {
    return [...new Set(values.flatMap((value) => {
        const repository = normalizeNotificationRepositoryIdentity(value);
        return repository === undefined ? [] : [repository];
    }))];
}

async function insertInChunks(
    transaction: RepositoryAccessDatabase,
    table: string,
    rows: Array<Record<string, unknown>>
): Promise<void> {
    for (let offset = 0; offset < rows.length; offset += INSERT_CHUNK_SIZE) {
        await transaction(table).insert(rows.slice(offset, offset + INSERT_CHUNK_SIZE));
    }
}

async function runAtomically<T>(
    database: RepositoryAccessDatabase,
    callback: (transaction: RepositoryAccessDatabase) => Promise<T>
): Promise<T> {
    if ((database as Knex.Transaction).isTransaction) {
        return callback(database);
    }
    return (database as Knex).transaction(callback);
}

export function getNotificationRepositoryEntitlementTtlMs(): number {
    return positiveIntegerEnv(
        'NOTIFICATION_REPOSITORY_ENTITLEMENT_TTL_MS',
        DEFAULT_NOTIFICATION_REPOSITORY_ENTITLEMENT_TTL_MS
    );
}

export async function replaceNotificationRepositoryEntitlements(options: {
    userId: string;
    repositories: readonly string[];
    database?: RepositoryAccessDatabase;
    verifiedAt?: string | number | Date;
    ttlMs?: number;
    fence?: NotificationRepositoryEntitlementFence;
}): Promise<boolean> {
    const database = options.database ?? db;
    const userId = normalizedUserId(options.userId);
    const repositories = normalizedRepositories(options.repositories);
    const verifiedAt = normalizeISO8601Timestamp(options.verifiedAt ?? new Date());
    const ttlMs = options.ttlMs ?? getNotificationRepositoryEntitlementTtlMs();
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
        throw new TypeError('ttlMs must be a positive safe integer');
    }
    const expiresAt = normalizeISO8601Timestamp(Date.parse(verifiedAt) + ttlMs);
    return runAtomically(database, async (transaction) => {
        if (options.fence) {
            const lease = await transaction('notification_repository_entitlement_refresh_leases')
                .select('lease_token', 'fencing_token', 'expires_at', 'invalidated_at')
                .where({
                    user_id: userId,
                    lease_token: options.fence.leaseToken,
                    fencing_token: options.fence.fencingToken
                })
                .forUpdate()
                .first() as {
                    lease_token?: unknown;
                    fencing_token?: unknown;
                    expires_at?: unknown;
                    invalidated_at?: unknown;
                } | undefined;
            const expiresAtMs = typeof lease?.expires_at === 'string'
                ? Date.parse(lease.expires_at)
                : Number.NaN;
            if (lease?.lease_token !== options.fence.leaseToken
                || Number(lease.fencing_token) !== options.fence.fencingToken
                || lease.invalidated_at !== null
                || !Number.isFinite(expiresAtMs)
                || expiresAtMs <= Date.now()) {
                return false;
            }
        }
        await transaction('notification_repository_entitlements').where({ user_id: userId }).delete();
        await insertInChunks(transaction, 'notification_repository_entitlements', repositories.map((repository) => ({
            user_id: userId,
            repository,
            verified_at: verifiedAt,
            expires_at: expiresAt
        })));
        await transaction('notification_repository_entitlement_snapshots')
            .insert({ user_id: userId, verified_at: verifiedAt, expires_at: expiresAt })
            .onConflict('user_id')
            .merge({ verified_at: verifiedAt, expires_at: expiresAt });
        return true;
    });
}

export async function replaceNotificationRepositorySubscriptions(options: {
    userId: string;
    preferences: Readonly<Record<string, { hidden?: boolean }>>;
    database?: RepositoryAccessDatabase;
    updatedAt?: string | number | Date;
}): Promise<void> {
    const database = options.database ?? db;
    const userId = normalizedUserId(options.userId);
    const preferences = new Map<string, { hidden?: boolean }>();
    for (const [repository, preference] of Object.entries(options.preferences)) {
        const key = normalizeNotificationRepositoryIdentity(repository);
        if (key !== undefined) preferences.set(key, preference);
    }
    const updatedAt = normalizeISO8601Timestamp(options.updatedAt ?? new Date());
    await runAtomically(database, async (transaction) => {
        await transaction('notification_repository_subscriptions').where({ user_id: userId }).delete();
        await insertInChunks(transaction, 'notification_repository_subscriptions', [...preferences].map(([
            repository,
            preference
        ]) => ({
            user_id: userId,
            repository,
            hidden: preference.hidden === true,
            updated_at: updatedAt
        })));
    });
}
