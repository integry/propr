import { createHash } from 'node:crypto';
import type { Knex } from 'knex';
import { normalizeISO8601Timestamp } from '@propr/shared';
import { db } from '../db/connection.js';
import logger from '../utils/logger.js';
import {
    NotificationService,
    type NotificationRecipient
} from './notificationService.js';
import {
    NotificationProjectionStore,
    buildProjectionDeduplicationKey
} from './notificationProjectionStore.js';

type TimestampInput = string | number | Date;
export type SystemStatusSnapshot = Record<string, unknown>;

interface ComponentSnapshot {
    component: string;
    status: string;
    /** null means the observation is unrecognized/transitional, not a confirmed outage. */
    healthy: boolean | null;
}

interface ComponentSpec {
    key: string;
    component: string;
    healthyStatuses: readonly string[];
    knownStatuses: readonly string[];
    unhealthyStatuses: readonly string[];
}

const COMPONENT_SPECS: readonly ComponentSpec[] = [
    // API availability requires an observer outside this process. Do not imply
    // self-outage coverage by projecting the API's constant local "healthy" value.
    {
        key: 'redis',
        component: 'redis',
        healthyStatuses: ['connected'],
        knownStatuses: ['connected', 'disconnected', 'failed', 'unknown'],
        unhealthyStatuses: ['disconnected', 'failed']
    },
    {
        key: 'daemon',
        component: 'daemon',
        healthyStatuses: ['running'],
        knownStatuses: ['running', 'stopped', 'failed', 'unknown'],
        unhealthyStatuses: ['stopped', 'failed']
    },
    {
        key: 'worker',
        component: 'worker',
        healthyStatuses: ['running'],
        knownStatuses: ['running', 'stopped', 'failed', 'unknown'],
        unhealthyStatuses: ['stopped', 'failed']
    },
    {
        key: 'githubAuth',
        component: 'github-auth',
        healthyStatuses: ['connected'],
        knownStatuses: ['connected', 'disconnected', 'failed', 'unknown'],
        unhealthyStatuses: ['disconnected', 'failed']
    },
    {
        key: 'githubEventIntakeStatus',
        component: 'github-event-intake',
        healthyStatuses: ['connected', 'active'],
        knownStatuses: ['connected', 'active', 'disconnected', 'failed', 'unknown'],
        unhealthyStatuses: ['disconnected', 'failed']
    },
    {
        key: 'indexingService',
        component: 'indexing-service',
        healthyStatuses: ['connected'],
        knownStatuses: ['connected', 'disconnected', 'failed', 'unknown'],
        unhealthyStatuses: ['disconnected', 'failed']
    }
];

function normalizedKnownStatus(value: unknown, knownStatuses: readonly string[]): string {
    if (typeof value !== 'string') return 'unknown';
    const normalized = value.trim().toLowerCase();
    return knownStatuses.includes(normalized) ? normalized : 'unknown';
}

function classifiedHealth(
    status: string,
    healthyStatuses: readonly string[],
    unhealthyStatuses: readonly string[]
): boolean | null {
    if (healthyStatuses.includes(status)) return true;
    if (unhealthyStatuses.includes(status)) return false;
    return null;
}

function safeComponentSuffix(value: unknown): string {
    if (typeof value === 'string' && /^[a-zA-Z0-9._-]{1,96}$/.test(value)) return value;
    return createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
}

function extractComponentSnapshots(snapshot: SystemStatusSnapshot): ComponentSnapshot[] {
    const components: ComponentSnapshot[] = [];
    if (typeof snapshot.healthy === 'boolean') {
        components.push({
            component: 'system',
            status: snapshot.healthy ? 'healthy' : 'unhealthy',
            healthy: snapshot.healthy
        });
    } else if (typeof snapshot.status === 'string') {
        const status = normalizedKnownStatus(snapshot.status, ['healthy', 'ok', 'unhealthy', 'failed']);
        components.push({
            component: 'system',
            status,
            healthy: classifiedHealth(status, ['healthy', 'ok'], ['unhealthy', 'failed'])
        });
    }

    for (const spec of COMPONENT_SPECS) {
        if (!(spec.key in snapshot)) continue;
        const status = normalizedKnownStatus(snapshot[spec.key], spec.knownStatuses);
        components.push({
            component: spec.component,
            status,
            healthy: classifiedHealth(status, spec.healthyStatuses, spec.unhealthyStatuses)
        });
    }

    if (Array.isArray(snapshot.agents)) {
        for (const value of snapshot.agents) {
            if (typeof value !== 'object' || value === null) continue;
            const agent = value as Record<string, unknown>;
            const status = normalizedKnownStatus(agent.status, ['connected', 'disconnected', 'failed', 'unknown']);
            components.push({
                component: `agent:${safeComponentSuffix(agent.id ?? agent.alias ?? 'unknown')}`,
                status,
                healthy: classifiedHealth(status, ['connected'], ['disconnected', 'failed'])
            });
        }
    }

    const runtime = snapshot.agentRuntime;
    if (typeof runtime === 'object' && runtime !== null) {
        const image = (runtime as Record<string, unknown>).unifiedAgentImage;
        if (typeof image === 'object' && image !== null) {
            const status = normalizedKnownStatus(
                (image as Record<string, unknown>).status,
                ['ready', 'building', 'pending', 'unavailable', 'failed', 'unknown']
            );
            components.push({
                component: 'agent-runtime',
                status,
                healthy: classifiedHealth(status, ['ready'], ['unavailable', 'failed'])
            });
        }
    }
    return components;
}

export interface NotificationSystemProjectionOptions {
    database?: Knex;
    notificationService?: NotificationService;
    now?: () => TimestampInput;
}

export class NotificationSystemProjection {
    private readonly database: Knex;
    private readonly notifications: NotificationService;
    private readonly store: NotificationProjectionStore;
    private readonly now: () => TimestampInput;

    constructor(options: NotificationSystemProjectionOptions = {}) {
        const database = options.database ?? db;
        this.database = database;
        this.now = options.now ?? (() => new Date());
        this.notifications = options.notificationService ?? new NotificationService({
            database,
            now: this.now
        });
        this.store = new NotificationProjectionStore(database, this.now);
    }

    async projectSnapshot(
        snapshot: SystemStatusSnapshot,
        recipients: readonly NotificationRecipient[] = [],
        shouldContinue: () => boolean = () => true
    ): Promise<void> {
        if (!shouldContinue()) return;
        const timestamp = normalizeISO8601Timestamp(
            typeof snapshot.timestamp === 'string' ? snapshot.timestamp : this.now()
        );
        const components = extractComponentSnapshots(snapshot);
        if (components.length === 0) return;
        const knownRecipients = components.some((component) => component.healthy === false)
            ? await this.store.getKnownRecipients()
            : [];
        if (!shouldContinue()) return;
        const requestedUserIds = new Set(recipients.map((recipient) =>
            typeof recipient === 'string' ? recipient : recipient.userId
        ));
        const requestedRecipients = [
            ...recipients,
            ...knownRecipients.filter((userId) => !requestedUserIds.has(userId))
        ];
        await this.database.transaction(async (transaction) => {
            for (const component of components) {
                if (!shouldContinue()) throw new Error('Notification system projection lease was lost');
                if (component.healthy === null) {
                    await this.store.updateUnknownSystemObservation({
                        component: component.component,
                        status: component.status,
                        timestamp
                    }, transaction);
                    if (!shouldContinue()) throw new Error('Notification system projection lease was lost');
                    continue;
                }
                const transition = await this.store.updateSystemTransition({
                    ...component,
                    healthy: component.healthy!,
                    timestamp
                }, transaction);
                if (!shouldContinue()) throw new Error('Notification system projection lease was lost');
                if (transition.healthy) continue;
                // Reassign on every confirmed unhealthy observation. Event insertion
                // is idempotent, while newly eligible users join the active episode.
                await this.notifications.createNotificationEventInTransaction(transaction, {
                    deduplicationKey: buildProjectionDeduplicationKey(
                        'system',
                        transition.component,
                        'unhealthy',
                        transition.transitionAt
                    ),
                    kind: 'system_failure',
                    severity: 'error',
                    target: { type: 'system_failure', component: transition.component },
                    title: 'System component needs attention',
                    body: `The ${transition.component} component reported ${transition.status}.`,
                    metadata: {
                        transitionState: transition.status,
                        transitionAt: transition.transitionAt
                    },
                    occurredAt: transition.transitionAt,
                    recipients: requestedRecipients
                });
                if (!shouldContinue()) {
                    throw new Error('Notification system projection lease was lost');
                }
            }
        });
    }
}

export const notificationSystemProjection = new NotificationSystemProjection();

export async function projectSystemSnapshotBestEffort(
    snapshot: SystemStatusSnapshot,
    recipients: readonly NotificationRecipient[] = []
): Promise<void> {
    try {
        await notificationSystemProjection.projectSnapshot(snapshot, recipients);
    } catch (error) {
        logger.warn({
            error: error instanceof Error ? error.message : String(error)
        }, 'Failed to project system notification snapshot');
    }
}
