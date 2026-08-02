import type { Knex } from 'knex';
import { normalizeISO8601Timestamp } from '@propr/shared';
import { db } from '../db/connection.js';
import logger from '../utils/logger.js';

export const DEFAULT_NOTIFICATION_REPOSITORY_ENTITLEMENT_TTL_MS = 60 * 60 * 1000;

const REPOSITORY_PATTERN = /^[^/\s]+\/[^/\s]+$/;
const INSERT_CHUNK_SIZE = 200;
type RepositoryAccessDatabase = Knex | Knex.Transaction;

function positiveIntegerEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    if (Number.isSafeInteger(value) && value > 0) return value;
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

function normalizedRepositories(values: readonly string[]): string[] {
    return [...new Set(values.map((value) => value.trim()).filter((value) =>
        value.length <= 255 && REPOSITORY_PATTERN.test(value)
    ))];
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

async function runAtomically(
    database: RepositoryAccessDatabase,
    callback: (transaction: RepositoryAccessDatabase) => Promise<void>
): Promise<void> {
    if ((database as Knex.Transaction).isTransaction) {
        await callback(database);
        return;
    }
    await (database as Knex).transaction(callback);
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
}): Promise<void> {
    const database = options.database ?? db;
    const userId = normalizedUserId(options.userId);
    const repositories = normalizedRepositories(options.repositories);
    const verifiedAt = normalizeISO8601Timestamp(options.verifiedAt ?? new Date());
    const ttlMs = options.ttlMs ?? getNotificationRepositoryEntitlementTtlMs();
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
        throw new TypeError('ttlMs must be a positive safe integer');
    }
    const expiresAt = normalizeISO8601Timestamp(Date.parse(verifiedAt) + ttlMs);
    await runAtomically(database, async (transaction) => {
        await transaction('notification_repository_entitlements').where({ user_id: userId }).delete();
        await insertInChunks(transaction, 'notification_repository_entitlements', repositories.map((repository) => ({
            user_id: userId,
            repository,
            verified_at: verifiedAt,
            expires_at: expiresAt
        })));
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
    const repositories = normalizedRepositories(Object.keys(options.preferences));
    const updatedAt = normalizeISO8601Timestamp(options.updatedAt ?? new Date());
    await runAtomically(database, async (transaction) => {
        await transaction('notification_repository_subscriptions').where({ user_id: userId }).delete();
        await insertInChunks(transaction, 'notification_repository_subscriptions', repositories.map((repository) => ({
            user_id: userId,
            repository,
            hidden: options.preferences[repository]?.hidden === true,
            updated_at: updatedAt
        })));
    });
}
