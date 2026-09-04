import type { Request, Response } from 'express';
import {
    decodeNotificationCursor,
    NotificationQueryValidationError,
    NotificationValidationError,
    notificationService,
    parseNotificationListLimit,
    PushSubscriptionConflictError,
    PushSubscriptionQuotaError,
    PushSubscriptionRateLimitError,
    type NotificationService
} from '@propr/core';
import {
    NOTIFICATION_PAYLOAD_LIMITS,
    parseNotificationCapabilitiesResponse,
    parseNotificationPreferencesResponse,
    parsePushSubscriptionEnrollmentResponse,
    parsePushSubscriptionsResponse,
    parseNotificationUnreadCountResponse
} from '@propr/shared';
import {
    validateWebPushConfiguration,
    WEB_PUSH_CONFIGURATION_WARNINGS,
    webPushConfigurationFromEnvironment,
    type WebPushServerConfiguration
} from '../services/webPushConfiguration.js';

export type NotificationRouteService = Pick<
    NotificationService,
    | 'listNotifications'
    | 'getUnreadNotificationCount'
    | 'markNotificationRead'
    | 'dismissNotification'
    | 'dismissAllNotifications'
    | 'getNotificationPreferences'
    | 'updateNotificationPreferences'
    | 'upsertPushSubscription'
    | 'listPushSubscriptions'
    | 'revokePushSubscription'
    | 'revokePushSubscriptionById'
>;

export interface NotificationRouteDependencies {
    service?: NotificationRouteService;
    getWebPushConfiguration?: () => WebPushServerConfiguration;
    webPushDispatcherConfigured?: boolean;
    logWarning?: (message: string) => void;
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

function subscriptionIdFromRequest(req: Request): string {
    const subscriptionId = req.params.subscriptionId;
    if (
        typeof subscriptionId !== 'string'
        || subscriptionId.trim().length === 0
        || Buffer.byteLength(subscriptionId, 'utf8')
            > NOTIFICATION_PAYLOAD_LIMITS.identifierBytes
    ) {
        throw new NotificationQueryValidationError('push subscription id is invalid');
    }
    return subscriptionId;
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
    if (error instanceof PushSubscriptionQuotaError) {
        res.status(409).json({
            code: error.code,
            error: error.message,
            limit: error.limit,
            scope: error.scope
        });
        return;
    }
    if (error instanceof PushSubscriptionRateLimitError) {
        res.set('Retry-After', String(error.retryAfterSeconds));
        res.status(429).json({
            code: error.code,
            error: error.message,
            retryAfterSeconds: error.retryAfterSeconds
        });
        return;
    }

    // Database/provider errors can contain SQL bindings with subscription
    // endpoints or encryption material. Keep this boundary deliberately fixed.
    console.error(`Failed to ${operation}`);
    res.status(500).json({ error: 'Internal server error' });
}

export function createNotificationRoutes(
    dependencies: NotificationRouteDependencies = {}
) {
    const service = dependencies.service ?? notificationService;
    const getWebPushConfiguration = dependencies.getWebPushConfiguration
        ?? webPushConfigurationFromEnvironment;
    // The dispatcher owns the single process startup warning. Tests and other
    // embedders may inject a warning sink to inspect validation directly.
    const logWarning = dependencies.logWarning ?? (() => undefined);
    // VAPID configuration is process-static. Validate the key pair once when the
    // routes are constructed instead of repeating P-256 derivation per request.
    const vapidValidation = validateWebPushConfiguration(getWebPushConfiguration());
    if (!vapidValidation.configured && vapidValidation.issue !== 'disabled') {
        logWarning(`[notifications] Web Push disabled: ${
            WEB_PUSH_CONFIGURATION_WARNINGS[vapidValidation.issue]
        }`);
    }
    const pushConfigured = vapidValidation.configured
        && (dependencies.webPushDispatcherConfigured ?? true);
    const capabilityResponse = parseNotificationCapabilitiesResponse({
        push: {
            configured: pushConfigured,
            vapidPublicKey: pushConfigured ? vapidValidation.publicKey : null
        }
    });

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

    async function dismissAll(req: Request, res: Response): Promise<void> {
        const userId = authenticatedUserId(req, res);
        if (!userId) return;

        try {
            res.json(parseNotificationUnreadCountResponse(
                await service.dismissAllNotifications(userId)
            ));
        } catch (error) {
            handleRouteError(res, error, 'dismiss all notifications');
        }
    }

    async function getConfiguration(req: Request, res: Response): Promise<void> {
        const userId = authenticatedUserId(req, res);
        if (!userId) return;

        res.json(capabilityResponse);
    }

    async function getPreferences(req: Request, res: Response): Promise<void> {
        const userId = authenticatedUserId(req, res);
        if (!userId) return;

        try {
            res.json(parseNotificationPreferencesResponse(
                await service.getNotificationPreferences(userId)
            ));
        } catch (error) {
            handleRouteError(res, error, 'read notification preferences');
        }
    }

    async function updatePreferences(req: Request, res: Response): Promise<void> {
        const userId = authenticatedUserId(req, res);
        if (!userId) return;

        try {
            res.json(parseNotificationPreferencesResponse(
                await service.updateNotificationPreferences(
                    userId,
                    withoutClientSuppliedOwner(req.body) as Parameters<
                        NotificationRouteService['updateNotificationPreferences']
                    >[1]
                )
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
            res.json(parsePushSubscriptionEnrollmentResponse({ subscription }));
        } catch (error) {
            handleRouteError(res, error, 'create or refresh push subscription');
        }
    }

    async function listPushSubscriptions(req: Request, res: Response): Promise<void> {
        const userId = authenticatedUserId(req, res);
        if (!userId) return;

        try {
            const subscriptions = await service.listPushSubscriptions(userId);
            res.json(parsePushSubscriptionsResponse({ subscriptions }));
        } catch (error) {
            handleRouteError(res, error, 'list push subscriptions');
        }
    }

    async function revokePushSubscription(req: Request, res: Response): Promise<void> {
        const userId = authenticatedUserId(req, res);
        if (!userId) return;

        try {
            const body = typeof req.body === 'object' && req.body !== null
                ? req.body as Record<string, unknown>
                : {};
            const endpoint = body.endpoint;
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

    async function revokePushSubscriptionById(req: Request, res: Response): Promise<void> {
        const userId = authenticatedUserId(req, res);
        if (!userId) return;

        try {
            await service.revokePushSubscriptionById(
                userId,
                subscriptionIdFromRequest(req)
            );
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
        dismissAll,
        getConfiguration,
        getCapabilities: getConfiguration,
        getPreferences,
        updatePreferences,
        createPushSubscription,
        upsertPushSubscription: createPushSubscription,
        listPushSubscriptions,
        revokePushSubscription,
        revokePushSubscriptionById
    };
}
