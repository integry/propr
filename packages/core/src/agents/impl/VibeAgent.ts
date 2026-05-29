import fs from 'fs';
import path from 'path';
import logger from '../../utils/logger.js';
import { Agent, AgentConfig, AgentTaskOptions, AgentExecutionResult, AnalysisResult, AnalyzeOptions } from '../types.js';
import { executeDockerCommand } from '../../claude/docker/dockerExecutor.js';
import { wrapDockerRunArgsWithRepoSetup } from '../../claude/docker/repoSetupWrapper.js';
import {
    verifyWorktreeStructure,
    verifyWorktreePostExecution,
    setWorktreeOwnership,
    UsageLimitError
} from '../../claude/claudeHelpers.js';
import { resolveConfigPath } from '../../config/configManager.js';
import { persistLlmLog, createLlmLogFromAnalysis, buildTaskWorkRef, buildAnalysisWorkRef, formatUsageMetrics } from '../../utils/llmLogger.js';
import { executeWithUsageTracking, type UsageTrackingMetrics } from './utils/index.js';
import { parseVibeOutput } from './utils/vibeOutputParser.js';
import { getAnalysisSandboxArgs, getForwardedVibeEnvVars, getParsedVibeError, isSuccessfulVibeResult, sanitizeDockerNamePart, splitVibeCliArgs } from './utils/vibeAgentHelpers.js';
import type { ExecutionType } from '../../utils/llmMetrics.types.js';

export { UsageLimitError };
export { parseVibeOutput } from './utils/vibeOutputParser.js';

const DEFAULT_VIBE_MAX_TURNS = 1000;
const DEFAULT_VIBE_TIMEOUT_MS = 3600000;
const CONTAINER_CONFIG_PATH = '/home/node/.vibe';

interface VibeDockerArgsParams {
    worktreePath: string;
    githubToken: string;
    modelName?: string;
    issueNumber: number;
    taskId?: string;
    executionType?: string;
    maxTurns?: number;
    mode?: 'execute' | 'analysis';
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

        try {
            const prompt = this.buildPromptWithRetryContext(customPrompt, isRetry, retryReason);
            await setWorktreeOwnership(worktreePath, issueRef.number);
            const worktreeGitContent = verifyWorktreeStructure(worktreePath, issueRef.number);
            const dockerArgs = this.buildDockerArgs({
                worktreePath,
                githubToken,
                modelName: effectiveModel,
                issueNumber: issueRef.number,
                taskId
            });
            const { result, usageMetrics } = await executeWithUsageTracking(
                'vibe',
                async () => executeDockerCommand('docker', dockerArgs, {
                    timeout: this.timeoutMs,
                    cwd: worktreePath,
                    onSessionId,
                    onContainerId,
                    worktreePath,
                    stdinData: prompt,
                    taskId,
                    streamToRedis: true
                })
            );

            const executionTimeMs = Date.now() - startTime;
            const parsedOutput = parseVibeOutput(result.stdout);
            const modelUsed = parsedOutput.model || effectiveModel || 'unknown';
            const success = isSuccessfulVibeResult(result.exitCode, parsedOutput);
            const error = success ? undefined : this.buildFailureMessage(result, parsedOutput);
            if (parsedOutput.sessionId && onSessionId) onSessionId(parsedOutput.sessionId);

            const response: AgentExecutionResult = {
                success,
                executionTimeMs,
                logs: this.formatLogs(result.stdout, result.stderr),
                exitCode: result.exitCode,
                rawOutput: result.stdout,
                modelUsed,
                modifiedFiles: [],
                commitMessage: null,
                summary: parsedOutput.summary,
                prompt,
                sessionId: parsedOutput.sessionId,
                error,
                tokenUsage: parsedOutput.tokenUsage,
                usageMetrics: usageMetrics ?? undefined
            };

            const usage = this.formatUsageMetrics(usageMetrics);
            await persistLlmLog(createLlmLogFromAnalysis({
                executionType: 'implementation',
                modelUsed,
                executionTimeMs,
                success: response.success,
                tokenUsage: parsedOutput.tokenUsage,
                error: response.success ? undefined : (response.error || result.stderr || 'Execution failed'),
                sessionId: parsedOutput.sessionId,
                draftId: taskId,
                repository,
                agentAlias: this.config.alias,
                metadata: { isRetry, retryReason, rawOutput: result.stdout, stderr: result.stderr },
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
        }
    }

    async analyze(prompt: string, options?: AnalyzeOptions): Promise<AnalysisResult> {
        const { context, model, taskId, taskNumber, prNumber, executionType, correlationId, repository, metadata } = options || {};
        const startTime = Date.now();
        const effectiveModel = model || this.config.defaultModel || 'mistral-medium-3.5';
        const suffix = '\n\nCRITICAL: Do not modify any files. Do not run any commands. Only provide your analysis as plain text output.';
        const analysisPrompt = context ? `${prompt}\n\nContext:\n${context}${suffix}` : `${prompt}${suffix}`;

        logger.info({ agentAlias: this.config.alias, promptLength: prompt.length, hasContext: !!context, requestedModel: model, taskId, executionType }, 'Running lightweight analysis via Vibe agent...');

        try {
            const analysisWorkspace = this.ensureAnalysisWorkspace();
            const dockerArgs = this.buildDockerArgs({
                worktreePath: analysisWorkspace,
                githubToken: process.env.GITHUB_TOKEN || '',
                modelName: effectiveModel,
                issueNumber: 0,
                taskId,
                executionType,
                maxTurns: 5,
                mode: 'analysis'
            });
            const { result, usageMetrics } = await executeWithUsageTracking(
                'vibe',
                async () => executeDockerCommand('docker', dockerArgs, {
                    timeout: 1800000,
                    stdinData: analysisPrompt,
                    taskId
                })
            );
            const executionTimeMs = Date.now() - startTime;
            const parsedOutput = parseVibeOutput(result.stdout);
            const analysisText = (parsedOutput.summary || '').trim();
            const success = isSuccessfulVibeResult(result.exitCode, parsedOutput);
            const usage = this.formatUsageMetrics(usageMetrics);

            if (success && analysisText) {
                await persistLlmLog(createLlmLogFromAnalysis({
                    executionType: (executionType || 'other') as ExecutionType,
                    modelUsed: parsedOutput.model || effectiveModel,
                    executionTimeMs,
                    success: true,
                    tokenUsage: parsedOutput.tokenUsage,
                    sessionId: parsedOutput.sessionId,
                    draftId: taskId,
                    correlationId,
                    repository,
                    metadata: { ...(metadata || {}), rawOutput: result.stdout, stderr: result.stderr },
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
                    tokenUsage: parsedOutput.tokenUsage,
                    sessionId: parsedOutput.sessionId
                };
            }

            const errorMsg = analysisText ? this.buildFailureMessage(result, parsedOutput) : (this.buildFailureMessage(result, parsedOutput) || 'No result returned');
            await persistLlmLog(createLlmLogFromAnalysis({
                executionType: (executionType || 'other') as ExecutionType,
                modelUsed: parsedOutput.model || effectiveModel,
                executionTimeMs,
                success: false,
                tokenUsage: parsedOutput.tokenUsage,
                error: errorMsg,
                sessionId: parsedOutput.sessionId,
                draftId: taskId,
                correlationId,
                repository,
                metadata: { ...(metadata || {}), rawOutput: result.stdout, stderr: result.stderr },
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
        }
    }

    async healthCheck(): Promise<boolean> {
        logger.debug({ agentAlias: this.config.alias, dockerImage: this.config.dockerImage }, 'Running health check for Vibe agent...');
        try {
            const result = await executeDockerCommand('docker', ['images', '-q', this.config.dockerImage], { timeout: 10000 });
            const imageExists = !!result.stdout.trim();
            logger.info({ agentAlias: this.config.alias, dockerImage: this.config.dockerImage, imageExists }, imageExists ? 'Health check passed' : 'Health check failed: Docker image not found');
            return imageExists;
        } catch (error) {
            logger.error({ agentAlias: this.config.alias, error: (error as Error).message }, 'Health check failed with error');
            return false;
        }
    }

    private buildPromptWithRetryContext(prompt: string, isRetry: boolean, retryReason?: string): string {
        if (isRetry && retryReason) {
            return `${prompt}\n\n---\n\nRETRY CONTEXT: This is a retry attempt. Previous attempt failed with: ${retryReason}\n\nPlease address the issues from the previous attempt.`;
        }
        return prompt;
    }

    private ensureAnalysisWorkspace(): string {
        const workspace = '/tmp/vibe-analysis';
        try {
            if (!fs.existsSync(workspace)) {
                fs.mkdirSync(workspace, { recursive: true });
            }
            fs.chmodSync(workspace, 0o755);
        } catch (error) {
            logger.warn({ error: (error as Error).message, workspace }, 'Failed to prepare Vibe analysis workspace');
        }
        return workspace;
    }

    private canMountConfigPath(configPath: string): boolean {
        try {
            return fs.existsSync(configPath) && fs.statSync(configPath).isDirectory();
        } catch {
            return false;
        }
    }

    private hasVibeConfigFile(configPath: string): boolean {
        try {
            return fs.existsSync(path.join(configPath, 'config.toml'));
        } catch {
            return false;
        }
    }

    private getMistralApiKey(): string | undefined {
        const processApiKey = process.env.MISTRAL_API_KEY?.trim();
        if (processApiKey) {
            return processApiKey;
        }
        const configuredApiKey = this.config.envVars?.MISTRAL_API_KEY?.trim();
        return configuredApiKey || undefined;
    }

    private getCliArgs(): string[] {
        // Vibe does not currently document a stable headless flag set, so keep
        // the invocation overrideable while defaulting to stdin-driven `vibe`.
        const configuredArgs = process.env.VIBE_CLI_ARGS ?? this.config.envVars?.VIBE_CLI_ARGS;
        if (!configuredArgs || !configuredArgs.trim()) {
            return ['vibe'];
        }

        const args = splitVibeCliArgs(configuredArgs);
        if (args.length === 0) {
            return ['vibe'];
        }
        return args;
    }

    private formatLogs(stdout: string, stderr: string): string {
        return stdout + (stderr ? `\n\nSTDERR:\n${stderr}` : '');
    }

    private buildFailureMessage(result: { stdout: string; stderr: string; exitCode: number | null }, parsedOutput: ReturnType<typeof parseVibeOutput>): string {
        const parsedError = getParsedVibeError(parsedOutput);
        const exitContext = result.exitCode === 0
            ? undefined
            : result.exitCode === null
                ? 'Vibe CLI exited without an exit code'
                : `Vibe CLI exited with code ${result.exitCode}`;
        const parts = [
            parsedError,
            exitContext,
            result.stderr.trim() ? `stderr: ${result.stderr.trim().slice(0, 4000)}` : undefined,
            result.stdout.trim() ? `stdout: ${result.stdout.trim().slice(0, 4000)}` : undefined
        ].filter((part): part is string => Boolean(part));

        return parts.join('\n');
    }

    private buildDockerArgs(params: VibeDockerArgsParams): string[] {
        const { worktreePath, githubToken, modelName, issueNumber, taskId, executionType, maxTurns = this.maxTurns, mode = 'execute' } = params;
        const configPath = resolveConfigPath(process.env.VIBE_CONFIG_PATH || this.config.configPath);
        const mistralApiKey = this.getMistralApiKey();
        const shouldMountConfig = this.canMountConfigPath(configPath)
            && (!mistralApiKey || this.hasVibeConfigFile(configPath));
        const configMountArgs = shouldMountConfig ? ['-v', `${configPath}:${CONTAINER_CONFIG_PATH}:ro`] : [];
        const forwardedEnvVars = getForwardedVibeEnvVars(this.config.envVars);
        for (const envVar of forwardedEnvVars.skipped) {
            logger.warn({ agentAlias: this.config.alias, envVar }, 'Skipping invalid Vibe Docker environment variable');
        }
        const envVars = forwardedEnvVars.dockerArgs;
        if (mistralApiKey) {
            envVars.push('-e', `MISTRAL_API_KEY=${mistralApiKey}`);
        }
        if (modelName) {
            const cleanModelName = modelName.includes(':') ? modelName.split(':').pop()! : modelName;
            envVars.push('-e', `VIBE_ACTIVE_MODEL=${cleanModelName}`);
        }
        envVars.push('-e', 'VIBE_SOURCE_HOME=/home/node/.vibe');
        if (mode === 'analysis') {
            envVars.push('-e', 'VIBE_READ_ONLY_CONFIG=1');
            envVars.push('-e', 'XDG_CACHE_HOME=/tmp/propr-vibe-cache');
            envVars.push('-e', 'XDG_CONFIG_HOME=/tmp/propr-vibe-config');
            envVars.push('-e', 'XDG_DATA_HOME=/tmp/propr-vibe-data');
            envVars.push('-e', 'UV_CACHE_DIR=/tmp/propr-uv-cache');
            envVars.push('-e', 'HOME=/tmp/propr-vibe-home');
            envVars.push('-e', 'VIBE_RUNTIME_HOME=/tmp/propr-vibe-home');
            envVars.push('-e', 'XDG_STATE_HOME=/tmp/propr-vibe-state');
            envVars.push('-e', 'PIP_CACHE_DIR=/tmp/propr-pip-cache');
            envVars.push('-e', 'PYTHONPYCACHEPREFIX=/tmp/propr-python-cache');
        }
        envVars.push('-e', `VIBE_MAX_TURNS=${maxTurns}`);

        const timestamp = Date.now().toString(36);
        const shortTaskId = sanitizeDockerNamePart(taskId?.slice(-8), timestamp);
        const taskType = sanitizeDockerNamePart(executionType || (issueNumber === 0 ? 'analysis' : `issue-${issueNumber}`), 'task');
        const alias = sanitizeDockerNamePart(this.config.alias, 'vibe');
        const containerName = `${alias}-${taskType}-${shortTaskId}`.slice(0, 128);
        const workspaceMountMode = mode === 'analysis' ? 'ro' : 'rw';
        const analysisSandboxArgs = getAnalysisSandboxArgs(mode);
        const cliArgs = this.getCliArgs();
        const dockerArgs: string[] = [
            'run', '--rm', '-i', '--name', containerName, '--security-opt', 'no-new-privileges', '--network', 'bridge',
            ...analysisSandboxArgs,
            '-v', `${worktreePath}:/home/node/workspace:${workspaceMountMode}`,
            ...configMountArgs,
            '-e', `GH_TOKEN=${githubToken}`,
            '-e', `GITHUB_TOKEN=${githubToken}`,
            ...envVars,
            '-w', '/home/node/workspace',
            this.config.dockerImage,
            ...cliArgs
        ];

        logger.info({
            issueNumber,
            agentAlias: this.config.alias,
            mode,
            dockerImage: this.config.dockerImage,
            configPath,
            configPathMounted: shouldMountConfig,
            workspaceMountMode,
            cliArgs
        }, 'Docker args built for Vibe agent');
        if (mode === 'analysis') {
            return dockerArgs;
        }
        return wrapDockerRunArgsWithRepoSetup(dockerArgs, this.config.dockerImage, 'vibe');
    }

    private formatUsageMetrics(usageMetrics: UsageTrackingMetrics | null | undefined) {
        return formatUsageMetrics(usageMetrics);
    }
}
