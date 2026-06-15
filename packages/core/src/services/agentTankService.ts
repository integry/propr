import logger from '../utils/logger.js';
import { loadAgentTankSettings } from '../config/configManager.js';

// Refresh can take 15-20 seconds when CLI agent needs cold start
const DEFAULT_TIMEOUT_MS = 25000;

/**
 * Get the Agent Tank base URL from database settings.
 * Falls back to environment variable or default if settings unavailable.
 */
async function getAgentTankBaseUrl(): Promise<string> {
    try {
        const settings = await loadAgentTankSettings();
        return settings.url || process.env.AGENT_TANK_URL || 'http://0.0.0.0:3456';
    } catch {
        return process.env.AGENT_TANK_URL || 'http://0.0.0.0:3456';
    }
}

const AGENT_TANK_AGENT_ALIASES: Record<string, string> = {
    antigravity: 'agy',
};

const PROPR_AGENT_ALIASES: Record<string, string> = Object.fromEntries(
    Object.entries(AGENT_TANK_AGENT_ALIASES).map(([proprAgent, tankAgent]) => [tankAgent, proprAgent])
);

/**
 * Translate ProPR agent aliases to Agent Tank provider keys.
 *
 * ProPR exposes Google's agent as "antigravity", while Agent Tank tracks the
 * same provider under the CLI key "agy".
 */
export function toAgentTankAgent(agent: string): string {
    return AGENT_TANK_AGENT_ALIASES[agent] || agent;
}

/** Translate Agent Tank provider keys back to ProPR agent aliases. */
export function toProprAgent(agent: string): string {
    return PROPR_AGENT_ALIASES[agent] || agent;
}

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

/** Normalize a single Agent Tank status object to ProPR-facing agent names. */
export function normalizeAgentTankStatus(status: AgentStatusResponse): AgentStatusResponse {
    return { ...status, name: toProprAgent(status.name) };
}

/** Normalize a GET /status response map to ProPR-facing agent keys and names. */
export function normalizeAgentTankAgents(agents: Record<string, AgentStatusResponse>): Record<string, AgentStatusResponse> {
    return Object.fromEntries(
        Object.entries(agents).map(([agent, status]) => {
            const proprAgent = toProprAgent(agent);
            return [proprAgent, { ...status, name: toProprAgent(status.name || agent) }];
        })
    );
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
    const baseUrl = await getAgentTankBaseUrl();
    const tankAgent = toAgentTankAgent(agent);
    const url = `${baseUrl}/refresh/${encodeURIComponent(tankAgent)}`;
    logger.info({ url, agent, tankAgent }, 'Triggering Agent Tank refresh');

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
    const baseUrl = await getAgentTankBaseUrl();
    const tankAgent = toAgentTankAgent(agent);
    const url = `${baseUrl}/status/${encodeURIComponent(tankAgent)}`;
    logger.info({ url, agent, tankAgent }, 'Fetching Agent Tank status');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
            throw new Error(`Agent Tank returned HTTP ${response.status}: ${response.statusText}`);
        }
        const data = (await response.json()) as AgentStatusResponse;
        return normalizeAgentTankStatus(data);
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
        } else if (Array.isArray(postVal) && Array.isArray(preVal)) {
            // Handle arrays of model usage objects
            const arrayDelta = calculateArrayDelta(preVal, postVal);
            if (arrayDelta.length > 0) {
                result[key] = arrayDelta;
            }
        }
    }

    return result;
}

/**
 * Compute delta for arrays of model usage objects.
 * Matches items by 'model' property and computes percentUsed delta.
 */
function calculateArrayDelta(
    pre: unknown[],
    post: unknown[],
): Array<{ model: string; percentUsed: number }> {
    const result: Array<{ model: string; percentUsed: number }> = [];

    // Build a map of pre values by model name
    const preMap = new Map<string, number>();
    for (const item of pre) {
        if (item && typeof item === 'object') {
            const obj = item as Record<string, unknown>;
            if (typeof obj.model === 'string' && typeof obj.percentUsed === 'number') {
                preMap.set(obj.model, obj.percentUsed);
            }
        }
    }

    // Compute delta for each post item
    for (const item of post) {
        if (item && typeof item === 'object') {
            const obj = item as Record<string, unknown>;
            if (typeof obj.model === 'string' && typeof obj.percentUsed === 'number') {
                const prePercent = preMap.get(obj.model) ?? 0;
                const delta = obj.percentUsed - prePercent;
                if (delta !== 0) {
                    result.push({ model: obj.model, percentUsed: delta });
                }
            }
        }
    }

    return result;
}
