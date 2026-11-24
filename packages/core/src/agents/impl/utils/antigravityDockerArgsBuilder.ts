import { agentOwnsGit, buildAgentGitCredentialArgs, buildAgentGitMountArgs } from '../../agentGitAccess.js';
import { createContainerExecutionId } from './containerExecutionId.js';
import { buildAntigravityContainerName } from './antigravityContainerName.js';
import {
    buildAntigravityRepositoryScoutMcpConfig,
    buildAntigravityRepositoryScoutPermissions,
    REPOSITORY_SCOUT_CONTAINER_ROOT,
} from './repositoryScoutMcpServer.js';

const ANTIGRAVITY_CONTAINER_SOURCE_CONFIG_PATH = '/home/node/.gemini-source';
const GITHUB_CREDENTIAL_ENV_PATTERN = /^(?:GH|GITHUB)_.*(?:TOKEN|KEY|SECRET|PASSWORD|PAT|PRIVATE_KEY)$/;

interface AntigravityDockerArgsParams {
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

function buildAgentEnvironmentArgs(
    omitGithubCredentials: boolean,
    ...sources: Array<Record<string, string> | undefined>
): string[] {
    const args: string[] = [];
    for (const source of sources) {
        if (!source) continue;
        for (const [key, value] of Object.entries(source)) {
            if (omitGithubCredentials && GITHUB_CREDENTIAL_ENV_PATTERN.test(key.toUpperCase())) continue;
            args.push('-e', `${key}=${value}`);
        }
    }
    return args;
}

function buildWorkspaceMountArgs(
    params: Pick<AntigravityDockerArgsParams, 'worktreePath' | 'readOnlyWorkspace' | 'repositoryInspection' | 'gitMountArgs'>,
    workerOwnedGit: boolean,
): string[] {
    const { worktreePath, readOnlyWorkspace, repositoryInspection } = params;
    return [
        '-v', `${worktreePath}:${repositoryInspection ? REPOSITORY_SCOUT_CONTAINER_ROOT : '/home/node/workspace'}:${readOnlyWorkspace ? 'ro' : 'rw'}`,
        ...(repositoryInspection ? [] : params.gitMountArgs ?? buildAgentGitMountArgs(worktreePath, !workerOwnedGit, readOnlyWorkspace)),
    ];
}

function buildCredentialArgs(repositoryInspection: boolean, githubToken: string): string[] {
    return repositoryInspection
        ? []
        : ['-e', `GH_TOKEN=${githubToken}`, '-e', `GITHUB_TOKEN=${githubToken}`];
}

function buildRepositoryInspectionArgs(repositoryInspection: boolean): string[] {
    return repositoryInspection ? [
        '-e', 'PROPR_REPOSITORY_INSPECTION=1',
        '-e', `PROPR_REPOSITORY_SCOUT_ANTIGRAVITY_MCP_CONFIG=${buildAntigravityRepositoryScoutMcpConfig()}`,
        '-e', `PROPR_REPOSITORY_SCOUT_ANTIGRAVITY_PERMISSIONS=${buildAntigravityRepositoryScoutPermissions()}`,
    ] : [];
}

export function buildAntigravityDockerArgs(params: AntigravityDockerArgsParams): string[] {
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
    const envVars = buildAgentEnvironmentArgs(
        true,
        configEnvironment,
        environment,
    );
    const taskType = executionMode === 'goal'
        ? 'goal'
        : executionType || (issueNumber === 0 ? 'analysis' : `issue-${issueNumber}`);
    const containerName = buildAntigravityContainerName(
        agentAlias || 'antigravity',
        taskType,
        createContainerExecutionId(taskId),
        modelName,
    );

    return [
        'run', '--rm', '-i', '--name', containerName, '--security-opt', 'no-new-privileges',
        '--cap-add', 'CHOWN', '--network', 'bridge', '--user', '0:0',
        ...buildWorkspaceMountArgs({ worktreePath, readOnlyWorkspace, repositoryInspection, gitMountArgs: params.gitMountArgs }, workerOwnedGit),
        '-v', `${configPath}:${configMountTarget}:rw`,
        ...buildCredentialArgs(repositoryInspection, githubToken),
        '-e', 'ANTIGRAVITY_CLI=1', '-e', 'ANTIGRAVITY_CLI_TRUST_WORKSPACE=true',
        ...(readOnlyWorkspace ? ['-e', 'PROPR_REPO_SETUP=0'] : []),
        ...(executionMode === 'task' ? ['-e', 'PROPR_EPHEMERAL_STATE=1'] : []),
        '-e', `PROPR_ANTIGRAVITY_SOURCE_CONFIG=${configMountTarget}`,
        ...buildRepositoryInspectionArgs(repositoryInspection),
        ...(transcriptPath ? ['-e', `PROPR_ANTIGRAVITY_TRANSCRIPT_PATH=${transcriptPath}`] : []),
        ...envVars, ...buildAgentGitCredentialArgs(), '-w', '/home/node/workspace',
        dockerImage, '/bin/bash', '-lc', shellCommand, 'propr-antigravity',
    ];
}
