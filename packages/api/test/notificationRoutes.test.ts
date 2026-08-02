import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import express from 'express';
import type { Request, Response } from 'express';
import { closeConnection } from '@propr/core';
import { ensureAuthenticated } from '../auth.js';
import {
    configureDemoMode,
    demoModeReadOnlyMiddleware,
    resetConfiguredDemoMode
} from '../demoMode.js';
import { createNotificationRoutes, type NotificationRouteService } from '../routes/notificationRoutes.js';

after(async () => closeConnection());

function responseRecorder(): {
    response: Response;
    status: () => number;
    body: () => unknown;
} {
    let statusCode = 200;
    let payload: unknown;
    const response = {
        status(code: number) {
            statusCode = code;
            return response;
        },
        json(body: unknown) {
            payload = body;
            return response;
        }
    } as unknown as Response;
    return { response, status: () => statusCode, body: () => payload };
}

function createService(
    overrides: Partial<NotificationRouteService> = {}
): NotificationRouteService {
    return {
        listNotifications: async () => ({
            notifications: [],
            unreadCount: 0,
            nextCursor: null
        }),
        getUnreadNotificationCount: async () => 0,
        markNotificationRead: async () => null,
        dismissNotification: async () => null,
        ...overrides
    };
}

async function fetchFromApp(
    app: express.Express,
    path: string,
    init?: RequestInit
): Promise<globalThis.Response> {
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    try {
        return await fetch(`http://127.0.0.1:${address.port}${path}`, init);
    } finally {
        await new Promise<void>((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        });
    }
}

describe('notification routes', () => {
    test('uses only the authenticated user and clamps list limits', async () => {
        let receivedUserId: string | undefined;
        let receivedOptions: unknown;
        const routes = createNotificationRoutes({
            service: createService({
                listNotifications: async (userId, options) => {
                    receivedUserId = userId;
                    receivedOptions = options;
                    return { notifications: [], unreadCount: 0, nextCursor: null };
                }
            })
        });
        const { response, status } = responseRecorder();

        await routes.getNotifications({
            user: { id: 'authenticated-user' },
            body: { userId: 'browser-supplied-user' },
            query: { limit: '10000', includeDismissed: 'true' }
        } as unknown as Request, response);

        assert.equal(status(), 200);
        assert.equal(receivedUserId, 'authenticated-user');
        assert.deepEqual(receivedOptions, {
            cursor: undefined,
            limit: 100,
            includeDismissed: true
        });
    });

    test('uses the authenticated user for receipt mutations', async () => {
        let received: [string, string] | undefined;
        const routes = createNotificationRoutes({
            service: createService({
                markNotificationRead: async (userId, eventId) => {
                    received = [userId, eventId];
                    return null;
                }
            })
        });
        const { response, status } = responseRecorder();

        await routes.markRead({
            user: { id: 'authenticated-user' },
            params: { id: 'event-1' },
            body: { userId: 'victim-user' },
            query: {}
        } as unknown as Request, response);

        assert.deepEqual(received, ['authenticated-user', 'event-1']);
        assert.equal(status(), 404);
    });

    test('returns 400 for malformed limits, cursors, and history flags', async () => {
        let calls = 0;
        const routes = createNotificationRoutes({
            service: createService({
                listNotifications: async () => {
                    calls += 1;
                    return { notifications: [], unreadCount: 0, nextCursor: null };
                }
            })
        });

        for (const query of [
            { limit: '1.5' },
            { cursor: 'not-a-valid-cursor' },
            { includeDismissed: 'sometimes' }
        ]) {
            const { response, status, body } = responseRecorder();
            await routes.getNotifications({
                user: { id: 'authenticated-user' },
                query
            } as unknown as Request, response);
            assert.equal(status(), 400);
            assert.equal((body() as { code: string }).code, 'INVALID_NOTIFICATION_QUERY');
        }
        assert.equal(calls, 0);
    });

    test('requires an authenticated identity even when handlers are called directly', async () => {
        const routes = createNotificationRoutes({ service: createService() });
        const { response, status, body } = responseRecorder();

        await routes.getUnreadCount({ query: {} } as Request, response);

        assert.equal(status(), 401);
        assert.deepEqual(body(), { error: 'Authentication required' });
    });

    test('keeps demo Inbox reads available while the existing policy blocks mutations', async () => {
        configureDemoMode(true);
        let listedUserId: string | undefined;
        let mutationCalls = 0;
        const routes = createNotificationRoutes({
            service: createService({
                listNotifications: async (userId) => {
                    listedUserId = userId;
                    return { notifications: [], unreadCount: 0, nextCursor: null };
                },
                markNotificationRead: async () => {
                    mutationCalls += 1;
                    return null;
                }
            })
        });
        const app = express();
        app.use(express.json());
        app.use('/api', demoModeReadOnlyMiddleware);
        app.use('/api', ensureAuthenticated);
        app.get('/api/notifications', routes.getNotifications);
        app.post('/api/notifications/:id/read', routes.markRead);

        try {
            const listResponse = await fetchFromApp(app, '/api/notifications');
            assert.equal(listResponse.status, 200);
            assert.equal(listedUserId, 'propr-demo');

            const mutationResponse = await fetchFromApp(
                app,
                '/api/notifications/event-1/read',
                { method: 'POST' }
            );
            assert.equal(mutationResponse.status, 405);
            assert.equal(mutationCalls, 0);
        } finally {
            resetConfiguredDemoMode();
        }
    });
});
