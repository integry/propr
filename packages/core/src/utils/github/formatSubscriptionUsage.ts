import { humanizeMetricKey } from '../../agents/impl/utils/usageTrackingWrapper.js';

/**
 * Shared formatter for Agent Tank subscription usage in GitHub comments.
 *
 * Converts usage metric records (or raw delta data) into a short,
 * GitHub-comment-friendly text line. Prefers `usage_metric_records`
 * when available because they are already normalized and human-readable
 * at the storage boundary. Falls back to `usage_metrics.delta` when
 * structured records are not present.
 *
 * Returns an empty string when all values are zero or missing so callers
 * can safely concatenate without rendering empty lines.
 */

/** Minimal record shape accepted by the formatter. */
export interface SubscriptionUsageRecord {
    agent: string;
    metricKey: string;
    metricValue: number;
}

/** Shape of the usage metrics object carried on result objects. */
export interface SubscriptionUsageMetrics {
    delta?: Record<string, unknown>;
    records?: SubscriptionUsageRecord[];
    agent?: string;
}

function humanizeKey(key: string): string {
    return humanizeMetricKey(key)
        .replace(/[-_]/g, ' ')
        .replace(/(\d) (\d)/g, '$1.$2');
}

function clampPercent(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.min(100, Math.max(0, value));
}

function extractPercentFromDeltaObject(obj: Record<string, unknown>): number | null {
    if (typeof obj.percentLeft === 'number') return clampPercent(-obj.percentLeft);
    if (typeof obj.percent === 'number') return clampPercent(obj.percent);
    if (typeof obj.percentUsed === 'number') return clampPercent(obj.percentUsed);
    return null;
}

function extractRecordsFromArray(
    agent: string,
    key: string,
    items: unknown[],
): SubscriptionUsageRecord[] {
    const records: SubscriptionUsageRecord[] = [];
    for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const entry = item as Record<string, unknown>;
        const percentValue = extractPercentFromDeltaObject(entry);
        if (percentValue !== null && percentValue > 0) {
            records.push({
                agent,
                metricKey: humanizeKey(key),
                metricValue: percentValue,
            });
        }
    }
    return records;
}

function aggregateRecords(records: SubscriptionUsageRecord[]): SubscriptionUsageRecord[] {
    const aggregated = new Map<string, number>();

    for (const record of records) {
        const metricKey = humanizeKey(record.metricKey);
        const metricValue = clampPercent(record.metricValue);
        if (metricValue <= 0) continue;
        aggregated.set(metricKey, clampPercent((aggregated.get(metricKey) ?? 0) + metricValue));
    }

    return Array.from(aggregated.entries(), ([metricKey, metricValue]) => ({
        agent: 'aggregated',
        metricKey,
        metricValue,
    }));
}

/**
 * Extract metric records from a raw Agent Tank delta object.
 * Lightweight version that handles the common shapes without importing
 * the full usage tracking wrapper.
 */
function extractRecordsFromDelta(
    agent: string,
    delta: Record<string, unknown>,
): SubscriptionUsageRecord[] {
    const records: SubscriptionUsageRecord[] = [];

    for (const [key, value] of Object.entries(delta)) {
        if (value === null || value === undefined) continue;

        const label = humanizeKey(key);

        if (typeof value === 'number') {
            if (value > 0) records.push({ agent, metricKey: label, metricValue: value });
            continue;
        }

        if (typeof value === 'object' && !Array.isArray(value)) {
            const percentValue = extractPercentFromDeltaObject(value as Record<string, unknown>);
            if (percentValue !== null && percentValue > 0) {
                records.push({ agent, metricKey: label, metricValue: percentValue });
            }
        }

        if (Array.isArray(value)) {
            records.push(...extractRecordsFromArray(agent, key, value));
        }
    }

    return records;
}

/**
 * Normalize a possibly snake_case payload into the camelCase shape
 * the formatter expects. This handles older or partially migrated
 * callers that pass through the storage-shaped `usage_metrics` /
 * `usage_metric_records` directly.
 */
function normalizeMetrics(
    raw: Record<string, unknown>,
): SubscriptionUsageMetrics {
    const normalized: SubscriptionUsageMetrics = {};

    // records / usage_metric_records
    const records = raw.records ?? raw.usage_metric_records;
    if (Array.isArray(records)) {
        normalized.records = records as SubscriptionUsageRecord[];
    }

    // delta / usage_metrics.delta
    // Only use the nested delta object so sibling metadata fields inside
    // usage_metrics are never interpreted as usage metrics.
    let delta = raw.delta;
    if (!delta || typeof delta !== 'object' || Array.isArray(delta)) {
        const usageMetrics = raw.usage_metrics;
        if (usageMetrics && typeof usageMetrics === 'object' && !Array.isArray(usageMetrics)) {
            const nestedDelta = (usageMetrics as Record<string, unknown>).delta;
            if (nestedDelta && typeof nestedDelta === 'object' && !Array.isArray(nestedDelta)) {
                delta = nestedDelta;
            }
        }
    }
    if (delta && typeof delta === 'object' && !Array.isArray(delta)) {
        normalized.delta = delta as Record<string, unknown>;
    }

    // agent
    if (typeof raw.agent === 'string') {
        normalized.agent = raw.agent;
    }

    return normalized;
}

/**
 * Format subscription usage data into a single GitHub-comment line.
 *
 * @param usageMetrics - The usage tracking metrics from a result object.
 *   May be null/undefined when Agent Tank tracking was not active.
 *   Accepts both camelCase (`records`, `delta`) and snake_case
 *   (`usage_metric_records`, `usage_metrics`) field names.
 * @returns A formatted string like `Session +16%, Weekly +4%`
 *   or an empty string when there is nothing to display.
 *   Returns only the content - callers are responsible for rendering
 *   their own bullet style or prefix.
 */
export function formatSubscriptionUsage(
    usageMetrics: SubscriptionUsageMetrics | Record<string, unknown> | null | undefined,
): string {
    if (!usageMetrics) return '';

    const metrics = normalizeMetrics(usageMetrics as Record<string, unknown>);

    let records = metrics.records;
    if ((!records || records.length === 0) && metrics.delta) {
        const agent = metrics.agent || 'unknown';
        records = extractRecordsFromDelta(agent, metrics.delta);
    }

    if (!records || records.length === 0) return '';

    const meaningful = aggregateRecords(records);
    if (meaningful.length === 0) return '';

    const parts = meaningful.map(r => {
        const value = Number.isInteger(r.metricValue)
            ? r.metricValue.toString()
            : r.metricValue.toFixed(1);
        return `${r.metricKey} +${value}%`;
    });

    return parts.join(', ');
}
