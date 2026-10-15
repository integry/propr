import { retireProviderRuntime } from '../../diagnostics/managedLogRuntime.js';
import { withPromptOnlyToolPolicy } from '../agentToolPolicy.js';
import fs from 'fs';
import { buildAgentGitCredentialArgs, buildAgentGitMountArgs, prepareAgentGitAccess, prepareAnalysisGitAccess } from '../agentGitAccess.js';
import logger from '../../utils/logger.js';
import { Agent, AgentConfig, AgentTaskOptions, AgentExecutionResult, AnalysisResult, AnalyzeOptions } from '../types.js';
import { executeDockerCommand } from '../../claude/docker/dockerExecutor.js';
import { buildAgentContainerResourceArgs, wrapDockerRunArgsWithRepoSetup } from '../../claude/docker/repoSetupWrapper.js';
import { verifyWorktreeStructure, verifyWorktreePostExecution, setWorktreeOwnership, UsageLimitError } from '../../claude/claudeHelpers.js';
import { resolveConfigPath, loadSettings, AgentConfigPathUnavailableError } from '../../config/configManager.js';
import { persistLlmLog, createLlmLogFromAnalysis, buildTaskWorkRef, buildAnalysisWorkRef, formatUsageMetrics, resolveTaskLogAttribution } from '../../utils/llmLogger.js';
import { buildAnalysisSafetySuffix, executeWithUsageTracking } from './utils/index.js';
import { parseVibeConversationLog, parseVibeOutput } from './utils/vibeOutputParser.js';
import { getAnalysisSandboxArgs, isSuccessfulVibeResult, splitVibeCliArgs, getDefaultVibeCliArgs, buildPromptWithRetryContext, buildLogMetadata, buildVibeFailureMessage, writeVibePromptFile, writeVibeSecretEnvFile, cleanupTempFile, buildVibeContainerName, resolveHostBindPath, getMistralApiKeyFromSettings, readLatestVibeSessionMessages, readLatestVibeSessionTokenUsage, ensureAnalysisWorkspace, prepareRuntimeHome, cleanupRuntimeHome, hasUsableVibeConfigDir, hasStructuredOutputArg } from './utils/vibeAgentHelpers.js';
import type { ExecutionType } from '../../utils/llmMetrics.types.js';
import { DEFAULT_AGENT_EXECUTION_TIMEOUT_MS } from '../constants.js';
import { NoDefaultModelConfiguredError } from '../../config/modelAliases.js';
import { resolveAgentTerminationReason } from '../termination.js';
import {
    REPOSITORY_SCOUT_CONTAINER_ROOT,
    REPOSITORY_SCOUT_PREFIXED_MCP_TOOLS,
} from './utils/repositoryScoutMcpServer.js';
import { buildVibeDockerEnvVars } from './utils/vibeDockerEnvironment.js';

export { UsageLimitError };
export { parseVibeConversationLog, parseVibeOutput } from './utils/vibeOutputParser.js';
export { getMistralApiKeyFromSettings, readLatestVibeSessionTokenUsage } from './utils/vibeAgentHelpers.js';

const DEFAULT_VIBE_MAX_TURNS = 1000;
const CONTAINER_CONFIG_PATH = '/home/node/.vibe';

function buildFailedExecutionResult(error: Error & { stderr?: string }, executionTimeMs: number, model: string | undefined): AgentExecutionResult {
    return { success: false, error: error.message, executionTimeMs, logs: error.stderr || error.message, modifiedFiles: [], commitMessage: null, summary: undefined, modelUsed: model || 'unknown' };
}

interface VibeDockerArgsParams {
    worktreePath: string;
    githubToken: string;
    gitMountArgs?: string[];
    modelName?: string;
    mistralApiKey?: string;
    issueNumber: number;
    taskId?: string;
    executionType?: string;
    maxTurns?: number;
    mode?: 'execute' | 'analysis';
    promptFilePath?: string;
    envFilePath?: string;
    runtimeHomePath?: string;
    repositoryInspection?: boolean;
}

export class VibeAgent implements Agent {
    readonly config: AgentConfig;
    readonly goalCapable = false;
    private readonly maxTurns: number;
    private readonly timeoutMs: number;

    constructor(config: AgentConfig) {
        this.config = config;
        this.maxTurns = parseInt(process.env.VIBE_MAX_TURNS || String(DEFAULT_VIBE_MAX_TURNS), 10);
        this.timeoutMs = parseInt(process.env.VIBE_TIMEOUT_MS || String(DEFAULT_AGENT_EXECUTION_TIMEOUT_MS), 10);
    }

    // eslint-disable-next-line complexity -- runtime admission, execution and cleanup share one task lifecycle
    async executeTask(options: AgentTaskOptions): Promise<AgentExecutionResult> {
        if (options.extensionProfile) throw new Error('Extension profiles require Claude or Codex task execution');
        const { worktreePath, issueRef, prompt: customPrompt, model, isRetry = false, retryReason, onSessionId, onContainerId, taskId, prNumber, metadata } = options;
        const startTime = Date.now();
        const effectiveModel = model || this.config.defaultModel;
        const repository = `${issueRef.repoOwner}/${issueRef.repoName}`;

        logger.info({
            issueNumber: issueRef.number,
            repository,
            worktreePath,
            dockerImage: this.config.dockerImage,
            agentAlias: this.config.alias,
            isRetry,
            retryReason
        }, isRetry ? 'Starting Vibe agent execution (RETRY)...' : 'Starting Vibe agent execution...');

        let promptFilePath: string | undefined;
        let envFilePath: string | undefined;
        let runtimeHomePath: string | undefined;
        try {
            // No native web switch: the restriction is best effort through the prompt.
            const prompt = buildPromptWithRetryContext(withPromptOnlyToolPolicy(customPrompt, options.toolPolicy), isRetry, retryReason);
            promptFilePath = writeVibePromptFile(prompt);
            const mistralApiKey = await this.getMistralApiKey();
            runtimeHomePath = prepareRuntimeHome(taskId);
            await setWorktreeOwnership(worktreePath, issueRef.number);
            const worktreeGitContent = verifyWorktreeStructure(worktreePath, issueRef.number);
            const { githubToken, gitMountArgs } = await prepareAgentGitAccess(options);
            envFilePath = writeVibeSecretEnvFile({ mistralApiKey, githubToken });
            const dockerArgs = this.buildDockerArgs({
                worktreePath,
                githubToken,
                gitMountArgs,
                modelName: effectiveModel,
                mistralApiKey,
                issueNumber: issueRef.number,
                taskId,
                promptFilePath,
                envFilePath,
                runtimeHomePath
            });
            const { result, usageMetrics } = await executeWithUsageTracking(
                'vibe',
                async () => executeDockerCommand('docker', dockerArgs, { diagnostics: this.diagnosticContext(runtimeHomePath, mistralApiKey, githubToken),
                    timeout: this.timeoutMs,
                    cwd: worktreePath,
                    onSessionId,
                    onContainerId,
                    worktreePath,
                    taskId,
                    streamToRedis: true,
                    streamStderrToRedis: true,
                    preserveOutputOnTimeout: true,
                    model: effectiveModel,
                    streamExtraOutput: () => readLatestVibeSessionMessages(runtimeHomePath)
                })
            );

            const executionTimeMs = Date.now() - startTime;
            const parsedOutput = parseVibeOutput(result.stdout);
            const conversationLog = parseVibeConversationLog(result.stdout);
            const tokenUsage = parsedOutput.tokenUsage || readLatestVibeSessionTokenUsage(runtimeHomePath);
            const modelUsed = parsedOutput.model || effectiveModel || 'unknown';
            const terminationReason = resolveAgentTerminationReason({ timedOut: result.timedOut, costCapExceeded: result.costCapExceeded, watchdogTrip: result.watchdogTrip, error: parsedOutput.error || result.stderr });
            const success = isSuccessfulVibeResult(result.exitCode, parsedOutput) && !terminationReason;
            const error = success ? undefined : buildVibeFailureMessage(result, parsedOutput);
            if (parsedOutput.sessionId && onSessionId) onSessionId(parsedOutput.sessionId);

            const response: AgentExecutionResult = {
                success,
                executionTimeMs,
                logs: result.stdout + (result.stderr ? `\n\nSTDERR:\n${result.stderr}` : ''),
                exitCode: result.exitCode,
                rawOutput: result.stdout,
                modelUsed,
                modifiedFiles: [],
                commitMessage: null,
                summary: parsedOutput.summary,
                prompt,
                sessionId: parsedOutput.sessionId,
                conversationLog,
                error,
                terminationReason,
                tokenUsage,
                usageMetrics: usageMetrics ?? undefined
            };

            const usage = formatUsageMetrics(usageMetrics);
            await persistLlmLog(createLlmLogFromAnalysis({
                ...resolveTaskLogAttribution(metadata, buildTaskWorkRef(taskId, issueRef.number, repository, prNumber), buildLogMetadata({ isRetry, retryReason }, result, !success)),
                modelUsed,
                executionTimeMs,
                success: response.success,
                tokenUsage,
                error: response.success ? undefined : (response.error || result.stderr || 'Execution failed'),
                sessionId: parsedOutput.sessionId,
                draftId: taskId,
                repository,
                agentAlias: this.config.alias,
                usageMetrics: usage.metrics,
                usageMetricRecords: usage.records,
            }));

            if (response.success) {
                logger.info({ issueNumber: issueRef.number, model: modelUsed, agentAlias: this.config.alias }, 'Vibe agent execution succeeded');
                verifyWorktreePostExecution(worktreePath, issueRef.number, worktreeGitContent);
            } else {
                logger.error({ issueNumber: issueRef.number, exitCode: result.exitCode, stderr: result.stderr, agentAlias: this.config.alias, error: response.error }, 'Vibe agent execution failed');
            }

            return response;
        } catch (error) {
            if (error instanceof UsageLimitError) throw error;
            const executionTimeMs = Date.now() - startTime;
            const err = error as Error & { stderr?: string };
            logger.error({ issueNumber: issueRef.number, repository, executionTimeMs, error: err.message, agentAlias: this.config.alias }, 'Error during Vibe agent execution');
            return buildFailedExecutionResult(err, executionTimeMs, effectiveModel);
        } finally {
            cleanupTempFile(promptFilePath);
            cleanupTempFile(envFilePath);
            cleanupRuntimeHome(runtimeHomePath);
            retireProviderRuntime(this.config.id, runtimeHomePath);
        }
    }

    // eslint-disable-next-line complexity
    async analyze(prompt: string, options?: AnalyzeOptions): Promise<AnalysisResult> {
        const { context, model, taskId, taskNumber, prNumber, executionType, correlationId, repository, metadata, timeoutMs, responseFormat = 'text', suppressLlmLog, readOnlyWorkspacePath, allowReadOnlyCommands = false } = options || {};
        const startTime = Date.now();
        const effectiveModel = model || this.config.defaultModel;
        if (!effectiveModel) throw new NoDefaultModelConfiguredError();
        const suffix = buildAnalysisSafetySuffix(responseFormat, allowReadOnlyCommands, readOnlyWorkspacePath);
        const analysisPrompt = context ? `${prompt}\n\nContext:\n${context}${suffix}` : `${prompt}${suffix}`;

        logger.info({ agentAlias: this.config.alias, promptLength: prompt.length, hasContext: !!context, requestedModel: model, taskId, executionType }, 'Running lightweight analysis via Vibe agent...');

        let analysisWorkspace: string | undefined;
        let promptFilePath: string | undefined;
        let envFilePath: string | undefined;
        let runtimeHomePath: string | undefined;
        try {
            analysisWorkspace = readOnlyWorkspacePath || ensureAnalysisWorkspace();
            promptFilePath = writeVibePromptFile(analysisPrompt);
            const mistralApiKey = await this.getMistralApiKey();
            const repositoryInspection = !!readOnlyWorkspacePath && allowReadOnlyCommands;
            const gitAccess = await prepareAnalysisGitAccess(options, analysisWorkspace);
            envFilePath = writeVibeSecretEnvFile({
                mistralApiKey,
                githubToken: gitAccess.githubToken,
            });
            runtimeHomePath = prepareRuntimeHome(taskId);
            const dockerArgs = this.buildDockerArgs({
                worktreePath: analysisWorkspace,
                ...gitAccess,
                modelName: effectiveModel,
                mistralApiKey,
                issueNumber: 0,
                taskId,
                executionType,
                maxTurns: 5,
                mode: 'analysis',
                promptFilePath,
                envFilePath,
                runtimeHomePath,
                repositoryInspection,
            });
            const { result, usageMetrics } = await executeWithUsageTracking(
                'vibe',
                async () => executeDockerCommand('docker', dockerArgs, { diagnostics: this.diagnosticContext(runtimeHomePath, mistralApiKey, gitAccess.githubToken),
                    timeout: timeoutMs ?? parseInt(process.env.VIBE_ANALYSIS_TIMEOUT_MS || '1800000', 10),
                    taskId,
                    model: effectiveModel
                }),
                undefined,
                this.config.alias,
                options?.skipUsageTracking
            );
            const executionTimeMs = Date.now() - startTime;
            const parsedOutput = parseVibeOutput(result.stdout);
            const tokenUsage = parsedOutput.tokenUsage || readLatestVibeSessionTokenUsage(runtimeHomePath);
            const analysisText = (parsedOutput.summary || '').trim();
            const success = !result.timedOut && isSuccessfulVibeResult(result.exitCode, parsedOutput) && !!analysisText;
            const usage = formatUsageMetrics(usageMetrics);
            const errorMsg = success ? undefined : buildVibeFailureMessage(result, parsedOutput);
            if (!suppressLlmLog) {
                await persistLlmLog(createLlmLogFromAnalysis({
                    executionType: (executionType || 'other') as ExecutionType,
                    modelUsed: parsedOutput.model || effectiveModel,
                    executionTimeMs,
                    success,
                    tokenUsage,
                    error: errorMsg,
                    sessionId: parsedOutput.sessionId,
                    draftId: taskId,
                    correlationId,
                    repository,
                    metadata: buildLogMetadata(metadata || {}, result, !success),
                    agentAlias: this.config.alias,
                    usageMetrics: usage.metrics,
                    usageMetricRecords: usage.records,
                    workRef: buildAnalysisWorkRef(executionType, taskId, repository, { taskNumber, prNumber }),
                }));
            }
            if (success) {
                return {
                    response: analysisText,
                    modelUsed: parsedOutput.model || effectiveModel,
                    executionTimeMs,
                    success: true,
                    tokenUsage,
                    sessionId: parsedOutput.sessionId
                };
            }
            return { response: '', modelUsed: effectiveModel, executionTimeMs, success: false, error: `Analysis failed: ${errorMsg}` };
        } catch (error) {
            const executionTimeMs = Date.now() - startTime;
            const err = error as Error;
            logger.error({ agentAlias: this.config.alias, error: err.message, executionTimeMs }, 'Lightweight analysis failed');
            return { response: '', modelUsed: effectiveModel, executionTimeMs, success: false, error: err.message };
        } finally {
            cleanupTempFile(promptFilePath);
            cleanupTempFile(envFilePath);
            cleanupRuntimeHome(runtimeHomePath);
            retireProviderRuntime(this.config.id, runtimeHomePath);
            if (analysisWorkspace && !readOnlyWorkspacePath) {
                try { fs.rmSync(analysisWorkspace, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
            }
        }
    }

    async healthCheck(): Promise<boolean> {
        logger.debug({ agentAlias: this.config.alias, dockerImage: this.config.dockerImage }, 'Running health check for Vibe agent...');
        try {
            const result = await executeDockerCommand('docker', ['images', '-q', this.config.dockerImage], { timeout: 10000 });
            const imageExists = !!result.stdout.trim();
            if (!imageExists) {
                logger.info({ agentAlias: this.config.alias, dockerImage: this.config.dockerImage }, 'Health check failed: Docker image not found');
                return false;
            }
            const { configPath } = this.resolveOptionalConfigPath();
            const mistralApiKey = await this.getMistralApiKey();
            const hasCredentials = !!mistralApiKey || (!!configPath && hasUsableVibeConfigDir(configPath, mistralApiKey));
            if (!hasCredentials) {
                logger.warn({ agentAlias: this.config.alias, configPath }, 'Health check warning: no Vibe credentials found (set MISTRAL_API_KEY or configure ~/.vibe)');
            }
            logger.info({ agentAlias: this.config.alias, dockerImage: this.config.dockerImage, imageExists, hasCredentials }, 'Health check passed');
            return true;
        } catch (error) {
            logger.error({ agentAlias: this.config.alias, error: (error as Error).message }, 'Health check failed with error');
            return false;
        }
    }

    private async getMistralApiKey(): Promise<string | undefined> {
        const explicitKey = process.env.MISTRAL_API_KEY?.trim() || this.config.envVars?.MISTRAL_API_KEY?.trim();
        if (explicitKey) return explicitKey;
        try {
            const settings = await loadSettings();
            return getMistralApiKeyFromSettings(settings);
        } catch (error) {
            logger.warn({ agentAlias: this.config.alias, error: (error as Error).message }, 'Failed to load Mistral API key from settings');
        }
        return undefined;
    }

    private getCliArgs(repositoryInspection: boolean): string[] {
        const processArgs = process.env.VIBE_CLI_ARGS;
        const configuredArgs = processArgs ?? this.config.envVars?.VIBE_CLI_ARGS;
        const source = processArgs !== undefined ? 'process.env.VIBE_CLI_ARGS' : 'config.envVars.VIBE_CLI_ARGS';
        let args: string[];
        if (!configuredArgs?.trim()) {
            args = getDefaultVibeCliArgs();
        } else {
            try { args = splitVibeCliArgs(configuredArgs); } catch (error) { throw new Error(`Invalid ${source}: ${(error as Error).message}`); }
            if (args.length === 0) {
                args = getDefaultVibeCliArgs();
            } else if (!hasStructuredOutputArg(args)) {
                const allowNoJson = process.env.VIBE_ALLOW_UNSTRUCTURED === '1' || this.config.envVars?.VIBE_ALLOW_UNSTRUCTURED === '1';
                if (!allowNoJson) {
                    throw new Error(`${source} does not include --output json. Structured output is required. Add --output json or set VIBE_ALLOW_UNSTRUCTURED=1 to override.`);
                }
                logger.warn({ source, args }, 'VIBE_CLI_ARGS override does not include --output json; structured output parsing may degrade');
            }
        }
        if (repositoryInspection) {
            for (const tool of REPOSITORY_SCOUT_PREFIXED_MCP_TOOLS) {
                args.push('--enabled-tools', tool);
            }
        }
        return args;
    }

    /**
     * Vibe's config directory is optional when an API key is available, so an
     * unmapped containerized default is reported as absent rather than thrown;
     * callers that need the directory rethrow `unavailable`. The backend HOME
     * is never substituted.
     */
    private resolveOptionalConfigPath(): { configPath?: string; unavailable?: AgentConfigPathUnavailableError } {
        try {
            return { configPath: resolveConfigPath(process.env.VIBE_CONFIG_PATH || this.config.configPath) };
        } catch (error) {
            if (error instanceof AgentConfigPathUnavailableError) return { unavailable: error };
            throw error;
        }
    }

    private diagnosticContext(nativeRoot: string | undefined, mistralApiKey?: string, githubToken?: string) {
        const { configPath } = this.resolveOptionalConfigPath();
        const hasUsableConfig = !!configPath && hasUsableVibeConfigDir(configPath, mistralApiKey);
        return { provider: this.config.type, agent: this.config.id, configPath, nativeRoot,
            authenticationRoot: hasUsableConfig ? configPath : nativeRoot, nativeCredentialContextComplete: !hasUsableConfig,
            credentials: { ...this.config.envVars, MISTRAL_API_KEY: mistralApiKey || '', GITHUB_TOKEN: githubToken || '' } };
    }

    private resolveCredentialsAndConfig(mistralApiKey?: string): { configPath: string | undefined; resolvedApiKey: string | undefined; hasUsableConfig: boolean; configMountArgs: string[] } {
        const { configPath, unavailable } = this.resolveOptionalConfigPath();
        const resolvedApiKey = mistralApiKey || process.env.MISTRAL_API_KEY?.trim() || this.config.envVars?.MISTRAL_API_KEY?.trim();
        // Directory credentials are required without an API key.
        if (!configPath) {
            if (!resolvedApiKey) throw unavailable!;
            return { configPath, resolvedApiKey, hasUsableConfig: false, configMountArgs: [] };
        }
        const hasUsableConfig = hasUsableVibeConfigDir(configPath, resolvedApiKey);
        if (!resolvedApiKey && !hasUsableConfig) throw new Error(`Vibe agent "${this.config.alias}" has no credentials. Set MISTRAL_API_KEY or ensure ${configPath} contains valid Vibe config files.`);
        return { configPath, resolvedApiKey, hasUsableConfig, configMountArgs: hasUsableConfig ? ['-v', `${configPath}:${CONTAINER_CONFIG_PATH}:ro`] : [] };
    }

    private buildPromptMountArgs(promptFilePath: string | undefined, cliArgs: string[]): string[] {
        if (!promptFilePath) return [];
        const hostPromptPath = resolveHostBindPath(promptFilePath);
        const containerPromptPath = '/home/node/propr-prompt.txt';
        cliArgs.push('--prompt-file', containerPromptPath);
        return ['-v', `${hostPromptPath}:${containerPromptPath}:ro`];
    }

    private buildDockerArgs(params: VibeDockerArgsParams): string[] {
        const { worktreePath, modelName, mistralApiKey, issueNumber, taskId, executionType, maxTurns = this.maxTurns, mode = 'execute', promptFilePath, envFilePath, runtimeHomePath, repositoryInspection = false } = params;
        if (repositoryInspection && mode !== 'analysis') {
            throw new Error('Repository inspection requires analysis mode');
        }
        const { configPath, hasUsableConfig, configMountArgs } = this.resolveCredentialsAndConfig(mistralApiKey);
        const cleanModelName = modelName?.includes(':') ? modelName.split(':').pop()! : modelName;
        const mistralEnvFileArgs = envFilePath ? ['--env-file', envFilePath] : [];
        const envVars = buildVibeDockerEnvVars(this.config, { cleanModelName, mode, maxTurns, runtimeHomePath, repositoryInspection });

        const containerName = buildVibeContainerName(this.config.alias, executionType || (issueNumber === 0 ? 'analysis' : `issue-${issueNumber}`), taskId, modelName);
        const workspaceMountMode = mode === 'analysis' ? 'ro' : 'rw';
        const cliArgs = this.getCliArgs(repositoryInspection);
        const promptMountArgs = this.buildPromptMountArgs(promptFilePath, cliArgs);
        const runtimeHomeMountArgs = runtimeHomePath ? ['-v', `${resolveHostBindPath(runtimeHomePath)}:/tmp/propr-vibe-home:rw`] : [];
        const dockerArgs: string[] = [
            'run', '--rm', '--name', containerName, '--security-opt', 'no-new-privileges', '--network', 'bridge',
            ...getAnalysisSandboxArgs(mode),
            '-v', `${worktreePath}:${repositoryInspection ? REPOSITORY_SCOUT_CONTAINER_ROOT : '/home/node/workspace'}:${workspaceMountMode}`,
            ...(repositoryInspection ? [] : params.gitMountArgs ?? buildAgentGitMountArgs(worktreePath, false, mode === 'analysis')),
            ...configMountArgs, ...promptMountArgs, ...runtimeHomeMountArgs, ...mistralEnvFileArgs,
            ...envVars, ...buildAgentGitCredentialArgs(), '-w', '/home/node/workspace', this.config.dockerImage, ...cliArgs
        ];
        const cliArgsSource = (process.env.VIBE_CLI_ARGS ?? this.config.envVars?.VIBE_CLI_ARGS) ? 'custom' : 'default';
        logger.info({ issueNumber, agentAlias: this.config.alias, mode, dockerImage: this.config.dockerImage, configPath, configPathMounted: hasUsableConfig, workspaceMountMode, cliArgsSource, cliArgCount: cliArgs.length }, 'Docker args built for Vibe agent');
        if (mode === 'analysis') return [dockerArgs[0], ...buildAgentContainerResourceArgs(), ...dockerArgs.slice(1)];
        return wrapDockerRunArgsWithRepoSetup(dockerArgs, this.config.dockerImage, 'vibe');
    }

}
