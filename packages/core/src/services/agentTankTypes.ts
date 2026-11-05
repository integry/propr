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
    /**
     * Agent Tank 0.10+ canonical fields, carried next to the legacy `usage`
     * payload (which 0.10 keeps under `raw`). Absent against a 0.9.x daemon.
     */
    windows?: AgentTankUsageWindow[];
    plan?: string | null;
}

/** One rate-limit window in Agent Tank 0.10's canonical provider shape. */
export interface AgentTankUsageWindow {
    /** `session`, `five_hour` or `weekly` upstream; kept open for new cycles. */
    type: string;
    label: string;
    /** Model or model group the window is specific to; null for all models. */
    model: string | null;
    used_percent: number | null;
    remaining_percent: number | null;
    resets_at: string | null;
    resets_in_seconds: number | null;
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
    if (status.windows?.some(window => typeof window.used_percent === 'number')) return true;
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function finiteOrNull(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

function parseWindows(value: unknown): AgentTankUsageWindow[] {
    if (!Array.isArray(value)) return [];
    return value.filter(isRecord).map(window => ({
        type: typeof window.type === 'string' ? window.type : 'session',
        label: typeof window.label === 'string' ? window.label : '',
        model: stringOrNull(window.model),
        used_percent: finiteOrNull(window.used_percent),
        remaining_percent: finiteOrNull(window.remaining_percent),
        resets_at: stringOrNull(window.resets_at),
        resets_in_seconds: finiteOrNull(window.resets_in_seconds),
    }));
}

/** Whether one status object is in Agent Tank 0.10's canonical provider shape. */
export function isCanonicalAgentTankProvider(value: unknown): value is Record<string, unknown> {
    return isRecord(value) && Array.isArray(value.windows) && ('raw' in value || 'provider' in value);
}

/** A 0.9.x per-provider payload, as `raw` in 0.10 or the whole object before. */
function parseLegacyStatus(value: Record<string, unknown>, fallbackName: string): AgentStatusResponse {
    const status: AgentStatusResponse = {
        name: typeof value.name === 'string' && value.name ? value.name : fallbackName,
        usage: isRecord(value.usage) ? value.usage : {},
        error: typeof value.error === 'string' && value.error ? value.error : null,
    };
    if (isRecord(value.metadata)) status.metadata = value.metadata;
    if (typeof value.lastUpdated === 'string') status.lastUpdated = value.lastUpdated;
    if (value.isRefreshing === true) status.isRefreshing = true;
    return status;
}

/**
 * Read one provider status in either Agent Tank response generation.
 *
 * 0.10 moved every provider onto one canonical object (`id`, `windows`, ...)
 * and kept the 0.9.x payload, untouched, under `raw`. Every ProPR consumer -
 * the sidebar, per-call deltas, synthetic routing - reads that legacy `usage`
 * shape, so it stays the primary field and the canonical windows ride along.
 * A daemon that has not been upgraded keeps answering in the old shape, which
 * passes through unchanged.
 */
export function parseAgentTankStatus(value: unknown, fallbackName = ''): AgentStatusResponse | undefined {
    if (!isRecord(value)) return undefined;
    if (!isCanonicalAgentTankProvider(value)) return parseLegacyStatus(value, fallbackName);
    const id = typeof value.id === 'string' && value.id ? value.id : fallbackName;
    const status = parseLegacyStatus(isRecord(value.raw) ? value.raw : {}, id || stringOrNull(value.provider) || '');
    // The canonical object is the newer, authoritative view of freshness and failure.
    if (typeof value.last_updated === 'string') status.lastUpdated = value.last_updated;
    if (typeof value.error === 'string' && value.error) status.error = value.error;
    if (value.status === 'refreshing') status.isRefreshing = true;
    status.windows = parseWindows(value.windows);
    status.plan = stringOrNull(value.plan);
    return status;
}

/**
 * Read a `GET /status` (or `--once --json`) document in either generation:
 * 0.10's `{ providers: [...] }`, the 0.9.x map keyed by agent id, or an
 * `{ agents: {...} }` wrapper around that map.
 */
export function parseAgentTankStatusMap(value: unknown): Record<string, AgentStatusResponse> {
    if (!isRecord(value)) return {};
    const agents: Record<string, AgentStatusResponse> = {};
    if (Array.isArray(value.providers)) {
        for (const provider of value.providers) {
            if (!isRecord(provider)) continue;
            const key = stringOrNull(provider.id) || stringOrNull(provider.provider);
            if (!key) continue;
            const status = parseAgentTankStatus(provider, key);
            if (status) agents[key] = status;
        }
        return agents;
    }
    const source = isRecord(value.agents) ? value.agents : value;
    for (const [key, entry] of Object.entries(source)) {
        const status = parseAgentTankStatus(entry, key);
        if (status) agents[key] = status;
    }
    return agents;
}
