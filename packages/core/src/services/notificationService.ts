/* eslint-disable max-lines -- event creation and Inbox state share one transactional boundary */
import { ECDH, randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import {
    DEFAULT_NOTIFICATION_PREFERENCE_CHANNELS,
    DEFAULT_NOTIFICATION_QUIET_HOURS,
    NOTIFICATION_KINDS,
    NOTIFICATION_PAYLOAD_LIMITS,
    normalizeISO8601Timestamp,
    parseNotification,
    parseNotificationEvent,
    parseNotificationListResponse,
    parseNotificationPreferencesResponse,
    parseNotificationPreferencesUpdate,
    parseNotificationStateResponse,
    parseTruthyEnvValue,
    parsePushSubscription,
    parsePushSubscriptionEndpoint,
    parsePushSubscriptionInput,
    type ISO8601Timestamp,
    type JsonObject,
    type Notification,
    type NotificationAction,
    type NotificationEvent,
    type NotificationKind,
    type NotificationListResponse,
    type NotificationPreferenceChannels,
    type NotificationPreferencesResponse,
    type NotificationPreferencesUpdate,
    type NotificationSeverity,
    type NotificationStateResponse,
    type NotificationTargetFor,
    type PushSubscription,
    type PushSubscriptionInput
} from '@propr/shared';
import { db } from '../db/connection.js';
import {
    decodeNotificationCursor,
    encodeNotificationCursor,
    parseNotificationListLimit
} from './notificationPagination.js';

type TimestampInput = string | number | Date;
type Database = Knex | Knex.Transaction;

export interface NotificationRecipientInput {
    userId: string;
    /** Producer eligibility; stored user preferences are applied at assignment time. */
    inboxEnabled?: boolean;
    pushEnabled?: boolean;
}

export type NotificationRecipient = string | NotificationRecipientInput;

export type CreateNotificationEventInput<
    K extends NotificationKind = NotificationKind
> = K extends NotificationKind ? {
    /** Optional stable ID; a UUID is generated when omitted. */
    id?: string;
    /** Backwards-friendly persistence spelling accepted in addition to `id`. */
    eventId?: string;
    deduplicationKey: string;
    kind: K;
    severity?: NotificationSeverity;
    target: NotificationTargetFor<K>;
    title: string;
    body: string;
    action?: NotificationAction;
    metadata?: JsonObject;
    occurredAt?: TimestampInput;
    /** Trusted producer-selected recipients, snapshotted with this event. */
    recipients?: readonly NotificationRecipient[];
} : never;

export interface NotificationListOptions {
    cursor?: string | null;
    limit?: number;
    includeDismissed?: boolean;
}

export interface NotificationServiceOptions {
    database?: Knex;
    now?: () => TimestampInput;
    generateId?: () => string;
    allowInsecureLocalhost?: boolean;
    maxActivePushSubscriptionsPerUser?: number;
    maxStoredPushSubscriptionsPerUser?: number;
    maxPushSubscriptionEnrollmentsPerWindow?: number;
    pushSubscriptionEnrollmentWindowMs?: number;
    pushSubscriptionRevokedRetentionMs?: number;
}

interface NotificationEventRow {
    event_id: string;
    deduplication_key: string;
    kind: string;
    severity: string;
    target_json: string;
    title: string;
    body: string;
    action_json: string | null;
    metadata_json: string | null;
    occurred_at: string;
    created_at: string;
}

interface NotificationRow extends NotificationEventRow {
    read_at: string | null;
    dismissed_at: string | null;
}

interface NotificationPreferenceRow {
    user_id: string;
    notification_kind: string;
    inbox_enabled: number | boolean;
    push_enabled: number | boolean;
    updated_at: string;
}

interface NotificationPreferenceSettingsRow {
    user_id: string;
    quiet_hours_start: string | null;
    quiet_hours_end: string | null;
    timezone: string;
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

interface NormalizedRecipient {
    userId: string;
    inboxEnabled: boolean;
    pushEnabled: boolean;
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

function parseStoredJson(value: string, field: string): unknown {
    try {
        return JSON.parse(value) as unknown;
    } catch {
        throw new Error(`Stored notification ${field} is invalid JSON`);
    }
}

function toNotificationEvent(row: NotificationEventRow): NotificationEvent {
    return parseNotificationEvent({
        id: row.event_id,
        deduplicationKey: row.deduplication_key,
        kind: row.kind,
        severity: row.severity,
        target: parseStoredJson(row.target_json, 'target'),
        title: row.title,
        body: row.body,
        ...(row.action_json === null
            ? {}
            : { action: parseStoredJson(row.action_json, 'action') }),
        ...(row.metadata_json === null
            ? {}
            : { metadata: parseStoredJson(row.metadata_json, 'metadata') }),
        occurredAt: row.occurred_at,
        createdAt: row.created_at
    });
}

function toNotification(row: NotificationRow): Notification {
    return parseNotification({
        ...toNotificationEvent(row),
        readAt: row.read_at,
        dismissedAt: row.dismissed_at
    });
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
        // Preserve delivery recency only when the encryption material is
        // unchanged. The SQL expression remains correct if another writer
        // refreshes the row between reconciliation reads and this update.
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

async function waitBeforePushSubscriptionRetry(attempt: number): Promise<void> {
    const delay = Math.min(
        PUSH_SUBSCRIPTION_RETRY_BASE_DELAY_MS * (2 ** attempt),
        PUSH_SUBSCRIPTION_RETRY_MAX_DELAY_MS
    );
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
}

function asNotificationValidationError(error: unknown): never {
    if (error instanceof NotificationValidationError) throw error;
    if (error instanceof TypeError) {
        throw new NotificationValidationError(error.message);
    }
    throw error;
}

function validateNotificationInput<T>(parser: () => T): T {
    try {
        return parser();
    } catch (error) {
        return asNotificationValidationError(error);
    }
}

function assertIdentifier(value: string, path: string): void {
    // Reuse the durable event parser's identifier constraints without exposing
    // unbounded values to SQLite. User IDs come from trusted auth or workers.
    if (
        typeof value !== 'string'
        || value.trim().length === 0
        || Buffer.byteLength(value, 'utf8') > NOTIFICATION_PAYLOAD_LIMITS.identifierBytes
    ) {
        throw new TypeError(`${path} must be a bounded non-empty string`);
    }
}

function normalizeRecipients(
    recipients: readonly NotificationRecipient[]
): NormalizedRecipient[] {
    const normalized = new Map<string, NormalizedRecipient>();

    for (const recipient of recipients) {
        const value = typeof recipient === 'string'
            ? { userId: recipient }
            : recipient;
        assertIdentifier(value.userId, 'notification recipient userId');
        const inboxEnabled = value.inboxEnabled ?? true;
        const pushEnabled = value.pushEnabled ?? false;
        if (typeof inboxEnabled !== 'boolean' || typeof pushEnabled !== 'boolean') {
            throw new TypeError('notification recipient channels must be booleans');
        }
        if (!inboxEnabled && !pushEnabled) {
            throw new TypeError('notification recipient must have at least one enabled channel');
        }

        const existing = normalized.get(value.userId);
        if (
            existing
            && (existing.inboxEnabled !== inboxEnabled || existing.pushEnabled !== pushEnabled)
        ) {
            throw new TypeError('duplicate notification recipient has conflicting channels');
        }
        normalized.set(value.userId, { userId: value.userId, inboxEnabled, pushEnabled });
    }

    return [...normalized.values()];
}

function eventSelectColumns(): string[] {
    return [
        'event.event_id',
        'event.deduplication_key',
        'event.kind',
        'event.severity',
        'event.target_json',
        'event.title',
        'event.body',
        'event.action_json',
        'event.metadata_json',
        'event.occurred_at',
        'event.created_at',
        'receipt.read_at',
        'receipt.dismissed_at'
    ];
}

async function unreadCount(database: Database, userId: string): Promise<number> {
    const result = await database('notification_user_states')
        .where({ user_id: userId, inbox_enabled: true })
        .whereNull('read_at')
        .whereNull('dismissed_at')
        .count({ count: '*' })
        .first() as { count: number | string } | undefined;

    const count = Number(result?.count ?? 0);
    if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error('Invalid notification unread count returned by database');
    }
    return count;
}

export class NotificationService {
    private readonly database: Knex;
    private readonly now: () => TimestampInput;
    private readonly generateId: () => string;
    private readonly allowInsecureLocalhost: boolean;
    private readonly maxActivePushSubscriptionsPerUser: number;
    private readonly maxStoredPushSubscriptionsPerUser: number;
    private readonly maxPushSubscriptionEnrollmentsPerWindow: number;
    private readonly pushSubscriptionEnrollmentWindowMs: number;
    private readonly pushSubscriptionRevokedRetentionMs: number;

    constructor(options: NotificationServiceOptions = {}) {
        this.database = options.database ?? db;
        this.now = options.now ?? (() => new Date());
        this.generateId = options.generateId ?? randomUUID;
        this.allowInsecureLocalhost = options.allowInsecureLocalhost
            ?? parseTruthyEnvValue(process.env.PROPR_ALLOW_INSECURE_LOCAL_WEB_PUSH);
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
        if (
            this.maxStoredPushSubscriptionsPerUser
            < this.maxActivePushSubscriptionsPerUser
        ) {
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

    async createNotificationEvent<K extends NotificationKind>(
        input: CreateNotificationEventInput<K>,
        recipients: readonly NotificationRecipient[] = input.recipients ?? []
    ): Promise<NotificationEvent<K>> {
        if (input.id !== undefined && input.eventId !== undefined && input.id !== input.eventId) {
            throw new TypeError('notification id and eventId must match when both are supplied');
        }

        const createdAt = normalizeISO8601Timestamp(this.now());
        const event = parseNotificationEvent({
            id: input.eventId ?? input.id ?? this.generateId(),
            deduplicationKey: input.deduplicationKey,
            kind: input.kind,
            severity: input.severity ?? 'info',
            target: input.target,
            title: input.title,
            body: input.body,
            ...(input.action === undefined ? {} : { action: input.action }),
            ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
            occurredAt: input.occurredAt === undefined
                ? createdAt
                : normalizeISO8601Timestamp(input.occurredAt),
            createdAt
        }) as NotificationEvent<K>;
        const normalizedRecipients = normalizeRecipients(recipients);

        return this.database.transaction(async (transaction) => {
            await transaction('notification_events')
                .insert({
                    event_id: event.id,
                    deduplication_key: event.deduplicationKey,
                    kind: event.kind,
                    severity: event.severity,
                    target_json: JSON.stringify(event.target),
                    title: event.title,
                    body: event.body,
                    action_json: event.action === undefined ? null : JSON.stringify(event.action),
                    metadata_json: event.metadata === undefined ? null : JSON.stringify(event.metadata),
                    occurred_at: event.occurredAt,
                    created_at: event.createdAt
                })
                .onConflict('deduplication_key')
                .ignore();

            const storedRow = await transaction<NotificationEventRow>('notification_events')
                .where({ deduplication_key: event.deduplicationKey })
                .first();
            if (!storedRow) {
                throw new Error('Notification event was not persisted');
            }
            const storedEvent = toNotificationEvent(storedRow) as NotificationEvent<K>;
            await this.assignRecipients(transaction, storedEvent, normalizedRecipients);
            return storedEvent;
        });
    }

    async assignNotificationRecipients(
        eventId: string,
        recipients: readonly NotificationRecipient[]
    ): Promise<void> {
        assertIdentifier(eventId, 'notification eventId');
        const normalizedRecipients = normalizeRecipients(recipients);

        await this.database.transaction(async (transaction) => {
            const eventRow = await transaction<NotificationEventRow>('notification_events')
                .where({ event_id: eventId })
                .first();
            if (!eventRow) throw new NotificationEventNotFoundError(eventId);
            await this.assignRecipients(
                transaction,
                toNotificationEvent(eventRow),
                normalizedRecipients
            );
        });
    }

    async getNotificationPreferences(userId: string): Promise<NotificationPreferencesResponse> {
        assertIdentifier(userId, 'notification userId');
        return this.readPreferenceSnapshot(this.database, userId);
    }

    async updateNotificationPreferences(
        userId: string,
        input: NotificationPreferencesUpdate
    ): Promise<NotificationPreferencesResponse> {
        assertIdentifier(userId, 'notification userId');
        const update = validateNotificationInput(() =>
            parseNotificationPreferencesUpdate(input));

        return this.database.transaction(async (transaction) => {
            for (const [kind, channels] of Object.entries(update.preferences ?? {})) {
                const values: Record<string, boolean> = {};
                if (channels.inboxEnabled !== undefined) {
                    values.inbox_enabled = channels.inboxEnabled;
                }
                if (channels.pushEnabled !== undefined) {
                    values.push_enabled = channels.pushEnabled;
                }
                await transaction('notification_preferences')
                    .insert({
                        user_id: userId,
                        notification_kind: kind,
                        inbox_enabled: channels.inboxEnabled
                            ?? DEFAULT_NOTIFICATION_PREFERENCE_CHANNELS.inboxEnabled,
                        push_enabled: channels.pushEnabled
                            ?? DEFAULT_NOTIFICATION_PREFERENCE_CHANNELS.pushEnabled
                    })
                    .onConflict(['user_id', 'notification_kind'])
                    .merge(values);
            }

            if (update.quietHours !== undefined) {
                const values: Record<string, string | null> = {};
                if (update.quietHours.start !== undefined) {
                    values.quiet_hours_start = update.quietHours.start;
                }
                if (update.quietHours.end !== undefined) {
                    values.quiet_hours_end = update.quietHours.end;
                }
                if (update.quietHours.timezone !== undefined) {
                    values.timezone = update.quietHours.timezone;
                }
                await transaction('notification_preference_settings')
                    .insert({
                        user_id: userId,
                        quiet_hours_start: update.quietHours.start
                            ?? DEFAULT_NOTIFICATION_QUIET_HOURS.start,
                        quiet_hours_end: update.quietHours.end
                            ?? DEFAULT_NOTIFICATION_QUIET_HOURS.end,
                        timezone: update.quietHours.timezone
                            ?? DEFAULT_NOTIFICATION_QUIET_HOURS.timezone
                    })
                    .onConflict('user_id')
                    .merge(values);
            }

            return this.readPreferenceSnapshot(transaction, userId);
        });
    }

    async updateNotificationPreference(
        userId: string,
        category: string,
        channels: Partial<NotificationPreferenceChannels>
    ): Promise<NotificationPreferencesResponse> {
        return this.updateNotificationPreferences(userId, {
            preferences: { [category]: channels }
        } as NotificationPreferencesUpdate);
    }

    async upsertPushSubscription(
        userId: string,
        input: PushSubscriptionInput,
        userAgent?: string
    ): Promise<PushSubscription> {
        assertIdentifier(userId, 'push subscription userId');
        const subscription = validateNotificationInput(() =>
            parsePushSubscriptionInput(input, {
                allowInsecureLocalhost: this.allowInsecureLocalhost
            }));
        // The shared parser performs a platform-neutral curve equation check;
        // confirm it with OpenSSL at this Node persistence boundary as well.
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

        const contentionAttemptLimit = await this.pushSubscriptionContentionAttemptLimit();
        let contentionFailures = 0;
        let lastRaceError: unknown;
        for (
            let attempt = 0;
            attempt < PUSH_SUBSCRIPTION_CONSTRAINT_WRITE_ATTEMPTS;
            attempt += 1
        ) {
            try {
                return await this.database.transaction(async (transaction) => {
                    // Acquire SQLite's single-writer slot before taking an
                    // ownership/quota snapshot. Contending enrollments then wait
                    // once inside the configured busy timeout and read fresh
                    // state instead of repeatedly failing lock upgrades.
                    await transaction('push_subscription_write_lock')
                        .where({ lock_key: 1 })
                        .update({ lock_key: 1 });
                    const activeOwner = await transaction<PushSubscriptionRow>(
                        'push_subscriptions'
                    )
                        .where({ endpoint: subscription.endpoint })
                        .whereNull('revoked_at')
                        .orderBy('subscription_id', 'asc')
                        .first();
                    if (activeOwner && activeOwner.user_id !== userId) {
                        throw new PushSubscriptionConflictError();
                    }

                    // Prefer the already-active owned row. Legacy append-only data can
                    // contain newer revoked versions with identical timestamps.
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
                        await this.preparePushSubscriptionEnrollment(
                            transaction,
                            userId,
                            {
                                now,
                                createsStoredVersion: existing === undefined,
                                excludedSubscriptionId: existing?.subscription_id
                            }
                        );
                    }
                    if (existing) {
                        await transaction('push_subscriptions')
                            .where({ subscription_id: existing.subscription_id, user_id: userId })
                            .update(buildPushSubscriptionRefreshValues(
                                transaction,
                                subscription,
                                expiresAt,
                                userAgentValue
                            ));
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
                // SQLite's configured busy timeout is already the bounded retry
                // policy for lock contention. Long configured timeouts get no
                // application retry; short/test timeouts get one retry so an
                // async better-sqlite3 writer can resume and commit. Contention
                // never performs the additional reconciliation query.
                if (isPushSubscriptionContention(error)) {
                    contentionFailures += 1;
                    if (contentionFailures >= contentionAttemptLimit) throw error;
                    lastRaceError = error;
                    await waitBeforePushSubscriptionRetry(attempt);
                    continue;
                }
                if (!isPushSubscriptionConstraintRace(error)) throw error;
                lastRaceError = error;

                // The unique partial index is the final ownership authority. A
                // competing transaction may have committed after our initial read.
                // Reconciliation is itself contention-prone, so keep it inside the
                // retry policy. A same-user owner must be refreshed before success;
                // merely returning it can silently discard rotated browser keys.
                try {
                    const reconciled = await this.reconcilePushSubscriptionRefresh(
                        userId,
                        subscription,
                        expiresAt,
                        userAgentValue
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

    /**
     * Delete a bounded batch of old, revoked subscriptions that have no delivery
     * audit references. The database trigger independently enforces both safety
     * conditions in case a future caller builds a broader query.
     */
    async garbageCollectPushSubscriptions(
        limit = PUSH_SUBSCRIPTION_GC_BATCH_SIZE
    ): Promise<number> {
        const boundedLimit = positiveIntegerOption(limit, 'push subscription GC limit');
        const now = normalizeISO8601Timestamp(this.now());
        return this.database.transaction((transaction) =>
            this.deleteGarbageCollectablePushSubscriptions(
                transaction,
                { now, limit: boundedLimit }
            ));
    }

    async revokePushSubscription(userId: string, endpoint: string): Promise<boolean> {
        assertIdentifier(userId, 'push subscription userId');
        const normalizedEndpoint = validateNotificationInput(() =>
            parsePushSubscriptionEndpoint(endpoint, {
                // Disabling local enrollment must not strand loopback rows that
                // were registered while the development opt-in was enabled.
                allowInsecureLocalhost: true
            }));
        const revokedAt = normalizeISO8601Timestamp(this.now());
        const updated = await this.database('push_subscriptions')
            .where({ user_id: userId, endpoint: normalizedEndpoint })
            .whereNull('revoked_at')
            .update({ revoked_at: revokedAt });
        return updated > 0;
    }

    private async reconcilePushSubscriptionRefresh(
        userId: string,
        subscription: PushSubscriptionInput,
        expiresAt: ISO8601Timestamp | null,
        userAgentValue: string | null | undefined
    ): Promise<PushSubscription | null> {
        const owner = await this.database<PushSubscriptionRow>('push_subscriptions')
            .where({ endpoint: subscription.endpoint })
            .whereNull('revoked_at')
            .orderBy('subscription_id', 'asc')
            .first();
        if (!owner) return null;
        if (owner.user_id !== userId) throw new PushSubscriptionConflictError();

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

    private async preparePushSubscriptionEnrollment(
        transaction: Knex.Transaction,
        userId: string,
        preparation: PushSubscriptionEnrollmentPreparation
    ): Promise<void> {
        const { now, createsStoredVersion, excludedSubscriptionId } = preparation;
        await this.deleteGarbageCollectablePushSubscriptions(
            transaction,
            {
                now,
                limit: PUSH_SUBSCRIPTION_GC_BATCH_SIZE,
                userId,
                excludedSubscriptionId
            }
        );

        const activeCount = await this.countPushSubscriptions(
            transaction,
            userId,
            true
        );
        if (activeCount >= this.maxActivePushSubscriptionsPerUser) {
            throw new PushSubscriptionQuotaError(
                'active',
                this.maxActivePushSubscriptionsPerUser
            );
        }

        if (createsStoredVersion) {
            let storedCount = await this.countPushSubscriptions(transaction, userId, false);
            if (storedCount >= this.maxStoredPushSubscriptionsPerUser) {
                const requiredCapacity = storedCount
                    - this.maxStoredPushSubscriptionsPerUser
                    + 1;
                await this.deleteGarbageCollectablePushSubscriptions(
                    transaction,
                    {
                        now,
                        limit: requiredCapacity,
                        userId,
                        includeRecent: true
                    }
                );
                storedCount = await this.countPushSubscriptions(transaction, userId, false);
            }
            if (storedCount >= this.maxStoredPushSubscriptionsPerUser) {
                throw new PushSubscriptionQuotaError(
                    'stored',
                    this.maxStoredPushSubscriptionsPerUser
                );
            }
        }

        await this.consumePushSubscriptionEnrollment(transaction, userId, now);
    }

    private async pushSubscriptionContentionAttemptLimit(): Promise<number> {
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

    private async countPushSubscriptions(
        database: Database,
        userId: string,
        activeOnly: boolean
    ): Promise<number> {
        const query = database('push_subscriptions').where({ user_id: userId });
        if (activeOnly) query.whereNull('revoked_at');
        const row = await query.count({ count: '*' }).first() as {
            count: number | string;
        } | undefined;
        const count = Number(row?.count ?? 0);
        if (!Number.isSafeInteger(count) || count < 0) {
            throw new Error('Invalid push subscription count returned by database');
        }
        return count;
    }

    private async consumePushSubscriptionEnrollment(
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

        if (
            inCurrentWindow
            && row.enrollment_count >= this.maxPushSubscriptionEnrollmentsPerWindow
        ) {
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
            .insert({
                user_id: userId,
                window_started_at: now,
                enrollment_count: 1
            })
            .onConflict('user_id')
            .merge({ window_started_at: now, enrollment_count: 1 });
    }

    private async deleteGarbageCollectablePushSubscriptions(
        database: Database,
        collection: PushSubscriptionGarbageCollection
    ): Promise<number> {
        const {
            now,
            limit,
            userId,
            includeRecent = false,
            excludedSubscriptionId
        } = collection;
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

    async listNotifications(
        userId: string,
        options: NotificationListOptions = {}
    ): Promise<NotificationListResponse> {
        assertIdentifier(userId, 'notification userId');
        const limit = parseNotificationListLimit(options.limit);
        if (options.includeDismissed !== undefined && typeof options.includeDismissed !== 'boolean') {
            throw new TypeError('includeDismissed must be a boolean');
        }
        const cursor = options.cursor === undefined || options.cursor === null
            ? null
            : decodeNotificationCursor(options.cursor);

        return this.database.transaction(async (transaction) => {
            const query = transaction('notification_user_states as receipt')
                .join('notification_events as event', 'event.event_id', 'receipt.event_id')
                .select(eventSelectColumns())
                .where({
                    'receipt.user_id': userId,
                    'receipt.inbox_enabled': true
                });

            if (!options.includeDismissed) query.whereNull('receipt.dismissed_at');
            if (cursor) {
                query.andWhere((boundary) => {
                    boundary
                        .where('event.occurred_at', '<', cursor.occurredAt)
                        .orWhere((tie) => {
                            tie.where('event.occurred_at', '=', cursor.occurredAt)
                                .andWhere('event.event_id', '<', cursor.eventId);
                        });
                });
            }

            const rows = await query
                .orderBy('event.occurred_at', 'desc')
                .orderBy('event.event_id', 'desc')
                .limit(limit + 1) as NotificationRow[];
            const pageRows = rows.slice(0, limit);
            const notifications = pageRows.map(toNotification);
            const nextCursor = rows.length > limit && notifications.length > 0
                ? encodeNotificationCursor({
                    occurredAt: notifications[notifications.length - 1].occurredAt,
                    eventId: notifications[notifications.length - 1].id
                })
                : null;

            return parseNotificationListResponse({
                notifications,
                unreadCount: await unreadCount(transaction, userId),
                nextCursor
            });
        });
    }

    async getUnreadNotificationCount(userId: string): Promise<number> {
        assertIdentifier(userId, 'notification userId');
        return unreadCount(this.database, userId);
    }

    async markNotificationRead(
        userId: string,
        eventId: string
    ): Promise<NotificationStateResponse | null> {
        return this.updateInboxTimestamp(userId, eventId, 'read_at');
    }

    async dismissNotification(
        userId: string,
        eventId: string
    ): Promise<NotificationStateResponse | null> {
        return this.updateInboxTimestamp(userId, eventId, 'dismissed_at');
    }

    private async readPreferenceSnapshot(
        database: Database,
        userId: string
    ): Promise<NotificationPreferencesResponse> {
        const rows = await database<NotificationPreferenceRow>('notification_preferences')
            .select('notification_kind', 'inbox_enabled', 'push_enabled', 'updated_at')
            .where({ user_id: userId });
        const rowByKind = new Map(rows.map((row) => [row.notification_kind, row]));
        const settings = await database<NotificationPreferenceSettingsRow>(
            'notification_preference_settings'
        ).where({ user_id: userId }).first();

        const preferences = Object.fromEntries(NOTIFICATION_KINDS.map((kind) => {
            const row = rowByKind.get(kind);
            return [kind, {
                inboxEnabled: row === undefined
                    ? DEFAULT_NOTIFICATION_PREFERENCE_CHANNELS.inboxEnabled
                    : Boolean(row.inbox_enabled),
                pushEnabled: row === undefined
                    ? DEFAULT_NOTIFICATION_PREFERENCE_CHANNELS.pushEnabled
                    : Boolean(row.push_enabled),
                // Null identifies a synthesized default without manufacturing a
                // timestamp or making GET mutate a read-only database.
                updatedAt: row?.updated_at ?? null
            }];
        }));
        return parseNotificationPreferencesResponse({
            preferences,
            quietHours: {
                start: settings?.quiet_hours_start ?? DEFAULT_NOTIFICATION_QUIET_HOURS.start,
                end: settings?.quiet_hours_end ?? DEFAULT_NOTIFICATION_QUIET_HOURS.end,
                timezone: settings?.timezone ?? DEFAULT_NOTIFICATION_QUIET_HOURS.timezone
            }
        });
    }

    private async assignRecipients(
        transaction: Knex.Transaction,
        event: NotificationEvent,
        recipients: NormalizedRecipient[]
    ): Promise<void> {
        if (recipients.length === 0) return;
        const preferenceRows = await transaction<NotificationPreferenceRow>(
            'notification_preferences'
        )
            .select('user_id', 'inbox_enabled', 'push_enabled')
            .where({ notification_kind: event.kind })
            .whereIn('user_id', recipients.map(({ userId }) => userId));
        const preferenceByUser = new Map(
            preferenceRows.map((row) => [row.user_id, row])
        );
        const eligibleRecipients = recipients.flatMap((recipient) => {
            const preference = preferenceByUser.get(recipient.userId);
            const inboxEnabled = recipient.inboxEnabled && (
                preference === undefined
                    ? DEFAULT_NOTIFICATION_PREFERENCE_CHANNELS.inboxEnabled
                    : Boolean(preference.inbox_enabled)
            );
            const pushEnabled = recipient.pushEnabled && (
                preference === undefined
                    ? DEFAULT_NOTIFICATION_PREFERENCE_CHANNELS.pushEnabled
                    : Boolean(preference.push_enabled)
            );
            return inboxEnabled || pushEnabled
                ? [{ ...recipient, inboxEnabled, pushEnabled }]
                : [];
        });
        if (eligibleRecipients.length === 0) return;
        const now = normalizeISO8601Timestamp(this.now());
        const assignedAt: ISO8601Timestamp = now < event.createdAt ? event.createdAt : now;

        await transaction('notification_user_states')
            .insert(eligibleRecipients.map((recipient) => ({
                event_id: event.id,
                user_id: recipient.userId,
                inbox_enabled: recipient.inboxEnabled,
                push_enabled: recipient.pushEnabled,
                read_at: null,
                dismissed_at: null,
                created_at: assignedAt
            })))
            .onConflict(['event_id', 'user_id'])
            .ignore();
    }

    private async updateInboxTimestamp(
        userId: string,
        eventId: string,
        column: 'read_at' | 'dismissed_at'
    ): Promise<NotificationStateResponse | null> {
        assertIdentifier(userId, 'notification userId');
        assertIdentifier(eventId, 'notification eventId');
        const timestamp = normalizeISO8601Timestamp(this.now());

        return this.database.transaction(async (transaction) => {
            await transaction('notification_user_states')
                .where({
                    event_id: eventId,
                    user_id: userId,
                    inbox_enabled: true
                })
                .whereNull(column)
                .update({ [column]: timestamp });

            const row = await transaction('notification_user_states as receipt')
                .join('notification_events as event', 'event.event_id', 'receipt.event_id')
                .select(eventSelectColumns())
                .where({
                    'receipt.event_id': eventId,
                    'receipt.user_id': userId,
                    'receipt.inbox_enabled': true
                })
                .first() as NotificationRow | undefined;
            if (!row) return null;

            return parseNotificationStateResponse({
                notification: toNotification(row),
                unreadCount: await unreadCount(transaction, userId)
            });
        });
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

export class NotificationEventNotFoundError extends Error {
    constructor(eventId: string) {
        super(`Notification event ${eventId} was not found`);
        this.name = 'NotificationEventNotFoundError';
    }
}

export const notificationService = new NotificationService();

export const createNotificationEvent = notificationService.createNotificationEvent
    .bind(notificationService) as NotificationService['createNotificationEvent'];
export const assignNotificationRecipients = notificationService.assignNotificationRecipients
    .bind(notificationService) as NotificationService['assignNotificationRecipients'];
export const listNotifications = notificationService.listNotifications
    .bind(notificationService) as NotificationService['listNotifications'];
export const getUnreadNotificationCount = notificationService.getUnreadNotificationCount
    .bind(notificationService) as NotificationService['getUnreadNotificationCount'];
export const markNotificationRead = notificationService.markNotificationRead
    .bind(notificationService) as NotificationService['markNotificationRead'];
export const dismissNotification = notificationService.dismissNotification
    .bind(notificationService) as NotificationService['dismissNotification'];
export const getNotificationPreferences = notificationService.getNotificationPreferences
    .bind(notificationService) as NotificationService['getNotificationPreferences'];
export const updateNotificationPreferences = notificationService.updateNotificationPreferences
    .bind(notificationService) as NotificationService['updateNotificationPreferences'];
export const updateNotificationPreference = notificationService.updateNotificationPreference
    .bind(notificationService) as NotificationService['updateNotificationPreference'];
export const upsertPushSubscription = notificationService.upsertPushSubscription
    .bind(notificationService) as NotificationService['upsertPushSubscription'];
export const revokePushSubscription = notificationService.revokePushSubscription
    .bind(notificationService) as NotificationService['revokePushSubscription'];
export const garbageCollectPushSubscriptions = notificationService
    .garbageCollectPushSubscriptions
    .bind(notificationService) as NotificationService['garbageCollectPushSubscriptions'];
