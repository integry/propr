import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import type { Request, Response } from 'express';
import knex, { type Knex } from 'knex';
import { closeConnection, closeEventPublisher, decodeNotificationCursor, encodeNotificationCursor, type NotificationListOptions } from '@propr/core';
import { INSTANCE_PERMISSIONS, type Notification, type NotificationListResponse } from '@propr/shared';
import { configureDemoMode, getDemoUser, resetConfiguredDemoMode } from '../demoMode.js';
import { createNotificationRoutes } from '../routes/notificationRoutes.js';
import { createDemoInboxReader } from '../services/demoInbox.js';

const DEMO_REPOSITORY = 'acme/demo';

let database: Knex;
const listedFor: string[] = [];

const notification = (id: string, kind: string, repository?: string, occurredAt = '2026-10-01T00:00:00.000Z') => ({
    id, kind, occurredAt, target: repository ? { type: kind, repository } : { type: kind, component: 'redis' },
}) as unknown as Notification;

// Pages a newest-first receipt list the way NotificationService does: keyset
// cursor, limit, and a next cursor only while older receipts remain.
function pagedService(inboxes: Record<string, Notification[]>) {
    return {
        listNotifications: async (userId: string, options: NotificationListOptions = {}): Promise<NotificationListResponse> => {
            listedFor.push(userId);
            const boundary = options.cursor ? decodeNotificationCursor(options.cursor) : null;
            const remaining = (inboxes[userId] ?? []).filter(item => !boundary
                || item.occurredAt < boundary.occurredAt
                || (item.occurredAt === boundary.occurredAt && item.id < boundary.eventId));
            const limit = options.limit ?? 25;
            const notifications = remaining.slice(0, limit);
            const last = notifications[notifications.length - 1];
            return {
                notifications,
                unreadCount: 99,
                nextCursor: remaining.length > limit ? encodeNotificationCursor({ occurredAt: last.occurredAt, eventId: last.id }) : null,
            };
        },
    };
}

const representativeInbox = [
    notification('event-visible', 'task', DEMO_REPOSITORY),
    notification('event-other-repository', 'task', 'acme/private'),
    notification('event-system', 'system_failure'),
];
const service = pagedService({ operator: representativeInbox, reviewer: representativeInbox });

async function createInboxTables(target: Knex): Promise<void> {
    await target.schema.createTable('notification_events', table => {
        table.string('event_id').primary(); table.string('kind'); table.text('target_json');
    });
    await target.schema.createTable('notification_user_states', table => {
        table.string('event_id'); table.string('user_id'); table.boolean('inbox_enabled');
        table.timestamp('read_at').nullable(); table.timestamp('dismissed_at').nullable();
    });
}

before(async () => {
    database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await createInboxTables(database);
    await database('notification_events').insert([
        { event_id: 'e1', kind: 'task', target_json: JSON.stringify({ type: 'task', repository: DEMO_REPOSITORY }) },
        { event_id: 'e2', kind: 'review', target_json: JSON.stringify({ type: 'review', repository: DEMO_REPOSITORY }) },
        { event_id: 'e3', kind: 'task', target_json: JSON.stringify({ type: 'task', repository: 'acme/private' }) },
        { event_id: 'e4', kind: 'system_failure', target_json: JSON.stringify({ type: 'system_failure' }) },
        { event_id: 'e5', kind: 'pull_request', target_json: JSON.stringify({ type: 'pull_request', repository: DEMO_REPOSITORY }) },
    ]);
    const receipt = (event_id: string, user_id: string, read_at: string | null = null) => ({
        event_id, user_id, inbox_enabled: true, read_at, dismissed_at: null,
    });
    await database('notification_user_states').insert([
        // The operator holds most receipts, so their Inbox represents the demo.
        receipt('e1', 'operator'), receipt('e2', 'operator', '2026-10-01T00:00:00.000Z'),
        receipt('e3', 'operator'), receipt('e4', 'operator'), receipt('e5', 'operator'),
        receipt('e1', 'teammate'),
    ]);
});

afterEach(() => {
    listedFor.length = 0;
    resetConfiguredDemoMode();
});

after(async () => {
    await database.destroy();
    await closeConnection();
    await closeEventPublisher();
});

function demoRequest(query: Record<string, string> = {}): Request {
    return {
        user: getDemoUser(), query, params: {}, method: 'GET',
        authorization: { role: 'member', permissions: [...INSTANCE_PERMISSIONS], source: 'demo' },
    } as unknown as Request;
}

function recorder() {
    const state: { status: number; body?: unknown } = { status: 200 };
    const res = {
        status(code: number) { state.status = code; return res; },
        json(body: unknown) { state.body = body; return res; },
        set() { return res; },
    } as unknown as Response;
    return { res, state };
}

describe('demo Inbox', () => {
    const reader = () => createDemoInboxReader({
        service, database, loadRepositories: async () => [DEMO_REPOSITORY],
    });

    test('reads the most-notified recipient, limited to demo repositories and without host health', async () => {
        const page = await reader().listNotifications({ limit: 20 });

        assert.deepEqual(listedFor, ['operator']);
        assert.deepEqual(page.notifications.map(item => item.id), ['event-visible']);
        assert.equal(page.nextCursor, null);
        // Unread: e1 and e5; e2 is read, e3 is outside the demo, e4 is host health.
        assert.equal(page.unreadCount, 2);
        assert.equal(await reader().getUnreadNotificationCount(), 2);
    });

    test('skips a higher-volume recipient whose receipts the demo cannot show', async () => {
        const curated = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
        try {
            await createInboxTables(curated);
            await curated('notification_events').insert([
                { event_id: 'h1', kind: 'system_failure', target_json: JSON.stringify({ type: 'system_failure' }) },
                { event_id: 'h2', kind: 'system_failure', target_json: JSON.stringify({ type: 'system_failure' }) },
                { event_id: 'p1', kind: 'task', target_json: JSON.stringify({ type: 'task', repository: 'acme/private' }) },
                { event_id: 'd1', kind: 'task', target_json: JSON.stringify({ type: 'task', repository: DEMO_REPOSITORY }) },
                { event_id: 'v1', kind: 'task', target_json: JSON.stringify({ type: 'task', repository: DEMO_REPOSITORY }) },
            ]);
            const receipt = (event_id: string, user_id: string, extra: Record<string, unknown> = {}) => ({
                event_id, user_id, inbox_enabled: true, read_at: null, dismissed_at: null, ...extra,
            });
            await curated('notification_user_states').insert([
                // "noisy" holds the most receipts, but none the demo Inbox shows.
                receipt('h1', 'noisy'), receipt('h2', 'noisy'), receipt('p1', 'noisy'),
                receipt('d1', 'noisy', { dismissed_at: '2026-10-01T00:00:00.000Z' }),
                receipt('v1', 'noisy', { inbox_enabled: false }),
                receipt('v1', 'reviewer'),
            ]);
            const inbox = createDemoInboxReader({ service, database: curated, loadRepositories: async () => [DEMO_REPOSITORY] });

            const page = await inbox.listNotifications({ limit: 20 });
            assert.deepEqual(listedFor, ['reviewer']);
            assert.deepEqual(page.notifications.map(item => item.id), ['event-visible']);
            assert.equal(page.unreadCount, 1);
            assert.equal(await inbox.getUnreadNotificationCount(), 1);
            assert.deepEqual(listedFor, ['reviewer']);
        } finally {
            await curated.destroy();
        }
    });

    test('fills the page past an entirely hidden first page and resumes without skipping or repeating', async () => {
        const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString();
        const hidden = Array.from({ length: 120 }, (_, index) => index % 2
            ? notification(`hidden-${String(index).padStart(3, '0')}`, 'system_failure', undefined, at(500 - index))
            : notification(`hidden-${String(index).padStart(3, '0')}`, 'task', 'acme/private', at(500 - index)));
        const shown = ['shown-1', 'shown-2', 'shown-3'].map((id, index) => notification(id, 'task', DEMO_REPOSITORY, at(100 - index * 2)));
        const between = notification('hidden-between', 'system_failure', undefined, at(99));
        const inbox = createDemoInboxReader({
            service: pagedService({ operator: [...hidden, shown[0], between, shown[1], shown[2]] }),
            database, loadRepositories: async () => [DEMO_REPOSITORY],
        });

        const first = await inbox.listNotifications({ limit: 2 });
        assert.deepEqual(first.notifications.map(item => item.id), ['shown-1', 'shown-2']);
        assert.ok(first.nextCursor);
        // The first underlying page (100 receipts) held nothing the demo shows.
        assert.deepEqual(listedFor, ['operator', 'operator']);

        const second = await inbox.listNotifications({ limit: 2, cursor: first.nextCursor });
        assert.deepEqual(second.notifications.map(item => item.id), ['shown-3']);
        assert.equal(second.nextCursor, null);
    });

    test('no configured demo repository yields an empty Inbox', async () => {
        const inbox = createDemoInboxReader({ service, database, loadRepositories: async () => [] });
        assert.deepEqual(await inbox.listNotifications({}), { notifications: [], unreadCount: 0, nextCursor: null });
        assert.equal(await inbox.getUnreadNotificationCount(), 0);
        assert.deepEqual(listedFor, []);
    });

    test('an empty curated database yields an empty Inbox', async () => {
        const empty = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
        try {
            await createInboxTables(empty);
            const inbox = createDemoInboxReader({ service, database: empty, loadRepositories: async () => [DEMO_REPOSITORY] });
            assert.deepEqual(await inbox.listNotifications({}), { notifications: [], unreadCount: 0, nextCursor: null });
            assert.equal(await inbox.getUnreadNotificationCount(), 0);
            assert.deepEqual(listedFor, []);
        } finally {
            await empty.destroy();
        }
    });

    test('the Inbox routes serve the demo viewer the representative Inbox only in demo mode', async () => {
        const routes = createNotificationRoutes({
            service: service as never,
            demoInbox: reader(),
            getWebPushConfiguration: () => ({ subject: '', publicKey: '', privateKey: '' }) as never,
        });

        configureDemoMode(true);
        const listed = recorder();
        await routes.getNotifications(demoRequest(), listed.res);
        assert.equal(listed.state.status, 200);
        assert.deepEqual((listed.state.body as NotificationListResponse).notifications.map(item => item.id), ['event-visible']);
        const unread = recorder();
        await routes.getUnreadCount(demoRequest(), unread.res);
        assert.deepEqual(unread.state.body, { unreadCount: 2 });
        assert.deepEqual(listedFor, ['operator']);

        configureDemoMode(false);
        listedFor.length = 0;
        await routes.getNotifications(demoRequest(), recorder().res);
        assert.deepEqual(listedFor, [getDemoUser().id]);
    });
});
