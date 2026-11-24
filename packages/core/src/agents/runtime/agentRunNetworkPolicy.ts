import { isIP } from 'node:net';
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

const isIpLiteralRule = (rule: AgentRunEgressRule): boolean => !rule.wildcard && isIP(rule.host) !== 0;

/**
 * The instance allowlist entries that may reach private, loopback or
 * link-local addresses: exact IP literals only. Hostname and wildcard entries
 * stay public-only, matching Docker's proxy, which checks this list against
 * the resolved address, so a hostname's private resolution is never
 * authorized unless its IP literal is listed too.
 */
export function agentRunPrivateAddressRules(instanceAllow: readonly string[]): AgentRunEgressRule[] {
    return agentRunEgressRules(instanceAllow).filter(isIpLiteralRule);
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
        privateAddressAllow: agentRunPrivateAddressRules(restriction.instanceAllow ?? []),
        source: restriction.source,
    };
}

const ruleKey = (rule: AgentRunEgressRule): string => `${rule.wildcard ? '*.' : ''}${rule.host}:${[...new Set(rule.ports)].sort((a, b) => a - b).join(',')}`;
const ruleKeys = (rules: readonly AgentRunEgressRule[]): string => JSON.stringify([...new Set(rules.map(ruleKey))].sort());

/** The same neutral policy, whatever the order of its rules and ports. */
export function sameAgentRunNetworkPolicy(a: AgentRunNetworkPolicy, b: AgentRunNetworkPolicy): boolean {
    return a.mode === b.mode && (a.source ?? null) === (b.source ?? null)
        && ruleKeys(a.allow) === ruleKeys(b.allow) && ruleKeys(a.privateAddressAllow) === ruleKeys(b.privateAddressAllow);
}

function isEgressRule(rule: unknown): rule is AgentRunEgressRule {
    if (!rule || typeof rule !== 'object') return false;
    const { host, wildcard, ports } = rule as Partial<AgentRunEgressRule>;
    return typeof host === 'string' && host.trim() !== '' && typeof wildcard === 'boolean' && Array.isArray(ports)
        && ports.length > 0 && ports.every(port => Number.isInteger(port) && port > 0 && port <= 65535);
}

/**
 * Whether `policy` is a well-formed restricted policy a runtime can enforce:
 * mode `restricted` with every allow and private-address rule a host plus
 * at least one valid port, and every private-address rule an exact IP
 * literal. A malformed one is refused, never treated as open.
 */
export function isValidRestrictedAgentRunNetworkPolicy(policy: AgentRunNetworkPolicy | undefined): boolean {
    return !!policy && policy.mode === 'restricted' && Array.isArray(policy.allow) && Array.isArray(policy.privateAddressAllow)
        && policy.allow.every(isEgressRule) && policy.privateAddressAllow.every(rule => isEgressRule(rule) && isIpLiteralRule(rule));
}

/**
 * The spec with {@link AgentRunNetwork.policy} derived from its restriction
 * (or open). A spec that already carries a restricted policy but no
 * restriction keeps that policy: an explicit restriction is never replaced by
 * the open default.
 */
export function withAgentRunNetworkPolicy(spec: AgentRunSpec): AgentRunSpec {
    if (!spec.network.restriction && spec.network.policy?.mode === 'restricted') return spec;
    return { ...spec, network: { ...spec.network, policy: agentRunNetworkPolicy(spec.profile.agentType, spec.network.restriction) } };
}
