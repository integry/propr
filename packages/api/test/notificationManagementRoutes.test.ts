import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import { after, describe, test } from 'node:test';
import type { Request, Response } from 'express';
import { closeConnection } from '@propr/core';
import { NOTIFICATION_KINDS, parseNotificationPreferencesResponse,
    parsePushSubscription } from '@propr/shared';
import { createNotificationRoutes, type NotificationRouteService } from
    '../routes/notificationRoutes.js';

after(async () => closeConnection());

const timestamp = '2026-08-02T10:00:00.000Z';
const subscription = parsePushSubscription({
    id: 'subscription-1',
    endpoint: 'https://fcm.googleapis.com/fcm/send/subscription-1',
    expiresAt: null,
    revokedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp
});
const preferences = parseNotificationPreferencesResponse({
    preferences: Object.fromEntries(NOTIFICATION_KINDS.map((kind) => [kind, {
        inboxEnabled: true, pushEnabled: false, updatedAt: null
    }])),
    quietHours: { start: null, end: null, timezone: 'UTC' }
});

function routeService(
    overrides: Partial<NotificationRouteService> = {}
): NotificationRouteService {
    return {
        listNotifications: async () => ({
            notifications: [], unreadCount: 0, nextCursor: null
        }),
        getUnreadNotificationCount: async () => 0,
        markNotificationRead: async () => null,
        dismissNotification: async () => null,
        getNotificationPreferences: async () => preferences,
        updateNotificationPreferences: async () => preferences,
        upsertPushSubscription: async () => subscription,
        listPushSubscriptions: async () => [],
        revokePushSubscription: async () => false,
        revokePushSubscriptionById: async () => false,
        ...overrides
    };
}

function request(overrides: Record<string, unknown> = {}): Request {
    return { user: { id: 'authenticated-user' }, body: {}, query: {}, params: {},
        ...overrides } as unknown as Request;
}

function recorder(): { response: Response; status: () => number; body: () => unknown } {
    let statusCode = 200;
    let payload: unknown;
    const response = {
        status(code: number) { statusCode = code; return response; },
        json(body: unknown) { payload = body; return response; },
        end() { return response; }
    } as unknown as Response;
    return { response, status: () => statusCode, body: () => payload };
}

function vapidPair(): { publicKey: string; privateKey: string } {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    return {
        publicKey: ecdh.getPublicKey(undefined, 'uncompressed').toString('base64url'),
        privateKey: ecdh.getPrivateKey().toString('base64url')
    };
}

describe('notification subscription management routes', () => {
    test('lists safe metadata and revokes an owned opaque subscription ID', async () => {
        let listedUser: string | undefined;
        let revoked: [string, string] | undefined;
        const unsafeSubscription = { ...subscription, encryptionKey: 'must-not-leak' };
        const routes = createNotificationRoutes({
            service: routeService({
                listPushSubscriptions: async (userId) => {
                    listedUser = userId;
                    return [unsafeSubscription];
                },
                revokePushSubscriptionById: async (userId, subscriptionId) => {
                    revoked = [userId, subscriptionId];
                    return true;
                }
            }),
            logWarning: () => undefined
        });
        const listRecorder = recorder();
        await routes.listPushSubscriptions(request(), listRecorder.response);

        assert.equal(listedUser, 'authenticated-user');
        assert.deepEqual(listRecorder.body(), { subscriptions: [subscription] });
        assert.equal(JSON.stringify(listRecorder.body()).includes('must-not-leak'), false);

        const revokeRecorder = recorder();
        await routes.revokePushSubscriptionById(
            request({ params: { subscriptionId: 'subscription-1' } }),
            revokeRecorder.response
        );
        assert.deepEqual(revoked, ['authenticated-user', 'subscription-1']);
        assert.equal(revokeRecorder.status(), 204);
    });

    test('sanitizes preference snapshots at both response boundaries', async () => {
        const unsafe = { ...preferences, internalPolicy: 'must-not-leak' };
        const routes = createNotificationRoutes({
            service: routeService({
                getNotificationPreferences: async () => unsafe,
                updateNotificationPreferences: async () => unsafe
            }),
            logWarning: () => undefined
        });
        const getRecorder = recorder();
        await routes.getPreferences(request(), getRecorder.response);
        const updateRecorder = recorder();
        await routes.updatePreferences(
            request({ body: { preferences: { task: { pushEnabled: true } } } }),
            updateRecorder.response
        );

        assert.deepEqual(getRecorder.body(), preferences);
        assert.deepEqual(updateRecorder.body(), preferences);
        assert.equal(JSON.stringify(getRecorder.body()).includes('must-not-leak'), false);
    });

    test('warns distinctly and without secrets for invalid VAPID configuration', () => {
        const first = vapidPair();
        const second = vapidPair();
        const cases = [
            { configuration: {}, expected: 'missing' },
            {
                configuration: { publicKey: 'invalid-public', privateKey: 'invalid-private' },
                expected: 'malformed'
            },
            {
                configuration: { publicKey: first.publicKey, privateKey: second.privateKey },
                expected: 'do not match'
            }
        ];

        for (const { configuration, expected } of cases) {
            const warnings: string[] = [];
            createNotificationRoutes({
                service: routeService(),
                getWebPushConfiguration: () => configuration,
                logWarning: (message) => warnings.push(message)
            });
            assert.equal(warnings.length, 1);
            assert.match(warnings[0], new RegExp(expected));
            assert.equal(warnings[0].includes(first.privateKey), false);
            assert.equal(warnings[0].includes(second.privateKey), false);
        }
    });
});
