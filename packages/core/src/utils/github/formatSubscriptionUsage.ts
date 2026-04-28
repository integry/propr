/**
 * Shared formatter for Agent Tank subscription usage in GitHub comments.
 *
 * Converts usage metric records (or raw delta data) into a short,
 * GitHub-comment-friendly text line.  Prefers `usage_metric_records`
 * when available because they are already normalized and human-readable
 * at the storage boundary.  Falls back to `usage_metrics.delta` when
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

/**
 * Map of raw Agent Tank metric keys to human-readable labels.
 * Mirrors the canonical map in usageTrackingWrapper to stay self-contained.
 */
const METRIC_KEY_LABELS: Record<string, string> = {
    session: 'Session',
    weeklyAll: 'Weekly',
    weeklySonnet: 'Sonnet',
    weeklyOpus: 'Opus',
    weeklyHaiku: 'Haiku',
    fiveHour: 'Five Hour',
    weekly: 'Weekly',
    daily: 'Daily',
    monthly: 'Monthly',
};

function humanizeKey(key: string): string {
    if (METRIC_KEY_LABELS[key]) return METRIC_KEY_LABELS[key];
    return key
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/^./, c => c.toUpperCase());
}

function extractPercentFromObject(obj: Record<string, unknown>): number | null {
    if (typeof obj.percentLeft === 'number') return -obj.percentLeft;
    if (typeof obj.percent === 'number') return obj.percent;
    if (typeof obj.percentUsed === 'number') return obj.percentUsed;
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
        const rawName = typeof entry.model === 'string' ? entry.model : key;
        const pv = extractPercentFromObject(entry);
        if (pv !== null && pv > 0) {
            records.push({ agent, metricKey: humanizeKey(rawName), metricValue: pv });
        }
    }
    return records;
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
            const percentValue = extractPercentFromObject(value as Record<string, unknown>);
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
 * Format subscription usage data into a single GitHub-comment line.
 *
 * @param usageMetrics - The usage tracking metrics from a result object.
 *   May be null/undefined when Agent Tank tracking was not active.
 * @returns A formatted string like `- Subscription usage: Session +16%, Weekly +4%`
 *   or an empty string when there is nothing to display.
 */
export function formatSubscriptionUsage(
    usageMetrics: SubscriptionUsageMetrics | null | undefined,
): string {
    if (!usageMetrics) return '';

    // Prefer structured records when available
    let records = usageMetrics.records;

    // Fall back to extracting from delta
    if ((!records || records.length === 0) && usageMetrics.delta) {
        const agent = usageMetrics.agent || 'unknown';
        records = extractRecordsFromDelta(agent, usageMetrics.delta);
    }

    if (!records || records.length === 0) return '';

    // Filter out zero or negative values
    const meaningful = records.filter(r => r.metricValue > 0);
    if (meaningful.length === 0) return '';

    // Build compact representation: "Session +16%, Weekly +4%"
    const parts = meaningful.map(r => {
        const value = Number.isInteger(r.metricValue)
            ? r.metricValue.toString()
            : r.metricValue.toFixed(1);
        return `${r.metricKey} +${value}%`;
    });

    return `- Subscription usage: ${parts.join(', ')}\n`;
}
