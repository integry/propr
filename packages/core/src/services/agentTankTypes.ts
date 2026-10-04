/**
 * Agent Tank vocabulary shared by both transports (HTTP and bundled).
 *
 * This lives apart from `agentTankService.ts` so the bundled runner can reuse
 * the provider-key mapping and the response shape without importing the
 * transport router that imports it back.
 */

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

/**
 * Whether a status map describes any provider at all.
 *
 * A run can succeed and still describe nothing: bundled mode returns an empty
 * map when no enabled agent is a provider Agent Tank can inspect, and a daemon
 * with nothing configured answers the same way. This only separates "nothing to
 * inspect" from "something was inspected" so callers can name that reason; it is
 * NOT a readiness answer - use `hasUsableAgentTankStatuses` for that.
 */
export function hasAgentTankStatuses(agents: Record<string, AgentStatusResponse> | undefined): boolean {
    return !!agents && Object.keys(agents).length > 0;
}

/**
 * Whether one provider status is evidence that usage monitoring actually works.
 *
 * A provider Agent Tank could not read is still reported as a status *object*
 * carrying the failure - `{"claude":{"usage":{},"error":"Timeout waiting for
 * usage data"}}` - so the presence of a key proves only that a provider key was
 * configured. A status with an error, or with no usage fields at all, cannot
 * produce a single number for the capacity gauge, so it is not usable evidence.
 */
export function isUsableAgentTankStatus(status: AgentStatusResponse | undefined): boolean {
    if (!status || status.error) return false;
    return !!status.usage && typeof status.usage === 'object' && Object.keys(status.usage).length > 0;
}

/**
 * Whether a status map is evidence that usage monitoring actually works.
 *
 * Readiness and a successful refresh promise a capacity gauge that can show a
 * number, so they ask for at least one provider whose usage actually came back:
 * an all-error snapshot refreshed nothing, however many keys it carries.
 */
export function hasUsableAgentTankStatuses(agents: Record<string, AgentStatusResponse> | undefined): boolean {
    return !!agents && Object.values(agents).some(isUsableAgentTankStatus);
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
