import type { AgentConfig } from '../types.js';

/**
 * Which runtime agents select, without loading any runtime (image
 * preparation and Docker sweeps import this). Unknown names count as Docker
 * here, so Docker preparation continues until the launch itself refuses them.
 */
const NON_DOCKER_AGENT_RUNTIMES = new Set(['sprites']);

export function selectedAgentRuntimeName(config?: Pick<AgentConfig, 'runtime'> | null, environment: NodeJS.ProcessEnv = process.env): string {
    return (config?.runtime?.trim() || environment.PROPR_AGENT_RUNTIME?.trim() || 'docker').toLowerCase();
}

/**
 * Whether any enabled agent (or, with none, the instance default) runs on
 * Docker. When none does, the worker skips agent image preparation, image
 * liveness checks and Docker-only sweeps: a Sprites-only worker has no Docker.
 */
export function dockerAgentRuntimeInUse(
    configs: ReadonlyArray<Pick<AgentConfig, 'runtime' | 'enabled'>> = [],
    environment: NodeJS.ProcessEnv = process.env,
): boolean {
    const enabled = configs.filter(config => config.enabled !== false);
    const selections = enabled.length > 0 ? enabled : [null];
    return selections.some(config => !NON_DOCKER_AGENT_RUNTIMES.has(selectedAgentRuntimeName(config, environment)));
}

export type AgentRuntimeSelections = ReadonlyArray<Pick<AgentConfig, 'runtime' | 'enabled'>>;

/**
 * The configured agents' runtime selections, as the registry and image
 * preparation see them (`agents` in `system_configs`). Rejects when they
 * cannot be read, so a caller keeps Docker authority instead of guessing.
 */
export async function loadConfiguredAgentRuntimes(): Promise<AgentRuntimeSelections> {
    // Lazy: the selection helpers above must not open the database on import.
    const { getConfigStrict } = await import('../../config/configStore.js');
    const agents = await getConfigStrict<unknown>('agents', []);
    if (!Array.isArray(agents)) throw new Error('The agents configuration is not a list');
    return agents as AgentRuntimeSelections;
}

/**
 * {@link dockerAgentRuntimeInUse} for the configured agents: true when any
 * enabled agent (or, with none, the instance default) selects Docker, and
 * when the configuration cannot be read.
 */
export async function configuredDockerAgentRuntimeInUse(
    environment: NodeJS.ProcessEnv = process.env,
    loadAgents: () => Promise<AgentRuntimeSelections> = loadConfiguredAgentRuntimes,
): Promise<boolean> {
    try {
        return dockerAgentRuntimeInUse(await loadAgents(), environment);
    } catch {
        return true;
    }
}
