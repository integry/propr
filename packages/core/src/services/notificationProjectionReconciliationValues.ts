import { normalizeISO8601Timestamp } from '@propr/shared';

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
