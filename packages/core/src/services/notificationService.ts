/* eslint-disable max-lines -- event creation, preferences, and Inbox state share transactions */
import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import {
    DEFAULT_NOTIFICATION_PREFERENCE_CHANNELS,
    DEFAULT_NOTIFICATION_QUIET_HOURS,
    NOTIFICATION_KINDS,
    NOTIFICATION_PAYLOAD_LIMITS,
    normalizeISO8601Timestamp,
    parseIanaTimezone,
    parseNotification,
    parseNotificationEvent,
    parseNotificationListResponse,
    parseNotificationPreferencesResponse,
    parseNotificationPreferencesUpdate,
    parseNotificationStateResponse,
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
import {
    MAX_ACTIVE_PUSH_SUBSCRIPTIONS_PER_USER,
    MAX_PUSH_SUBSCRIPTION_ENROLLMENTS_PER_WINDOW,
    MAX_STORED_PUSH_SUBSCRIPTIONS_PER_USER,
    NotificationValidationError,
    PUSH_SUBSCRIPTION_ENROLLMENT_WINDOW_MS,
    PUSH_SUBSCRIPTION_GC_BATCH_SIZE,
    PUSH_SUBSCRIPTION_REVOKED_RETENTION_MS,
    PushSubscriptionConflictError,
    PushSubscriptionQuotaError,
    PushSubscriptionRateLimitError,
    PushSubscriptionService,
    type PushSubscriptionPolicyOptions
} from './pushSubscriptionService.js';

type TimestampInput = string | number | Date;
type Database = Knex | Knex.Transaction;

export interface NotificationRecipientInput {
    userId: string;
    /** Producer eligibility; stored user preferences are applied at assignment time. */
    inboxEnabled?: boolean;
    pushEnabled: boolean;
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

export interface NotificationServiceOptions extends PushSubscriptionPolicyOptions {
    database?: Knex;
    now?: () => TimestampInput;
    generateId?: () => string;
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

interface NormalizedRecipient {
    userId: string;
    inboxEnabled: boolean;
    pushEnabled: boolean;
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
            ? { userId: recipient, inboxEnabled: true, pushEnabled: false }
            : recipient;
        assertIdentifier(value.userId, 'notification recipient userId');
        const inboxEnabled = value.inboxEnabled ?? true;
        const pushEnabled = value.pushEnabled;
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
    private readonly pushSubscriptions: PushSubscriptionService;

    constructor(options: NotificationServiceOptions = {}) {
        this.database = options.database ?? db;
        this.now = options.now ?? (() => new Date());
        this.generateId = options.generateId ?? randomUUID;
        this.pushSubscriptions = new PushSubscriptionService({
            ...options,
            database: this.database,
            now: this.now,
            generateId: this.generateId
        });
    }

    async createNotificationEvent<K extends NotificationKind>(
        input: CreateNotificationEventInput<K>,
        recipients: readonly NotificationRecipient[] = input.recipients ?? []
    ): Promise<NotificationEvent<K>> {
        return this.database.transaction((transaction) =>
            this.createNotificationEventInTransaction(transaction, input, recipients)
        );
    }

    /**
     * Persist an event and its recipient snapshot inside a caller-owned transaction.
     * Projection activity and notification writes share this boundary. Durable
     * reconciliation cursors advance afterward, so crash recovery is explicitly
     * at-least-once and relies on event/recipient deduplication during replay.
     */
    async createNotificationEventInTransaction<K extends NotificationKind>(
        transaction: Knex.Transaction,
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
        return this.pushSubscriptions.upsert(userId, input, userAgent);
    }

    async garbageCollectPushSubscriptions(
        limit = PUSH_SUBSCRIPTION_GC_BATCH_SIZE
    ): Promise<number> {
        return this.pushSubscriptions.garbageCollect(limit);
    }

    async listPushSubscriptions(userId: string): Promise<PushSubscription[]> {
        return this.pushSubscriptions.list(userId);
    }

    async revokePushSubscription(userId: string, endpoint: string): Promise<boolean> {
        return this.pushSubscriptions.revokeByEndpoint(userId, endpoint);
    }

    async revokePushSubscriptionById(
        userId: string,
        subscriptionId: string
    ): Promise<boolean> {
        return this.pushSubscriptions.revokeById(userId, subscriptionId);
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
                timezone: parseIanaTimezone(
                    settings?.timezone ?? DEFAULT_NOTIFICATION_QUIET_HOURS.timezone
                )
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

export class NotificationEventNotFoundError extends Error {
    constructor(eventId: string) {
        super(`Notification event ${eventId} was not found`);
        this.name = 'NotificationEventNotFoundError';
    }
}

export {
    MAX_ACTIVE_PUSH_SUBSCRIPTIONS_PER_USER,
    MAX_PUSH_SUBSCRIPTION_ENROLLMENTS_PER_WINDOW,
    MAX_STORED_PUSH_SUBSCRIPTIONS_PER_USER,
    NotificationValidationError,
    PUSH_SUBSCRIPTION_ENROLLMENT_WINDOW_MS,
    PUSH_SUBSCRIPTION_GC_BATCH_SIZE,
    PUSH_SUBSCRIPTION_REVOKED_RETENTION_MS,
    PushSubscriptionConflictError,
    PushSubscriptionQuotaError,
    PushSubscriptionRateLimitError
};

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
export const listPushSubscriptions = notificationService.listPushSubscriptions
    .bind(notificationService) as NotificationService['listPushSubscriptions'];
export const revokePushSubscription = notificationService.revokePushSubscription
    .bind(notificationService) as NotificationService['revokePushSubscription'];
export const revokePushSubscriptionById = notificationService.revokePushSubscriptionById
    .bind(notificationService) as NotificationService['revokePushSubscriptionById'];
export const garbageCollectPushSubscriptions = notificationService
    .garbageCollectPushSubscriptions
    .bind(notificationService) as NotificationService['garbageCollectPushSubscriptions'];
