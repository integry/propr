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
import { getStatus, calculateDelta, type AgentStatusResponse } from '../../../services/agentTankService.js';

const AGENT_TANK_URL = process.env.AGENT_TANK_URL || '';

/** Result returned by {@link executeWithUsageTracking}. */
export interface UsageTrackingResult<T> {
    /** The value returned by the wrapped LLM execution function. */
    result: T;
    /** Usage metrics captured around the call, or null if tracking was skipped. */
    usageMetrics: UsageTrackingMetrics | null;
}

/** Metrics captured by the usage tracking wrapper. */
export interface UsageTrackingMetrics {
    /** Agent Tank status snapshot taken before the LLM call. */
    preCall: AgentStatusResponse;
    /** Agent Tank status snapshot taken after the LLM call. */
    postCall: AgentStatusResponse;
    /** Computed numeric difference between post and pre usage values. */
    delta: Record<string, unknown>;
    /** ISO 8601 timestamp of when the metrics were captured. */
    timestamp: string;
    /** The agent name that was queried. */
    agent: string;
}

/**
 * Returns true when Agent Tank tracking is enabled.
 *
 * Tracking is disabled when AGENT_TANK_URL is unset, empty, or "false".
 */
export function isAgentTankEnabled(): boolean {
    const url = AGENT_TANK_URL;
    return url !== '' && url !== 'false' && url !== '0';
}

/**
 * Execute an LLM call wrapped with Agent Tank usage tracking.
 *
 * 1. Fetches the current Agent Tank status for the given agent (pre-call).
 * 2. Runs the provided `executeFn` (the actual LLM call).
 * 3. Fetches the Agent Tank status again (post-call).
 * 4. Computes the delta between pre and post usage.
 * 5. Returns both the execution result and the usage metrics.
 *
 * If Agent Tank is disabled or a status fetch fails, the LLM call still
 * proceeds — usage tracking is best-effort and never blocks execution.
 *
 * @param agent - The agent identifier to query (e.g. "claude", "gemini", "codex").
 * @param executeFn - An async function that performs the LLM call and returns its result.
 * @param timeoutMs - Optional timeout for each Agent Tank HTTP request (default: 5000ms).
 * @returns The execution result and usage metrics (metrics are null if tracking was skipped).
 */
export async function executeWithUsageTracking<T>(
    agent: string,
    executeFn: () => Promise<T>,
    timeoutMs?: number,
): Promise<UsageTrackingResult<T>> {
    if (!isAgentTankEnabled()) {
        logger.debug({ agent }, 'Agent Tank disabled — skipping usage tracking');
        const result = await executeFn();
        return { result, usageMetrics: null };
    }

    // Pre-call: fetch status (best-effort)
    let preCall: AgentStatusResponse | null = null;
    try {
        preCall = await getStatus(agent, timeoutMs);
        logger.debug({ agent, preCall: preCall.usage }, 'Agent Tank pre-call status');
    } catch (err: unknown) {
        logger.warn({ agent, err }, 'Failed to fetch Agent Tank pre-call status — proceeding without tracking');
    }

    // Execute the LLM call (always runs, even if pre-call failed)
    const result = await executeFn();

    // Post-call: fetch status (best-effort)
    if (preCall === null) {
        return { result, usageMetrics: null };
    }

    let postCall: AgentStatusResponse | null = null;
    try {
        postCall = await getStatus(agent, timeoutMs);
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

    const usageMetrics: UsageTrackingMetrics = {
        preCall,
        postCall,
        delta,
        timestamp: new Date().toISOString(),
        agent,
    };

    logger.info({ agent, delta }, 'Agent Tank usage delta computed');

    return { result, usageMetrics };
}
