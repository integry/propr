import logger from '../utils/logger.js';
import { validateEgressAllowlist } from './egressAllowlist.js';

export type AgentNetworkMode = 'open' | 'restricted';
export const AGENT_NETWORK_MODES: readonly AgentNetworkMode[] = ['open', 'restricted'];

/** Instance policy: Settings values, with environment variables as their defaults. */
export interface InstanceNetworkPolicy {
    mode: AgentNetworkMode;
    /** With `restricted`, repositories cannot choose `open`. */
    enforced: boolean;
    /** Hosts every restricted run may reach, in addition to the built-in base list. */
    allow: string[];
    /** With enforced restricted mode, a repository's `network.allow` adds nothing. */
    ignoreRepositoryAllow: boolean;
}

/** The `network` block of `.propr/workflow.yml`. */
export interface RepositoryNetworkConfig {
    mode?: AgentNetworkMode;
    allow?: string[];
}

export interface ResolvedNetworkPolicy {
    mode: AgentNetworkMode;
    /** Where the mode came from. */
    source: 'instance' | 'workflow' | 'instance_enforced';
    /** Instance and repository additions; each container adds its agent's base list. */
    allow: string[];
    /**
     * The instance's own entries. Only their IP literals open a non-public
     * address (loopback, private, link-local): a repository cannot give its
     * containers the worker's network position.
     */
    instanceAllow?: string[];
    /** Set when instance enforcement overrode the repository's requested mode or hosts. */
    note?: string;
}

export const AGENT_NETWORK_SETTING_KEYS = ['agent_network_mode', 'agent_network_mode_enforced', 'agent_network_allow', 'agent_network_ignore_repository_allow'] as const;
export type AgentNetworkSettingKey = typeof AGENT_NETWORK_SETTING_KEYS[number];

export function parseAgentNetworkMode(value: unknown): AgentNetworkMode | null {
    return typeof value === 'string' && (AGENT_NETWORK_MODES as readonly string[]).includes(value.trim().toLowerCase())
        ? value.trim().toLowerCase() as AgentNetworkMode
        : null;
}

function parseBoolean(value: unknown): boolean | null {
    if (typeof value === 'boolean') return value;
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off', ''].includes(normalized)) return false;
    return null;
}

function parseAllowList(value: unknown): string[] | null {
    const list = typeof value === 'string' ? value.split(/[\s,]+/).filter(Boolean) : value;
    if (validateEgressAllowlist(list, 'agent_network_allow')) return null;
    return [...new Set((list as string[]).map(entry => entry.trim().toLowerCase()))];
}

/** `AGENT_NETWORK_MODE`, `AGENT_NETWORK_MODE_ENFORCED`, `AGENT_NETWORK_ALLOW` (comma separated), `AGENT_NETWORK_IGNORE_REPOSITORY_ALLOW`. */
export function resolveInstanceNetworkPolicyEnvDefault(env: NodeJS.ProcessEnv = process.env): InstanceNetworkPolicy {
    const policy: InstanceNetworkPolicy = { mode: 'open', enforced: false, allow: [], ignoreRepositoryAllow: false };
    if (env.AGENT_NETWORK_MODE?.trim()) {
        const mode = parseAgentNetworkMode(env.AGENT_NETWORK_MODE);
        if (mode) policy.mode = mode;
        else logger.warn({ value: env.AGENT_NETWORK_MODE }, 'Invalid AGENT_NETWORK_MODE, using open');
    }
    if (env.AGENT_NETWORK_MODE_ENFORCED !== undefined) {
        const enforced = parseBoolean(env.AGENT_NETWORK_MODE_ENFORCED);
        if (enforced !== null) policy.enforced = enforced;
        else logger.warn({ value: env.AGENT_NETWORK_MODE_ENFORCED }, 'Invalid AGENT_NETWORK_MODE_ENFORCED, using false');
    }
    if (env.AGENT_NETWORK_ALLOW?.trim()) {
        const allow = parseAllowList(env.AGENT_NETWORK_ALLOW);
        if (allow) policy.allow = allow;
        else logger.warn({ value: env.AGENT_NETWORK_ALLOW }, 'Invalid AGENT_NETWORK_ALLOW, ignoring it');
    }
    if (env.AGENT_NETWORK_IGNORE_REPOSITORY_ALLOW !== undefined) {
        const ignore = parseBoolean(env.AGENT_NETWORK_IGNORE_REPOSITORY_ALLOW);
        if (ignore !== null) policy.ignoreRepositoryAllow = ignore;
        else logger.warn({ value: env.AGENT_NETWORK_IGNORE_REPOSITORY_ALLOW }, 'Invalid AGENT_NETWORK_IGNORE_REPOSITORY_ALLOW, using false');
    }
    return policy;
}

/**
 * Stored settings override the environment defaults; `null` (or no row) means
 * "use the environment". An invalid stored value falls back to the default.
 */
export function resolveInstanceNetworkPolicy(
    stored: Partial<Record<AgentNetworkSettingKey, unknown>>,
    env: NodeJS.ProcessEnv = process.env,
): InstanceNetworkPolicy {
    const policy = resolveInstanceNetworkPolicyEnvDefault(env);
    const read = <T>(key: AgentNetworkSettingKey, parse: (value: unknown) => T | null, apply: (value: T) => void): void => {
        const value = stored[key];
        if (value === undefined || value === null) return;
        const parsed = parse(value);
        if (parsed === null) logger.warn({ setting: key, stored_value: value }, 'Invalid agent network setting in DB, using default');
        else apply(parsed);
    };
    read('agent_network_mode', parseAgentNetworkMode, mode => { policy.mode = mode; });
    read('agent_network_mode_enforced', parseBoolean, enforced => { policy.enforced = enforced; });
    read('agent_network_allow', parseAllowList, allow => { policy.allow = allow; });
    read('agent_network_ignore_repository_allow', parseBoolean, ignore => { policy.ignoreRepositoryAllow = ignore; });
    return policy;
}

/** Validates a stored-setting write; returns an error message when invalid. */
export function validateAgentNetworkSetting(key: AgentNetworkSettingKey, value: unknown): string | undefined {
    if (value === null) return undefined;
    if (key === 'agent_network_mode') return parseAgentNetworkMode(value) ? undefined : 'agent_network_mode must be "open" or "restricted"';
    if (key === 'agent_network_mode_enforced' || key === 'agent_network_ignore_repository_allow') return typeof value === 'boolean' ? undefined : `${key} must be a boolean`;
    return validateEgressAllowlist(value, 'agent_network_allow');
}

/**
 * The repository file may tighten the instance mode (choose `restricted`) and
 * may relax a non-enforced instance `restricted` default, but cannot choose
 * `open` when the instance enforces `restricted`. Repository `allow` entries
 * add hosts in either case (restricted runs still need their build
 * registries), unless an enforcing instance also ignores repository hosts.
 */
export function resolveNetworkPolicy(instance: InstanceNetworkPolicy, repository?: RepositoryNetworkConfig): ResolvedNetworkPolicy {
    const enforced = instance.mode === 'restricted' && instance.enforced;
    const repositoryAllow = (repository?.allow ?? []).map(entry => entry.trim().toLowerCase());
    const ignoredAllow = enforced && instance.ignoreRepositoryAllow && repositoryAllow.some(entry => !instance.allow.includes(entry));
    const allow = [...new Set([...instance.allow, ...(enforced && instance.ignoreRepositoryAllow ? [] : repositoryAllow)])];
    const base = { allow, instanceAllow: [...instance.allow] };
    const requested = repository?.mode;
    if (enforced) {
        const notes = [
            ...(requested === 'open' ? ['.propr/workflow.yml requested network.mode: open, but this instance enforces restricted networking'] : []),
            ...(ignoredAllow ? ['.propr/workflow.yml network.allow was ignored: this instance enforces restricted networking with its own allowlist only'] : []),
        ];
        return { mode: 'restricted', source: 'instance_enforced', ...base, ...(notes.length ? { note: notes.join('; ') } : {}) };
    }
    if (requested) return { mode: requested, source: 'workflow', ...base };
    return { mode: instance.mode, source: 'instance', ...base };
}
