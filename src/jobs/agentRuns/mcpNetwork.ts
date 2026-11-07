import { executeDockerCommand, isValidDockerNetworkName, logger } from '@propr/core';

/**
 * Finds the Docker network an agent container must join to reach the ProPR
 * MCP endpoint. The default MCP URL names the Compose service `api`, which
 * only resolves on the Compose network, while agent containers are started on
 * the default bridge. A containerized worker shares that network with the API,
 * so its own container's networks name it. An operator can pin it with
 * `PROPR_AGENT_DOCKER_NETWORK`, which also serves a worker outside Compose.
 */

const RESERVED_NETWORKS = new Set(['bridge', 'host', 'none']);
const INSPECT_TIMEOUT_MS = 10_000;

export interface McpNetworkOptions {
    environment?: NodeJS.ProcessEnv;
    inspect?: (containerId: string) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
}

function containerized(environment: NodeJS.ProcessEnv): boolean {
    const flag = environment.PROPR_CONTAINERIZED?.trim().toLowerCase();
    return flag === '1' || flag === 'true';
}

async function inspectNetworks(containerId: string) {
    return executeDockerCommand('docker', [
        'inspect', '--format', '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}', containerId,
    ], { timeout: INSPECT_TIMEOUT_MS });
}

/**
 * The network for MCP-bearing agent containers, or null when none can be
 * named: the container then stays on bridge, which is right whenever
 * `PROPR_AGENT_MCP_URL` points at an address the bridge can reach.
 */
export async function resolveMcpContainerNetwork(options: McpNetworkOptions = {}): Promise<string | null> {
    const environment = options.environment ?? process.env;
    const pinned = environment.PROPR_AGENT_DOCKER_NETWORK?.trim();
    if (pinned) {
        if (isValidDockerNetworkName(pinned)) return pinned;
        logger.warn({ network: pinned }, 'PROPR_AGENT_DOCKER_NETWORK is not a valid Docker network name; agent containers stay on the default bridge');
        return null;
    }
    const containerId = environment.HOSTNAME?.trim();
    if (!containerized(environment) || !containerId) return null;
    try {
        const result = await (options.inspect ?? inspectNetworks)(containerId);
        if (result.exitCode !== 0) {
            logger.warn({ containerId, stderr: result.stderr.trim().slice(0, 300) }, 'Could not inspect the worker container for its Docker network; agent containers stay on the default bridge');
            return null;
        }
        const networks = result.stdout.split('\n').map(name => name.trim()).filter(Boolean);
        const network = networks.find(name => !RESERVED_NETWORKS.has(name) && isValidDockerNetworkName(name));
        if (!network) logger.warn({ containerId, networks }, 'The worker container is on no named Docker network; agent containers stay on the default bridge');
        return network ?? null;
    } catch (error) {
        logger.warn({ containerId, error: (error as Error).message }, 'Could not resolve the Docker network for MCP-bearing agent containers; they stay on the default bridge');
        return null;
    }
}

let resolved: Promise<string | null> | undefined;

/** Process-wide cached {@link resolveMcpContainerNetwork}: the worker's network does not change while it runs. */
export function mcpContainerNetwork(options: McpNetworkOptions = {}): Promise<string | null> {
    resolved ??= resolveMcpContainerNetwork(options).catch(() => null);
    return resolved;
}

/** Test seam. */
export function resetMcpContainerNetworkCache(): void {
    resolved = undefined;
}
