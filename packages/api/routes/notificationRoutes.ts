import { createECDH, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import {
    decodeNotificationCursor,
    NotificationQueryValidationError,
    NotificationValidationError,
    notificationService,
    parseNotificationListLimit,
    PushSubscriptionConflictError,
    type NotificationService
} from '@propr/core';
import {
    NOTIFICATION_PAYLOAD_LIMITS,
    parseNotificationUnreadCountResponse
} from '@propr/shared';

export type NotificationRouteService = Pick<
    NotificationService,
    | 'listNotifications'
    | 'getUnreadNotificationCount'
    | 'markNotificationRead'
    | 'dismissNotification'
    | 'getNotificationPreferences'
    | 'updateNotificationPreferences'
    | 'upsertPushSubscription'
    | 'revokePushSubscription'
>;

export interface WebPushServerConfiguration {
    publicKey?: string;
    privateKey?: string;
}

export interface NotificationRouteDependencies {
    service?: NotificationRouteService;
    getWebPushConfiguration?: () => WebPushServerConfiguration;
}

function decodeVapidKey(value: unknown, expectedBytes: number): Buffer | null {
    const expectedLength = Math.ceil(expectedBytes * 8 / 6);
    if (
        typeof value !== 'string'
        || value.length !== expectedLength
        || value !== value.trim()
        || !/^[A-Za-z0-9_-]+$/.test(value)
    ) {
        return null;
    }
    const decoded = Buffer.from(value, 'base64url');
    if (
        decoded.length !== expectedBytes
        || decoded.toString('base64url') !== value
    ) {
        return null;
    }
    return decoded;
}

function validatedVapidPublicKey(
    configuration: WebPushServerConfiguration
): string | null {
    const publicKey = decodeVapidKey(configuration.publicKey, 65);
    const privateKey = decodeVapidKey(configuration.privateKey, 32);
    if (!publicKey || publicKey[0] !== 0x04 || !privateKey) return null;

    try {
        const ecdh = createECDH('prime256v1');
        ecdh.setPrivateKey(privateKey);
        const derivedPublicKey = ecdh.getPublicKey(undefined, 'uncompressed');
        if (!timingSafeEqual(publicKey, derivedPublicKey)) return null;
    } catch {
        return null;
    }
    return publicKey.toString('base64url');
}

function authenticatedUserId(req: Request, res: Response): string | null {
    if (typeof req.user?.id !== 'string' || req.user.id.trim().length === 0) {
        res.status(401).json({ error: 'Authentication required' });
        return null;
    }
    return req.user.id;
}

function parseIncludeDismissed(value: unknown): boolean {
    if (value === undefined) return false;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    throw new NotificationQueryValidationError(
        'includeDismissed must be true or false'
    );
}

function parseCursor(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length === 0) {
        throw new NotificationQueryValidationError('cursor is invalid');
    }
    decodeNotificationCursor(value);
    return value;
}

function eventIdFromRequest(req: Request): string {
    const eventId = req.params.id;
    if (
        typeof eventId !== 'string'
        || eventId.trim().length === 0
        || Buffer.byteLength(eventId, 'utf8') > NOTIFICATION_PAYLOAD_LIMITS.identifierBytes
    ) {
        throw new NotificationQueryValidationError('notification id is invalid');
    }
    return eventId;
}

function withoutClientSuppliedOwner(value: unknown): unknown {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
    const payload = { ...value as Record<string, unknown> };
    delete payload.userId;
    return payload;
}

function handleRouteError(res: Response, error: unknown, operation: string): void {
    if (
        error instanceof NotificationQueryValidationError
        || error instanceof NotificationValidationError
    ) {
        res.status(400).json({
            code: error.code,
            error: error.message
        });
        return;
    }
    if (error instanceof PushSubscriptionConflictError) {
        res.status(409).json({
            code: error.code,
            error: error.message
        });
        return;
    }

    console.error(`Failed to ${operation}:`, error);
    res.status(500).json({ error: 'Internal server error' });
}

export function createNotificationRoutes(
    dependencies: NotificationRouteDependencies = {}
) {
    const service = dependencies.service ?? notificationService;
    const getWebPushConfiguration = dependencies.getWebPushConfiguration ?? (() => ({
        publicKey: process.env.VAPID_PUBLIC_KEY,
        privateKey: process.env.VAPID_PRIVATE_KEY
    }));

    async function getNotifications(req: Request, res: Response): Promise<void> {
        const userId = authenticatedUserId(req, res);
        if (!userId) return;

        try {
            const response = await service.listNotifications(userId, {
                cursor: parseCursor(req.query.cursor),
                limit: parseNotificationListLimit(req.query.limit),
                includeDismissed: parseIncludeDismissed(req.query.includeDismissed)
            });
            res.json(response);
        } catch (error) {
            handleRouteError(res, error, 'list notifications');
        }
    }

    async function getUnreadCount(req: Request, res: Response): Promise<void> {
        const userId = authenticatedUserId(req, res);
        if (!userId) return;

        try {
            const unreadCount = await service.getUnreadNotificationCount(userId);
            res.json(parseNotificationUnreadCountResponse({ unreadCount }));
        } catch (error) {
            handleRouteError(res, error, 'count unread notifications');
        }
    }

    async function markRead(req: Request, res: Response): Promise<void> {
        const userId = authenticatedUserId(req, res);
        if (!userId) return;

        try {
            const response = await service.markNotificationRead(
                userId,
                eventIdFromRequest(req)
            );
            if (!response) {
                res.status(404).json({ error: 'Notification not found' });
                return;
            }
            res.json(response);
        } catch (error) {
            handleRouteError(res, error, 'mark notification as read');
        }
    }

    async function dismiss(req: Request, res: Response): Promise<void> {
        const userId = authenticatedUserId(req, res);
        if (!userId) return;

        try {
            const response = await service.dismissNotification(
                userId,
                eventIdFromRequest(req)
            );
            if (!response) {
                res.status(404).json({ error: 'Notification not found' });
                return;
            }
            res.json(response);
        } catch (error) {
            handleRouteError(res, error, 'dismiss notification');
        }
    }

    async function getConfiguration(req: Request, res: Response): Promise<void> {
        const userId = authenticatedUserId(req, res);
        if (!userId) return;

        const configuration = getWebPushConfiguration();
        const publicKey = validatedVapidPublicKey(configuration);
        res.json({
            push: {
                configured: publicKey !== null,
                vapidPublicKey: publicKey
            }
        });
    }

    async function getPreferences(req: Request, res: Response): Promise<void> {
        const userId = authenticatedUserId(req, res);
        if (!userId) return;

        try {
            res.json(await service.getNotificationPreferences(userId));
        } catch (error) {
            handleRouteError(res, error, 'read notification preferences');
        }
    }

    async function updatePreferences(req: Request, res: Response): Promise<void> {
        const userId = authenticatedUserId(req, res);
        if (!userId) return;

        try {
            res.json(await service.updateNotificationPreferences(
                userId,
                withoutClientSuppliedOwner(req.body) as Parameters<
                    NotificationRouteService['updateNotificationPreferences']
                >[1]
            ));
        } catch (error) {
            handleRouteError(res, error, 'update notification preferences');
        }
    }

    async function createPushSubscription(req: Request, res: Response): Promise<void> {
        const userId = authenticatedUserId(req, res);
        if (!userId) return;

        try {
            const userAgent = typeof req.get === 'function'
                ? req.get('user-agent')
                : undefined;
            const subscription = await service.upsertPushSubscription(
                userId,
                withoutClientSuppliedOwner(req.body) as Parameters<
                    NotificationRouteService['upsertPushSubscription']
                >[1],
                userAgent
            );
            res.json({ subscription });
        } catch (error) {
            handleRouteError(res, error, 'create or refresh push subscription');
        }
    }

    async function revokePushSubscription(req: Request, res: Response): Promise<void> {
        const userId = authenticatedUserId(req, res);
        if (!userId) return;

        try {
            const body = typeof req.body === 'object' && req.body !== null
                ? req.body as Record<string, unknown>
                : {};
            const endpoint = body.endpoint ?? req.query.endpoint;
            if (typeof endpoint !== 'string') {
                throw new NotificationValidationError(
                    'pushSubscriptionInput.endpoint is required'
                );
            }
            await service.revokePushSubscription(userId, endpoint);
            res.status(204).end();
        } catch (error) {
            handleRouteError(res, error, 'revoke push subscription');
        }
    }

    return {
        getNotifications,
        getUnreadCount,
        markRead,
        dismiss,
        getConfiguration,
        getCapabilities: getConfiguration,
        getPreferences,
        updatePreferences,
        createPushSubscription,
        upsertPushSubscription: createPushSubscription,
        revokePushSubscription
    };
}
