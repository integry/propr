/* eslint-disable max-lines -- push enrollment and lifecycle share one serialized policy boundary */
import { ECDH } from 'node:crypto';
import type { Knex } from 'knex';
import {
    NOTIFICATION_PAYLOAD_LIMITS,
    normalizeISO8601Timestamp,
    parsePushSubscription,
    parsePushSubscriptionEndpoint,
    parsePushSubscriptionInput,
    parseTruthyEnvValue,
    type ISO8601Timestamp,
    type PushSubscription,
    type PushSubscriptionInput
} from '@propr/shared';

type TimestampInput = string | number | Date;
type Database = Knex | Knex.Transaction;

export interface PushSubscriptionPolicyOptions {
    allowInsecureLocalhost?: boolean;
    maxActivePushSubscriptionsPerUser?: number;
    maxStoredPushSubscriptionsPerUser?: number;
    maxPushSubscriptionEnrollmentsPerWindow?: number;
    pushSubscriptionEnrollmentWindowMs?: number;
    pushSubscriptionRevokedRetentionMs?: number;
}

export interface PushSubscriptionServiceOptions extends PushSubscriptionPolicyOptions {
    database: Knex;
    now: () => TimestampInput;
    generateId: () => string;
}

interface PushSubscriptionRow {
    subscription_id: string;
    user_id: string;
    endpoint: string;
    p256dh_key: string | null;
    auth_key: string | null;
    expires_at: string | null;
    user_agent: string | null;
    last_used_at: string | null;
    revoked_at: string | null;
    created_at: string;
    updated_at: string;
}

interface PushSubscriptionEnrollmentLimitRow {
    user_id: string;
    window_started_at: string;
    enrollment_count: number;
}

interface PushSubscriptionEnrollmentPreparation {
    now: ISO8601Timestamp;
    createsStoredVersion: boolean;
    excludedSubscriptionId?: string;
}

interface PushSubscriptionGarbageCollection {
    now: ISO8601Timestamp;
    limit: number;
    userId?: string;
    includeRecent?: boolean;
    excludedSubscriptionId?: string;
}

interface PushSubscriptionExpirationScope {
    userId?: string;
    endpoint?: string;
    limit?: number;
}

interface PushSubscriptionRefresh {
    subscription: PushSubscriptionInput;
    expiresAt: ISO8601Timestamp | null;
    userAgentValue: string | null | undefined;
    now: ISO8601Timestamp;
}

export const MAX_ACTIVE_PUSH_SUBSCRIPTIONS_PER_USER = 10;
export const MAX_STORED_PUSH_SUBSCRIPTIONS_PER_USER = 50;
export const MAX_PUSH_SUBSCRIPTION_ENROLLMENTS_PER_WINDOW = 20;
export const PUSH_SUBSCRIPTION_ENROLLMENT_WINDOW_MS = 60 * 60 * 1000;
export const PUSH_SUBSCRIPTION_REVOKED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const PUSH_SUBSCRIPTION_GC_BATCH_SIZE = 100;

const PUSH_SUBSCRIPTION_CONSTRAINT_WRITE_ATTEMPTS = 5;
const PUSH_SUBSCRIPTION_SHORT_BUSY_TIMEOUT_MAX_MS = 5_000;
const PUSH_SUBSCRIPTION_RETRY_BASE_DELAY_MS = 5;
const PUSH_SUBSCRIPTION_RETRY_MAX_DELAY_MS = 40;
const LOCAL_DEPLOYMENT_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function sqliteErrorCode(error: unknown): string | undefined {
    return error instanceof Error
        ? (error as Error & { code?: string }).code
        : undefined;
}

function isPushSubscriptionContention(error: unknown): boolean {
    const code = sqliteErrorCode(error);
    return code === 'SQLITE_BUSY'
        || code === 'SQLITE_BUSY_SNAPSHOT'
        || code === 'SQLITE_LOCKED'
        || code === 'SQLITE_LOCKED_SHAREDCACHE';
}

function isPushSubscriptionConstraintRace(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    return sqliteErrorCode(error) === 'SQLITE_CONSTRAINT_UNIQUE'
        || error.message.includes('push_subscriptions_active_endpoint_idx')
        || error.message.includes('UNIQUE constraint failed: push_subscriptions.endpoint');
}

function positiveIntegerOption(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`${name} must be a positive integer`);
    }
    return value;
}

function nonnegativeIntegerOption(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${name} must be a nonnegative integer`);
    }
    return value;
}

function isNodeValidatedP256Point(value: string): boolean {
    try {
        const decoded = Buffer.from(value, 'base64url');
        const converted = ECDH.convertKey(
            decoded,
            'prime256v1',
            undefined,
            undefined,
            'uncompressed'
        );
        return Buffer.isBuffer(converted) && converted.equals(decoded);
    } catch {
        return false;
    }
}

function isLocalDevelopmentDeployment(): boolean {
    if (process.env.NODE_ENV === 'production') return false;
    const configuredPublicUrl = process.env.API_PUBLIC_URL;
    if (configuredPublicUrl === undefined || configuredPublicUrl.length === 0) return true;
    try {
        return LOCAL_DEPLOYMENT_HOSTS.has(new URL(configuredPublicUrl).hostname.toLowerCase());
    } catch {
        return false;
    }
}

function toPushSubscription(row: PushSubscriptionRow): PushSubscription {
    return parsePushSubscription({
        id: row.subscription_id,
        endpoint: row.endpoint,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    });
}

function boundedUserAgent(value: string | undefined): string | null {
    if (value === undefined || value.length === 0) return null;
    let bytes = 0;
    let end = 0;
    for (const character of value) {
        const characterBytes = Buffer.byteLength(character, 'utf8');
        if (bytes + characterBytes > NOTIFICATION_PAYLOAD_LIMITS.userAgentBytes) break;
        bytes += characterBytes;
        end += character.length;
    }
    return end === 0 ? null : value.slice(0, end);
}

function buildPushSubscriptionRefreshValues(
    database: Database,
    subscription: PushSubscriptionInput,
    expiresAt: ISO8601Timestamp | null,
    userAgentValue: string | null | undefined
) {
    return {
        p256dh_key: subscription.keys.p256dh,
        auth_key: subscription.keys.auth,
        expires_at: expiresAt,
        last_used_at: database.raw(
            `CASE
                WHEN p256dh_key = ? AND auth_key = ? THEN last_used_at
                ELSE NULL
            END`,
            [subscription.keys.p256dh, subscription.keys.auth]
        ),
        revoked_at: null,
        ...(userAgentValue === undefined ? {} : { user_agent: userAgentValue })
    };
}

function pushSubscriptionRefreshDiffers(
    row: PushSubscriptionRow,
    subscription: PushSubscriptionInput,
    expiresAt: ISO8601Timestamp | null,
    userAgentValue: string | null | undefined
): boolean {
    return row.p256dh_key !== subscription.keys.p256dh
        || row.auth_key !== subscription.keys.auth
        || row.expires_at !== expiresAt
        || (userAgentValue !== undefined && row.user_agent !== userAgentValue);
}

async function waitBeforePushSubscriptionRetry(attempt: number): Promise<void> {
    const delay = Math.min(
        PUSH_SUBSCRIPTION_RETRY_BASE_DELAY_MS * (2 ** attempt),
        PUSH_SUBSCRIPTION_RETRY_MAX_DELAY_MS
    );
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
}

function validateNotificationInput<T>(parser: () => T): T {
    try {
        return parser();
    } catch (error) {
        if (error instanceof NotificationValidationError) throw error;
        if (error instanceof TypeError) {
            throw new NotificationValidationError(error.message);
        }
        throw error;
    }
}

function assertIdentifier(value: string, path: string): void {
    if (
        typeof value !== 'string'
        || value.trim().length === 0
        || Buffer.byteLength(value, 'utf8') > NOTIFICATION_PAYLOAD_LIMITS.identifierBytes
    ) {
        throw new TypeError(`${path} must be a bounded non-empty string`);
    }
}

export class PushSubscriptionService {
    private readonly database: Knex;
    private readonly now: () => TimestampInput;
    private readonly generateId: () => string;
    private readonly allowInsecureLocalhost: boolean;
    private readonly maxActivePushSubscriptionsPerUser: number;
    private readonly maxStoredPushSubscriptionsPerUser: number;
    private readonly maxPushSubscriptionEnrollmentsPerWindow: number;
    private readonly pushSubscriptionEnrollmentWindowMs: number;
    private readonly pushSubscriptionRevokedRetentionMs: number;

    constructor(options: PushSubscriptionServiceOptions) {
        this.database = options.database;
        this.now = options.now;
        this.generateId = options.generateId;
        const insecureLocalhostRequested = options.allowInsecureLocalhost
            ?? parseTruthyEnvValue(process.env.PROPR_ALLOW_INSECURE_LOCAL_WEB_PUSH);
        this.allowInsecureLocalhost = insecureLocalhostRequested
            && isLocalDevelopmentDeployment();
        this.maxActivePushSubscriptionsPerUser = positiveIntegerOption(
            options.maxActivePushSubscriptionsPerUser
                ?? MAX_ACTIVE_PUSH_SUBSCRIPTIONS_PER_USER,
            'maxActivePushSubscriptionsPerUser'
        );
        this.maxStoredPushSubscriptionsPerUser = positiveIntegerOption(
            options.maxStoredPushSubscriptionsPerUser
                ?? MAX_STORED_PUSH_SUBSCRIPTIONS_PER_USER,
            'maxStoredPushSubscriptionsPerUser'
        );
        if (this.maxStoredPushSubscriptionsPerUser
            < this.maxActivePushSubscriptionsPerUser) {
            throw new TypeError(
                'maxStoredPushSubscriptionsPerUser must be at least the active limit'
            );
        }
        this.maxPushSubscriptionEnrollmentsPerWindow = positiveIntegerOption(
            options.maxPushSubscriptionEnrollmentsPerWindow
                ?? MAX_PUSH_SUBSCRIPTION_ENROLLMENTS_PER_WINDOW,
            'maxPushSubscriptionEnrollmentsPerWindow'
        );
        this.pushSubscriptionEnrollmentWindowMs = positiveIntegerOption(
            options.pushSubscriptionEnrollmentWindowMs
                ?? PUSH_SUBSCRIPTION_ENROLLMENT_WINDOW_MS,
            'pushSubscriptionEnrollmentWindowMs'
        );
        this.pushSubscriptionRevokedRetentionMs = nonnegativeIntegerOption(
            options.pushSubscriptionRevokedRetentionMs
                ?? PUSH_SUBSCRIPTION_REVOKED_RETENTION_MS,
            'pushSubscriptionRevokedRetentionMs'
        );
    }

    async upsert(
        userId: string,
        input: PushSubscriptionInput,
        userAgent?: string
    ): Promise<PushSubscription> {
        assertIdentifier(userId, 'push subscription userId');
        const subscription = validateNotificationInput(() =>
            parsePushSubscriptionInput(input, {
                allowInsecureLocalhost: this.allowInsecureLocalhost
            }));
        if (!isNodeValidatedP256Point(subscription.keys.p256dh)) {
            throw new NotificationValidationError(
                'pushSubscriptionInput.keys.p256dh must be a P-256 public point'
            );
        }
        const now = normalizeISO8601Timestamp(this.now());
        const expiresAt = subscription.expirationTime === null
            ? null
            : normalizeISO8601Timestamp(subscription.expirationTime);
        if (expiresAt !== null && expiresAt <= now) {
            throw new NotificationValidationError(
                'pushSubscriptionInput.expirationTime must be in the future'
            );
        }
        const userAgentValue = userAgent === undefined
            ? undefined
            : boundedUserAgent(userAgent);

        const unchangedOwner = await this.findActiveOwner(
            this.database,
            subscription.endpoint,
            now
        );
        if (unchangedOwner && unchangedOwner.user_id !== userId) {
            throw new PushSubscriptionConflictError();
        }
        if (unchangedOwner && !pushSubscriptionRefreshDiffers(
            unchangedOwner,
            subscription,
            expiresAt,
            userAgentValue
        )) {
            return toPushSubscription(unchangedOwner);
        }

        const contentionAttemptLimit = await this.contentionAttemptLimit();
        let contentionFailures = 0;
        let lastRaceError: unknown;
        for (let attempt = 0; attempt < PUSH_SUBSCRIPTION_CONSTRAINT_WRITE_ATTEMPTS;
            attempt += 1) {
            try {
                return await this.database.transaction(async (transaction) => {
                    await transaction('push_subscription_write_lock')
                        .where({ lock_key: 1 })
                        .update({ lock_key: 1 });
                    await this.expire(transaction, now, {
                        userId,
                        endpoint: subscription.endpoint
                    });
                    const activeOwner = await this.findActiveOwner(
                        transaction,
                        subscription.endpoint,
                        now
                    );
                    if (activeOwner && activeOwner.user_id !== userId) {
                        throw new PushSubscriptionConflictError();
                    }

                    const existing = activeOwner ?? await transaction<PushSubscriptionRow>(
                        'push_subscriptions'
                    )
                        .where({ user_id: userId, endpoint: subscription.endpoint })
                        .whereNotNull('revoked_at')
                        .orderBy('updated_at', 'desc')
                        .orderBy('created_at', 'desc')
                        .orderBy('subscription_id', 'desc')
                        .first();
                    if (!activeOwner) {
                        await this.prepareEnrollment(transaction, userId, {
                            now,
                            createsStoredVersion: existing === undefined,
                            excludedSubscriptionId: existing?.subscription_id
                        });
                    }
                    if (existing) {
                        if (pushSubscriptionRefreshDiffers(
                            existing,
                            subscription,
                            expiresAt,
                            userAgentValue
                        )) {
                            await transaction('push_subscriptions')
                                .where({
                                    subscription_id: existing.subscription_id,
                                    user_id: userId
                                })
                                .update(buildPushSubscriptionRefreshValues(
                                    transaction,
                                    subscription,
                                    expiresAt,
                                    userAgentValue
                                ));
                        }
                    } else {
                        await transaction('push_subscriptions').insert({
                            subscription_id: this.generateId(),
                            user_id: userId,
                            endpoint: subscription.endpoint,
                            p256dh_key: subscription.keys.p256dh,
                            auth_key: subscription.keys.auth,
                            expires_at: expiresAt,
                            user_agent: userAgentValue ?? null,
                            last_used_at: null,
                            revoked_at: null,
                            created_at: now,
                            updated_at: now
                        });
                    }

                    const stored = await transaction<PushSubscriptionRow>('push_subscriptions')
                        .where({ user_id: userId, endpoint: subscription.endpoint })
                        .whereNull('revoked_at')
                        .orderBy('subscription_id', 'asc')
                        .first();
                    if (!stored) throw new Error('Push subscription was not persisted');
                    return toPushSubscription(stored);
                });
            } catch (error) {
                if (isPushSubscriptionContention(error)) {
                    contentionFailures += 1;
                    if (contentionFailures >= contentionAttemptLimit) throw error;
                    lastRaceError = error;
                    await waitBeforePushSubscriptionRetry(attempt);
                    continue;
                }
                if (!isPushSubscriptionConstraintRace(error)) throw error;
                lastRaceError = error;
                try {
                    const reconciled = await this.reconcileRefresh(
                        userId,
                        { subscription, expiresAt, userAgentValue, now }
                    );
                    if (reconciled) return reconciled;
                } catch (reconciliationError) {
                    if (isPushSubscriptionContention(reconciliationError)) {
                        throw reconciliationError;
                    }
                    if (!isPushSubscriptionConstraintRace(reconciliationError)) {
                        throw reconciliationError;
                    }
                    lastRaceError = reconciliationError;
                }
                if (attempt < PUSH_SUBSCRIPTION_CONSTRAINT_WRITE_ATTEMPTS - 1) {
                    await waitBeforePushSubscriptionRetry(attempt);
                }
            }
        }
        throw lastRaceError;
    }

    async garbageCollect(limit = PUSH_SUBSCRIPTION_GC_BATCH_SIZE): Promise<number> {
        const boundedLimit = positiveIntegerOption(limit, 'push subscription GC limit');
        const now = normalizeISO8601Timestamp(this.now());
        return this.database.transaction(async (transaction) => {
            await transaction('push_subscription_write_lock')
                .where({ lock_key: 1 })
                .update({ lock_key: 1 });
            await this.expire(transaction, now, { limit: boundedLimit });
            return this.deleteGarbageCollectable(
                transaction,
                { now, limit: boundedLimit }
            );
        });
    }

    async list(userId: string): Promise<PushSubscription[]> {
        assertIdentifier(userId, 'push subscription userId');
        const now = normalizeISO8601Timestamp(this.now());
        const rows = await this.database<PushSubscriptionRow>('push_subscriptions')
            .where({ user_id: userId })
            .whereNull('revoked_at')
            .andWhere((expiration) => {
                expiration.whereNull('expires_at').orWhere('expires_at', '>', now);
            })
            .orderBy('updated_at', 'desc')
            .orderBy('subscription_id', 'asc');
        return rows.map(toPushSubscription);
    }

    async revokeByEndpoint(userId: string, endpoint: string): Promise<boolean> {
        assertIdentifier(userId, 'push subscription userId');
        const normalizedEndpoint = validateNotificationInput(() =>
            parsePushSubscriptionEndpoint(endpoint, { allowInsecureLocalhost: true }));
        return this.revokeWhere({ user_id: userId, endpoint: normalizedEndpoint });
    }

    async revokeById(userId: string, subscriptionId: string): Promise<boolean> {
        assertIdentifier(userId, 'push subscription userId');
        assertIdentifier(subscriptionId, 'push subscription id');
        return this.revokeWhere({ user_id: userId, subscription_id: subscriptionId });
    }

    private async revokeWhere(ownership: Record<string, string>): Promise<boolean> {
        const revokedAt = normalizeISO8601Timestamp(this.now());
        const updated = await this.database('push_subscriptions')
            .where(ownership)
            .whereNull('revoked_at')
            .update({ revoked_at: revokedAt });
        return updated > 0;
    }

    private async reconcileRefresh(
        userId: string,
        refresh: PushSubscriptionRefresh
    ): Promise<PushSubscription | null> {
        const { subscription, expiresAt, userAgentValue, now } = refresh;
        const owner = await this.findActiveOwner(this.database, subscription.endpoint, now);
        if (!owner) return null;
        if (owner.user_id !== userId) throw new PushSubscriptionConflictError();
        if (!pushSubscriptionRefreshDiffers(
            owner,
            subscription,
            expiresAt,
            userAgentValue
        )) {
            return toPushSubscription(owner);
        }

        const updated = await this.database('push_subscriptions')
            .where({
                subscription_id: owner.subscription_id,
                user_id: userId,
                endpoint: subscription.endpoint
            })
            .whereNull('revoked_at')
            .update(buildPushSubscriptionRefreshValues(
                this.database,
                subscription,
                expiresAt,
                userAgentValue
            ));
        if (updated === 0) return null;
        const stored = await this.database<PushSubscriptionRow>('push_subscriptions')
            .where({ subscription_id: owner.subscription_id })
            .first();
        if (!stored) throw new Error('Push subscription was not persisted');
        return toPushSubscription(stored);
    }

    private async findActiveOwner(
        database: Database,
        endpoint: string,
        now: ISO8601Timestamp
    ): Promise<PushSubscriptionRow | undefined> {
        return database<PushSubscriptionRow>('push_subscriptions')
            .where({ endpoint })
            .whereNull('revoked_at')
            .andWhere((expiration) => {
                expiration.whereNull('expires_at').orWhere('expires_at', '>', now);
            })
            .orderBy('subscription_id', 'asc')
            .first();
    }

    private async prepareEnrollment(
        transaction: Knex.Transaction,
        userId: string,
        preparation: PushSubscriptionEnrollmentPreparation
    ): Promise<void> {
        const { now, createsStoredVersion, excludedSubscriptionId } = preparation;
        await this.deleteGarbageCollectable(transaction, {
            now,
            limit: PUSH_SUBSCRIPTION_GC_BATCH_SIZE,
            userId,
            excludedSubscriptionId
        });

        const activeCount = await this.count(transaction, userId, true, now);
        if (activeCount >= this.maxActivePushSubscriptionsPerUser) {
            throw new PushSubscriptionQuotaError(
                'active',
                this.maxActivePushSubscriptionsPerUser
            );
        }

        if (createsStoredVersion) {
            let storedCount = await this.count(transaction, userId, false);
            if (storedCount >= this.maxStoredPushSubscriptionsPerUser) {
                const requiredCapacity = storedCount
                    - this.maxStoredPushSubscriptionsPerUser
                    + 1;
                await this.deleteGarbageCollectable(transaction, {
                    now,
                    limit: requiredCapacity,
                    userId,
                    includeRecent: true
                });
                storedCount = await this.count(transaction, userId, false);
            }
            if (storedCount >= this.maxStoredPushSubscriptionsPerUser) {
                throw new PushSubscriptionQuotaError(
                    'stored',
                    this.maxStoredPushSubscriptionsPerUser
                );
            }
        }
        await this.consumeEnrollment(transaction, userId, now);
    }

    private async contentionAttemptLimit(): Promise<number> {
        try {
            const rows = await this.database.raw('PRAGMA busy_timeout') as Array<{
                timeout?: number;
                busy_timeout?: number;
            }>;
            const timeout = Number(rows[0]?.timeout ?? rows[0]?.busy_timeout);
            return Number.isFinite(timeout)
                && timeout >= 0
                && timeout <= PUSH_SUBSCRIPTION_SHORT_BUSY_TIMEOUT_MAX_MS
                ? 2
                : 1;
        } catch {
            return 1;
        }
    }

    private async count(
        database: Database,
        userId: string,
        activeOnly: boolean,
        now?: ISO8601Timestamp
    ): Promise<number> {
        const query = database('push_subscriptions').where({ user_id: userId });
        if (activeOnly) {
            if (now === undefined) throw new Error('Active subscription count requires now');
            query.whereNull('revoked_at').andWhere((expiration) => {
                expiration.whereNull('expires_at').orWhere('expires_at', '>', now);
            });
        }
        const row = await query.count({ count: '*' }).first() as {
            count: number | string;
        } | undefined;
        const count = Number(row?.count ?? 0);
        if (!Number.isSafeInteger(count) || count < 0) {
            throw new Error('Invalid push subscription count returned by database');
        }
        return count;
    }

    private async expire(
        database: Database,
        now: ISO8601Timestamp,
        scope: PushSubscriptionExpirationScope
    ): Promise<number> {
        const scopedCandidates = () => {
            const query = database<PushSubscriptionRow>('push_subscriptions')
                .whereNull('revoked_at')
                .whereNotNull('expires_at')
                .where('expires_at', '<=', now);
            if (scope.userId !== undefined || scope.endpoint !== undefined) {
                query.andWhere((selection) => {
                    if (scope.userId !== undefined) selection.where({ user_id: scope.userId });
                    if (scope.endpoint !== undefined) {
                        const method = scope.userId === undefined ? 'where' : 'orWhere';
                        selection[method]({ endpoint: scope.endpoint });
                    }
                });
            }
            return query;
        };
        if (scope.limit === undefined) {
            return scopedCandidates().update({ revoked_at: now });
        }
        const rows = await scopedCandidates()
            .select('subscription_id')
            .orderBy('expires_at', 'asc')
            .orderBy('subscription_id', 'asc')
            .limit(scope.limit);
        const subscriptionIds = rows.map(({ subscription_id: id }) => id);
        if (subscriptionIds.length === 0) return 0;
        return database('push_subscriptions')
            .whereIn('subscription_id', subscriptionIds)
            .whereNull('revoked_at')
            .whereNotNull('expires_at')
            .where('expires_at', '<=', now)
            .update({ revoked_at: now });
    }

    private async consumeEnrollment(
        transaction: Knex.Transaction,
        userId: string,
        now: ISO8601Timestamp
    ): Promise<void> {
        const row = await transaction<PushSubscriptionEnrollmentLimitRow>(
            'push_subscription_enrollment_limits'
        ).where({ user_id: userId }).first();
        const nowMs = Date.parse(now);
        const windowStartedAtMs = row === undefined
            ? Number.NaN
            : Date.parse(row.window_started_at);
        const elapsed = nowMs - windowStartedAtMs;
        const inCurrentWindow = row !== undefined
            && Number.isFinite(elapsed)
            && elapsed >= 0
            && elapsed < this.pushSubscriptionEnrollmentWindowMs;

        if (inCurrentWindow
            && row.enrollment_count >= this.maxPushSubscriptionEnrollmentsPerWindow) {
            const retryAfterSeconds = Math.max(
                1,
                Math.ceil((this.pushSubscriptionEnrollmentWindowMs - elapsed) / 1000)
            );
            throw new PushSubscriptionRateLimitError(retryAfterSeconds);
        }
        if (inCurrentWindow) {
            await transaction('push_subscription_enrollment_limits')
                .where({ user_id: userId })
                .update({ enrollment_count: row.enrollment_count + 1 });
            return;
        }
        await transaction('push_subscription_enrollment_limits')
            .insert({ user_id: userId, window_started_at: now, enrollment_count: 1 })
            .onConflict('user_id')
            .merge({ window_started_at: now, enrollment_count: 1 });
    }

    private async deleteGarbageCollectable(
        database: Database,
        collection: PushSubscriptionGarbageCollection
    ): Promise<number> {
        const { now, limit, userId, includeRecent = false,
            excludedSubscriptionId } = collection;
        const cutoff = normalizeISO8601Timestamp(
            Date.parse(now) - this.pushSubscriptionRevokedRetentionMs
        );
        const candidates = database<PushSubscriptionRow>('push_subscriptions')
            .select('subscription_id')
            .whereNotNull('revoked_at')
            .whereNotIn(
                'subscription_id',
                database('push_delivery_jobs').select('subscription_id')
            );
        if (!includeRecent) candidates.where('revoked_at', '<=', cutoff);
        if (userId !== undefined) candidates.where({ user_id: userId });
        if (excludedSubscriptionId !== undefined) {
            candidates.whereNot({ subscription_id: excludedSubscriptionId });
        }
        const rows = await candidates
            .orderBy('revoked_at', 'asc')
            .orderBy('subscription_id', 'asc')
            .limit(limit);
        const subscriptionIds = rows.map(({ subscription_id: id }) => id);
        if (subscriptionIds.length === 0) return 0;
        return database('push_subscriptions')
            .whereIn('subscription_id', subscriptionIds)
            .whereNotNull('revoked_at')
            .whereNotIn(
                'subscription_id',
                database('push_delivery_jobs').select('subscription_id')
            )
            .delete();
    }
}

export class NotificationValidationError extends Error {
    readonly code = 'INVALID_NOTIFICATION_INPUT';

    constructor(message: string) {
        super(message);
        this.name = 'NotificationValidationError';
    }
}

export class PushSubscriptionConflictError extends Error {
    readonly code = 'PUSH_SUBSCRIPTION_CONFLICT';

    constructor() {
        super('Push subscription endpoint is already enrolled');
        this.name = 'PushSubscriptionConflictError';
    }
}

export class PushSubscriptionQuotaError extends Error {
    readonly code = 'PUSH_SUBSCRIPTION_QUOTA_EXCEEDED';
    readonly scope: 'active' | 'stored';
    readonly limit: number;

    constructor(scope: 'active' | 'stored', limit: number) {
        super(scope === 'active'
            ? `A user may have at most ${limit} active push subscriptions`
            : `A user may retain at most ${limit} push subscription records`);
        this.name = 'PushSubscriptionQuotaError';
        this.scope = scope;
        this.limit = limit;
    }
}

export class PushSubscriptionRateLimitError extends Error {
    readonly code = 'PUSH_SUBSCRIPTION_RATE_LIMITED';
    readonly retryAfterSeconds: number;

    constructor(retryAfterSeconds: number) {
        super('Too many push subscription enrollments');
        this.name = 'PushSubscriptionRateLimitError';
        this.retryAfterSeconds = retryAfterSeconds;
    }
}
