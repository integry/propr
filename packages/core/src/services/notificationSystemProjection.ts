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
    healthy: boolean;
}

interface ComponentSpec {
    key: string;
    component: string;
    healthyStatuses: readonly string[];
    knownStatuses: readonly string[];
}

const COMPONENT_SPECS: readonly ComponentSpec[] = [
    {
        key: 'api',
        component: 'api',
        healthyStatuses: ['healthy', 'ok'],
        knownStatuses: ['healthy', 'ok', 'unhealthy', 'failed', 'disconnected']
    },
    {
        key: 'redis',
        component: 'redis',
        healthyStatuses: ['connected'],
        knownStatuses: ['connected', 'disconnected', 'failed', 'unknown']
    },
    {
        key: 'daemon',
        component: 'daemon',
        healthyStatuses: ['running'],
        knownStatuses: ['running', 'stopped', 'failed', 'unknown']
    },
    {
        key: 'worker',
        component: 'worker',
        healthyStatuses: ['running'],
        knownStatuses: ['running', 'stopped', 'failed', 'unknown']
    },
    {
        key: 'githubAuth',
        component: 'github-auth',
        healthyStatuses: ['connected'],
        knownStatuses: ['connected', 'disconnected', 'failed', 'unknown']
    },
    {
        key: 'githubEventIntakeStatus',
        component: 'github-event-intake',
        healthyStatuses: ['connected', 'active'],
        knownStatuses: ['connected', 'active', 'disconnected', 'failed', 'unknown']
    },
    {
        key: 'indexing',
        component: 'indexing-service',
        healthyStatuses: ['idle', 'active', 'queued', 'indexing', 'completed'],
        knownStatuses: ['idle', 'active', 'queued', 'indexing', 'completed', 'failed', 'disconnected', 'unknown']
    }
];

function normalizedKnownStatus(value: unknown, knownStatuses: readonly string[]): string {
    if (typeof value !== 'string') return 'unhealthy';
    const normalized = value.trim().toLowerCase();
    return knownStatuses.includes(normalized) ? normalized : 'unhealthy';
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
            healthy: status === 'healthy' || status === 'ok'
        });
    }

    for (const spec of COMPONENT_SPECS) {
        if (!(spec.key in snapshot)) continue;
        const status = normalizedKnownStatus(snapshot[spec.key], spec.knownStatuses);
        components.push({
            component: spec.component,
            status,
            healthy: spec.healthyStatuses.includes(status)
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
                healthy: status === 'connected'
            });
        }
    }

    const runtime = snapshot.agentRuntime;
    if (typeof runtime === 'object' && runtime !== null) {
        const image = (runtime as Record<string, unknown>).unifiedAgentImage;
        if (typeof image === 'object' && image !== null) {
            const status = normalizedKnownStatus(
                (image as Record<string, unknown>).status,
                ['ready', 'unavailable', 'failed', 'unknown']
            );
            components.push({
                component: 'agent-runtime',
                status,
                healthy: status === 'ready'
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
    private readonly notifications: NotificationService;
    private readonly store: NotificationProjectionStore;
    private readonly now: () => TimestampInput;

    constructor(options: NotificationSystemProjectionOptions = {}) {
        const database = options.database ?? db;
        this.now = options.now ?? (() => new Date());
        this.notifications = options.notificationService ?? new NotificationService({
            database,
            now: this.now
        });
        this.store = new NotificationProjectionStore(database);
    }

    async projectSnapshot(
        snapshot: SystemStatusSnapshot,
        recipients: readonly NotificationRecipient[] = []
    ): Promise<void> {
        const timestamp = normalizeISO8601Timestamp(
            typeof snapshot.timestamp === 'string' ? snapshot.timestamp : this.now()
        );
        const knownRecipients = await this.store.getKnownRecipients();
        const requestedUserIds = new Set(recipients.map((recipient) =>
            typeof recipient === 'string' ? recipient : recipient.userId
        ));
        const requestedRecipients = [
            ...recipients,
            ...knownRecipients.filter((userId) => !requestedUserIds.has(userId))
        ];
        for (const component of extractComponentSnapshots(snapshot)) {
            const transition = await this.store.updateSystemTransition({ ...component, timestamp });
            if (!transition.unhealthyEpisodeStarted) continue;
            await this.notifications.createNotificationEvent({
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
        }
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
