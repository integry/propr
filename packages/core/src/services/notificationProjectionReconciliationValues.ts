import { normalizeISO8601Timestamp } from '@propr/shared';
import logger from '../utils/logger.js';

export const DEFAULT_NOTIFICATION_INDEXING_TRANSITION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function positiveIntegerEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    if (Number.isSafeInteger(value) && value > 0) return value;
    logger.warn({ name, value: raw }, 'Ignoring invalid notification reconciliation configuration');
    return fallback;
}

export function getNotificationIndexingTransitionRetentionMs(): number {
    return positiveIntegerEnv(
        'NOTIFICATION_INDEXING_TRANSITION_RETENTION_MS',
        DEFAULT_NOTIFICATION_INDEXING_TRANSITION_RETENTION_MS
    );
}

export function parseReconciliationMetadata(value: unknown): Record<string, unknown> {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    if (typeof value !== 'string') return {};
    try {
        const parsed: unknown = JSON.parse(value);
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : {};
    } catch {
        return {};
    }
}

export function normalizedReconciliationTimestamp(value: unknown): string {
    if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) {
        throw new TypeError('durable notification transition timestamp is invalid');
    }
    return normalizeISO8601Timestamp(value);
}

export function nonNegativeCheckpoint(value: string | undefined): number | undefined {
    if (value === undefined || !/^\d+$/.test(value)) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function checkpointTuple(value: string | undefined, length: number): string[] | undefined {
    if (value === undefined) return undefined;
    try {
        const parsed: unknown = JSON.parse(value);
        return Array.isArray(parsed) && parsed.length === length
            && parsed.every((part) => typeof part === 'string')
            ? parsed
            : undefined;
    } catch {
        return undefined;
    }
}

export function logMalformedReconciliationTimestamp(
    source: string,
    identity: string | number,
    value: unknown,
    error: unknown
): void {
    logger.warn({
        source,
        identity,
        value: String(value).slice(0, 128),
        error: error instanceof Error ? error.message : String(error)
    }, 'Skipping malformed durable notification transition and advancing its checkpoint');
}

export function reconciliationPublicationTimestamp(
    now: string | number | Date,
    transitionAt: string
): string {
    const current = normalizeISO8601Timestamp(now);
    return current >= transitionAt ? current : transitionAt;
}
