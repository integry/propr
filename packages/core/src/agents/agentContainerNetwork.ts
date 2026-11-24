import type { AgentToolPolicy } from './types.js';

/**
 * Which Docker network an agent container joins. The default bridge reaches
 * the internet but has no DNS for Compose services, so a run whose tool policy
 * names a ProPR MCP server at `http://api:4000/...` must join the network the
 * API is on. The policy carries that network; everything else stays on bridge.
 */

export const AGENT_CONTAINER_DEFAULT_NETWORK = 'bridge';

/** Docker network names: no shell metacharacters, no leading option dash. */
const NETWORK_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export function isValidDockerNetworkName(name: string): boolean {
    return NETWORK_NAME_PATTERN.test(name);
}

/** The `--network` value for a container run under `policy`; the default bridge without one. */
export function agentContainerNetwork(policy?: Pick<AgentToolPolicy, 'dockerNetwork'> | null): string {
    const network = policy?.dockerNetwork?.trim();
    if (!network) return AGENT_CONTAINER_DEFAULT_NETWORK;
    if (!isValidDockerNetworkName(network)) throw new Error(`Invalid Docker network name for agent container: ${network}`);
    return network;
}
