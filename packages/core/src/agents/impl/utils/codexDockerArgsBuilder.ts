import logger from '../../../utils/logger.js';
import type { AgentConfig } from '../../types.js';
import { resolveConfigPath, type CodexRuntimeReasoningLevel } from '../../../config/configManager.js';
import { wrapDockerRunArgsWithRepoSetup } from '../../../claude/docker/repoSetupWrapper.js';
import { createContainerExecutionId } from './containerExecutionId.js';
import {
    buildCodexRepositoryScoutArgs,
    REPOSITORY_SCOUT_CONTAINER_ROOT,
} from './repositoryScoutMcpServer.js';

const CONTAINER_CONFIG_PATH = '/home/node/.codex';
const GITHUB_CREDENTIAL_ENV_NAMES = new Set(['GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_ACCESS_TOKEN']);
const GITHUB_CREDENTIAL_ENV_PATTERN = /^(?:GH|GITHUB)_.*(?:TOKEN|KEY|SECRET|PASSWORD|PAT|PRIVATE_KEY)$/;

function isGitHubCredentialEnvironmentVariable(name: string): boolean {
    const normalizedName = name.toUpperCase();
    return GITHUB_CREDENTIAL_ENV_NAMES.has(normalizedName)
        || GITHUB_CREDENTIAL_ENV_PATTERN.test(normalizedName);
}

function buildEnvironmentVariableArgs(
    sources: Array<Record<string, string> | undefined>,
    omitGitHubCredentials: boolean
): string[] {
    const args: string[] = [];
    for (const source of sources) {
        if (!source) continue;
        for (const [key, value] of Object.entries(source)) {
            if (omitGitHubCredentials && isGitHubCredentialEnvironmentVariable(key)) continue;
            args.push('-e', `${key}=${value}`);
        }
    }
    return args;
}

export interface CodexDockerArgsParams {
    worktreePath: string;
    githubToken: string;
    modelName?: string;
    issueNumber: number;
    jsonOutput?: boolean;
    environment?: Record<string, string>;
    taskId?: string;
    executionType?: string;
    reasoningLevel?: CodexRuntimeReasoningLevel | '';
    readOnlyWorkspace?: boolean;
    repositoryInspection?: boolean;
}

export function buildCodexDockerArgs(config: AgentConfig, params: CodexDockerArgsParams): string[] {
    const {
        worktreePath, githubToken, modelName, issueNumber, jsonOutput = true, environment,
        taskId, executionType, reasoningLevel, readOnlyWorkspace = false, repositoryInspection = false,
    } = params;
    if (repositoryInspection && !readOnlyWorkspace) {
        throw new Error('Repository inspection requires a read-only workspace');
    }

    const dockerImage = config.dockerImage;
    const configPath = resolveConfigPath(config.configPath);
    const envVars = buildEnvironmentVariableArgs([config.envVars, environment], repositoryInspection);
    const shortTaskId = createContainerExecutionId(taskId);
    const taskType = executionType || (issueNumber === 0 ? 'analysis' : `issue-${issueNumber}`);
    const containerName = `${config.alias || 'codex'}-${taskType}-${shortTaskId}`;
    const workspaceTarget = repositoryInspection ? REPOSITORY_SCOUT_CONTAINER_ROOT : '/home/node/workspace';
    const dockerArgs: string[] = [
        'run', '--rm', '-i',
        '--name', containerName,
        '--security-opt', 'no-new-privileges',
        '--security-opt', 'seccomp=unconfined',
        '--security-opt', 'apparmor=unconfined',
        '--cap-add', 'CHOWN',
        '--network', 'bridge',
        '--user', '0:0',
        '-v', `${worktreePath}:${workspaceTarget}:${readOnlyWorkspace ? 'ro' : 'rw'}`,
        ...(repositoryInspection ? [] : ['-v', `/tmp/git-processor:/tmp/git-processor:${readOnlyWorkspace ? 'ro' : 'rw'}`]),
        '-v', `${configPath}:${CONTAINER_CONFIG_PATH}:rw`,
        ...(repositoryInspection ? [] : ['-e', `GH_TOKEN=${githubToken}`, '-e', `GITHUB_TOKEN=${githubToken}`]),
        ...(readOnlyWorkspace ? ['-e', 'PROPR_REPO_SETUP=0'] : []),
        ...envVars,
        '-w', '/home/node/workspace',
        dockerImage,
        'codex', 'exec', '--ephemeral',
        ...(jsonOutput ? ['--json'] : []),
        ...(repositoryInspection
            ? buildCodexRepositoryScoutArgs()
            : ['--dangerously-bypass-approvals-and-sandbox', '--config', 'features.multi_agent=false']),
        ...(reasoningLevel ? ['--config', `model_reasoning_effort="${reasoningLevel}"`] : []),
        '--skip-git-repo-check',
        '--cd', '/home/node/workspace',
        '-'
    ];

    if (modelName) {
        const cleanModelName = modelName.includes(':') ? modelName.split(':').pop()! : modelName;
        const codexIndex = dockerArgs.indexOf('codex');
        dockerArgs.splice(codexIndex + 2, 0, '--model', cleanModelName);
        logger.info({ issueNumber, requestedModel: cleanModelName, agentAlias: config.alias }, 'Using specific model for Codex agent execution');
    } else {
        logger.debug({ issueNumber, agentAlias: config.alias }, 'No model specified, Codex agent will use default');
    }
    logger.info({ issueNumber, agentAlias: config.alias }, 'Docker args built for Codex agent');
    return wrapDockerRunArgsWithRepoSetup(dockerArgs, dockerImage, 'codex');
}
