import { baseEgressAllowlist, DEFAULT_EGRESS_PORTS, parseEgressAllowEntry } from '../../network/egressAllowlist.js';
import type { AgentType } from '../types.js';
import type { AgentRunEgressRule, AgentRunNetworkPolicy, AgentRunNetworkRestriction, AgentRunSpec } from './types.js';

/** The open policy: the runtime's default outbound network. */
export const OPEN_AGENT_RUN_NETWORK_POLICY: AgentRunNetworkPolicy = Object.freeze({ mode: 'open', allow: [], privateAddressAllow: [] }) as AgentRunNetworkPolicy;

/**
 * Allowlist entries (`host`, `*.zone`, `host:port`, IP literals) as rules a
 * runtime can enforce. Entries for the same host and wildcard merge their
 * ports; an entry without a port allows {@link DEFAULT_EGRESS_PORTS}. Invalid
 * entries are dropped: configuration is validated before it reaches a run.
 */
export function agentRunEgressRules(entries: readonly string[]): AgentRunEgressRule[] {
    const rules = new Map<string, AgentRunEgressRule>();
    for (const entry of entries) {
        const parsed = parseEgressAllowEntry(entry);
        if (typeof parsed === 'string') continue;
        const key = `${parsed.wildcard ? '*.' : ''}${parsed.host}`;
        const rule = rules.get(key) ?? { host: parsed.host, wildcard: parsed.wildcard, ports: [] };
        for (const port of parsed.port !== undefined ? [parsed.port] : DEFAULT_EGRESS_PORTS) {
            if (!rule.ports.includes(port)) rule.ports.push(port);
        }
        rule.ports.sort((a, b) => a - b);
        rules.set(key, rule);
    }
    return [...rules.values()].sort((a, b) => (a.wildcard ? `*.${a.host}` : a.host).localeCompare(b.wildcard ? `*.${b.host}` : b.host));
}

/**
 * The runtime-neutral policy for a run of `agentType`: open without a
 * restriction; otherwise the same allowlist Docker's egress proxy compiles
 * (the agent's base hosts plus the policy's additions), with the instance's
 * own IP literals as the only private destinations.
 */
export function agentRunNetworkPolicy(agentType: AgentType, restriction?: AgentRunNetworkRestriction): AgentRunNetworkPolicy {
    if (!restriction) return OPEN_AGENT_RUN_NETWORK_POLICY;
    return {
        mode: 'restricted',
        allow: agentRunEgressRules([...baseEgressAllowlist(agentType), ...restriction.allow]),
        privateAddressAllow: agentRunEgressRules(restriction.instanceAllow ?? []),
        source: restriction.source,
    };
}

/** The spec with {@link AgentRunNetwork.policy} derived from its restriction (or open). */
export function withAgentRunNetworkPolicy(spec: AgentRunSpec): AgentRunSpec {
    return { ...spec, network: { ...spec.network, policy: agentRunNetworkPolicy(spec.profile.agentType, spec.network.restriction) } };
}
