import { executeWithAgentRunNetworkRestriction } from '../../network/agentRunNetworkRestriction.js';
import { NetworkPolicyError } from '../../network/egressExecution.js';
import type { AgentToolPolicy } from '../types.js';
import type { AgentRunSpec, AgentRuntimeRestrictedNetworkEnforcement } from './types.js';

/**
 * Networking helpers owned by the Docker runtime. The spec says *what* the
 * run may reach ({@link AgentRunSpec.network}, {@link AgentRunSpec.mcpGrant});
 * these decide how Docker provides it:
 *
 * - open runs join `bridge`, or the named network an MCP grant reaches its
 *   servers through (the API-only Compose network);
 * - restricted runs get `--network none` and a bind-mounted Unix socket to a
 *   per-run allowlist proxy on the worker (`network/egressExecution.ts`, the
 *   proxy engine), which a small bridge in the container exposes as
 *   `HTTP(S)_PROXY`. That needs the worker and the Docker daemon to share a
 *   directory, so it is a local-Docker capability, not a generic one.
 */

export const AGENT_CONTAINER_DEFAULT_NETWORK = 'bridge';

export const DOCKER_RESTRICTED_NETWORK_ENFORCEMENT: AgentRuntimeRestrictedNetworkEnforcement = Object.freeze({
    method: 'egress-proxy-socket',
    description: 'The container runs with --network none; its only way out is a bind-mounted Unix socket to a per-run allowlist proxy on the worker, exposed in the container as HTTP(S)_PROXY.',
});

/** Docker network names: no shell metacharacters, no leading option dash. */
const NETWORK_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export function isValidDockerNetworkName(name: string): boolean {
    return NETWORK_NAME_PATTERN.test(name);
}

/**
 * The `--network` value for a container run under `policy`. The default
 * bridge reaches the internet but has no DNS for Compose services, so a run
 * whose tool policy names a ProPR MCP server at `http://api:4000/...` joins
 * the network the API is on; everything else stays on bridge.
 */
export function agentContainerNetwork(policy?: Pick<AgentToolPolicy, 'dockerNetwork'> | null): string {
    const network = policy?.dockerNetwork?.trim();
    if (!network) return AGENT_CONTAINER_DEFAULT_NETWORK;
    if (!isValidDockerNetworkName(network)) throw new Error(`Invalid Docker network name for agent container: ${network}`);
    return network;
}

/**
 * Runs a Docker launch of `spec` under the restricted policy the spec
 * carries, so the executor's network boundary swaps the container's network
 * for `--network none` plus the egress proxy. A spec without a restriction
 * launches unchanged on its named network. A spec whose neutral policy is
 * restricted but which carries no restriction for the proxy to enforce is
 * refused rather than launched open.
 */
export async function executeDockerRunWithSpecNetwork<T>(spec: AgentRunSpec, execute: () => Promise<T>): Promise<T> {
    if (spec.network.policy?.mode === 'restricted' && !spec.network.restriction) {
        throw new NetworkPolicyError(`Agent run ${spec.name} has a restricted network policy but no restriction the Docker egress proxy can enforce`);
    }
    return executeWithAgentRunNetworkRestriction(spec.network.restriction, spec.name, execute);
}
