import { agentOwnsGit, buildAgentGitCredentialArgs, buildAgentGitMountArgs } from '../../agentGitAccess.js';
import { AgentRunSpecBuilder, agentRunMcpGrant, agentRunNetwork } from '../../runtime/agentRunSpec.js';
import { renderDockerRunArgs } from '../../runtime/dockerRunArgs.js';
import type { AgentRunSpec } from '../../runtime/types.js';
import { createContainerExecutionId } from './containerExecutionId.js';
import { agentContainerNetwork } from '../../agentContainerNetwork.js';
import { antigravityToolPolicyArgs, antigravityToolPolicyEnvironment } from '../../mcpLaunch/antigravityMcpLaunch.js';
import type { AgentToolPolicy } from '../../types.js';
import { buildAntigravityContainerName } from './antigravityContainerName.js';
import {
    buildAntigravityRepositoryScoutMcpConfig,
    buildAntigravityRepositoryScoutPermissions,
    REPOSITORY_SCOUT_CONTAINER_ROOT,
} from './repositoryScoutMcpServer.js';
import { buildAntigravityTranscriptArgs } from './antigravityTranscriptPaths.js';

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
    /** Worker-side path of a disposable run's transcript; its directory is mounted read-write. */
    transcriptPath?: string;
    readOnlyWorkspace?: boolean;
    repositoryInspection?: boolean;
    executionMode?: 'task' | 'goal';
    configPath: string;
    dockerImage: string;
    agentAlias?: string;
    shellCommand: string;
    /** Task runs only: run MCP servers, the exclusive switch and native skills. */
    toolPolicy?: AgentToolPolicy;
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

function assertAntigravityLaunchMode(repositoryInspection: boolean, readOnlyWorkspace: boolean, executionMode: 'task' | 'goal', toolPolicy: AgentToolPolicy | undefined): void {
    if (repositoryInspection && !readOnlyWorkspace) {
        throw new Error('Repository inspection requires a read-only workspace');
    }
    // The entrypoint writes the MCP config into the disposable runtime home only.
    if (toolPolicy && (executionMode !== 'task' || repositoryInspection)) throw new Error('Antigravity MCP launch requires a disposable task runtime');
}

function addRepositoryInspectionEnvironment(builder: AgentRunSpecBuilder): void {
    builder
        .env('PROPR_REPOSITORY_INSPECTION', '1')
        .env('PROPR_REPOSITORY_SCOUT_ANTIGRAVITY_MCP_CONFIG', buildAntigravityRepositoryScoutMcpConfig())
        .env('PROPR_REPOSITORY_SCOUT_ANTIGRAVITY_PERMISSIONS', buildAntigravityRepositoryScoutPermissions());
}

/** The MCP config, exclusive switch and skills; tokens and stdio secrets by name only (the runtime copies the values). */
function addToolPolicyEnvironment(builder: AgentRunSpecBuilder, toolPolicy: AgentToolPolicy): void {
    builder.dockerOptions(antigravityToolPolicyEnvironment(toolPolicy), 'scratch');
    for (const name of Object.keys(antigravityToolPolicyArgs(toolPolicy).env)) builder.env(name);
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
        agentAlias, shellCommand, toolPolicy,
    } = params;
    assertAntigravityLaunchMode(repositoryInspection, readOnlyWorkspace, executionMode, toolPolicy);
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
        stdin: true, user: '0:0', network: agentRunNetwork(agentContainerNetwork(toolPolicy)), security: { capAdd: ['CHOWN'] },
        mcpGrant: agentRunMcpGrant(toolPolicy),
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
    if (repositoryInspection) addRepositoryInspectionEnvironment(builder);
    builder.dockerOptions(buildAntigravityTranscriptArgs(transcriptPath), 'logs');
    addAgentEnvironment(builder, true, configEnvironment, environment);
    // After operator variables, so their envVars cannot change them.
    if (toolPolicy) addToolPolicyEnvironment(builder, toolPolicy);
    builder.dockerOptions(buildAgentGitCredentialArgs(), 'credential');
    return builder.command('/bin/bash', '-lc', shellCommand, 'propr-antigravity').build();
}

export function buildAntigravityDockerArgs(params: AntigravityDockerArgsParams): string[] {
    return renderDockerRunArgs(buildAntigravityRunSpec(params));
}
