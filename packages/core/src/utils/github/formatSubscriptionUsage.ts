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
            const nested = value as Record<string, unknown>;
            let percentValue: number | null = null;

            if (typeof nested.percentLeft === 'number') {
                percentValue = -nested.percentLeft;
            } else if (typeof nested.percent === 'number') {
                percentValue = nested.percent;
            } else if (typeof nested.percentUsed === 'number') {
                percentValue = nested.percentUsed;
            }

            if (percentValue !== null && percentValue > 0) {
                records.push({ agent, metricKey: label, metricValue: percentValue });
            }
        }

        if (Array.isArray(value)) {
            for (const item of value) {
                if (item && typeof item === 'object') {
                    const entry = item as Record<string, unknown>;
                    const rawName = typeof entry.model === 'string' ? entry.model : key;
                    const itemLabel = humanizeKey(rawName);
                    const pv =
                        typeof entry.percentUsed === 'number' ? entry.percentUsed :
                        typeof entry.percent === 'number' ? entry.percent :
                        null;
                    if (pv !== null && pv > 0) {
                        records.push({ agent, metricKey: itemLabel, metricValue: pv });
                    }
                }
            }
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
