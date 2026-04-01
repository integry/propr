import logger from '../utils/logger.js';

const AGENT_TANK_BASE_URL = process.env.AGENT_TANK_URL || 'http://0.0.0.0:3456';
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Response shape from GET /status/:agent
 *
 * Example call:
 *   const status = await getStatus('claude');
 *   // GET http://0.0.0.0:3456/status/claude
 *   // => { "name": "claude", "usage": { "session": { "percent": 42, ... }, ... }, ... }
 */
export interface AgentStatusResponse {
    name: string;
    usage: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    lastUpdated?: string;
    error?: string | null;
    isRefreshing?: boolean;
}

/**
 * Trigger a refresh for the given agent on Agent Tank.
 *
 * Calls POST /refresh/:agent to ensure the daemon fetches the latest
 * usage data before we query it. This is required because Agent Tank
 * caches usage snapshots and may return stale data otherwise.
 *
 * @example
 *   await refreshAgent('claude');
 *   const status = await getStatus('claude');
 */
export async function refreshAgent(agent: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<void> {
    const url = `${AGENT_TANK_BASE_URL}/refresh/${encodeURIComponent(agent)}`;
    logger.info({ url, agent }, 'Triggering Agent Tank refresh');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, { method: 'POST', signal: controller.signal });
        if (!response.ok) {
            throw new Error(`Agent Tank refresh returned HTTP ${response.status}: ${response.statusText}`);
        }
    } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') {
            throw new Error(`Agent Tank refresh timed out after ${timeoutMs}ms`);
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Fetch the current status for the given agent from Agent Tank.
 *
 * @example
 *   await refreshAgent('claude');
 *   const status = await getStatus('claude');
 */
export async function getStatus(agent: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<AgentStatusResponse> {
    const url = `${AGENT_TANK_BASE_URL}/status/${encodeURIComponent(agent)}`;
    logger.info({ url, agent }, 'Fetching Agent Tank status');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
            throw new Error(`Agent Tank returned HTTP ${response.status}: ${response.statusText}`);
        }
        const data = (await response.json()) as AgentStatusResponse;
        return data;
    } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') {
            throw new Error(`Agent Tank request timed out after ${timeoutMs}ms`);
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Recursively compute the numeric delta between two nested usage objects.
 *
 * For every key whose value is a number in both `pre` and `post`, the result
 * contains `post[key] - pre[key]`. Nested objects are traversed recursively.
 * Non-numeric and missing keys are omitted from the result.
 *
 * @example
 *   const pre  = { session: { percent: 42 }, weeklyAll: { percent: 31 } };
 *   const post = { session: { percent: 58 }, weeklyAll: { percent: 35 } };
 *   calculateDelta(pre, post);
 *   // => { session: { percent: 16 }, weeklyAll: { percent: 4 } }
 */
export function calculateDelta(
    pre: Record<string, unknown>,
    post: Record<string, unknown>,
): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const key of Object.keys(post)) {
        const preVal = pre[key];
        const postVal = post[key];

        if (typeof postVal === 'number' && typeof preVal === 'number') {
            result[key] = postVal - preVal;
        } else if (
            postVal !== null &&
            preVal !== null &&
            typeof postVal === 'object' &&
            typeof preVal === 'object' &&
            !Array.isArray(postVal) &&
            !Array.isArray(preVal)
        ) {
            const nested = calculateDelta(
                preVal as Record<string, unknown>,
                postVal as Record<string, unknown>,
            );
            if (Object.keys(nested).length > 0) {
                result[key] = nested;
            }
        }
    }

    return result;
}
