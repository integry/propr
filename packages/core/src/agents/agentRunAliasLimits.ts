/** Optional per-agent ceilings for physical agent-run admission.
 *
 * `PROPR_AGENT_RUN_ALIAS_LIMITS` maps a direct agent alias to the most
 * simultaneous admitted executions that alias may hold, e.g.
 * `local-llama=1,claude-prod=3`. These are ceilings inside the global limit,
 * never reserved shares: every admitted launch still needs a global slot.
 * They are not part of the fenced admission identity; each acquire passes the
 * caller's current value. */
export const AGENT_RUN_ALIAS_LIMITS_ENV = 'PROPR_AGENT_RUN_ALIAS_LIMITS';

export type AgentRunAliasLimits = Readonly<Record<string, number>>;

/** Direct agent aliases are validated by the config API with this pattern. */
const ALIAS = /^[a-z0-9-]+$/;

export class AgentRunAliasLimitsError extends Error {
    constructor(message: string) {
        super(`Invalid ${AGENT_RUN_ALIAS_LIMITS_ENV}: ${message}`);
        this.name = 'AgentRunAliasLimitsError';
    }
}

/** Parses the policy. An unset or blank value means no per-alias policy.
 * Rules: comma-separated `alias=N` entries; each alias at most once; N is a
 * positive integer no greater than the global limit (a larger ceiling could
 * never bind, so it is reported as a mistake rather than accepted). */
export function parseAgentRunAliasLimits(raw: string | undefined, globalLimit: number | null): AgentRunAliasLimits | undefined {
    if (raw === undefined || !raw.trim()) return undefined;
    if (globalLimit === null) {
        throw new AgentRunAliasLimitsError('per-agent ceilings require agent-run admission; set PROPR_AGENT_RUN_LIMIT and PROPR_INSTANCE_ID (Hosted: the Fleet entitlement), or unset this variable');
    }
    // A Map, so an alias that names an Object.prototype member (`constructor`) is just an alias.
    const limits = new Map<string, number>();
    for (const entry of raw.split(',')) {
        const separator = entry.indexOf('=');
        const alias = separator < 0 ? entry.trim() : entry.slice(0, separator).trim();
        const value = separator < 0 ? '' : entry.slice(separator + 1).trim();
        if (separator < 0 || !ALIAS.test(alias) || !/^[0-9]+$/.test(value)) {
            throw new AgentRunAliasLimitsError(`expected comma-separated alias=N entries with lowercase alias letters, digits and hyphens; got '${entry.trim()}'`);
        }
        const limit = Number(value);
        if (!Number.isSafeInteger(limit) || limit < 1) throw new AgentRunAliasLimitsError(`ceiling for '${alias}' must be a positive integer`);
        if (limit > globalLimit) throw new AgentRunAliasLimitsError(`ceiling ${limit} for '${alias}' exceeds the global agent-run limit ${globalLimit}; a ceiling can only lower an agent's share`);
        if (limits.has(alias)) throw new AgentRunAliasLimitsError(`alias '${alias}' is listed more than once`);
        limits.set(alias, limit);
    }
    return Object.freeze(Object.fromEntries(limits));
}

/** The ceiling configured for `alias`. Reads only listed entries: a direct
 * agent named `constructor` without a ceiling must not resolve to the
 * inherited `Object.prototype.constructor`. */
export function agentRunAliasCeiling(limits: AgentRunAliasLimits | undefined, alias: string): number | undefined {
    return alias && limits && Object.hasOwn(limits, alias) ? limits[alias] : undefined;
}

/** The implicit agent registered when no direct agent is configured. */
export const IMPLICIT_DEFAULT_AGENT_ALIAS = 'default';

export interface AgentRunAliasInventory {
    /** Every configured direct agent alias, enabled or not. */
    directAliases: readonly string[];
    syntheticAliases: readonly string[];
}

/** Configuration problems that would leave a policy entry without effect. */
export function agentRunAliasLimitProblems(limits: AgentRunAliasLimits | undefined, inventory: AgentRunAliasInventory): string[] {
    if (!limits) return [];
    const direct = new Set(inventory.directAliases);
    const synthetic = new Set(inventory.syntheticAliases);
    // With no configured direct agent, the registry runs the implicit default agent.
    if (direct.size === 0) direct.add(IMPLICIT_DEFAULT_AGENT_ALIAS);
    const problems: string[] = [];
    for (const alias of Object.keys(limits)) {
        if (synthetic.has(alias) && !direct.has(alias)) {
            problems.push(`'${alias}' is a synthetic agent; set the ceiling on the direct agent it routes to, which is charged for every run`);
        } else if (!direct.has(alias)) {
            problems.push(`'${alias}' is not a configured direct agent`);
        }
    }
    return problems;
}
