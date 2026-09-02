import {
    NOTIFICATION_PAYLOAD_LIMITS,
    parseISO8601Timestamp,
    type ISO8601Timestamp
} from '@propr/shared';

export const DEFAULT_NOTIFICATION_LIST_LIMIT = 25;
export const MAX_NOTIFICATION_LIST_LIMIT = 100;

const MAX_NOTIFICATION_CURSOR_LENGTH = 2048;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface NotificationCursor {
    occurredAt: ISO8601Timestamp;
    eventId: string;
}

export class NotificationQueryValidationError extends Error {
    readonly code = 'INVALID_NOTIFICATION_QUERY';

    constructor(message: string) {
        super(message);
        this.name = 'NotificationQueryValidationError';
    }
}

function isBoundedIdentifier(value: unknown): value is string {
    return typeof value === 'string'
        && value.trim().length > 0
        && Buffer.byteLength(value, 'utf8') <= NOTIFICATION_PAYLOAD_LIMITS.identifierBytes;
}

/** Parse and clamp a caller-controlled Inbox page size. */
export function parseNotificationListLimit(value: unknown): number {
    if (value === undefined || value === null) {
        return DEFAULT_NOTIFICATION_LIST_LIMIT;
    }

    let parsed: number;
    if (typeof value === 'number') {
        parsed = value;
    } else if (typeof value === 'string' && /^\d+$/.test(value)) {
        parsed = Number(value);
    } else {
        throw new NotificationQueryValidationError('limit must be a positive integer');
    }

    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new NotificationQueryValidationError('limit must be a positive integer');
    }

    return Math.min(parsed, MAX_NOTIFICATION_LIST_LIMIT);
}

/** Encode the stable keyset boundary without exposing a query-string contract. */
export function encodeNotificationCursor(cursor: NotificationCursor): string {
    const occurredAt = parseISO8601Timestamp(cursor.occurredAt);
    if (!isBoundedIdentifier(cursor.eventId)) {
        throw new TypeError('notification cursor eventId must be a bounded non-empty string');
    }

    return Buffer.from(JSON.stringify([occurredAt, cursor.eventId]), 'utf8')
        .toString('base64url');
}

/** Decode and strictly validate an opaque Inbox keyset boundary. */
export function decodeNotificationCursor(value: unknown): NotificationCursor {
    try {
        if (
            typeof value !== 'string'
            || value.length === 0
            || value.length > MAX_NOTIFICATION_CURSOR_LENGTH
            || !BASE64URL_PATTERN.test(value)
        ) {
            throw new TypeError('invalid cursor encoding');
        }

        const decoded = Buffer.from(value, 'base64url');
        if (decoded.toString('base64url') !== value) {
            throw new TypeError('non-canonical cursor encoding');
        }

        const payload: unknown = JSON.parse(decoded.toString('utf8'));
        if (!Array.isArray(payload) || payload.length !== 2) {
            throw new TypeError('invalid cursor payload');
        }

        const occurredAt = parseISO8601Timestamp(payload[0]);
        const eventId = payload[1];
        if (!isBoundedIdentifier(eventId)) {
            throw new TypeError('invalid cursor event ID');
        }

        return { occurredAt, eventId };
    } catch (error) {
        if (error instanceof NotificationQueryValidationError) throw error;
        throw new NotificationQueryValidationError('cursor is invalid');
    }
}
