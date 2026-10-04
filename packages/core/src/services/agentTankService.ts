import { getEventPublisher } from '../utils/eventPublisher.js';
import logger from '../utils/logger.js';
import { loadAgentTankSettings } from '../config/configManager.js';
import { observeAgentTankUsage } from './agentTankUsageEvents.js';
import {
    getBundledStatusForAlias,
    getBundledStatusesForDelta,
    refreshBundledStatuses,
    scheduleBundledRefresh,
} from './agentTankBundledRunner.js';
import {
    normalizeAgentTankAgents,
    normalizeAgentTankStatus,
    toAgentTankAgent,
    type AgentStatusResponse,
} from './agentTankTypes.js';

// The provider-key vocabulary and the status shape live in `agentTankTypes.ts`
// so the bundled runner can share them without importing this router back.
export {
    hasAgentTankStatuses,
    hasUsableAgentTankStatuses,
    isUsableAgentTankStatus,
    normalizeAgentTankAgents,
    normalizeAgentTankStatus,
    toAgentTankAgent,
    toProprAgent,
} from './agentTankTypes.js';
export type { AgentStatusResponse } from './agentTankTypes.js';

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

export {
    agentTankUsageFingerprint,
    observeAgentTankUsage,
    observeAgentTankUsageSnapshot,
    resetAgentTankUsageTracking,
    type UsageUpdatePublisher
} from './agentTankUsageEvents.js';

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
export async function refreshAgent(
    agent: string,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
    phase?: 'pre-call' | 'post-call',
): Promise<void> {
    const settings = await loadAgentTankSettings();
    if (settings.mode === 'disabled') return;
    if (settings.mode === 'bundled') {
        if (phase) {
            const statuses = await refreshBundledStatuses({ phase });
            if (!statuses) throw new Error('Bundled Agent Tank refresh failed or timed out');
        } else {
            scheduleBundledRefresh();
        }
        return;
    }
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
        await getEventPublisher().publishUsageUpdate();
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
export async function getStatus(
    agent: string,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
    // Account identity for bundled per-call probes; external endpoints remain provider-based.
    alias?: string,
): Promise<AgentStatusResponse> {
    const settings = await loadAgentTankSettings();
    if (settings.mode === 'disabled') {
        throw new Error('Agent Tank is disabled');
    }
    if (settings.mode === 'bundled') {
        // Cache-only: bounded by the delta freshness window so a stale snapshot
        // cannot be subtracted to produce a misleading per-call usage delta.
        // Per-call readers supply the executing alias. Provider-wide consumers
        // may still read the aggregate cache without claiming account identity.
        const status = alias !== undefined
            ? getBundledStatusForAlias(alias)
            : getBundledStatusesForDelta()?.[toAgentTankAgent(agent)];
        if (!status) {
            throw new Error(`No fresh bundled Agent Tank snapshot for ${agent}`);
        }
        return normalizeAgentTankStatus(status);
    }
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
        const normalized = normalizeAgentTankStatus(data);
        // Published here rather than on a timer: this is the only component that
        // reads the external service, so it is the only one that can tell a
        // changed snapshot from an unchanged poll.
        await observeAgentTankUsage(normalized);
        return normalized;
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
 * Fetch usage for one configured agent *alias*, for decisions that are specific
 * to that account rather than to the provider as a whole (synthetic-agent
 * capacity routing).
 *
 * Bundled mode inspects one account per provider, so its snapshot can only
 * answer for the alias whose credentials produced it; every other alias of the
 * same provider is reported as unavailable instead of being handed a stranger's
 * numbers. The answer is renamed to the requested alias, because the bundled
 * snapshot carries the provider key rather than the account's name. External
 * mode keeps the daemon's own per-name answer.
 *
 * @example
 *   const status = await getStatusForAlias('claude-secondary');
 */
export async function getStatusForAlias(
    alias: string,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<AgentStatusResponse> {
    const settings = await loadAgentTankSettings();
    if (settings.mode === 'disabled') {
        throw new Error('Agent Tank is disabled');
    }
    if (settings.mode === 'bundled') {
        const status = getBundledStatusForAlias(alias);
        if (!status) {
            throw new Error(`No fresh bundled Agent Tank snapshot for alias ${alias}`);
        }
        // The bundled snapshot is named after the provider key its generated id
        // was pinned to, never after the account it describes. Provenance has
        // just proven this snapshot came from `alias`'s credentials, so answer
        // under that name: alias-specific consumers match the response name
        // against the alias they asked for, and a custom alias would otherwise
        // be rejected as somebody else's data. The copy keeps the cached
        // snapshot untouched.
        return { ...normalizeAgentTankStatus(status), name: alias };
    }
    return getStatus(alias, timeoutMs);
}

/**
 * Transport-agnostic "give me every provider's usage" used by the sidebar and
 * the MCP usage tool. Returns `undefined` when tracking is disabled or no data
 * is available, so callers can hide the UI rather than render an error.
 */
export async function getAllStatuses(
    options: { refresh?: boolean } = {}
): Promise<Record<string, AgentStatusResponse> | undefined> {
    const settings = await loadAgentTankSettings();
    if (settings.mode === 'disabled') return undefined;
    if (settings.mode === 'bundled') {
        const agents = await refreshBundledStatuses({ force: options.refresh === true });
        return agents ? normalizeAgentTankAgents(agents) : undefined;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
        const response = await fetch(`${settings.url}/status`, { signal: controller.signal });
        if (!response.ok) return undefined;
        const data = await response.json() as Record<string, AgentStatusResponse>;
        return normalizeAgentTankAgents(data);
    } catch {
        return undefined;
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
