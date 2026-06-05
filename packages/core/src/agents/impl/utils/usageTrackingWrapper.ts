/**
 * Wraps LLM execution with Agent Tank usage tracking.
 *
 * Fetches usage status from the local Agent Tank daemon before and after
 * the LLM call, computes the delta, and returns the combined metrics
 * alongside the execution result.
 *
 * If Agent Tank is disabled (AGENT_TANK_URL is empty or set to "false"),
 * the wrapper skips status fetching and runs the LLM call directly.
 *
 * @example
 *   // Pre-call status (GET /status/claude):
 *   // {
 *   //   "name": "claude",
 *   //   "usage": {
 *   //     "session": { "percent": 42, "resetsInSeconds": 764 },
 *   //     "weeklyAll": { "percent": 31, "resetsInSeconds": 364364 }
 *   //   },
 *   //   "lastUpdated": "2026-03-08T21:47:15.090Z"
 *   // }
 *   //
 *   // Post-call status:
 *   // {
 *   //   "name": "claude",
 *   //   "usage": {
 *   //     "session": { "percent": 58, "resetsInSeconds": 500 },
 *   //     "weeklyAll": { "percent": 35, "resetsInSeconds": 363000 }
 *   //   },
 *   //   "lastUpdated": "2026-03-08T21:50:22.000Z"
 *   // }
 *   //
 *   // Computed delta:
 *   // {
 *   //   "session": { "percent": 16, "resetsInSeconds": -264 },
 *   //   "weeklyAll": { "percent": 4, "resetsInSeconds": -1364 }
 *   // }
 *
 *   const { result, usageMetrics } = await executeWithUsageTracking(
 *     'claude',
 *     async () => runLlmCall(),
 *   );
 */

import logger from '../../../utils/logger.js';
import { refreshAgent, getStatus, calculateDelta, type AgentStatusResponse } from '../../../services/agentTankService.js';
import { loadAgentTankSettings } from '../../../config/configManager.js';

/** Result returned by {@link executeWithUsageTracking}. */
export interface UsageTrackingResult<T> {
    /** The value returned by the wrapped LLM execution function. */
    result: T;
    /** Usage metrics captured around the call, or null if tracking was skipped. */
    usageMetrics: UsageTrackingMetrics | null;
}

/**
 * A single structured usage metric record for DB storage.
 *
 * Each LLM call may produce multiple records — one per metric key
 * (e.g. "session", "weeklyAll", "weeklySonnet" for Claude).
 */
export interface UsageMetricRecord {
    /** The agent name (e.g. "claude", "antigravity", "codex"). */
    agent: string;
    /** The metric key (e.g. "session", "weeklyAll", "fiveHour"). */
    metricKey: string;
    /** The percentage-point delta consumed by this call. */
    metricValue: number;
}

/** Metrics captured by the usage tracking wrapper. */
export interface UsageTrackingMetrics {
    /** Agent Tank status snapshot taken before the LLM call. */
    preCall: AgentStatusResponse;
    /** Agent Tank status snapshot taken after the LLM call. */
    postCall: AgentStatusResponse;
    /** Computed numeric difference between post and pre usage values. */
    delta: Record<string, unknown>;
    /** Structured per-metric records for DB storage. */
    records: UsageMetricRecord[];
    /** ISO 8601 timestamp of when the metrics were captured. */
    timestamp: string;
    /** The agent name that was queried. */
    agent: string;
}

/**
 * Returns true when Agent Tank tracking is enabled.
 *
 * Checks the database settings for the Agent Tank configuration.
 * Tracking is disabled when enabled is false or url is empty/invalid.
 */
export async function isAgentTankEnabled(): Promise<boolean> {
    try {
        const settings = await loadAgentTankSettings();
        const enabled = settings.enabled && !!settings.url && settings.url !== 'false' && settings.url !== '0';
        logger.info({ enabled, settings }, 'Agent Tank enabled check');
        return enabled;
    } catch (err) {
        logger.warn({ error: (err as Error).message }, 'Failed to load Agent Tank settings, assuming disabled');
        return false;
    }
}

/**
 * Map of raw Agent Tank metric keys to human-readable labels.
 *
 * Keys not in this map are title-cased automatically
 * (e.g. "fiveHour" → "Five Hour").
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

/**
 * Convert a raw metric key to a human-readable label.
 *
 * Uses the lookup table first, then falls back to splitting camelCase
 * and title-casing each word (e.g. "someMetric" → "Some Metric").
 */
export function humanizeMetricKey(key: string): string {
    if (METRIC_KEY_LABELS[key]) return METRIC_KEY_LABELS[key];
    // Split camelCase and title-case each word
    return key
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/^./, c => c.toUpperCase());
}

/**
 * Extract structured metric records from an Agent Tank usage delta.
 *
 * Walks the delta object looking for "percent" values at the first or
 * second nesting level and produces one record per metric key.
 * Records with a 0% delta are excluded (nothing consumed).
 *
 * Examples of delta shapes handled:
 *   Claude:  { session: { percent: 16 }, weeklyAll: { percent: 4 } }
 *   Codex:   { fiveHour: { percentUsed: 3 }, weekly: { percentUsed: 1 } }
 *   Gemini:  { models: [...] } — array entries are mapped by model name
 */
export function extractMetricRecords(
    agent: string,
    delta: Record<string, unknown>,
): UsageMetricRecord[] {
    const records: UsageMetricRecord[] = [];

    for (const [key, value] of Object.entries(delta)) {
        if (value === null || value === undefined) continue;

        const label = humanizeMetricKey(key);

        // Direct numeric value (unlikely but handle it)
        // Only record positive values (actual consumption, not limit resets)
        if (typeof value === 'number') {
            if (value > 0) {
                records.push({ agent, metricKey: label, metricValue: value });
            }
            continue;
        }

        // Nested object — extract consumption metric
        // For percentLeft: negate the delta (decrease = positive consumption)
        // For percent/percentUsed: use directly (increase = positive consumption)
        if (typeof value === 'object' && !Array.isArray(value)) {
            const nested = value as Record<string, unknown>;
            let percentValue: number | null = null;

            if (typeof nested.percentLeft === 'number') {
                // percentLeft decreases when consuming, so negate the delta
                percentValue = -nested.percentLeft;
            } else if (typeof nested.percent === 'number') {
                percentValue = nested.percent;
            } else if (typeof nested.percentUsed === 'number') {
                percentValue = nested.percentUsed;
            }

            // Only record positive consumption
            if (percentValue !== null && percentValue > 0) {
                records.push({ agent, metricKey: label, metricValue: percentValue });
            }
        }

        // Array (Gemini models array)
        if (Array.isArray(value)) {
            extractArrayMetricRecords(agent, key, value, records);
        }
    }

    return records;
}

function extractArrayMetricRecords(
    agent: string,
    key: string,
    value: unknown[],
    records: UsageMetricRecord[],
): void {
    for (const item of value) {
        if (item && typeof item === 'object') {
            const entry = item as Record<string, unknown>;
            const rawName = typeof entry.model === 'string' ? entry.model : key;
            const label = humanizeMetricKey(rawName);
            const percentValue =
                typeof entry.percentUsed === 'number' ? entry.percentUsed :
                typeof entry.percent === 'number' ? entry.percent :
                null;
            // Only record positive values (actual consumption)
            if (percentValue !== null && percentValue > 0) {
                records.push({ agent, metricKey: label, metricValue: percentValue });
            }
        }
    }
}

/**
 * Refresh the agent and then fetch its current status.
 *
 * Always calls POST /refresh/:agent first to ensure Agent Tank has the
 * latest data, then calls GET /status/:agent to retrieve it.
 */
async function refreshAndGetStatus(
    agent: string,
    timeoutMs?: number,
): Promise<AgentStatusResponse> {
    await refreshAgent(agent, timeoutMs);
    return getStatus(agent, timeoutMs);
}

/**
 * Execute an LLM call wrapped with Agent Tank usage tracking.
 *
 * 1. Refreshes the agent and fetches status (pre-call).
 * 2. Runs the provided `executeFn` (the actual LLM call).
 * 3. Refreshes the agent again and fetches status (post-call).
 * 4. Computes the delta and extracts structured metric records.
 * 5. Returns both the execution result and the usage metrics.
 *
 * If Agent Tank is disabled or a status fetch fails, the LLM call still
 * proceeds — usage tracking is best-effort and never blocks execution.
 *
 * @param agent - The agent identifier to query (e.g. "claude", "antigravity", "codex").
 * @param executeFn - An async function that performs the LLM call and returns its result.
 * @param timeoutMs - Optional timeout for each Agent Tank HTTP request (default: 5000ms).
 * @returns The execution result and usage metrics (metrics are null if tracking was skipped).
 */
export async function executeWithUsageTracking<T>(
    agent: string,
    executeFn: () => Promise<T>,
    timeoutMs?: number,
): Promise<UsageTrackingResult<T>> {
    if (!(await isAgentTankEnabled())) {
        logger.debug({ agent }, 'Agent Tank disabled — skipping usage tracking');
        const result = await executeFn();
        return { result, usageMetrics: null };
    }

    // Pre-call: refresh agent and fetch status (best-effort)
    let preCall: AgentStatusResponse | null = null;
    try {
        preCall = await refreshAndGetStatus(agent, timeoutMs);
        logger.debug({ agent, preCall: preCall.usage }, 'Agent Tank pre-call status');
    } catch (err: unknown) {
        logger.warn({ agent, err }, 'Failed to fetch Agent Tank pre-call status — proceeding without tracking');
    }

    // Execute the LLM call (always runs, even if pre-call failed)
    const result = await executeFn();

    // Post-call: refresh agent and fetch status (best-effort)
    if (preCall === null) {
        return { result, usageMetrics: null };
    }

    let postCall: AgentStatusResponse | null = null;
    try {
        postCall = await refreshAndGetStatus(agent, timeoutMs);
        logger.debug({ agent, postCall: postCall.usage }, 'Agent Tank post-call status');
    } catch (err: unknown) {
        logger.warn({ agent, err }, 'Failed to fetch Agent Tank post-call status');
        return { result, usageMetrics: null };
    }

    // Compute delta
    const delta = calculateDelta(
        preCall.usage,
        postCall.usage,
    );

    // Extract structured metric records
    const records = extractMetricRecords(agent, delta);

    const usageMetrics: UsageTrackingMetrics = {
        preCall,
        postCall,
        delta,
        records,
        timestamp: new Date().toISOString(),
        agent,
    };

    logger.info({ agent, delta, records }, 'Agent Tank usage delta computed');

    return { result, usageMetrics };
}
