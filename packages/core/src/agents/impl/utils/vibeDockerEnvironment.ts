import type { AgentConfig } from '../../types.js';
import logger from '../../../utils/logger.js';
import { getForwardedVibeEnvVars } from './vibeAgentHelpers.js';
import { buildVibeRepositoryScoutConfig } from './repositoryScoutMcpServer.js';

export function buildVibeDockerEnvVars(config: AgentConfig, params: { cleanModelName?: string; mode: 'execute' | 'analysis'; maxTurns: number; runtimeHomePath?: string; repositoryInspection?: boolean }): string[] {
    const { cleanModelName, mode, maxTurns, runtimeHomePath, repositoryInspection = false } = params;
    const forwardedEnvVars = getForwardedVibeEnvVars(config.envVars, true);
    for (const envVar of forwardedEnvVars.skipped) logger.warn({ agentAlias: config.alias, envVar }, 'Skipping invalid Vibe Docker environment variable');
    const envVars = forwardedEnvVars.dockerArgs;
    envVars.push('-e', 'PROPR_AGENT_TYPE=vibe');
    if (cleanModelName) envVars.push('-e', `VIBE_ACTIVE_MODEL=${cleanModelName}`);
    // Vibe's bundled catalog does not include Mistral-hosted GLM. Its nested
    // environment layer merges this preset with existing user/provider config,
    // including in read-only analysis runs, without editing host credentials.
    if (cleanModelName === 'zai-glm-5-3' || cleanModelName === 'zai-glm-5-2') {
        envVars.push('-e', `VIBE_MODELS__${cleanModelName}=${JSON.stringify({
            name: cleanModelName,
            alias: cleanModelName,
            provider: 'mistral',
            thinking: 'high',
            input_price: 1.4,
            cached_input_price: 0.14,
            output_price: 4.4,
        })}`);
    }
    envVars.push('-e', 'VIBE_SOURCE_HOME=/home/node/.vibe');
    if (runtimeHomePath) envVars.push('-e', 'VIBE_RUNTIME_HOME=/tmp/propr-vibe-home', '-e', 'HOME=/tmp/propr-vibe-home');
    if (mode === 'analysis') {
        const analysisDirs = ['VIBE_READ_ONLY_CONFIG=1', 'XDG_CACHE_HOME=/tmp/propr-vibe-cache', 'XDG_CONFIG_HOME=/tmp/propr-vibe-config', 'XDG_DATA_HOME=/tmp/propr-vibe-data', 'UV_CACHE_DIR=/tmp/propr-uv-cache', 'HOME=/tmp/propr-vibe-home', 'VIBE_RUNTIME_HOME=/tmp/propr-vibe-home', 'XDG_STATE_HOME=/tmp/propr-vibe-state', 'PIP_CACHE_DIR=/tmp/propr-pip-cache', 'PYTHONPYCACHEPREFIX=/tmp/propr-python-cache'];
        for (const dir of analysisDirs) envVars.push('-e', dir);
    }
    if (repositoryInspection) {
        envVars.push('-e', 'PROPR_REPOSITORY_INSPECTION=1');
        envVars.push('-e', `PROPR_REPOSITORY_SCOUT_VIBE_CONFIG=${buildVibeRepositoryScoutConfig()}`);
    }
    envVars.push('-e', `VIBE_MAX_TURNS=${maxTurns}`);
    return envVars;
}
