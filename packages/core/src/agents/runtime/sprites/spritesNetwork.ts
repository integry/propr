import { isIP } from 'node:net';
import type { NetworkPolicy, PolicyRule, Sprite } from '@fly/sprites';
import { normalizeEgressHost } from '../../../network/egressAllowlist.js';
import { agentRunNetworkPolicy, assertAgentRunNetworkRepresentationsAgree, isValidRestrictedAgentRunNetworkPolicy } from '../agentRunNetworkPolicy.js';
import type { AgentRunSpec, AgentRuntimeRestrictedNetworkEnforcement } from '../types.js';

export const SPRITES_RESTRICTED_NETWORK_ENFORCEMENT: AgentRuntimeRestrictedNetworkEnforcement = Object.freeze({
    method: 'sprites-dns-allowlist',
    description: 'The Sprite gets a DNS allowlist network policy covering the run\'s allowed hosts, the granted ProPR MCP host and the extension gateway host, with every other domain denied. The policy is applied before the agent starts and cleared after checkpoint restoration and before reuse. Ports are not confined, raw IP connections are denied, and private addresses are never reachable.',
});

/** Sprites' unrestricted state: no rules, no enforcement. */
export const OPEN_SPRITE_NETWORK_POLICY: NetworkPolicy = Object.freeze({ rules: Object.freeze([]) as unknown as PolicyRule[] });

const privateMcpZones = ['localhost', 'local', 'lan', 'home.arpa', 'svc.cluster.local', 'internal'];

/**
 * The host a Sprite reaches the ProPR MCP endpoint at. A Sprite can never
 * reach a private address, and a restricted Sprite cannot reach a raw IP, so
 * the endpoint must be a public DNS name over HTTPS (the grant token crosses
 * the internet).
 */
export function restrictedSpriteMcpEndpoint(endpoint: string): { host: string } | { reason: string } {
    let url: URL;
    try { url = new URL(endpoint); } catch { return { reason: 'Sprites requires a valid ProPR MCP URL' }; }
    const host = normalizeEgressHost(url.hostname);
    if (url.protocol !== 'https:' || isIP(host) !== 0 || !host.includes('.')
        || privateMcpZones.some(zone => host === zone || host.endsWith(`.${zone}`))) {
        return { reason: `Sprites cannot reach ProPR MCP at ${url.origin}: set PROPR_SPRITES_MCP_URL (or PROPR_AGENT_MCP_URL/API_PUBLIC_URL) to a public HTTPS URL` };
    }
    return { host };
}

/**
 * The Sprites network policy a run gets, or undefined when it runs open.
 * Throws for anything Sprites cannot enforce: a named (private) network, a
 * malformed restricted policy, or two representations that disagree.
 *
 * Sprites rules are domains (exact, `*.zone`, or `*`), the most specific match
 * wins and every non-allowed lookup is refused. The translation keeps the
 * run no broader than its allowlist by host: a ProPR `*.zone` never covers the
 * bare zone, so deny it unless an exact allow or a broader wildcard covers it. IP
 * literal rules are dropped (Sprites denies raw IPs that were not resolved
 * from an allowed domain, and never reaches private addresses).
 */
export function spriteNetworkPolicy(spec: AgentRunSpec, gatewayUrls: readonly string[] = []): NetworkPolicy | undefined {
    if (spec.network.mode === 'named') throw new Error(`Sprites cannot join network "${spec.network.name}"`);
    const grant = spec.mcpGrant;
    if (grant && (grant.network || grant.transport !== 'reachable-url')) {
        throw new Error(`Sprites cannot join MCP network "${grant.network ?? 'unnamed'}"; set PROPR_SPRITES_MCP_URL to a public ProPR MCP URL`);
    }
    const { restriction, policy } = spec.network;
    if (!restriction && policy?.mode !== 'restricted') return undefined;
    assertAgentRunNetworkRepresentationsAgree(spec);
    const restricted = policy?.mode === 'restricted' ? policy : agentRunNetworkPolicy(spec.profile.agentType, restriction);
    if (!isValidRestrictedAgentRunNetworkPolicy(restricted)) throw new Error(`Sprites refuses the malformed restricted network policy of ${spec.name}`);
    const allowed = new Set<string>();
    const zones = new Set<string>();
    for (const rule of restricted.allow) {
        const host = normalizeEgressHost(rule.host);
        if (isIP(host) !== 0) continue;
        if (rule.wildcard) zones.add(host);
        allowed.add(rule.wildcard ? `*.${host}` : host);
    }
    for (const host of restrictedSpriteMcpHosts(grant?.url, gatewayUrls)) allowed.add(host);
    const wildcardZones = [...zones];
    const denied = wildcardZones.filter(zone => !allowed.has(zone)
        && !wildcardZones.some(parent => zone.endsWith(`.${parent}`)));
    return {
        rules: [
            ...[...allowed].sort().map(domain => ({ domain, action: 'allow' as const })),
            ...denied.sort().map(domain => ({ domain, action: 'deny' as const })),
            { domain: '*', action: 'deny' },
        ],
    };
}

/** The ProPR MCP host, and the extension gateway host a run's URL MCP servers are reached through. */
function restrictedSpriteMcpHosts(grantUrl: string | undefined, gatewayUrls: readonly string[]): string[] {
    return [grantUrl, ...gatewayUrls].filter((url): url is string => !!url).map(url => {
        const endpoint = restrictedSpriteMcpEndpoint(url);
        if ('reason' in endpoint) throw new Error(endpoint.reason);
        return endpoint.host;
    });
}

const ruleKey = (rule: PolicyRule) => `${rule.include ?? ''}|${rule.domain ?? ''}|${rule.action ?? 'allow'}`;

/** Whether the Sprite reports exactly `expected` (in any order). */
export function sameSpriteNetworkPolicy(actual: NetworkPolicy | undefined, expected: NetworkPolicy): boolean {
    const keys = (policy: NetworkPolicy) => JSON.stringify([...new Set(policy.rules.map(ruleKey))].sort());
    if (!Array.isArray(actual?.rules) || actual.rules.some(rule => !rule || typeof rule !== 'object')) return false;
    return keys(actual) === keys(expected);
}

/** Apply `policy` and read it back; a Sprite that does not report it is never handed the run. */
export async function applySpriteNetworkPolicy(sprite: Pick<Sprite, 'updateNetworkPolicy' | 'getNetworkPolicy'>, policy: NetworkPolicy): Promise<void> {
    await sprite.updateNetworkPolicy(policy);
    if (!sameSpriteNetworkPolicy(await sprite.getNetworkPolicy(), policy)) {
        throw new Error('Sprite did not report the network policy it was given');
    }
}
