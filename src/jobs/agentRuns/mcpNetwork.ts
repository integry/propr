import { executeDockerCommand, isValidDockerNetworkName, logger } from '@propr/core';

/**
 * MCP containers use the API-only Compose network, never the worker's shared
 * service network. Compose's project label identifies the network declared in
 * docker-compose.yml. Other deployments can explicitly pin an API-only network.
 */
const MCP_NETWORK_SUFFIX = '_propr-agent-mcp';
const INSPECT_TIMEOUT_MS = 10_000;

export interface McpNetworkOptions {
    environment?: NodeJS.ProcessEnv;
    inspect?: (containerId: string) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
}

function containerized(environment: NodeJS.ProcessEnv): boolean {
    const flag = environment.PROPR_CONTAINERIZED?.trim().toLowerCase();
    return flag === '1' || flag === 'true';
}

async function inspectProject(containerId: string) {
    return executeDockerCommand('docker', [
        'inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}}', containerId,
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
    if (environment.PROPR_AGENT_MCP_URL?.trim()) return null;
    const containerId = environment.HOSTNAME?.trim();
    if (!containerized(environment) || !containerId) return null;
    try {
        const result = await (options.inspect ?? inspectProject)(containerId);
        if (result.exitCode !== 0) {
            logger.warn({ containerId, stderr: result.stderr.trim().slice(0, 300) }, 'Could not inspect the worker container for its Compose project; agent containers stay on the default bridge');
            return null;
        }
        const project = result.stdout.trim();
        const network = `${project}${MCP_NETWORK_SUFFIX}`;
        if (!project || !isValidDockerNetworkName(network)) {
            logger.warn({ containerId }, 'The worker has no valid Compose project label; agent containers stay on the default bridge');
            return null;
        }
        return network;
    } catch (error) {
        logger.warn({ containerId, error: (error as Error).message }, 'Could not resolve the Docker network for MCP-bearing agent containers; they stay on the default bridge');
        return null;
    }
}

let resolved: Promise<string | null> | undefined;

/** Cache Compose discovery only; explicit configuration always takes precedence. */
export function mcpContainerNetwork(options: McpNetworkOptions = {}): Promise<string | null> {
    const environment = options.environment ?? process.env;
    if (environment.PROPR_AGENT_DOCKER_NETWORK?.trim() || environment.PROPR_AGENT_MCP_URL?.trim()) {
        return resolveMcpContainerNetwork(options);
    }
    resolved ??= resolveMcpContainerNetwork(options).catch(() => null);
    return resolved;
}

/** Test seam. */
export function resetMcpContainerNetworkCache(): void {
    resolved = undefined;
}
