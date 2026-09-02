/**
 * Docker arguments builder for Claude agent execution.
 *
 * This module handles the construction of Docker command-line arguments
 * for running Claude in a container with proper configuration.
 */

import path from 'path';
import os from 'os';
import fs from 'fs';
import logger from '../../../utils/logger.js';
import { AgentConfig } from '../../types.js';
import { resolveConfigPath, type ClaudeRuntimeReasoningLevel } from '../../../config/configManager.js';
import { wrapDockerRunArgsWithRepoSetup } from '../../../claude/docker/repoSetupWrapper.js';
import { createContainerExecutionId } from './containerExecutionId.js';
import {
    buildRepositoryScoutMcpConfig,
    REPOSITORY_SCOUT_CONTAINER_ROOT,
    REPOSITORY_SCOUT_MCP_TOOLS,
} from './repositoryScoutMcpServer.js';

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

/**
 * Parameters for building Docker arguments.
 */
export interface DockerArgsParams {
    /** Path to the git worktree */
    worktreePath: string;
    /** GitHub token for API access */
    githubToken: string;
    /** Optional model name to use */
    modelName?: string;
    /** Issue number (for logging) */
    issueNumber: number;
    /** Optional custom system prompt */
    systemPrompt?: string;
    /** Optional tools configuration */
    tools?: string;
    /** Per-execution environment variables to inject into the agent container. */
    environment?: Record<string, string>;
    /** Optional task ID for container naming */
    taskId?: string;
    /** Optional execution type for container naming (e.g., 'plan-generation', 'context-analysis') */
    executionType?: string;
    /** Optional reasoning effort for Claude Code. Empty or omitted means CLI default. */
    reasoningLevel?: ClaudeRuntimeReasoningLevel | '';
    /** Mount the repository workspace read-only and skip repository setup hooks. */
    readOnlyWorkspace?: boolean;
    /** Expose only the root-confined repository scout MCP tools. */
    repositoryInspection?: boolean;
    /** Preserve provider state and use native session resume semantics. */
    executionMode?: 'task' | 'goal';
    resumeSessionId?: string;
}

function repositoryInspectionArgs(enabled: boolean): string[] {
    if (!enabled) return [];
    return [
        '--mcp-config', buildRepositoryScoutMcpConfig(),
        '--strict-mcp-config',
        '--allowedTools', REPOSITORY_SCOUT_MCP_TOOLS.join(','),
        '--setting-sources', '',
        '--disable-slash-commands',
    ];
}

function optionalClaudeJsonMount(): string[] {
    const claudeJsonPath = path.join(os.homedir(), '.claude.json');
    return fs.existsSync(claudeJsonPath)
        ? ['-v', `${claudeJsonPath}:/home/node/.claude.json:rw`]
        : [];
}

function buildClaudeContainerName(
    config: AgentConfig,
    issueNumber: number,
    taskId: string | undefined,
    executionType: string | undefined
): string {
    const shortTaskId = createContainerExecutionId(taskId);
    const taskType = executionType || (issueNumber === 0 ? 'analysis' : `issue-${issueNumber}`);
    return `${config.alias || config.type}-${taskType}-${shortTaskId}`;
}

function buildBaseDockerArgs(options: {
    config: AgentConfig;
    maxTurns: number;
    worktreePath: string;
    workspaceMountTarget: string;
    configPath: string;
    containerName: string;
    githubToken: string;
    envVars: string[];
    claudeJsonMount: string[];
    inspectionArgs: string[];
    reasoningLevel?: ClaudeRuntimeReasoningLevel | '';
    readOnlyWorkspace: boolean;
    executionMode: 'task' | 'goal';
    resumeSessionId?: string;
}): string[] {
    const {
        config, maxTurns, worktreePath, workspaceMountTarget, configPath, containerName,
        githubToken, envVars, claudeJsonMount, inspectionArgs, reasoningLevel, readOnlyWorkspace,
        executionMode, resumeSessionId,
    } = options;
    return [
        'run', '--rm', '-i',
        '--name', containerName,
        '--security-opt', 'no-new-privileges',
        '--cap-add', 'CHOWN',
        '--network', 'bridge',
        '--user', '0:0',
        '-v', `${worktreePath}:${workspaceMountTarget}:${readOnlyWorkspace ? 'ro' : 'rw'}`,
        ...(readOnlyWorkspace ? [] : ['-v', '/tmp/git-processor:/tmp/git-processor:rw']),
        '-v', '/tmp/claude-logs:/tmp/claude-logs:rw',
        '-v', `${configPath}:/home/node/.claude:rw`,
        ...claudeJsonMount,
        ...(readOnlyWorkspace ? [] : ['-e', `GH_TOKEN=${githubToken}`]),
        ...(readOnlyWorkspace ? ['-e', 'PROPR_REPO_SETUP=0'] : []),
        ...envVars,
        '-w', '/home/node/workspace',
        config.dockerImage,
        'claude', '-p', '-',
        ...(executionMode === 'task' ? ['--no-session-persistence'] : []),
        ...(executionMode === 'goal' && resumeSessionId ? ['--resume', resumeSessionId] : []),
        ...(executionMode === 'task' ? ['--max-turns', maxTurns.toString()] : []),
        '--output-format', 'stream-json',
        '--verbose',
        ...inspectionArgs,
        ...(reasoningLevel ? ['--effort', reasoningLevel] : []),
        '--dangerously-skip-permissions'
    ];
}

/**
 * Builds Docker arguments for running Claude in a container.
 *
 * This function constructs the full `docker run` command arguments including:
 * - Security options (no-new-privileges, limited capabilities)
 * - Volume mounts (worktree, config, logs)
 * - Environment variables
 * - Claude CLI options (model, max-turns, output format)
 *
 * @param config - Agent configuration containing Docker image and env vars
 * @param maxTurns - Maximum number of conversation turns
 * @param params - Parameters for Docker execution
 * @returns Array of Docker command-line arguments
 */
export function buildDockerArgs(
    config: AgentConfig,
    maxTurns: number,
    params: DockerArgsParams
): string[] {
    const {
        worktreePath, githubToken, modelName, issueNumber, systemPrompt, tools, environment,
        taskId, executionType, reasoningLevel, readOnlyWorkspace = false, repositoryInspection = false,
        executionMode = 'task', resumeSessionId,
    } = params;
    const configPath = resolveConfigPath(config.configPath);
    if (repositoryInspection && !readOnlyWorkspace) {
        throw new Error('Repository inspection requires a read-only workspace');
    }
    // Native file tools can read mounted provider configuration, so read-only runs disable them.
    const effectiveTools = readOnlyWorkspace ? '' : tools;
    const inspectionArgs = repositoryInspectionArgs(repositoryInspection);
    const workspaceMountTarget = repositoryInspection
        ? REPOSITORY_SCOUT_CONTAINER_ROOT
        : '/home/node/workspace';
    const envVars = buildEnvironmentVariableArgs([config.envVars, environment], readOnlyWorkspace);
    const dockerArgs = buildBaseDockerArgs({
        config,
        maxTurns,
        worktreePath,
        workspaceMountTarget,
        configPath,
        containerName: buildClaudeContainerName(config, issueNumber, taskId, executionMode === 'goal' ? 'goal' : executionType),
        githubToken,
        envVars,
        claudeJsonMount: optionalClaudeJsonMount(),
        inspectionArgs,
        reasoningLevel,
        readOnlyWorkspace,
        executionMode,
        resumeSessionId,
    });

    // Add model parameter if specified
    if (modelName) {
        // Strip agent prefix if present (e.g., "claude:claude-opus-4-6" -> "claude-opus-4-6")
        const cleanModelName = modelName.includes(':') ? modelName.split(':').pop()! : modelName;
        const maxTurnsIndex = dockerArgs.indexOf('--max-turns');
        const modelIndex = maxTurnsIndex >= 0 ? maxTurnsIndex : dockerArgs.indexOf('--output-format');
        dockerArgs.splice(modelIndex, 0, '--model', cleanModelName);
        logger.info({
            issueNumber,
            requestedModel: cleanModelName,
            agentAlias: config.alias
        }, 'Using specific model for Claude agent execution');
    } else {
        logger.debug({
            issueNumber,
            agentAlias: config.alias
        }, 'No model specified, Claude agent will use default');
    }

    // Add optional system prompt
    if (systemPrompt !== undefined) {
        dockerArgs.push('--system-prompt', systemPrompt);
        logger.info({
            issueNumber,
            systemPromptLength: systemPrompt.length,
            agentAlias: config.alias
        }, 'Using custom system prompt');
    }

    // Add optional tools configuration
    if (effectiveTools !== undefined) {
        dockerArgs.push('--tools', effectiveTools);
        logger.info({
            issueNumber,
            tools: effectiveTools,
            agentAlias: config.alias
        }, 'Using custom tools configuration');
    }

    logger.info({
        issueNumber,
        hasSystemPrompt: systemPrompt !== undefined,
        hasTools: effectiveTools !== undefined,
        hasReasoningLevel: !!reasoningLevel,
        agentAlias: config.alias
    }, 'Docker args built for Claude agent');

    return wrapDockerRunArgsWithRepoSetup(dockerArgs, config.dockerImage, config.type);
}
