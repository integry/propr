import { agentOwnsGit, buildAgentGitCredentialArgs, buildAgentGitMountArgs } from '../../agentGitAccess.js';
import { AgentRunSpecBuilder, agentRunNetwork } from '../../runtime/agentRunSpec.js';
import { renderDockerRunArgs } from '../../runtime/dockerRunArgs.js';
import type { AgentRunSpec } from '../../runtime/types.js';
import { createContainerExecutionId } from './containerExecutionId.js';
import { buildAntigravityContainerName } from './antigravityContainerName.js';
import {
    buildAntigravityRepositoryScoutMcpConfig,
    buildAntigravityRepositoryScoutPermissions,
    REPOSITORY_SCOUT_CONTAINER_ROOT,
} from './repositoryScoutMcpServer.js';

const ANTIGRAVITY_CONTAINER_SOURCE_CONFIG_PATH = '/home/node/.gemini-source';
const GITHUB_CREDENTIAL_ENV_PATTERN = /^(?:GH|GITHUB)_.*(?:TOKEN|KEY|SECRET|PASSWORD|PAT|PRIVATE_KEY)$/;

export interface AntigravityDockerArgsParams {
    worktreePath: string;
    githubToken: string;
    gitMountArgs?: string[];
    modelName?: string;
    issueNumber: number;
    environment?: Record<string, string>;
    configEnvironment?: Record<string, string>;
    taskId?: string;
    executionType?: string;
    transcriptPath?: string;
    readOnlyWorkspace?: boolean;
    repositoryInspection?: boolean;
    executionMode?: 'task' | 'goal';
    configPath: string;
    dockerImage: string;
    agentAlias?: string;
    shellCommand: string;
}

function addAgentEnvironment(
    builder: AgentRunSpecBuilder,
    omitGithubCredentials: boolean,
    ...sources: Array<Record<string, string> | undefined>
): void {
    for (const source of sources) {
        if (!source) continue;
        for (const [key, value] of Object.entries(source)) {
            if (omitGithubCredentials && GITHUB_CREDENTIAL_ENV_PATTERN.test(key.toUpperCase())) continue;
            builder.env(key, value);
        }
    }
}

/**
 * The Antigravity run before provider switches and the setup wrapper are
 * added: the agent appends CLI flags to `args`, then wraps the entrypoint.
 */
export function buildAntigravityRunSpec(params: AntigravityDockerArgsParams): AgentRunSpec {
    const {
        worktreePath, githubToken, modelName, issueNumber, environment, configEnvironment,
        taskId, executionType, transcriptPath, readOnlyWorkspace = false,
        repositoryInspection = false, executionMode = 'task', configPath, dockerImage,
        agentAlias, shellCommand,
    } = params;
    if (repositoryInspection && !readOnlyWorkspace) {
        throw new Error('Repository inspection requires a read-only workspace');
    }
    const configMountTarget = executionMode === 'goal'
        ? '/home/node/.gemini'
        : ANTIGRAVITY_CONTAINER_SOURCE_CONFIG_PATH;
    const workerOwnedGit = !agentOwnsGit(params);
    const taskType = executionMode === 'goal'
        ? 'goal'
        : executionType || (issueNumber === 0 ? 'analysis' : `issue-${issueNumber}`);
    const containerName = buildAntigravityContainerName(
        agentAlias || 'antigravity',
        taskType,
        createContainerExecutionId(taskId),
        modelName,
    );

    const builder = new AgentRunSpecBuilder({
        agentType: 'antigravity', image: dockerImage, ...(agentAlias ? { alias: agentAlias } : {}), name: containerName,
        stdin: true, user: '0:0', network: agentRunNetwork('bridge'), security: { capAdd: ['CHOWN'] },
        workspace: {
            hostPath: worktreePath,
            containerPath: repositoryInspection ? REPOSITORY_SCOUT_CONTAINER_ROOT : '/home/node/workspace',
            readOnly: readOnlyWorkspace,
        },
    }).workspaceMount();
    if (!repositoryInspection) {
        builder.dockerOptions(params.gitMountArgs ?? buildAgentGitMountArgs(worktreePath, !workerOwnedGit, readOnlyWorkspace), 'git');
    }
    builder.credentialBind(configPath, configMountTarget, false, { provider: 'antigravity', store: 'config', perRun: executionMode === 'task' });
    if (!repositoryInspection) builder.env('GH_TOKEN', githubToken).env('GITHUB_TOKEN', githubToken);
    builder.env('ANTIGRAVITY_CLI', '1').env('ANTIGRAVITY_CLI_TRUST_WORKSPACE', 'true');
    if (readOnlyWorkspace) builder.env('PROPR_REPO_SETUP', '0');
    if (executionMode === 'task') builder.env('PROPR_EPHEMERAL_STATE', '1');
    builder.env('PROPR_ANTIGRAVITY_SOURCE_CONFIG', configMountTarget);
    if (repositoryInspection) {
        builder
            .env('PROPR_REPOSITORY_INSPECTION', '1')
            .env('PROPR_REPOSITORY_SCOUT_ANTIGRAVITY_MCP_CONFIG', buildAntigravityRepositoryScoutMcpConfig())
            .env('PROPR_REPOSITORY_SCOUT_ANTIGRAVITY_PERMISSIONS', buildAntigravityRepositoryScoutPermissions());
    }
    if (transcriptPath) builder.env('PROPR_ANTIGRAVITY_TRANSCRIPT_PATH', transcriptPath);
    addAgentEnvironment(builder, true, configEnvironment, environment);
    builder.dockerOptions(buildAgentGitCredentialArgs(), 'credential');
    return builder.command('/bin/bash', '-lc', shellCommand, 'propr-antigravity').build();
}

export function buildAntigravityDockerArgs(params: AntigravityDockerArgsParams): string[] {
    return renderDockerRunArgs(buildAntigravityRunSpec(params));
}
