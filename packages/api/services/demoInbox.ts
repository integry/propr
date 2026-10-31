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
 * representative Inbox instead: the curated database's recipient with the most
 * receipts the demo can show, limited to the demo's repositories and without
 * host health events. Reads go
 * through the ordinary service, so receipts are never written for the demo.
 */
export function createDemoInboxReader({
    service,
    database = db,
    loadRepositories = loadDemoConfiguredRepoNames,
}: DemoInboxDependencies): DemoInboxReader {
    // Receipts the default demo Inbox can show: inbox-enabled, not dismissed,
    // not host health, and targeting one of the demo's repositories.
    function eligibleReceipts(repositories: readonly string[]) {
        return database('notification_user_states as receipt')
            .join('notification_events as event', 'event.event_id', 'receipt.event_id')
            .where({ 'receipt.inbox_enabled': true })
            .whereNull('receipt.dismissed_at')
            .whereNotIn('event.kind', DEMO_EXCLUDED_KINDS)
            .whereRaw(
                `json_extract(event.target_json, '$.repository') IN (${repositories.map(() => '?').join(', ')})`,
                [...repositories],
            );
    }

    // Ranked on eligible receipts only, so a recipient whose volume is host
    // health or other repositories never hides one with visible notifications.
    async function representativeRecipient(repositories: readonly string[]): Promise<string | null> {
        if (repositories.length === 0) return null;
        const row = await eligibleReceipts(repositories)
            .select('receipt.user_id as user_id')
            .count({ receipts: '*' })
            .groupBy('receipt.user_id')
            .orderBy([{ column: 'receipts', order: 'desc' }, { column: 'user_id', order: 'asc' }])
            .first() as { user_id: string } | undefined;
        return row?.user_id ?? null;
    }

    function isVisible(repositories: ReadonlySet<string>, notification: Notification): boolean {
        if (DEMO_EXCLUDED_KINDS.includes(notification.kind)) return false;
        const repository = notificationRepository(notification);
        return repository !== null && repositories.has(repository);
    }

    async function unreadCount(recipient: string, repositories: readonly string[]): Promise<number> {
        const row = await eligibleReceipts(repositories)
            .where({ 'receipt.user_id': recipient })
            .whereNull('receipt.read_at')
            .count({ unread: '*' })
            .first() as { unread: number | string } | undefined;
        return Number(row?.unread ?? 0);
    }

    async function getUnreadNotificationCount(): Promise<number> {
        const repositories = await loadRepositories();
        const recipient = await representativeRecipient(repositories);
        return recipient ? unreadCount(recipient, repositories) : 0;
    }

    async function listNotifications(options: NotificationListOptions): Promise<NotificationListResponse> {
        const repositories = await loadRepositories();
        const recipient = await representativeRecipient(repositories);
        if (!recipient) return { notifications: [], unreadCount: 0, nextCursor: null };
        const visible = new Set(repositories);
        // Filtering keeps the recipient's cursor, so a page may be short but paging stays exact.
        const page = await service.listNotifications(recipient, options);
        return {
            notifications: page.notifications.filter(notification => isVisible(visible, notification)),
            unreadCount: await unreadCount(recipient, repositories),
            nextCursor: page.nextCursor,
        };
    }

    return { listNotifications, getUnreadNotificationCount };
}
