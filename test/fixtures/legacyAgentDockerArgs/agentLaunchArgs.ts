// Pre-runtime-seam argv assembly of the Antigravity and Vibe agents (private
// methods at the time), kept verbatim as golden references. The agents' own
// unchanged helpers are reached through the instance.
// @ts-nocheck
/* eslint-disable */
import { buildAgentGitCredentialArgs, buildAgentGitMountArgs } from '../../../packages/core/src/agents/agentGitAccess.js';
import { toAntigravityCliModelId } from '../../../packages/core/src/agents/impl/antigravityModelIds.js';
import { buildVibeContainerName, resolveHostBindPath } from '../../../packages/core/src/agents/impl/utils/vibeAgentHelpers.js';
import { buildVibeDockerEnvVars } from '../../../packages/core/src/agents/impl/utils/vibeDockerEnvironment.js';
import { REPOSITORY_SCOUT_CONTAINER_ROOT } from '../../../packages/core/src/agents/impl/utils/repositoryScoutMcpServer.js';
import { buildAntigravityDockerArgs } from './antigravityDockerArgsBuilder.js';
import { buildAgentContainerResourceArgs } from './agentContainerResources.js';
import { wrapDockerRunArgsWithRepoSetup } from './repoSetupWrapper.js';

function getAnalysisSandboxArgs(mode) {
    return mode === 'analysis'
        ? [
            '--read-only',
            '--cap-drop=ALL',
            '--tmpfs', '/tmp:rw,nosuid,size=512m',
            '--tmpfs', '/home/node/bin:rw,nosuid,size=16m',
            '--tmpfs', '/home/node/.cache:rw,nosuid,size=256m',
            '--tmpfs', '/home/node/.config:rw,nosuid,size=64m',
            '--tmpfs', '/home/node/.local:rw,nosuid,size=128m'
        ]
        : [];
}

export function legacyAntigravityDockerArgs(agent, params) {
    const { worktreePath, githubToken, modelName, issueNumber, environment, taskId, executionType, transcriptPath, readOnlyWorkspace = false, repositoryInspection = false, executionMode = 'task', resumeConversationId, nativeGoalLaunch = false, printTimeoutMs = agent.timeoutMs } = params;
    const configPath = agent.getHostConfigPath();
    const runtimeName = 'antigravity';
    const dockerArgs = buildAntigravityDockerArgs({
        worktreePath, githubToken, gitMountArgs: params.gitMountArgs, modelName, issueNumber, environment,
        configEnvironment: agent.config.envVars, taskId, executionType, transcriptPath,
        readOnlyWorkspace, repositoryInspection, executionMode, configPath,
        dockerImage: agent.config.dockerImage, agentAlias: agent.config.alias,
        shellCommand: agent.buildAntigravityShellCommand(repositoryInspection),
    });
    dockerArgs.push('--print-timeout', `${Math.max(1, Math.ceil(printTimeoutMs / 1000))}s`);
    if (executionMode === 'goal') dockerArgs.push('--output-format', 'stream-json');
    if (executionMode === 'goal' && !nativeGoalLaunch) dockerArgs.push('--disable-slash-commands');
    if (modelName) {
        const cleanModelName = toAntigravityCliModelId(modelName, params.reasoningLevel);
        dockerArgs.push('--model', cleanModelName);
    }
    if (executionMode === 'goal' && resumeConversationId) dockerArgs.push('--conversation', resumeConversationId);
    return wrapDockerRunArgsWithRepoSetup(dockerArgs, agent.config.dockerImage, runtimeName);
}

export function legacyVibeDockerArgs(agent, params) {
    const { worktreePath, modelName, mistralApiKey, issueNumber, taskId, executionType, maxTurns = agent.maxTurns, mode = 'execute', promptFilePath, envFilePath, runtimeHomePath, repositoryInspection = false } = params;
    if (repositoryInspection && mode !== 'analysis') {
        throw new Error('Repository inspection requires analysis mode');
    }
    const { configMountArgs } = agent.resolveCredentialsAndConfig(mistralApiKey);
    const cleanModelName = modelName?.includes(':') ? modelName.split(':').pop() : modelName;
    const mistralEnvFileArgs = envFilePath ? ['--env-file', envFilePath] : [];
    const envVars = buildVibeDockerEnvVars(agent.config, { cleanModelName, mode, maxTurns, runtimeHomePath, repositoryInspection });

    const containerName = buildVibeContainerName(agent.config.alias, executionType || (issueNumber === 0 ? 'analysis' : `issue-${issueNumber}`), taskId, modelName);
    const workspaceMountMode = mode === 'analysis' ? 'ro' : 'rw';
    // CLI flags and the prompt mount come from the agent's own helper: the
    // Vibe 3 upgrade on main changed them independently of the runtime seam.
    const { cliArgs, promptMountArgs } = agent.buildCliAndPromptArgs({ repositoryInspection, mode, maxTurns, promptFilePath, runtimeHomePath });
    const runtimeHomeMountArgs = runtimeHomePath ? ['-v', `${resolveHostBindPath(runtimeHomePath)}:/tmp/propr-vibe-home:rw`] : [];
    const dockerArgs = [
        'run', '--rm', '--name', containerName, '--security-opt', 'no-new-privileges', '--network', 'bridge',
        ...getAnalysisSandboxArgs(mode),
        '-v', `${worktreePath}:${repositoryInspection ? REPOSITORY_SCOUT_CONTAINER_ROOT : '/home/node/workspace'}:${workspaceMountMode}`,
        ...(repositoryInspection ? [] : params.gitMountArgs ?? buildAgentGitMountArgs(worktreePath, false, mode === 'analysis')),
        ...configMountArgs, ...promptMountArgs, ...runtimeHomeMountArgs, ...mistralEnvFileArgs,
        ...envVars, ...buildAgentGitCredentialArgs(), '-w', '/home/node/workspace', agent.config.dockerImage, ...cliArgs
    ];
    if (mode === 'analysis') return [dockerArgs[0], ...buildAgentContainerResourceArgs(), ...dockerArgs.slice(1)];
    return wrapDockerRunArgsWithRepoSetup(dockerArgs, agent.config.dockerImage, 'vibe');
}
