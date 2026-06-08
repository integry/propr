import fs from 'fs';
import logger from '../../utils/logger.js';
import { Agent, AgentConfig, AgentTaskOptions, AgentExecutionResult, AnalysisResult, AnalyzeOptions } from '../types.js';
import { executeDockerCommand } from '../../claude/docker/dockerExecutor.js';
import { wrapDockerRunArgsWithRepoSetup } from '../../claude/docker/repoSetupWrapper.js';
import { verifyWorktreeStructure, verifyWorktreePostExecution, setWorktreeOwnership, UsageLimitError } from '../../claude/claudeHelpers.js';
import { resolveConfigPath, loadSettings } from '../../config/configManager.js';
import { persistLlmLog, createLlmLogFromAnalysis, buildTaskWorkRef, buildAnalysisWorkRef, formatUsageMetrics } from '../../utils/llmLogger.js';
import { executeWithUsageTracking } from './utils/index.js';
import { parseVibeConversationLog, parseVibeOutput } from './utils/vibeOutputParser.js';
import { getAnalysisSandboxArgs, getForwardedVibeEnvVars, isSuccessfulVibeResult, splitVibeCliArgs, getDefaultVibeCliArgs, buildPromptWithRetryContext, buildLogMetadata, buildVibeFailureMessage, writeVibePromptFile, writeVibeSecretEnvFile, cleanupTempFile, buildVibeContainerName, resolveHostBindPath, getMistralApiKeyFromSettings, readLatestVibeSessionMessages, readLatestVibeSessionTokenUsage, ensureAnalysisWorkspace, prepareRuntimeHome, cleanupRuntimeHome, hasUsableVibeConfigDir, hasStructuredOutputArg } from './utils/vibeAgentHelpers.js';
import type { ExecutionType } from '../../utils/llmMetrics.types.js';

export { UsageLimitError };
export { parseVibeConversationLog, parseVibeOutput } from './utils/vibeOutputParser.js';
export { getMistralApiKeyFromSettings, readLatestVibeSessionTokenUsage } from './utils/vibeAgentHelpers.js';

const DEFAULT_VIBE_MAX_TURNS = 1000;
const DEFAULT_VIBE_TIMEOUT_MS = 3600000;
const CONTAINER_CONFIG_PATH = '/home/node/.vibe';

interface VibeDockerArgsParams {
    worktreePath: string;
    githubToken: string;
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
}

export class VibeAgent implements Agent {
    readonly config: AgentConfig;
    private readonly maxTurns: number;
    private readonly timeoutMs: number;

    constructor(config: AgentConfig) {
        this.config = config;
        this.maxTurns = parseInt(process.env.VIBE_MAX_TURNS || String(DEFAULT_VIBE_MAX_TURNS), 10);
        this.timeoutMs = parseInt(process.env.VIBE_TIMEOUT_MS || String(DEFAULT_VIBE_TIMEOUT_MS), 10);
    }

    async executeTask(options: AgentTaskOptions): Promise<AgentExecutionResult> {
        const { worktreePath, issueRef, prompt: customPrompt, model, isRetry = false, retryReason, onSessionId, onContainerId, githubToken, taskId, prNumber } = options;
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
            const prompt = buildPromptWithRetryContext(customPrompt, isRetry, retryReason);
            promptFilePath = writeVibePromptFile(prompt);
            const mistralApiKey = await this.getMistralApiKey();
            envFilePath = writeVibeSecretEnvFile({ mistralApiKey, githubToken });
            runtimeHomePath = prepareRuntimeHome(taskId);
            await setWorktreeOwnership(worktreePath, issueRef.number);
            const worktreeGitContent = verifyWorktreeStructure(worktreePath, issueRef.number);
            const dockerArgs = this.buildDockerArgs({
                worktreePath,
                githubToken,
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
                async () => executeDockerCommand('docker', dockerArgs, {
                    timeout: this.timeoutMs,
                    cwd: worktreePath,
                    onSessionId,
                    onContainerId,
                    worktreePath,
                    taskId,
                    streamToRedis: true,
                    streamStderrToRedis: true,
                    streamExtraOutput: () => readLatestVibeSessionMessages(runtimeHomePath)
                })
            );

            const executionTimeMs = Date.now() - startTime;
            const parsedOutput = parseVibeOutput(result.stdout);
            const conversationLog = parseVibeConversationLog(result.stdout);
            const tokenUsage = parsedOutput.tokenUsage || readLatestVibeSessionTokenUsage(runtimeHomePath);
            const modelUsed = parsedOutput.model || effectiveModel || 'unknown';
            const success = isSuccessfulVibeResult(result.exitCode, parsedOutput);
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
                tokenUsage,
                usageMetrics: usageMetrics ?? undefined
            };

            const usage = formatUsageMetrics(usageMetrics);
            await persistLlmLog(createLlmLogFromAnalysis({
                executionType: 'implementation',
                modelUsed,
                executionTimeMs,
                success: response.success,
                tokenUsage,
                error: response.success ? undefined : (response.error || result.stderr || 'Execution failed'),
                sessionId: parsedOutput.sessionId,
                draftId: taskId,
                repository,
                agentAlias: this.config.alias,
                metadata: buildLogMetadata({ isRetry, retryReason }, result, !success),
                usageMetrics: usage.metrics,
                usageMetricRecords: usage.records,
                workRef: buildTaskWorkRef(taskId, issueRef.number, repository, prNumber),
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
            const err = error as Error;
            logger.error({ issueNumber: issueRef.number, repository, executionTimeMs, error: err.message, agentAlias: this.config.alias }, 'Error during Vibe agent execution');
            return {
                success: false,
                error: err.message,
                executionTimeMs,
                logs: (error as { stderr?: string }).stderr || err.message,
                modifiedFiles: [],
                commitMessage: null,
                summary: undefined,
                modelUsed: effectiveModel || 'unknown'
            };
        } finally {
            cleanupTempFile(promptFilePath);
            cleanupTempFile(envFilePath);
            cleanupRuntimeHome(runtimeHomePath);
        }
    }

    // eslint-disable-next-line complexity
    async analyze(prompt: string, options?: AnalyzeOptions): Promise<AnalysisResult> {
        const { context, model, taskId, taskNumber, prNumber, executionType, correlationId, repository, metadata, timeoutMs, responseFormat = 'text' } = options || {};
        const startTime = Date.now();
        const effectiveModel = model || this.config.defaultModel || 'mistral-medium-3.5';
        const suffix = responseFormat === 'json'
            ? '\n\nCRITICAL: Do not modify any files. Do not run any commands. Return only valid JSON matching the requested schema. Do not include markdown or explanatory text.'
            : '\n\nCRITICAL: Do not modify any files. Do not run any commands. Only provide your analysis as plain text output.';
        const analysisPrompt = context ? `${prompt}\n\nContext:\n${context}${suffix}` : `${prompt}${suffix}`;

        logger.info({ agentAlias: this.config.alias, promptLength: prompt.length, hasContext: !!context, requestedModel: model, taskId, executionType }, 'Running lightweight analysis via Vibe agent...');

        let analysisWorkspace: string | undefined;
        let promptFilePath: string | undefined;
        let envFilePath: string | undefined;
        let runtimeHomePath: string | undefined;
        try {
            analysisWorkspace = ensureAnalysisWorkspace();
            promptFilePath = writeVibePromptFile(analysisPrompt);
            const mistralApiKey = await this.getMistralApiKey();
            envFilePath = writeVibeSecretEnvFile({ mistralApiKey, githubToken: process.env.GITHUB_TOKEN });
            runtimeHomePath = prepareRuntimeHome(taskId);
            const dockerArgs = this.buildDockerArgs({
                worktreePath: analysisWorkspace,
                githubToken: process.env.GITHUB_TOKEN || '',
                modelName: effectiveModel,
                mistralApiKey,
                issueNumber: 0,
                taskId,
                executionType,
                maxTurns: 5,
                mode: 'analysis',
                promptFilePath,
                envFilePath,
                runtimeHomePath
            });
            const { result, usageMetrics } = await executeWithUsageTracking(
                'vibe',
                async () => executeDockerCommand('docker', dockerArgs, {
                    timeout: timeoutMs ?? parseInt(process.env.VIBE_ANALYSIS_TIMEOUT_MS || '1800000', 10),
                    taskId
                })
            );
            const executionTimeMs = Date.now() - startTime;
            const parsedOutput = parseVibeOutput(result.stdout);
            const tokenUsage = parsedOutput.tokenUsage || readLatestVibeSessionTokenUsage(runtimeHomePath);
            const analysisText = (parsedOutput.summary || '').trim();
            const success = isSuccessfulVibeResult(result.exitCode, parsedOutput);
            const usage = formatUsageMetrics(usageMetrics);

            if (success && analysisText) {
                await persistLlmLog(createLlmLogFromAnalysis({
                    executionType: (executionType || 'other') as ExecutionType,
                    modelUsed: parsedOutput.model || effectiveModel,
                    executionTimeMs,
                    success: true,
                    tokenUsage,
                    sessionId: parsedOutput.sessionId,
                    draftId: taskId,
                    correlationId,
                    repository,
                    metadata: buildLogMetadata(metadata || {}, result, false),
                    agentAlias: this.config.alias,
                    usageMetrics: usage.metrics,
                    usageMetricRecords: usage.records,
                    workRef: buildAnalysisWorkRef(executionType, taskId, repository, { taskNumber, prNumber }),
                }));

                return {
                    response: analysisText,
                    modelUsed: parsedOutput.model || effectiveModel,
                    executionTimeMs,
                    success: true,
                    tokenUsage,
                    sessionId: parsedOutput.sessionId
                };
            }

            const errorMsg = buildVibeFailureMessage(result, parsedOutput);
            await persistLlmLog(createLlmLogFromAnalysis({
                executionType: (executionType || 'other') as ExecutionType,
                modelUsed: parsedOutput.model || effectiveModel,
                executionTimeMs,
                success: false,
                tokenUsage,
                error: errorMsg,
                sessionId: parsedOutput.sessionId,
                draftId: taskId,
                correlationId,
                repository,
                metadata: buildLogMetadata(metadata || {}, result, true),
                agentAlias: this.config.alias,
                usageMetrics: usage.metrics,
                usageMetricRecords: usage.records,
                workRef: buildAnalysisWorkRef(executionType, taskId, repository, { taskNumber, prNumber }),
            }));
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
            if (analysisWorkspace) {
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
            const configPath = resolveConfigPath(process.env.VIBE_CONFIG_PATH || this.config.configPath);
            const mistralApiKey = await this.getMistralApiKey();
            const hasCredentials = !!mistralApiKey || hasUsableVibeConfigDir(configPath, mistralApiKey);
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

    private getCliArgs(): string[] {
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
        return args;
    }

    private buildDockerEnvVars(params: { cleanModelName?: string; mode: 'execute' | 'analysis'; maxTurns: number; runtimeHomePath?: string }): string[] {
        const { cleanModelName, mode, maxTurns, runtimeHomePath } = params;
        const forwardedEnvVars = getForwardedVibeEnvVars(this.config.envVars);
        for (const envVar of forwardedEnvVars.skipped) logger.warn({ agentAlias: this.config.alias, envVar }, 'Skipping invalid Vibe Docker environment variable');
        const envVars = forwardedEnvVars.dockerArgs;
        if (cleanModelName) envVars.push('-e', `VIBE_ACTIVE_MODEL=${cleanModelName}`);
        envVars.push('-e', 'VIBE_SOURCE_HOME=/home/node/.vibe');
        if (runtimeHomePath) envVars.push('-e', 'VIBE_RUNTIME_HOME=/tmp/propr-vibe-home', '-e', 'HOME=/tmp/propr-vibe-home');
        if (mode === 'analysis') {
            const analysisDirs = ['VIBE_READ_ONLY_CONFIG=1', 'XDG_CACHE_HOME=/tmp/propr-vibe-cache', 'XDG_CONFIG_HOME=/tmp/propr-vibe-config', 'XDG_DATA_HOME=/tmp/propr-vibe-data', 'UV_CACHE_DIR=/tmp/propr-uv-cache', 'HOME=/tmp/propr-vibe-home', 'VIBE_RUNTIME_HOME=/tmp/propr-vibe-home', 'XDG_STATE_HOME=/tmp/propr-vibe-state', 'PIP_CACHE_DIR=/tmp/propr-pip-cache', 'PYTHONPYCACHEPREFIX=/tmp/propr-python-cache'];
            for (const dir of analysisDirs) envVars.push('-e', dir);
        }
        envVars.push('-e', `VIBE_MAX_TURNS=${maxTurns}`);
        return envVars;
    }

    private resolveCredentialsAndConfig(mistralApiKey?: string): { configPath: string; resolvedApiKey: string | undefined; hasUsableConfig: boolean; configMountArgs: string[] } {
        const configPath = resolveConfigPath(process.env.VIBE_CONFIG_PATH || this.config.configPath);
        const resolvedApiKey = mistralApiKey || process.env.MISTRAL_API_KEY?.trim() || this.config.envVars?.MISTRAL_API_KEY?.trim();
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
        const { worktreePath, modelName, mistralApiKey, issueNumber, taskId, executionType, maxTurns = this.maxTurns, mode = 'execute', promptFilePath, envFilePath, runtimeHomePath } = params;
        const { configPath, hasUsableConfig, configMountArgs } = this.resolveCredentialsAndConfig(mistralApiKey);
        const cleanModelName = modelName?.includes(':') ? modelName.split(':').pop()! : modelName;
        const mistralEnvFileArgs = envFilePath ? ['--env-file', envFilePath] : [];
        const envVars = this.buildDockerEnvVars({ cleanModelName, mode, maxTurns, runtimeHomePath });

        const containerName = buildVibeContainerName(this.config.alias, executionType || (issueNumber === 0 ? 'analysis' : `issue-${issueNumber}`), taskId, modelName);
        const workspaceMountMode = mode === 'analysis' ? 'ro' : 'rw';
        const cliArgs = this.getCliArgs();
        const promptMountArgs = this.buildPromptMountArgs(promptFilePath, cliArgs);
        const runtimeHomeMountArgs = runtimeHomePath ? ['-v', `${resolveHostBindPath(runtimeHomePath)}:/tmp/propr-vibe-home:rw`] : [];
        const dockerArgs: string[] = [
            'run', '--rm', '--name', containerName, '--security-opt', 'no-new-privileges', '--network', 'bridge',
            ...getAnalysisSandboxArgs(mode),
            '-v', `${worktreePath}:/home/node/workspace:${workspaceMountMode}`,
            ...configMountArgs, ...promptMountArgs, ...runtimeHomeMountArgs, ...mistralEnvFileArgs,
            ...envVars, '-w', '/home/node/workspace', this.config.dockerImage, ...cliArgs
        ];
        const cliArgsSource = (process.env.VIBE_CLI_ARGS ?? this.config.envVars?.VIBE_CLI_ARGS) ? 'custom' : 'default';
        logger.info({ issueNumber, agentAlias: this.config.alias, mode, dockerImage: this.config.dockerImage, configPath, configPathMounted: hasUsableConfig, workspaceMountMode, cliArgsSource, cliArgCount: cliArgs.length }, 'Docker args built for Vibe agent');
        if (mode === 'analysis') return dockerArgs;
        return wrapDockerRunArgsWithRepoSetup(dockerArgs, this.config.dockerImage, 'vibe');
    }

}
