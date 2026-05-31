import fs from 'fs';
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
import { executeWithUsageTracking } from './utils/index.js';
import { parseVibeOutput } from './utils/vibeOutputParser.js';
import { getAnalysisSandboxArgs, getForwardedVibeEnvVars, isSuccessfulVibeResult, splitVibeCliArgs, getDefaultVibeCliArgs, buildPromptWithRetryContext, buildLogMetadata, buildVibeFailureMessage, writeVibePromptFile, writeMistralEnvFile, cleanupTempFile, buildVibeContainerName } from './utils/vibeAgentHelpers.js';
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
    promptFilePath?: string;
    envFilePath?: string;
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
        try {
            const prompt = buildPromptWithRetryContext(customPrompt, isRetry, retryReason);
            promptFilePath = writeVibePromptFile(prompt);
            envFilePath = writeMistralEnvFile(this.getMistralApiKey());
            await setWorktreeOwnership(worktreePath, issueRef.number);
            const worktreeGitContent = verifyWorktreeStructure(worktreePath, issueRef.number);
            const dockerArgs = this.buildDockerArgs({
                worktreePath,
                githubToken,
                modelName: effectiveModel,
                issueNumber: issueRef.number,
                taskId,
                promptFilePath,
                envFilePath
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
                    streamToRedis: true
                })
            );

            const executionTimeMs = Date.now() - startTime;
            const parsedOutput = parseVibeOutput(result.stdout);
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
                error,
                tokenUsage: parsedOutput.tokenUsage,
                usageMetrics: usageMetrics ?? undefined
            };

            const usage = formatUsageMetrics(usageMetrics);
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
        }
    }

    async analyze(prompt: string, options?: AnalyzeOptions): Promise<AnalysisResult> {
        const { context, model, taskId, taskNumber, prNumber, executionType, correlationId, repository, metadata } = options || {};
        const startTime = Date.now();
        const effectiveModel = model || this.config.defaultModel || 'mistral-medium-3.5';
        const suffix = '\n\nCRITICAL: Do not modify any files. Do not run any commands. Only provide your analysis as plain text output.';
        const analysisPrompt = context ? `${prompt}\n\nContext:\n${context}${suffix}` : `${prompt}${suffix}`;

        logger.info({ agentAlias: this.config.alias, promptLength: prompt.length, hasContext: !!context, requestedModel: model, taskId, executionType }, 'Running lightweight analysis via Vibe agent...');

        let analysisWorkspace: string | undefined;
        let promptFilePath: string | undefined;
        let envFilePath: string | undefined;
        try {
            analysisWorkspace = this.ensureAnalysisWorkspace();
            promptFilePath = writeVibePromptFile(analysisPrompt);
            envFilePath = writeMistralEnvFile(this.getMistralApiKey());
            const dockerArgs = this.buildDockerArgs({
                worktreePath: analysisWorkspace,
                githubToken: process.env.GITHUB_TOKEN || '',
                modelName: effectiveModel,
                issueNumber: 0,
                taskId,
                executionType,
                maxTurns: 5,
                mode: 'analysis',
                promptFilePath,
                envFilePath
            });
            const { result, usageMetrics } = await executeWithUsageTracking(
                'vibe',
                async () => executeDockerCommand('docker', dockerArgs, {
                    timeout: 1800000,
                    taskId
                })
            );
            const executionTimeMs = Date.now() - startTime;
            const parsedOutput = parseVibeOutput(result.stdout);
            const analysisText = (parsedOutput.summary || '').trim();
            const success = isSuccessfulVibeResult(result.exitCode, parsedOutput);
            const usage = formatUsageMetrics(usageMetrics);

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
                    tokenUsage: parsedOutput.tokenUsage,
                    sessionId: parsedOutput.sessionId
                };
            }

            const errorMsg = buildVibeFailureMessage(result, parsedOutput);
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
            logger.info({ agentAlias: this.config.alias, dockerImage: this.config.dockerImage, imageExists }, imageExists ? 'Health check passed' : 'Health check failed: Docker image not found');
            return imageExists;
        } catch (error) {
            logger.error({ agentAlias: this.config.alias, error: (error as Error).message }, 'Health check failed with error');
            return false;
        }
    }

    private ensureAnalysisWorkspace(): string {
        const workspace = fs.mkdtempSync('/tmp/vibe-analysis-');
        try {
            fs.chmodSync(workspace, 0o755);
        } catch (error) {
            logger.warn({ error: (error as Error).message, workspace }, 'Failed to prepare Vibe analysis workspace');
        }
        return workspace;
    }

    private hasUsableConfigDir(configPath: string): boolean {
        try {
            if (!fs.existsSync(configPath) || !fs.statSync(configPath).isDirectory()) return false;
            const entries = fs.readdirSync(configPath);
            const hasCredentials = entries.includes('credentials.json');
            if (hasCredentials) return true;
            if (this.getMistralApiKey() && entries.includes('config.toml')) return true;
            return false;
        } catch { return false; }
    }

    private getMistralApiKey(): string | undefined {
        return process.env.MISTRAL_API_KEY?.trim() || this.config.envVars?.MISTRAL_API_KEY?.trim() || undefined;
    }

    private getCliArgs(modelName?: string): string[] {
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
            } else if (!args.includes('--json')) {
                const allowNoJson = process.env.VIBE_ALLOW_UNSTRUCTURED === '1' || this.config.envVars?.VIBE_ALLOW_UNSTRUCTURED === '1';
                if (!allowNoJson) {
                    throw new Error(`${source} does not include --json. Structured output is required. Add --json or set VIBE_ALLOW_UNSTRUCTURED=1 to override.`);
                }
                logger.warn({ source, args }, 'VIBE_CLI_ARGS override does not include --json; structured output parsing may degrade');
            }
        }
        if (modelName && !args.includes('--model') && !args.includes('-m')) args.push('--model', modelName);
        return args;
    }

    private buildDockerEnvVars(params: { cleanModelName?: string; mode: 'execute' | 'analysis'; maxTurns: number }): string[] {
        const { cleanModelName, mode, maxTurns } = params;
        const forwardedEnvVars = getForwardedVibeEnvVars(this.config.envVars);
        for (const envVar of forwardedEnvVars.skipped) logger.warn({ agentAlias: this.config.alias, envVar }, 'Skipping invalid Vibe Docker environment variable');
        const envVars = forwardedEnvVars.dockerArgs;
        if (cleanModelName) envVars.push('-e', `VIBE_ACTIVE_MODEL=${cleanModelName}`);
        envVars.push('-e', 'VIBE_SOURCE_HOME=/home/node/.vibe');
        if (mode === 'analysis') {
            envVars.push(
                '-e', 'VIBE_READ_ONLY_CONFIG=1', '-e', 'XDG_CACHE_HOME=/tmp/propr-vibe-cache',
                '-e', 'XDG_CONFIG_HOME=/tmp/propr-vibe-config', '-e', 'XDG_DATA_HOME=/tmp/propr-vibe-data',
                '-e', 'UV_CACHE_DIR=/tmp/propr-uv-cache', '-e', 'HOME=/tmp/propr-vibe-home',
                '-e', 'VIBE_RUNTIME_HOME=/tmp/propr-vibe-home', '-e', 'XDG_STATE_HOME=/tmp/propr-vibe-state',
                '-e', 'PIP_CACHE_DIR=/tmp/propr-pip-cache', '-e', 'PYTHONPYCACHEPREFIX=/tmp/propr-python-cache'
            );
        }
        envVars.push('-e', `VIBE_MAX_TURNS=${maxTurns}`);
        return envVars;
    }

    private buildDockerArgs(params: VibeDockerArgsParams): string[] {
        const { worktreePath, githubToken, modelName, issueNumber, taskId, executionType, maxTurns = this.maxTurns, mode = 'execute', promptFilePath, envFilePath } = params;
        const configPath = resolveConfigPath(process.env.VIBE_CONFIG_PATH || this.config.configPath);
        const mistralApiKey = this.getMistralApiKey();
        const hasUsableConfig = this.hasUsableConfigDir(configPath);
        if (!mistralApiKey && !hasUsableConfig) {
            throw new Error(
                `Vibe agent "${this.config.alias}" has no credentials. ` +
                `Set MISTRAL_API_KEY or ensure ${configPath} contains valid Vibe config files.`
            );
        }
        const configMountArgs = hasUsableConfig ? ['-v', `${configPath}:${CONTAINER_CONFIG_PATH}:ro`] : [];
        const cleanModelName = modelName?.includes(':') ? modelName.split(':').pop()! : modelName;
        const mistralEnvFileArgs = envFilePath ? ['--env-file', envFilePath] : [];
        const envVars = this.buildDockerEnvVars({ cleanModelName, mode, maxTurns });

        const containerName = buildVibeContainerName(this.config.alias, executionType || (issueNumber === 0 ? 'analysis' : `issue-${issueNumber}`), taskId);
        const workspaceMountMode = mode === 'analysis' ? 'ro' : 'rw';
        const cliArgs = this.getCliArgs(cleanModelName);
        const promptMountArgs: string[] = [];
        if (promptFilePath) { promptMountArgs.push('-v', `${promptFilePath}:/tmp/propr-prompt.txt:ro`); cliArgs.push('--prompt-file', '/tmp/propr-prompt.txt'); }
        const dockerArgs: string[] = [
            'run', '--rm', '--name', containerName, '--security-opt', 'no-new-privileges', '--network', 'bridge',
            ...getAnalysisSandboxArgs(mode),
            '-v', `${worktreePath}:/home/node/workspace:${workspaceMountMode}`,
            ...configMountArgs, ...promptMountArgs, ...mistralEnvFileArgs,
            '-e', `GH_TOKEN=${githubToken}`, '-e', `GITHUB_TOKEN=${githubToken}`,
            ...envVars, '-w', '/home/node/workspace', this.config.dockerImage, ...cliArgs
        ];
        const cliArgsSource = (process.env.VIBE_CLI_ARGS ?? this.config.envVars?.VIBE_CLI_ARGS) ? 'custom' : 'default';
        logger.info({ issueNumber, agentAlias: this.config.alias, mode, dockerImage: this.config.dockerImage, configPath, configPathMounted: hasUsableConfig, workspaceMountMode, cliArgsSource, cliArgCount: cliArgs.length }, 'Docker args built for Vibe agent');
        if (mode === 'analysis') return dockerArgs;
        return wrapDockerRunArgsWithRepoSetup(dockerArgs, this.config.dockerImage, 'vibe');
    }

}
