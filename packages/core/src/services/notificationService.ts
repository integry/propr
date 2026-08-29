/* eslint-disable max-lines -- event creation, preferences, and Inbox state share transactions */
import { createHash, randomUUID } from 'node:crypto';
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
    type NotificationEventAction,
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
const PUSH_DELIVERY_FANOUT_CHUNK_SIZE = 100;

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
    actions?: readonly NotificationEventAction[];
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

export interface SystemFailureTransitionInput {
    component: string;
    status: string;
    healthy: boolean;
    snapshotAt: TimestampInput;
    eventFor: (
        status: string,
        failureStartedAt: ISO8601Timestamp
    ) => CreateNotificationEventInput<'system_failure'>
        | Promise<CreateNotificationEventInput<'system_failure'>>;
}

export interface SystemFailureTransitionResult {
    accepted: boolean;
    event: NotificationEvent<'system_failure'> | null;
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
    advertised_actions_json: string | null;
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
    badge_enabled: number | boolean;
}

interface SystemFailureStateRow {
    component: string;
    failure_status: string | null;
    failure_started_at: string | null;
    last_snapshot_at: string;
}

interface NormalizedRecipient {
    userId: string;
    inboxEnabled: boolean;
    pushEnabled: boolean;
}

interface PushDeliveryFanoutRow {
    user_id: string;
    subscription_id: string;
    assigned_at: string;
}

function parseStoredJson(value: string, field: string): unknown {
    try {
        return JSON.parse(value) as unknown;
    } catch {
        throw new Error(`Stored notification ${field} is invalid JSON`);
    }
}

function toNotificationEvent(row: NotificationEventRow): NotificationEvent {
    const storedMetadata = row.metadata_json === null
        ? undefined
        : parseStoredJson(row.metadata_json, 'metadata');
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
        actions: row.advertised_actions_json === null
            ? ['open_pr', 'dismiss']
            : parseStoredJson(row.advertised_actions_json, 'advertised actions'),
        ...(storedMetadata === undefined ? {} : { metadata: storedMetadata }),
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

function isContinuingSystemFailure(
    existing: SystemFailureStateRow | undefined,
    input: SystemFailureTransitionInput
): existing is SystemFailureStateRow & { failure_started_at: string } {
    return !input.healthy
        && existing?.failure_status === input.status
        && typeof existing.failure_started_at === 'string';
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
        'event.advertised_actions_json',
        'event.metadata_json',
        'event.occurred_at',
        'event.created_at',
        'receipt.read_at',
        'receipt.dismissed_at'
    ];
}

function pushDeliveryIdentity(eventId: string, subscriptionId: string): string {
    return createHash('sha256')
        .update(eventId)
        .update('\0')
        .update(subscriptionId)
        .digest('hex');
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
        const event = this.prepareNotificationEvent(input);
        const normalizedRecipients = normalizeRecipients(recipients);

        return this.database.transaction(transaction =>
            this.persistNotificationEvent(transaction, event, normalizedRecipients));
    }

    /**
     * Create a PR-related event only while the durable PR lifecycle says the
     * pull request is still open. This check shares the event transaction with
     * merge marking, so either creation commits first and merge dismisses it,
     * or the merge marker commits first and creation is skipped.
     */
    async createPullRequestNotificationEvent<K extends 'task' | 'review' | 'pull_request'>(
        repository: string,
        prNumber: number,
        input: CreateNotificationEventInput<K>,
        recipients: readonly NotificationRecipient[] = input.recipients ?? []
    ): Promise<NotificationEvent<K> | null> {
        this.assertPullRequestIdentity(repository, prNumber);
        const event = this.prepareNotificationEvent(input);
        const normalizedRecipients = normalizeRecipients(recipients);

        return this.database.transaction(async transaction => {
            if (!await this.pullRequestIsOpen(transaction, repository, prNumber)) return null;
            return this.persistNotificationEvent(transaction, event, normalizedRecipients);
        });
    }

    /**
     * Create or reuse a PR-attention event and supersede older cards in the
     * same transaction that checks the durable merge marker.
     */
    async createPullRequestAttentionNotificationEvent(
        repository: string,
        prNumber: number,
        input: CreateNotificationEventInput<'pull_request'>,
        recipients: readonly NotificationRecipient[] = input.recipients ?? []
    ): Promise<NotificationEvent<'pull_request'> | null> {
        this.assertPullRequestIdentity(repository, prNumber);
        const event = this.prepareNotificationEvent(input);
        const normalizedRecipients = normalizeRecipients(recipients);

        return this.database.transaction(async transaction => {
            if (!await this.pullRequestIsOpen(transaction, repository, prNumber)) return null;
            const storedEvent = await this.persistNotificationEvent(
                transaction,
                event,
                normalizedRecipients
            );
            const matching = () => this.matchingPullRequestAttentionEvents(
                transaction,
                repository,
                prNumber
            );
            const newest = await matching()
                .select('event.event_id')
                .orderBy('event.occurred_at', 'desc')
                .orderBy('event.event_id', 'desc')
                .first() as { event_id: string } | undefined;
            if (newest) {
                await this.dismissReceiptQuery(
                    matching().select('event.event_id').whereNot({
                        'event.event_id': newest.event_id
                    }),
                    transaction
                );
            }
            return storedEvent;
        });
    }

    /**
     * Commit one system-health transition together with receipt supersession
     * and current-event creation. After bootstrap, only the event belonging to
     * the transition being replaced is dismissed, so stale instances never run
     * a component-wide receipt update.
     */
    async reconcileSystemFailureTransition(
        input: SystemFailureTransitionInput,
        recipients: readonly NotificationRecipient[] = []
    ): Promise<SystemFailureTransitionResult> {
        assertIdentifier(input.component, 'notification system component');
        assertIdentifier(input.status, 'notification system status');
        const snapshotAt = normalizeISO8601Timestamp(input.snapshotAt);
        const normalizedRecipients = normalizeRecipients(recipients);

        return this.database.transaction(async transaction => {
            // Acquire SQLite's write reservation before reading. Concurrent
            // instances therefore observe transitions in commit order instead
            // of both reading the same pre-transition snapshot.
            const inserted = await transaction('notification_system_failure_state')
                .insert({
                    component: input.component,
                    failure_status: input.healthy ? null : input.status,
                    failure_started_at: input.healthy ? null : snapshotAt,
                    last_snapshot_at: snapshotAt
                })
                .onConflict('component')
                .ignore()
                .returning('component') as Array<{ component: string }>;
            const initializing = inserted.length > 0;
            const existing = await transaction<SystemFailureStateRow>(
                'notification_system_failure_state'
            )
                .where({ component: input.component })
                .first();
            if (existing && snapshotAt < existing.last_snapshot_at) {
                return { accepted: false, event: null };
            }
            if (initializing) {
                return this.reconcileInitialSystemFailureReceipts(
                    transaction,
                    input,
                    snapshotAt,
                    normalizedRecipients
                );
            }

            const continuingFailure = isContinuingSystemFailure(existing, input);
            const failureStartedAt = input.healthy
                ? null
                : continuingFailure ? existing.failure_started_at : snapshotAt;
            await transaction('notification_system_failure_state')
                .insert({
                    component: input.component,
                    failure_status: input.healthy ? null : input.status,
                    failure_started_at: failureStartedAt,
                    last_snapshot_at: snapshotAt
                })
                .onConflict('component')
                .merge({
                    failure_status: input.healthy ? null : input.status,
                    failure_started_at: failureStartedAt,
                    last_snapshot_at: snapshotAt
                });

            if (!continuingFailure
                && existing?.failure_status !== null
                && typeof existing?.failure_status === 'string'
                && typeof existing.failure_started_at === 'string'
            ) {
                const superseded = await input.eventFor(
                    existing.failure_status,
                    existing.failure_started_at as ISO8601Timestamp
                );
                await this.dismissReceiptQuery(
                    transaction('notification_events')
                        .select('event_id')
                        .where({ deduplication_key: superseded.deduplicationKey }),
                    transaction
                );
            }

            if (input.healthy || failureStartedAt === null) {
                return { accepted: true, event: null };
            }
            const event = this.prepareNotificationEvent(await input.eventFor(
                input.status,
                failureStartedAt as ISO8601Timestamp
            ));
            return {
                accepted: true,
                event: await this.persistNotificationEvent(
                    transaction,
                    event,
                    normalizedRecipients
                )
            };
        });
    }

    private async reconcileInitialSystemFailureReceipts(
        transaction: Knex.Transaction,
        input: SystemFailureTransitionInput,
        failureStartedAt: ISO8601Timestamp,
        normalizedRecipients: NormalizedRecipient[]
    ): Promise<SystemFailureTransitionResult> {
        let priorEvents = this.matchingTargetEvents(['system_failure'], transaction)
            .whereRaw("json_extract(event.target_json, '$.component') = ?", [input.component]);
        if (input.healthy) {
            await this.dismissReceiptQuery(priorEvents, transaction);
            return { accepted: true, event: null };
        }
        const eventInput = await input.eventFor(input.status, failureStartedAt);
        const currentEvent = this.prepareNotificationEvent(eventInput);
        priorEvents = priorEvents.whereNot({
            'event.deduplication_key': currentEvent.deduplicationKey
        });
        await this.dismissReceiptQuery(priorEvents, transaction);
        return {
            accepted: true,
            event: await this.persistNotificationEvent(
                transaction,
                currentEvent,
                normalizedRecipients
            )
        };
    }

    private prepareNotificationEvent<K extends NotificationKind>(
        input: CreateNotificationEventInput<K>
    ): NotificationEvent<K> {
        if (input.id !== undefined && input.eventId !== undefined && input.id !== input.eventId) {
            throw new TypeError('notification id and eventId must match when both are supplied');
        }

        const createdAt = normalizeISO8601Timestamp(this.now());
        return parseNotificationEvent({
            id: input.eventId ?? input.id ?? this.generateId(),
            deduplicationKey: input.deduplicationKey,
            kind: input.kind,
            severity: input.severity ?? 'info',
            target: input.target,
            title: input.title,
            body: input.body,
            actions: input.actions ?? [],
            ...(input.action === undefined ? {} : { action: input.action }),
            ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
            occurredAt: input.occurredAt === undefined
                ? createdAt
                : normalizeISO8601Timestamp(input.occurredAt),
            createdAt
        }) as NotificationEvent<K>;
    }

    private async persistNotificationEvent<K extends NotificationKind>(
        transaction: Knex.Transaction,
        event: NotificationEvent<K>,
        normalizedRecipients: NormalizedRecipient[]
    ): Promise<NotificationEvent<K>> {
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
                advertised_actions_json: JSON.stringify(event.actions),
                metadata_json: event.metadata === undefined
                    ? null
                    : JSON.stringify(event.metadata),
                occurred_at: event.occurredAt,
                created_at: event.createdAt
            })
            .onConflict('deduplication_key')
            .ignore();

        const storedRow = await transaction<NotificationEventRow>('notification_events')
            .where({ deduplication_key: event.deduplicationKey })
            .first();
        if (!storedRow) throw new Error('Notification event was not persisted');
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

            await this.updatePreferenceSettings(transaction, userId, update);

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

    /** Dismiss every Inbox receipt for one immutable audit event. */
    async dismissNotificationReceipts(eventId: string): Promise<number> {
        assertIdentifier(eventId, 'notification eventId');
        return this.dismissReceiptQuery(
            this.database('notification_events').select('event_id').where({ event_id: eventId })
        );
    }

    /**
     * Close every Inbox card whose target is the given pull request. Audit
     * events and push-delivery history remain untouched.
     */
    async dismissNotificationsForPullRequest(
        repository: string,
        prNumber: number
    ): Promise<number> {
        this.assertPullRequestIdentity(repository, prNumber);
        return this.dismissReceiptQuery(
            this.matchingTargetEvents(['task', 'review', 'pull_request'])
                .whereRaw("json_extract(event.target_json, '$.repository') = ?", [repository])
                .whereRaw("json_extract(event.target_json, '$.prNumber') = ?", [prNumber])
        );
    }

    /** Persist a merged marker and close all existing PR receipts atomically. */
    async markPullRequestMergedAndDismissNotifications(
        repository: string,
        prNumber: number,
        mergedAt: TimestampInput = this.now()
    ): Promise<number> {
        this.assertPullRequestIdentity(repository, prNumber);
        const normalizedMergedAt = normalizeISO8601Timestamp(mergedAt);

        return this.database.transaction(async transaction => {
            await transaction('notification_pull_request_state')
                .insert({
                    repository,
                    pr_number: prNumber,
                    merged_at: normalizedMergedAt
                })
                .onConflict(['repository', 'pr_number'])
                .merge({ merged_at: normalizedMergedAt });
            return this.dismissReceiptQuery(
                this.matchingTargetEvents(
                    ['task', 'review', 'pull_request'],
                    transaction
                )
                    .whereRaw("json_extract(event.target_json, '$.repository') = ?", [repository])
                    .whereRaw("json_extract(event.target_json, '$.prNumber') = ?", [prNumber]),
                transaction
            );
        });
    }

    /** Keep only the newest PR-attention event visible for a repository/PR. */
    async dismissSupersededPullRequestAttentionNotifications(
        repository: string,
        prNumber: number
    ): Promise<number> {
        this.assertPullRequestIdentity(repository, prNumber);

        return this.database.transaction(async (transaction) => {
            const matching = () => transaction('notification_events as event')
                .where({ 'event.kind': 'pull_request' })
                .whereRaw("json_extract(event.target_json, '$.repository') = ?", [repository])
                .whereRaw("json_extract(event.target_json, '$.prNumber') = ?", [prNumber]);
            const newest = await matching()
                .select('event.event_id')
                .orderBy('event.occurred_at', 'desc')
                .orderBy('event.event_id', 'desc')
                .first() as { event_id: string } | undefined;
            if (!newest) return 0;

            return this.dismissReceiptQuery(
                matching().select('event.event_id').whereNot({
                    'event.event_id': newest.event_id
                }),
                transaction
            );
        });
    }

    /** Dismiss active failure cards for one system-health component. */
    async dismissSystemFailureNotifications(component: string): Promise<number> {
        assertIdentifier(component, 'notification system component');
        return this.dismissReceiptQuery(
            this.matchingTargetEvents(['system_failure'])
                .whereRaw("json_extract(event.target_json, '$.component') = ?", [component])
        );
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
            },
            badgeEnabled: settings?.badge_enabled === undefined
                ? true
                : Boolean(settings.badge_enabled)
        });
    }

    private async updatePreferenceSettings(
        transaction: Knex.Transaction,
        userId: string,
        update: NotificationPreferencesUpdate
    ): Promise<void> {
        if (update.quietHours === undefined && update.badgeEnabled === undefined) return;

        const values: Record<string, string | boolean | null> = {};
        if (update.quietHours?.start !== undefined) {
            values.quiet_hours_start = update.quietHours.start;
        }
        if (update.quietHours?.end !== undefined) {
            values.quiet_hours_end = update.quietHours.end;
        }
        if (update.quietHours?.timezone !== undefined) {
            values.timezone = update.quietHours.timezone;
        }
        if (update.badgeEnabled !== undefined) {
            values.badge_enabled = update.badgeEnabled;
        }
        await transaction('notification_preference_settings')
            .insert({
                user_id: userId,
                quiet_hours_start: update.quietHours?.start
                    ?? DEFAULT_NOTIFICATION_QUIET_HOURS.start,
                quiet_hours_end: update.quietHours?.end
                    ?? DEFAULT_NOTIFICATION_QUIET_HOURS.end,
                timezone: update.quietHours?.timezone
                    ?? DEFAULT_NOTIFICATION_QUIET_HOURS.timezone,
                badge_enabled: update.badgeEnabled ?? true
            })
            .onConflict('user_id')
            .merge(values);
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

        const pushRecipientIds = eligibleRecipients
            .filter(recipient => recipient.pushEnabled)
            .map(recipient => recipient.userId);
        if (pushRecipientIds.length === 0) return;

        // Snapshot one job per subscription that was active when this recipient
        // was first assigned. The event/subscription unique index makes duplicate
        // producer calls harmless, while the creation/update-time boundaries
        // prevent newly enrolled or reactivated browsers from receiving
        // historical events.
        const fanoutRows = await transaction('notification_user_states as recipient')
            .join('push_subscriptions as subscription', function subscriptionJoin() {
                this.on('subscription.user_id', '=', 'recipient.user_id')
                    .andOn('subscription.created_at', '<=', 'recipient.created_at')
                    .andOn('subscription.updated_at', '<=', 'recipient.created_at');
            })
            .join('notification_preferences as preference', function preferenceJoin() {
                this.on('preference.user_id', '=', 'recipient.user_id')
                    .andOnVal('preference.notification_kind', '=', event.kind);
            })
            .select(
                'recipient.user_id',
                'subscription.subscription_id',
                { assigned_at: 'recipient.created_at' }
            )
            .where({
                'recipient.event_id': event.id,
                'recipient.push_enabled': true,
                'preference.push_enabled': true
            })
            .whereIn('recipient.user_id', pushRecipientIds)
            .whereNull('subscription.revoked_at')
            .andWhere(expiration => {
                expiration.whereNull('subscription.expires_at')
                    .orWhere('subscription.expires_at', '>', now);
            }) as PushDeliveryFanoutRow[];
        if (fanoutRows.length === 0) return;

        for (
            let offset = 0;
            offset < fanoutRows.length;
            offset += PUSH_DELIVERY_FANOUT_CHUNK_SIZE
        ) {
            await transaction('push_delivery_jobs')
                .insert(fanoutRows
                    .slice(offset, offset + PUSH_DELIVERY_FANOUT_CHUNK_SIZE)
                    .map(row => {
                        const identity = pushDeliveryIdentity(event.id, row.subscription_id);
                        return {
                            job_id: `push:${identity}`,
                            deduplication_key: `web-push:v1:${identity}`,
                            event_id: event.id,
                            user_id: row.user_id,
                            subscription_id: row.subscription_id,
                            created_at: row.assigned_at,
                            updated_at: row.assigned_at
                        };
                    }))
                .onConflict(['event_id', 'subscription_id'])
                .ignore();
        }
    }

    private assertPullRequestIdentity(repository: string, prNumber: number): void {
        assertIdentifier(repository, 'notification repository');
        if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
            throw new TypeError('notification prNumber must be a positive safe integer');
        }
    }

    private async pullRequestIsOpen(
        transaction: Knex.Transaction,
        repository: string,
        prNumber: number
    ): Promise<boolean> {
        // The insert is also the per-database write barrier. It prevents a
        // merge transaction from committing between this guard and event
        // persistence on SQLite's otherwise deferred transactions.
        await transaction('notification_pull_request_state')
            .insert({ repository, pr_number: prNumber, merged_at: null })
            .onConflict(['repository', 'pr_number'])
            .ignore();
        const state = await transaction('notification_pull_request_state')
            .select('merged_at')
            .where({ repository, pr_number: prNumber })
            .first() as { merged_at?: unknown } | undefined;
        return typeof state?.merged_at !== 'string';
    }

    private matchingPullRequestAttentionEvents(
        database: Database,
        repository: string,
        prNumber: number
    ): Knex.QueryBuilder {
        return database('notification_events as event')
            .where({ 'event.kind': 'pull_request' })
            .whereRaw("json_extract(event.target_json, '$.repository') = ?", [repository])
            .whereRaw("json_extract(event.target_json, '$.prNumber') = ?", [prNumber]);
    }

    private matchingTargetEvents(
        kinds: readonly NotificationKind[],
        database: Database = this.database
    ): Knex.QueryBuilder {
        return database('notification_events as event')
            .select('event.event_id')
            .whereIn('event.kind', kinds);
    }

    private async dismissReceiptQuery(
        eventIds: Knex.QueryBuilder,
        database: Database = this.database
    ): Promise<number> {
        const timestamp = normalizeISO8601Timestamp(this.now());
        const changed = await database('notification_user_states')
            .where({ inbox_enabled: true })
            .whereNull('dismissed_at')
            .whereIn('event_id', eventIds)
            .update({
                dismissed_at: database.raw(
                    'CASE WHEN created_at > ? THEN created_at ELSE ? END',
                    [timestamp, timestamp]
                )
            });
        return Number(changed);
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
export const dismissNotificationReceipts = notificationService.dismissNotificationReceipts
    .bind(notificationService) as NotificationService['dismissNotificationReceipts'];
export const dismissNotificationsForPullRequest = notificationService
    .dismissNotificationsForPullRequest
    .bind(notificationService) as NotificationService['dismissNotificationsForPullRequest'];
export const dismissSupersededPullRequestAttentionNotifications = notificationService
    .dismissSupersededPullRequestAttentionNotifications
    .bind(notificationService) as NotificationService['dismissSupersededPullRequestAttentionNotifications'];
export const dismissSystemFailureNotifications = notificationService
    .dismissSystemFailureNotifications
    .bind(notificationService) as NotificationService['dismissSystemFailureNotifications'];
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
