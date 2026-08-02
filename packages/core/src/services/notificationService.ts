/* eslint-disable max-lines -- event creation and Inbox state share one transactional boundary */
import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import {
    NOTIFICATION_PAYLOAD_LIMITS,
    normalizeISO8601Timestamp,
    parseNotification,
    parseNotificationEvent,
    parseNotificationListResponse,
    parseNotificationStateResponse,
    type ISO8601Timestamp,
    type JsonObject,
    type Notification,
    type NotificationAction,
    type NotificationEvent,
    type NotificationKind,
    type NotificationListResponse,
    type NotificationSeverity,
    type NotificationStateResponse,
    type NotificationTargetFor
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
        const pushEnabled = value.pushEnabled ?? true;
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

    constructor(options: NotificationServiceOptions = {}) {
        this.database = options.database ?? db;
        this.now = options.now ?? (() => new Date());
        this.generateId = options.generateId ?? randomUUID;
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

    private async assignRecipients(
        transaction: Knex.Transaction,
        event: NotificationEvent,
        recipients: NormalizedRecipient[]
    ): Promise<void> {
        if (recipients.length === 0) return;
        const now = normalizeISO8601Timestamp(this.now());
        const assignedAt: ISO8601Timestamp = now < event.createdAt ? event.createdAt : now;

        await transaction('notification_user_states')
            .insert(recipients.map((recipient) => ({
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
