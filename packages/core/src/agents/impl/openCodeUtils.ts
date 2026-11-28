import { buildAgentGitCredentialArgs, buildAgentGitMountArgs } from '../agentGitAccess.js';
import fs from 'fs';
import { currentOpenCodeModel, isManagedAgentConfigPath } from '@propr/shared';
import logger from '../../utils/logger.js';
import { resolveConfigPath } from '../../config/configManager.js';
import { applyAgentRunLaunchWrapper } from '../../claude/docker/repoSetupWrapper.js';
import { AgentRunSpecBuilder, agentRunMcpGrant, agentRunNetwork } from '../runtime/agentRunSpec.js';
import { renderDockerRunArgs } from '../runtime/dockerRunArgs.js';
import type { AgentRunSpec } from '../runtime/types.js';
import { generateClaudePrompt, type IssueDetails, type IssueRef } from '../../claude/prompts/promptGenerator.js';
import type { AgentConfig, AgentToolPolicy, AnalysisResult } from '../types.js';
import { agentContainerNetwork } from '../agentContainerNetwork.js';
import { mergeOpenCodeConfigContent, openCodeMcpConfig, openCodeToolPolicyArgs, openCodeToolPolicyEnvironment } from '../mcpLaunch/openCodeMcpLaunch.js';
import { createContainerExecutionId } from './utils/containerExecutionId.js';
import {
    buildOpenCodeRepositoryScoutConfig,
    REPOSITORY_SCOUT_CONTAINER_ROOT,
} from './utils/repositoryScoutMcpServer.js';
export { normalizeOpenCodeCliModelName, toOpenCodeExternalModelId, toProprOpenCodeExternalModelId, toProprOpenCodeModelId, toOpenCodeGoOpenRouterId } from './openCodeModelIds.js';
export { hasOpenCodeTokenUsage, isOpenCodeJsonlEvent, normalizeOpenCodeUsage, parseOpenCodeJsonl, parseOpenCodeStreamOutput, resolveOpenCodeFailureReason } from './openCodeParsing.js';
export type { NormalizedOpenCodeUsage, OpenCodeEvent, OpenCodeUsage, ParsedOpenCodeOutput } from './openCodeParsing.js';
import { resolveOpenCodeFailureReason, type ParsedOpenCodeOutput } from './openCodeParsing.js';
import { toOpenCodeExternalModelId } from './openCodeModelIds.js';
import { openCodeEnvVarRejection } from './openCodeEnvForwarding.js';

const CONTAINER_CONFIG_PATH = '/home/node/.config/opencode';
const CONTAINER_SOURCE_DATA_PATH = '/home/node/.local/share/opencode-source';
const CONTAINER_RUNTIME_DATA_HOME = '/tmp/propr-opencode-data';

export interface BuildOpenCodePromptOptions { customPrompt?: string; issueRef: IssueRef; branchName?: string; modelName?: string; issueDetails?: IssueDetails; isRetry?: boolean; retryReason?: string; systemPrompt?: string; }

export interface OpenCodeDockerArgsParams {
    config: AgentConfig; worktreePath: string; githubToken: string; modelName?: string; issueNumber: number;
    taskId?: string; executionType?: string; readOnlyWorkspace?: boolean; configPath?: string;
    repositoryInspection?: boolean;
    gitMountArgs?: string[];
    dataPath?: string;
    ensureConfigPath?: (configPath: string) => void;
    /** Task runs only: run MCP servers, skills and the exclusive switch (OpenCode 2.x). */
    toolPolicy?: AgentToolPolicy;
}

export function evaluateOpenCodeAnalysis(options: {
    parsedOutput: ParsedOpenCodeOutput;
    processResult: { timedOut?: boolean; exitCode: number | null; stderr?: string };
    effectiveModel: string;
    executionTimeMs: number;
}): {
    analysisText: string;
    modelUsed: string;
    success: boolean;
    errorMsg: string;
    result: AnalysisResult;
} {
    const { parsedOutput, processResult, effectiveModel, executionTimeMs } = options;
    const analysisText = (parsedOutput.summary || '').trim();
    const modelUsed = parsedOutput.modelUsed || effectiveModel;
    const success = !processResult.timedOut
        && processResult.exitCode === 0
        && !parsedOutput.error
        && analysisText.length > 0;
    const errorMsg = resolveOpenCodeFailureReason(parsedOutput, processResult.stderr) || processResult.stderr || 'No assistant text returned';
    const result: AnalysisResult = success
        ? {
            response: analysisText, modelUsed, executionTimeMs, success: true,
            sessionId: parsedOutput.sessionId, tokenUsage: parsedOutput.tokenUsage,
        }
        : {
            response: analysisText, modelUsed, executionTimeMs, success: false,
            error: `Analysis failed: ${errorMsg}`, tokenUsage: parsedOutput.tokenUsage,
        };
    return { analysisText, modelUsed, success, errorMsg, result };
}

export function buildOpenCodePrompt(options: BuildOpenCodePromptOptions): string {
    const { customPrompt, issueRef, branchName, modelName, issueDetails, isRetry, retryReason, systemPrompt } = options;

    const basePrompt = customPrompt || generateClaudePrompt({
        issueRef, branchName: branchName ?? null, modelName: modelName ?? null, issueDetails: issueDetails ?? null
    });
    const systemContext = systemPrompt ? `SYSTEM INSTRUCTIONS:\n${systemPrompt}\n\n---\n\n` : '';
    let prompt = `${systemContext}${basePrompt}

**CRITICAL GIT SAFETY RULES:**
- NEVER run 'rm .git' or delete the .git file/directory
- NEVER run 'git init' in the workspace - this is already a git repository
- If you encounter git errors, report them but DO NOT attempt to reinitialize the repository
- The workspace is a git worktree linked to the main repository
- Only make changes to the specific files mentioned in the issue/request
- If git commands fail, describe the error but do NOT try destructive recovery methods
- The system will automatically commit your changes after you complete the modifications`;

    if (isRetry && retryReason) {
        prompt += `\n\n---\n\n**RETRY CONTEXT**: This is a retry attempt. Previous attempt failed with: ${retryReason}\n\nPlease address the issues from the previous attempt.`;
    }

    logger.debug({ issueNumber: issueRef.number, promptLength: prompt.length, hasSafetyRules: prompt.includes('CRITICAL GIT SAFETY RULES'), isCustomPrompt: !!customPrompt }, 'Generated OpenCode prompt with safety rules');

    return prompt;
}

export function buildOpenCodeRunSpec(params: OpenCodeDockerArgsParams): AgentRunSpec {
    const { config, worktreePath, githubToken, modelName, issueNumber, taskId, executionType, readOnlyWorkspace, repositoryInspection = false, dataPath, ensureConfigPath = ensureDirectory, toolPolicy } = params;
    assertRepositoryInspectionMode(repositoryInspection, readOnlyWorkspace);
    const configPath = params.configPath || resolveConfigPath(config.configPath);
    const managedCredentials = isManagedAgentConfigPath(config.configPath);
    ensureConfigPath(configPath);
    const dataMount = resolveOpenCodeDataMount(configPath, config.envVars, dataPath, managedCredentials);
    const shortTaskId = createContainerExecutionId(taskId);
    const taskType = executionType || (issueNumber === 0 ? 'analysis' : `issue-${issueNumber}`);
    const containerName = buildOpenCodeContainerName(config.alias || 'opencode', taskType, shortTaskId, modelName);
    const workspaceMode = (readOnlyWorkspace ?? issueNumber === 0) ? 'ro' : 'rw';
    // Single execution path for every OpenCode run (task and analysis alike):
    // the prompt always arrives over stdin and is attached via the opencode-run
    // wrapper. Normal runs auto-approve prompts inside the task container. Scout
    // runs instead use an inline, highest-precedence deny-first policy and auto
    // mode, which still enforces explicit denies.
    const title = issueNumber === 0 ? 'ProPR analysis' : 'ProPR task';
    const legacyCli = isLegacyOpenCodeCli(config);
    assertOpenCodeToolPolicySupported(legacyCli, toolPolicy);
    const commandArgs = ['opencode-run', '--format', 'json', '--title', title, ...buildOpenCodePermissionFlags(legacyCli, repositoryInspection)];
    const builder = new AgentRunSpecBuilder({
        agentType: 'opencode', image: config.dockerImage, alias: config.alias, name: containerName, stdin: true, user: '0:0',
        network: agentRunNetwork(agentContainerNetwork(toolPolicy)), security: { capAdd: ['CHOWN'] },
        mcpGrant: agentRunMcpGrant(toolPolicy),
        workspace: {
            hostPath: worktreePath,
            containerPath: repositoryInspection ? REPOSITORY_SCOUT_CONTAINER_ROOT : '/home/node/workspace',
            readOnly: workspaceMode === 'ro',
        },
    }).workspaceMount();
    if (!repositoryInspection) builder.dockerOptions(params.gitMountArgs ?? buildAgentGitMountArgs(worktreePath, false, workspaceMode === 'ro'), 'git');
    builder.credentialBind(configPath, CONTAINER_CONFIG_PATH, false, { provider: 'opencode', store: 'config', perRun: true });
    if (!repositoryInspection) builder.env('GH_TOKEN', githubToken).env('GITHUB_TOKEN', githubToken);
    // User env vars precede the ProPR-managed OpenCode config vars so the
    // managed values (scout isolation in particular) win on duplicates.
    addEnvVars(builder, config);
    addOpenCodeConfigEnv(builder, legacyCli, repositoryInspection, toolPolicy);
    if (readOnlyWorkspace) builder.env('PROPR_REPO_SETUP', '0');
    builder.env('XDG_CONFIG_HOME', '/home/node/.config').env('XDG_DATA_HOME', CONTAINER_RUNTIME_DATA_HOME).env('PROPR_EPHEMERAL_STATE', '1');
    if (managedCredentials) builder.env('PROPR_MANAGED_CREDENTIALS', '1');
    builder.dockerOptions(buildAgentGitCredentialArgs(), 'credential');
    if (dataMount) {
        builder
            .credentialBind(dataMount.hostPath, CONTAINER_SOURCE_DATA_PATH, dataMount.mode === 'ro', { provider: 'opencode', store: 'data', perRun: true })
            .env('PROPR_OPENCODE_SOURCE_DATA', CONTAINER_SOURCE_DATA_PATH);
    }
    builder.command(...commandArgs);

    if (modelName) {
        // A saved selection of a retired free model runs on its current successor.
        const cleanModelName = toOpenCodeExternalModelId(currentOpenCodeModel(modelName));
        builder.command('--model', cleanModelName);
        logger.info({ issueNumber, requestedModel: cleanModelName, originalModel: modelName, agentAlias: config.alias }, 'Model specified for OpenCode agent');
    }

    return applyAgentRunLaunchWrapper(builder.build(), 'opencode');
}

export function buildOpenCodeDockerArgs(params: OpenCodeDockerArgsParams): string[] {
    return renderDockerRunArgs(buildOpenCodeRunSpec(params));
}

function isLegacyOpenCodeCli(config: AgentConfig): boolean {
    return (config.cliVersionResolved ?? config.cliVersion)?.startsWith('1.') ?? false;
}

function buildOpenCodePermissionFlags(legacyCli: boolean, repositoryInspection: boolean): string[] {
    if (!legacyCli) return ['--auto'];
    return repositoryInspection ? ['--pure', '--auto'] : ['--dangerously-skip-permissions'];
}

/**
 * OpenCode 1.x ignores `mcp.servers` and `skills.paths`, so a run that needs
 * them must not start on it with the servers silently missing. The capability
 * map already withholds extensions from 1.x; this guards direct policies.
 */
function assertOpenCodeToolPolicySupported(legacyCli: boolean, toolPolicy: AgentToolPolicy | undefined): void {
    if (legacyCli && toolPolicy && openCodeMcpConfig(toolPolicy)) {
        throw new Error('MCP servers and skills require OpenCode CLI 2.x; this agent runs OpenCode 1.x');
    }
}

/**
 * The run's MCP servers and skill path (merged into any existing inline config),
 * the exclusive switches, then the token and stdio secret names. Names only, after
 * operator variables so their envVars cannot change them: the runtime copies the
 * values from the launch environment.
 */
function addOpenCodeToolPolicyEnv(builder: AgentRunSpecBuilder, existingContent: string | undefined, toolPolicy: AgentToolPolicy | undefined): void {
    const content = mergeOpenCodeConfigContent(existingContent, toolPolicy && openCodeMcpConfig(toolPolicy));
    if (content) builder.env('OPENCODE_CONFIG_CONTENT', content);
    if (!toolPolicy) return;
    builder.dockerOptions(openCodeToolPolicyEnvironment(toolPolicy), 'scratch');
    for (const name of Object.keys(openCodeToolPolicyArgs(toolPolicy).env)) builder.env(name);
}

function addOpenCodeConfigEnv(builder: AgentRunSpecBuilder, legacyCli: boolean, repositoryInspection: boolean, toolPolicy?: AgentToolPolicy): void {
    if (!repositoryInspection || legacyCli) builder.env('OPENCODE_CONFIG_DIR', CONTAINER_CONFIG_PATH);
    else {
        builder
            .env('OPENCODE_CONFIG_DIR', '/tmp/propr-opencode-scout-config')
            .env('OPENCODE_CONFIG_PROJECT_DISABLE', '1').env('OPENCODE_DISABLE_CLAUDE_CODE', '1').env('OPENCODE_CONFIG', '');
    }
    addOpenCodeToolPolicyEnv(builder, repositoryInspection ? buildOpenCodeRepositoryScoutConfig(legacyCli) : undefined, toolPolicy);
}

function assertRepositoryInspectionMode(repositoryInspection: boolean, readOnlyWorkspace: boolean | undefined): void {
    if (repositoryInspection && !readOnlyWorkspace) throw new Error('Repository inspection requires a read-only workspace');
}

interface OpenCodeDataMount { hostPath: string; mode: 'ro' | 'rw'; }

function resolveOpenCodeDataMount(
    configPath: string,
    envVars: AgentConfig['envVars'],
    explicitHostDataPath?: string,
    managedCredentials = false
): OpenCodeDataMount | null {
    const configuredHostDataPath = process.env.HOST_OPENCODE_DATA_DIR;
    if (configuredHostDataPath && !managedCredentials) return { hostPath: configuredHostDataPath, mode: 'rw' };
    if (explicitHostDataPath) return { hostPath: explicitHostDataPath, mode: 'rw' };
    if (envVars?.XDG_DATA_HOME && shouldForwardEnvVar('XDG_DATA_HOME', envVars.XDG_DATA_HOME)) return null;
    const inferredHostDataPath = inferOpenCodeDataPath(configPath);
    return inferredHostDataPath && fs.existsSync(inferredHostDataPath)
        ? { hostPath: inferredHostDataPath, mode: 'rw' }
        : null;
}

export function inferOpenCodeDataPath(configPath: string): string | null {
    let end = configPath.length;
    while (end > 0 && configPath.charCodeAt(end - 1) === 47) end--;
    const normalized = configPath.slice(0, end);
    if (normalized.endsWith('/.config/opencode')) {
        return `${normalized.slice(0, -'/.config/opencode'.length)}/.local/share/opencode`;
    }
    return null;
}

function addEnvVars(builder: AgentRunSpecBuilder, config: AgentConfig): void {
    if (!config.envVars) return;
    for (const [key, value] of Object.entries(config.envVars)) {
        if (!shouldForwardEnvVar(key, value)) continue;
        builder.env(key, value);
    }
}

/**
 * Decide whether a user-configured env var is safe to forward into the OpenCode
 * container. Rejects invalid names, GitHub credential vars (the container gets
 * its scoped token injected separately), wrapper-managed vars, and values
 * containing newlines/NUL.
 */
export function shouldForwardEnvVar(key: string, value: string): boolean {
    const rejection = openCodeEnvVarRejection(key, value);
    if (rejection) logger.warn({ envVar: key }, REJECTION_MESSAGES[rejection]);
    return !rejection;
}

const REJECTION_MESSAGES = {
    'invalid-name': 'Skipping OpenCode env var with invalid name',
    'github-credential': 'Skipping GitHub credential env var for OpenCode container',
    reserved: 'Skipping OpenCode env var managed by ProPR',
    'unsafe-value': 'Skipping OpenCode env var with unsupported multiline or NUL value',
} as const;

function buildOpenCodeContainerName(alias: string, taskType: string, shortTaskId: string, modelName?: string): string {
    const suffix = `-${shortTaskId}`;
    const rawPrefix = modelName
        ? `${alias}-${taskType}-${modelName}`
        : `${alias}-${taskType}`;
    const maxPrefixLength = Math.max(1, 120 - suffix.length);
    const sanitizedPrefix = rawPrefix.replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '').slice(0, maxPrefixLength).replace(/[^a-zA-Z0-9]+$/, '');
    const sanitized = `${sanitizedPrefix || 'opencode'}${suffix}`;
    return (sanitized || `opencode-${Date.now().toString(36)}`).slice(0, 128);
}

function ensureDirectory(configPath: string): void { fs.mkdirSync(configPath, { recursive: true, mode: 0o700 }); }
