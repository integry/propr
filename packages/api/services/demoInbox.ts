import type { Knex } from 'knex';
import { db, type NotificationListOptions, type NotificationService } from '@propr/core';
import type { Notification, NotificationListResponse } from '@propr/shared';
import { loadDemoConfiguredRepoNames } from '../routes/demoRepositoryMetadata.js';
import type { DemoRepositoryLoader } from './demoGoalScope.js';

export interface DemoInboxReader {
    listNotifications(options: NotificationListOptions): Promise<NotificationListResponse>;
    getUnreadNotificationCount(): Promise<number>;
}

export interface DemoInboxDependencies {
    service: Pick<NotificationService, 'listNotifications'>;
    database?: Knex;
    loadRepositories?: DemoRepositoryLoader;
}

// Host health events describe the installation, not the demo's repositories.
const DEMO_EXCLUDED_KINDS = ['system_failure'];

function notificationRepository(notification: Notification): string | null {
    const target = notification.target as { repository?: unknown };
    return typeof target.repository === 'string' ? target.repository : null;
}

/**
 * The synthetic demo identity has no Inbox receipts of its own. It reads a
 * representative Inbox instead: the curated database's most-notified recipient,
 * limited to the demo's repositories and without host health events. Reads go
 * through the ordinary service, so receipts are never written for the demo.
 */
export function createDemoInboxReader({
    service,
    database = db,
    loadRepositories = loadDemoConfiguredRepoNames,
}: DemoInboxDependencies): DemoInboxReader {
    async function representativeRecipient(): Promise<string | null> {
        const row = await database('notification_user_states')
            .where({ inbox_enabled: true })
            .select('user_id')
            .count({ receipts: '*' })
            .groupBy('user_id')
            .orderBy([{ column: 'receipts', order: 'desc' }, { column: 'user_id', order: 'asc' }])
            .first() as { user_id: string } | undefined;
        return row?.user_id ?? null;
    }

    function isVisible(repositories: ReadonlySet<string>, notification: Notification): boolean {
        if (DEMO_EXCLUDED_KINDS.includes(notification.kind)) return false;
        const repository = notificationRepository(notification);
        return repository !== null && repositories.has(repository);
    }

    async function unreadCount(recipient: string, repositories: ReadonlySet<string>): Promise<number> {
        const rows = await database('notification_user_states as receipt')
            .join('notification_events as event', 'event.event_id', 'receipt.event_id')
            .where({ 'receipt.user_id': recipient, 'receipt.inbox_enabled': true })
            .whereNull('receipt.read_at')
            .whereNull('receipt.dismissed_at')
            .whereNotIn('event.kind', DEMO_EXCLUDED_KINDS)
            .select('event.target_json') as Array<{ target_json: string | Record<string, unknown> }>;
        return rows.filter(row => {
            const target = typeof row.target_json === 'string' ? JSON.parse(row.target_json) as unknown : row.target_json;
            const repository = (target as { repository?: unknown } | null)?.repository;
            return typeof repository === 'string' && repositories.has(repository);
        }).length;
    }

    async function getUnreadNotificationCount(): Promise<number> {
        const recipient = await representativeRecipient();
        return recipient ? unreadCount(recipient, new Set(await loadRepositories())) : 0;
    }

    async function listNotifications(options: NotificationListOptions): Promise<NotificationListResponse> {
        const recipient = await representativeRecipient();
        if (!recipient) return { notifications: [], unreadCount: 0, nextCursor: null };
        const repositories = new Set(await loadRepositories());
        // Filtering keeps the recipient's cursor, so a page may be short but paging stays exact.
        const page = await service.listNotifications(recipient, options);
        return {
            notifications: page.notifications.filter(notification => isVisible(repositories, notification)),
            unreadCount: await unreadCount(recipient, repositories),
            nextCursor: page.nextCursor,
        };
    }

    return { listNotifications, getUnreadNotificationCount };
}
