import type { Request, Response } from 'express';
import {
    decodeNotificationCursor,
    NotificationQueryValidationError,
    notificationService,
    parseNotificationListLimit,
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
>;

export interface NotificationRouteDependencies {
    service?: NotificationRouteService;
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

function handleRouteError(res: Response, error: unknown, operation: string): void {
    if (error instanceof NotificationQueryValidationError) {
        res.status(400).json({
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

    return { getNotifications, getUnreadCount, markRead, dismiss };
}
