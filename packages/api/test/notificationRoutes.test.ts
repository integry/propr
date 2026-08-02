import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import { after, describe, test } from 'node:test';
import express from 'express';
import type { Request, Response } from 'express';
import { closeConnection, NotificationValidationError, PushSubscriptionConflictError,
    PushSubscriptionQuotaError, PushSubscriptionRateLimitError } from '@propr/core';
import { NOTIFICATION_KINDS, parseNotificationPreferencesResponse,
    parsePushSubscription } from '@propr/shared';
import { ensureAuthenticated } from '../auth.js';
import { configureDemoMode, demoModeReadOnlyMiddleware, resetConfiguredDemoMode } from '../demoMode.js';
import { createNotificationRoutes, type NotificationRouteService } from '../routes/notificationRoutes.js';

after(async () => closeConnection());

function responseRecorder(): { response: Response; status: () => number; body: () => unknown;
    headers: () => Record<string, string> } {
    let statusCode = 200;
    let payload: unknown;
    const responseHeaders: Record<string, string> = {};
    const response = {
        status(code: number) {
            statusCode = code;
            return response;
        },
        json(body: unknown) {
            payload = body;
            return response;
        },
        set(name: string, value: string) {
            responseHeaders[name.toLowerCase()] = value;
            return response;
        },
        end() {
            return response;
        }
    } as unknown as Response;
    return {
        response,
        status: () => statusCode,
        body: () => payload,
        headers: () => ({ ...responseHeaders })
    };
}

function createService(overrides: Partial<NotificationRouteService> = {}): NotificationRouteService {
    const timestamp = '2026-08-02T10:00:00.000Z';
    const preferences = parseNotificationPreferencesResponse({
        preferences: Object.fromEntries(NOTIFICATION_KINDS.map((kind) => [kind, {
            inboxEnabled: true,
            pushEnabled: false,
            updatedAt: timestamp
        }])),
        quietHours: { start: null, end: null, timezone: 'UTC' }
    });
    return {
        listNotifications: async () => ({
            notifications: [],
            unreadCount: 0,
            nextCursor: null
        }),
        getUnreadNotificationCount: async () => 0,
        markNotificationRead: async () => null,
        dismissNotification: async () => null,
        getNotificationPreferences: async () => preferences,
        updateNotificationPreferences: async () => preferences,
        upsertPushSubscription: async () => parsePushSubscription({
            id: 'subscription-1',
            endpoint: 'https://fcm.googleapis.com/fcm/send/subscription-1',
            expiresAt: null,
            revokedAt: null,
            createdAt: timestamp,
            updatedAt: timestamp
        }),
        listPushSubscriptions: async () => [],
        revokePushSubscription: async () => false,
        revokePushSubscriptionById: async () => false,
        ...overrides
    };
}

function createVapidConfiguration(): { publicKey: string; privateKey: string } {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    return {
        publicKey: ecdh.getPublicKey(undefined, 'uncompressed').toString('base64url'),
        privateKey: ecdh.getPrivateKey().toString('base64url')
    };
}

function authenticatedRequest(overrides: Record<string, unknown> = {}): Request {
    return { user: { id: 'authenticated-user' }, body: {}, query: {}, ...overrides } as unknown as Request;
}

async function fetchFromApp(app: express.Express, path: string,
    init?: RequestInit): Promise<globalThis.Response> {
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

        await routes.getNotifications(authenticatedRequest({
            body: { userId: 'browser-supplied-user' },
            query: { limit: '10000', includeDismissed: 'true' }
        }), response);

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

        await routes.markRead(authenticatedRequest({
            params: { id: 'event-1' },
            body: { userId: 'victim-user' }
        }), response);

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
            await routes.getNotifications(authenticatedRequest({ query }), response);
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

    test('returns Web Push capability without exposing private VAPID material', async () => {
        const vapid = createVapidConfiguration();
        let configurationReads = 0;
        const routes = createNotificationRoutes({
            service: createService(),
            getWebPushConfiguration: () => {
                configurationReads += 1;
                return vapid;
            }
        });
        const { response, status, body } = responseRecorder();

        await routes.getConfiguration(authenticatedRequest(), response);

        assert.equal(status(), 200);
        assert.deepEqual(body(), {
            push: {
                configured: true,
                vapidPublicKey: vapid.publicKey
            }
        });
        assert.equal(JSON.stringify(body()).includes(vapid.privateKey), false);
        const secondRecorder = responseRecorder();
        await routes.getConfiguration(authenticatedRequest(), secondRecorder.response);
        assert.equal(configurationReads, 1, 'VAPID key-pair validation is cached per router');
    });

    test('does not advertise malformed, padded, or mismatched VAPID keys', async () => {
        const valid = createVapidConfiguration();
        const other = createVapidConfiguration();

        for (const configuration of [
            { publicKey: ` ${valid.publicKey}`, privateKey: valid.privateKey },
            { publicKey: `${valid.publicKey}=`, privateKey: valid.privateKey },
            { publicKey: valid.publicKey, privateKey: other.privateKey },
            { publicKey: 'not-a-p256-key', privateKey: 'not-a-private-key' }
        ]) {
            const routes = createNotificationRoutes({
                service: createService(),
                getWebPushConfiguration: () => configuration
            });
            const { response, status, body } = responseRecorder();
            await routes.getConfiguration(authenticatedRequest(), response);

            assert.equal(status(), 200);
            assert.deepEqual(body(), {
                push: { configured: false, vapidPublicKey: null }
            });
        }
    });

    test('derives the preference owner from authentication and passes sparse updates through', async () => {
        let receivedUserId: string | undefined;
        let receivedUpdate: unknown;
        const routes = createNotificationRoutes({
            service: createService({
                updateNotificationPreferences: async (userId, update) => {
                    receivedUserId = userId;
                    receivedUpdate = update;
                    return createService().getNotificationPreferences(userId);
                }
            })
        });
        const update = {
            userId: 'browser-supplied-user',
            preferences: { task: { pushEnabled: true } }
        };
        const { response, status } = responseRecorder();

        await routes.updatePreferences(authenticatedRequest({ body: update }), response);

        assert.equal(status(), 200);
        assert.equal(receivedUserId, 'authenticated-user');
        assert.deepEqual(receivedUpdate, {
            preferences: { task: { pushEnabled: true } }
        });
    });

    test('enrolls and revokes subscriptions only for the authenticated user', async () => {
        let enrolledUserId: string | undefined;
        let enrolledUserAgent: string | undefined;
        let revoked: [string, string] | undefined;
        const routes = createNotificationRoutes({
            service: createService({
                upsertPushSubscription: async (userId, _input, userAgent) => {
                    enrolledUserId = userId;
                    enrolledUserAgent = userAgent;
                    return createService().upsertPushSubscription(userId, _input, userAgent);
                },
                revokePushSubscription: async (userId, endpoint) => {
                    revoked = [userId, endpoint];
                    return true;
                }
            })
        });
        const endpoint = 'https://fcm.googleapis.com/fcm/send/subscription-1';
        const subscriptionRecorder = responseRecorder();

        await routes.createPushSubscription(authenticatedRequest({
            body: { userId: 'victim-user', endpoint, expirationTime: null, keys: {} },
            get: () => 'Example Browser'
        }), subscriptionRecorder.response);

        assert.equal(enrolledUserId, 'authenticated-user');
        assert.equal(enrolledUserAgent, 'Example Browser');
        assert.equal(subscriptionRecorder.status(), 200);
        assert.equal(JSON.stringify(subscriptionRecorder.body()).includes('keys'), false);

        const queryOnlyRecorder = responseRecorder();
        await routes.revokePushSubscription(authenticatedRequest({
            query: { endpoint }
        }), queryOnlyRecorder.response);
        assert.equal(queryOnlyRecorder.status(), 400);
        assert.equal(revoked, undefined, 'capability URLs must not be read from query strings');

        const revocationRecorder = responseRecorder();
        await routes.revokePushSubscription(authenticatedRequest({
            body: { userId: 'victim-user', endpoint }
        }), revocationRecorder.response);
        assert.deepEqual(revoked, ['authenticated-user', endpoint]);
        assert.equal(revocationRecorder.status(), 204);
    });

    test('maps invalid notification inputs to 400 responses', async () => {
        const routes = createNotificationRoutes({
            service: createService({
                updateNotificationPreferences: async () => {
                    throw new NotificationValidationError('invalid timezone');
                }
            })
        });
        const { response, status, body } = responseRecorder();

        await routes.updatePreferences(authenticatedRequest({
            body: { quietHours: { timezone: 'invalid' } }
        }), response);

        assert.equal(status(), 400);
        assert.deepEqual(body(), {
            code: 'INVALID_NOTIFICATION_INPUT',
            error: 'invalid timezone'
        });
    });

    test('maps endpoint ownership conflicts to a 409 response', async () => {
        const routes = createNotificationRoutes({
            service: createService({
                upsertPushSubscription: async () => {
                    throw new PushSubscriptionConflictError();
                }
            })
        });
        const { response, status, body } = responseRecorder();

        await routes.createPushSubscription(authenticatedRequest({
            body: {
                endpoint: 'https://fcm.googleapis.com/fcm/send/already-owned',
                expirationTime: null,
                keys: {}
            }
        }), response);

        assert.equal(status(), 409);
        assert.deepEqual(body(), {
            code: 'PUSH_SUBSCRIPTION_CONFLICT',
            error: 'Push subscription endpoint is already enrolled'
        });
    });

    test('maps subscription quotas and enrollment rate limits to actionable responses', async () => {
        const quotaRoutes = createNotificationRoutes({
            service: createService({
                upsertPushSubscription: async () => {
                    throw new PushSubscriptionQuotaError('active', 10);
                }
            })
        });
        const quotaRecorder = responseRecorder();
        await quotaRoutes.createPushSubscription(authenticatedRequest(), quotaRecorder.response);
        assert.equal(quotaRecorder.status(), 409);
        assert.deepEqual(quotaRecorder.body(), {
            code: 'PUSH_SUBSCRIPTION_QUOTA_EXCEEDED',
            error: 'A user may have at most 10 active push subscriptions',
            limit: 10,
            scope: 'active'
        });

        const rateRoutes = createNotificationRoutes({
            service: createService({
                upsertPushSubscription: async () => {
                    throw new PushSubscriptionRateLimitError(42);
                }
            })
        });
        const rateRecorder = responseRecorder();
        await rateRoutes.createPushSubscription(authenticatedRequest(), rateRecorder.response);
        assert.equal(rateRecorder.status(), 429);
        assert.equal(rateRecorder.headers()['retry-after'], '42');
        assert.deepEqual(rateRecorder.body(), {
            code: 'PUSH_SUBSCRIPTION_RATE_LIMITED',
            error: 'Too many push subscription enrollments',
            retryAfterSeconds: 42
        });
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
