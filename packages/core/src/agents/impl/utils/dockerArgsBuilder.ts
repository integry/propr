import { agentOwnsGit, buildAgentGitCredentialArgs, buildAgentGitMountArgs } from '../../agentGitAccess.js';
/**
 * Run spec builder for Claude agent execution.
 *
 * Describes a Claude Code run as an AgentRunSpec; the Docker runtime renders
 * it to the `docker run` arguments.
 */

import { currentClaudeModel } from '@propr/shared';
import logger from '../../../utils/logger.js';
import type { AgentConfig, AgentToolPolicy } from '../../types.js';
import { claudeToolPolicyArgs } from '../../agentToolPolicy.js';
import { agentContainerNetwork } from '../../agentContainerNetwork.js';
import { resolveConfigPath, type ClaudeRuntimeReasoningLevel } from '../../../config/configManager.js';
import { applyAgentRunLaunchWrapper } from '../../../claude/docker/repoSetupWrapper.js';
import { addClaudeConfigSeed } from '../../../claude/docker/claudeConfigSeed.js';
import { AgentRunSpecBuilder, agentRunMcpGrant, agentRunNetwork } from '../../runtime/agentRunSpec.js';
import { renderDockerRunArgs } from '../../runtime/dockerRunArgs.js';
import type { AgentRunMcpGrant, AgentRunSpec } from '../../runtime/types.js';
import { createContainerExecutionId } from './containerExecutionId.js';
import {
    buildRepositoryScoutMcpConfig,
    REPOSITORY_SCOUT_CONTAINER_ROOT,
    REPOSITORY_SCOUT_MCP_TOOLS,
} from './repositoryScoutMcpServer.js';
import { buildOperatorQuestionMcpConfig, type OperatorQuestionLaunch } from './operatorQuestionMcpServer.js';

const GITHUB_CREDENTIAL_ENV_NAMES = new Set(['GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_ACCESS_TOKEN']);
const GITHUB_CREDENTIAL_ENV_PATTERN = /^(?:GH|GITHUB)_.*(?:TOKEN|KEY|SECRET|PASSWORD|PAT|PRIVATE_KEY)$/;

function isGitHubCredentialEnvironmentVariable(name: string): boolean {
    const normalizedName = name.toUpperCase();
    return GITHUB_CREDENTIAL_ENV_NAMES.has(normalizedName)
        || GITHUB_CREDENTIAL_ENV_PATTERN.test(normalizedName);
}

function addEnvironmentVariables(
    builder: AgentRunSpecBuilder,
    sources: Array<Record<string, string> | undefined>,
    omitGitHubCredentials: boolean
): void {
    for (const source of sources) {
        if (!source) continue;
        for (const [key, value] of Object.entries(source)) {
            if (omitGitHubCredentials && isGitHubCredentialEnvironmentVariable(key)) continue;
            builder.env(key, value);
        }
    }
}

/**
 * Parameters for building Docker arguments.
 */
export interface DockerArgsParams {
    /** Path to the git worktree */
    worktreePath: string;
    /** GitHub token for API access */
    githubToken: string;
    gitMountArgs?: string[];
    /** Optional model name to use */
    modelName?: string;
    /** Issue number (for logging) */
    issueNumber: number;
    /** Optional custom system prompt */
    systemPrompt?: string;
    /** Optional tools configuration */
    tools?: string;
    /** Per-run web/MCP policy; its tokens must reach the docker process through `extraEnvVars`. */
    toolPolicy?: AgentToolPolicy;
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
    /** Identity to assign a fresh goal session so it is durable before any work starts. */
    sessionId?: string;
    /**
     * Inject the `ask_operator` MCP tool. Goal sessions only: ordinary task
     * runs are one-shot and never receive it, whatever the caller passes.
     */
    operatorQuestions?: OperatorQuestionLaunch;
}

function operatorQuestionArgs(executionMode: 'task' | 'goal', launch: OperatorQuestionLaunch | undefined): string[] {
    if (executionMode !== 'goal' || !launch) return [];
    return ['--mcp-config', buildOperatorQuestionMcpConfig(launch)];
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

function buildBaseRunSpec(options: {
    config: AgentConfig;
    maxTurns: number;
    worktreePath: string;
    workspaceMountTarget: string;
    configPath: string;
    containerName: string;
    githubToken: string;
    gitMountArgs?: string[];
    environmentSources: Array<Record<string, string> | undefined>;
    policyEnvNames: string[];
    inspectionArgs: string[];
    reasoningLevel?: ClaudeRuntimeReasoningLevel | '';
    readOnlyWorkspace: boolean;
    repositoryInspection: boolean;
    workerOwnedGit: boolean;
    executionMode: 'task' | 'goal';
    resumeSessionId?: string;
    sessionId?: string;
    /** Docker network to join; the default bridge unless the tool policy needs a Compose service. */
    network?: string;
    mcpGrant?: AgentRunMcpGrant;
}): AgentRunSpecBuilder {
    const {
        config, maxTurns, worktreePath, workspaceMountTarget, configPath, containerName,
        githubToken, inspectionArgs, reasoningLevel, readOnlyWorkspace, repositoryInspection,
        workerOwnedGit, executionMode, resumeSessionId, sessionId, network = agentContainerNetwork(),
    } = options;
    const goal = executionMode === 'goal';
    const builder = new AgentRunSpecBuilder({
        agentType: config.type, image: config.dockerImage, alias: config.alias, name: containerName, stdin: true,
        user: '0:0', network: agentRunNetwork(network), security: { capAdd: ['CHOWN'] },
        workspace: { hostPath: worktreePath, containerPath: workspaceMountTarget, readOnly: readOnlyWorkspace },
        mcpGrant: options.mcpGrant,
    }).workspaceMount();
    if (!repositoryInspection) {
        builder.dockerOptions(options.gitMountArgs ?? (readOnlyWorkspace ? [] : buildAgentGitMountArgs(worktreePath, !workerOwnedGit)), 'git');
    }
    builder
        .bind('/tmp/claude-logs', '/tmp/claude-logs', false, 'logs')
        .bind(configPath, '/home/node/.claude', false, 'credential');
    addClaudeConfigSeed(builder);
    if (!repositoryInspection) builder.env('GH_TOKEN', githubToken);
    if (readOnlyWorkspace) builder.env('PROPR_REPO_SETUP', '0');
    addEnvironmentVariables(builder, options.environmentSources, true);
    for (const name of options.policyEnvNames) builder.env(name);
    builder.dockerOptions(buildAgentGitCredentialArgs(), 'credential');
    // Goal sessions keep stdin open as a stream-json control channel, so
    // `/goal` and later steering arrive as real user messages.
    return builder.command(
        'claude', '-p', ...(goal ? ['--input-format', 'stream-json'] : ['-']),
        ...(goal ? [] : ['--no-session-persistence']),
        ...(goal && resumeSessionId ? ['--resume', resumeSessionId] : []),
        ...(goal && !resumeSessionId && sessionId ? ['--session-id', sessionId] : []),
        ...(goal ? [] : ['--max-turns', maxTurns.toString()]),
        '--output-format', 'stream-json',
        '--verbose',
        ...inspectionArgs,
        ...(reasoningLevel ? ['--effort', reasoningLevel] : []),
        '--dangerously-skip-permissions'
    );
}

/**
 * Turns the per-run tool policy into Claude CLI switches plus name-only
 * variables; the runtime copies the token values from the launch environment.
 */
function resolveClaudeToolPolicy(
    toolPolicy: AgentToolPolicy | undefined,
    issueNumber: DockerArgsParams['issueNumber'],
    agentAlias: string,
): { cliArgs: string[]; envNames: string[] } {
    if (!toolPolicy) return { cliArgs: [], envNames: [] };
    const { cliArgs, env } = claudeToolPolicyArgs(toolPolicy);
    logger.info({
        issueNumber,
        allowWeb: toolPolicy.allowWeb,
        mcpServers: toolPolicy.mcpServers?.map(server => server.name) ?? [],
        agentAlias
    }, 'Applying tool policy to Claude agent');
    return { cliArgs, envNames: Object.keys(env) };
}

/**
 * Describes one Claude Code run as an {@link AgentRunSpec}:
 * - Security options (no-new-privileges, limited capabilities)
 * - Mounts (worktree, config, logs) and environment variables
 * - Claude CLI options (model, max-turns, output format)
 *
 * @param config - Agent configuration containing the image and env vars
 * @param maxTurns - Maximum number of conversation turns
 * @param params - Parameters for the run
 */
export function buildClaudeRunSpec(
    config: AgentConfig,
    maxTurns: number,
    params: DockerArgsParams
): AgentRunSpec {
    const {
        worktreePath, githubToken, modelName, issueNumber, systemPrompt, tools, environment,
        taskId, executionType, reasoningLevel, readOnlyWorkspace = false, repositoryInspection = false,
        executionMode = 'task', resumeSessionId, sessionId, toolPolicy,
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
    const workerOwnedGit = !agentOwnsGit(params);
    const policyArgs = resolveClaudeToolPolicy(toolPolicy, issueNumber, config.alias);
    const builder = buildBaseRunSpec({
        config,
        maxTurns,
        worktreePath,
        workspaceMountTarget,
        configPath,
        containerName: buildClaudeContainerName(config, issueNumber, taskId, executionMode === 'goal' ? 'goal' : executionType),
        githubToken,
        gitMountArgs: params.gitMountArgs,
        environmentSources: [config.envVars, environment],
        policyEnvNames: policyArgs.envNames,
        inspectionArgs,
        reasoningLevel,
        readOnlyWorkspace,
        repositoryInspection,
        workerOwnedGit,
        executionMode,
        resumeSessionId,
        sessionId,
        network: agentContainerNetwork(toolPolicy),
        mcpGrant: agentRunMcpGrant(toolPolicy),
    });
    const cliArgs = builder.spec.args;

    // Add model parameter if specified
    if (modelName) {
        // Strip agent prefix if present (e.g., "claude:claude-opus-4-6" -> "claude-opus-4-6")
        const savedModelName = modelName.includes(':') ? modelName.split(':').pop()! : modelName;
        // A saved selection of a model Anthropic has retired runs on its successor.
        const cleanModelName = currentClaudeModel(savedModelName);
        const maxTurnsIndex = cliArgs.indexOf('--max-turns');
        const modelIndex = maxTurnsIndex >= 0 ? maxTurnsIndex : cliArgs.indexOf('--output-format');
        cliArgs.splice(modelIndex, 0, '--model', cleanModelName);
        logger.info({
            issueNumber,
            requestedModel: cleanModelName,
            ...(cleanModelName !== savedModelName ? { retiredModel: savedModelName } : {}),
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
        cliArgs.push('--system-prompt', systemPrompt);
        logger.info({
            issueNumber,
            systemPromptLength: systemPrompt.length,
            agentAlias: config.alias
        }, 'Using custom system prompt');
    }

    // Add optional tools configuration
    if (effectiveTools !== undefined) {
        cliArgs.push('--tools', effectiveTools);
        logger.info({
            issueNumber,
            tools: effectiveTools,
            agentAlias: config.alias
        }, 'Using custom tools configuration');
    }

    cliArgs.push(...policyArgs.cliArgs);
    cliArgs.push(...operatorQuestionArgs(executionMode, params.operatorQuestions));

    logger.info({
        issueNumber,
        hasSystemPrompt: systemPrompt !== undefined,
        hasTools: effectiveTools !== undefined,
        hasReasoningLevel: !!reasoningLevel,
        agentAlias: config.alias
    }, 'Docker args built for Claude agent');

    return applyAgentRunLaunchWrapper(builder.build(), config.type);
}

/** The `docker run` argv for {@link buildClaudeRunSpec}. */
export function buildDockerArgs(
    config: AgentConfig,
    maxTurns: number,
    params: DockerArgsParams
): string[] {
    return renderDockerRunArgs(buildClaudeRunSpec(config, maxTurns, params));
}
