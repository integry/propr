import type { AgentConfig } from '../types.js';

export const AGENT_RUNTIME_ENV = 'PROPR_AGENT_RUNTIME';
export const DEFAULT_AGENT_RUNTIME = 'docker';
export const FLY_MACHINES_AGENT_RUNTIME = 'fly-machines';
export const SPRITES_AGENT_RUNTIME = 'sprites';

let defaultDockerRuntimeReplaced = false;

/**
 * Whether the `docker` runtime is still the built-in implementation. A
 * replacement registered under that name may declare other capabilities, so
 * callers that answer Docker without loading the registry must check this
 * first. Set by `registerAgentRuntime`; never cleared, as the replacement's
 * factory cannot be compared with the built-in one.
 */
export const builtInDockerRuntimeSelected = () => !defaultDockerRuntimeReplaced;
export function noteAgentRuntimeRegistered(kind: string): void {
    if (kind === DEFAULT_AGENT_RUNTIME) defaultDockerRuntimeReplaced = true;
}

/**
 * Which runtime agents select, without loading any runtime (image
 * preparation and Docker sweeps import this). Unknown names count as Docker
 * here, so Docker preparation continues until the launch itself refuses them.
 */
export function selectedAgentRuntimeName(config?: Pick<AgentConfig, 'runtime'> | null, environment: NodeJS.ProcessEnv = process.env): string {
    return (config?.runtime?.trim() || environment[AGENT_RUNTIME_ENV]?.trim() || DEFAULT_AGENT_RUNTIME).toLowerCase();
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
    return selections.some(config => ![SPRITES_AGENT_RUNTIME, FLY_MACHINES_AGENT_RUNTIME].includes(selectedAgentRuntimeName(config, environment)));
}
