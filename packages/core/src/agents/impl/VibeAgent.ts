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
import type { ExecutionType } from '../../utils/llmMetrics.types.js';

export { UsageLimitError };
export { parseVibeOutput } from './utils/vibeOutputParser.js';

const DEFAULT_VIBE_MAX_TURNS = 1000;
const DEFAULT_VIBE_TIMEOUT_MS = 3600000;
const CONTAINER_CONFIG_PATH = '/home/node/.vibe';
const CONTAINER_PROMPT_PATH = '/tmp/propr-vibe-prompt.md';
const PROMPT_CACHE_DIR = '/tmp/git-processor/propr-cache/vibe-prompts';

interface VibeDockerArgsParams {
    worktreePath: string;
    githubToken: string;
    modelName?: string;
    promptPath: string;
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
            const promptPath = this.writePromptFile(prompt, taskId);

            const { result, usageMetrics } = await this.runWithPromptCleanup(promptPath, () => {
                const dockerArgs = this.buildDockerArgs({
                    worktreePath,
                    githubToken,
                    modelName: effectiveModel,
                    promptPath,
                    issueNumber: issueRef.number,
                    taskId
                });
                return executeWithUsageTracking(
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
            });

            const executionTimeMs = Date.now() - startTime;
            const parsedOutput = parseVibeOutput(result.stdout);
            const modelUsed = parsedOutput.model || effectiveModel || 'unknown';
            if (parsedOutput.sessionId && onSessionId) onSessionId(parsedOutput.sessionId);

            const response: AgentExecutionResult = {
                success: result.exitCode === 0 && !parsedOutput.error,
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
                error: parsedOutput.error,
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
                error: response.success ? undefined : (parsedOutput.error || result.stderr || 'Execution failed'),
                sessionId: parsedOutput.sessionId,
                draftId: taskId,
                repository,
                agentAlias: this.config.alias,
                metadata: { isRetry, retryReason },
                usageMetrics: usage.metrics,
                usageMetricRecords: usage.records,
                workRef: buildTaskWorkRef(taskId, issueRef.number, repository, prNumber),
            }));

            if (response.success) {
                logger.info({ issueNumber: issueRef.number, model: modelUsed, agentAlias: this.config.alias }, 'Vibe agent execution succeeded');
                verifyWorktreePostExecution(worktreePath, issueRef.number, worktreeGitContent);
            } else {
                logger.error({ issueNumber: issueRef.number, exitCode: result.exitCode, stderr: result.stderr, agentAlias: this.config.alias, error: parsedOutput.error }, 'Vibe agent execution failed');
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
            const promptPath = this.writePromptFile(analysisPrompt, taskId);

            const { result, usageMetrics } = await this.runWithPromptCleanup(promptPath, () => {
                const dockerArgs = this.buildDockerArgs({
                    worktreePath: analysisWorkspace,
                    githubToken: process.env.GITHUB_TOKEN || '',
                    modelName: effectiveModel,
                    promptPath,
                    issueNumber: 0,
                    taskId,
                    executionType,
                    maxTurns: 5,
                    mode: 'analysis'
                });
                return executeWithUsageTracking(
                    'vibe',
                    async () => executeDockerCommand('docker', dockerArgs, { timeout: 1800000, taskId })
                );
            });
            const executionTimeMs = Date.now() - startTime;
            const parsedOutput = parseVibeOutput(result.stdout);
            const analysisText = (parsedOutput.summary || '').trim();

            if (result.exitCode === 0 && !parsedOutput.error) {
                const usage = this.formatUsageMetrics(usageMetrics);
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
                    metadata,
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

            const errorMsg = parsedOutput.error || result.stderr || 'No result returned';
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

    private writePromptFile(prompt: string, taskId?: string): string {
        fs.mkdirSync(PROMPT_CACHE_DIR, { recursive: true, mode: 0o700 });
        const safeTaskId = taskId?.replace(/[^a-zA-Z0-9_-]/g, '').slice(-32) || Date.now().toString(36);
        const promptPath = path.join(PROMPT_CACHE_DIR, `${safeTaskId}-${Date.now().toString(36)}.md`);
        fs.writeFileSync(promptPath, prompt, { encoding: 'utf8', mode: 0o644 });
        fs.chmodSync(promptPath, 0o644);
        return promptPath;
    }

    private cleanupPromptFile(promptPath: string): void {
        try {
            fs.unlinkSync(promptPath);
        } catch (error) {
            logger.warn({ promptPath, error: (error as Error).message }, 'Failed to clean up Vibe prompt file');
        }
    }

    private async runWithPromptCleanup<T>(promptPath: string, run: () => Promise<T>): Promise<T> {
        try {
            return await run();
        } finally {
            this.cleanupPromptFile(promptPath);
        }
    }

    private buildDockerArgs(params: VibeDockerArgsParams): string[] {
        const { worktreePath, githubToken, modelName, promptPath, issueNumber, taskId, executionType, maxTurns = this.maxTurns, mode = 'execute' } = params;
        const configPath = resolveConfigPath(process.env.VIBE_CONFIG_PATH || this.config.configPath);
        const envVars: string[] = [];
        if (this.config.envVars) {
            for (const [key, value] of Object.entries(this.config.envVars)) envVars.push('-e', `${key}=${value}`);
        }
        if (process.env.MISTRAL_API_KEY) {
            envVars.push('-e', `MISTRAL_API_KEY=${process.env.MISTRAL_API_KEY}`);
        }
        if (modelName) {
            const cleanModelName = modelName.includes(':') ? modelName.split(':').pop()! : modelName;
            envVars.push('-e', `VIBE_ACTIVE_MODEL=${cleanModelName}`);
        }
        envVars.push('-e', 'VIBE_SOURCE_HOME=/home/node/.vibe');

        const timestamp = Date.now().toString(36);
        const shortTaskId = this.sanitizeDockerNamePart(taskId?.slice(-8), timestamp);
        const taskType = this.sanitizeDockerNamePart(executionType || (issueNumber === 0 ? 'analysis' : `issue-${issueNumber}`), 'task');
        const alias = this.sanitizeDockerNamePart(this.config.alias, 'vibe');
        const containerName = `${alias}-${taskType}-${shortTaskId}`.slice(0, 128);
        const workspaceMountMode = mode === 'analysis' ? 'ro' : 'rw';
        const promptInstruction = `Read the full task prompt from @${CONTAINER_PROMPT_PATH} and follow it exactly.`;
        const agentArgs = mode === 'analysis'
            ? ['--agent', 'plan']
            : ['--trust', '--agent', 'auto-approve'];
        const dockerArgs: string[] = [
            'run', '--rm', '-i', '--name', containerName, '--security-opt', 'no-new-privileges', '--cap-add', 'CHOWN', '--network', 'bridge', '--user', '0:0',
            '-v', `${worktreePath}:/home/node/workspace:${workspaceMountMode}`,
            '-v', '/tmp/git-processor:/tmp/git-processor:rw',
            '-v', `${configPath}:${CONTAINER_CONFIG_PATH}:ro`,
            '-v', `${promptPath}:${CONTAINER_PROMPT_PATH}:ro`,
            '-e', `GH_TOKEN=${githubToken}`,
            '-e', `GITHUB_TOKEN=${githubToken}`,
            ...envVars,
            '-w', '/home/node/workspace',
            this.config.dockerImage,
            'vibe', '--prompt', promptInstruction, '--max-turns', String(maxTurns), '--output', 'json', ...agentArgs
        ];

        logger.info({ issueNumber, agentAlias: this.config.alias, mode }, 'Docker args built for Vibe agent');
        return wrapDockerRunArgsWithRepoSetup(dockerArgs, this.config.dockerImage, 'vibe');
    }

    private sanitizeDockerNamePart(value: string | undefined, fallback: string): string {
        const sanitized = value?.replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '').replace(/[^a-zA-Z0-9]+$/, '');
        return sanitized || fallback;
    }

    private formatUsageMetrics(usageMetrics: UsageTrackingMetrics | null | undefined) {
        return formatUsageMetrics(usageMetrics);
    }
}
