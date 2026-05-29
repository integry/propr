import fs from 'fs';
import { execSync } from 'child_process';
import logger from '../../utils/logger.js';
import { Agent, AgentConfig, AgentTaskOptions, AgentExecutionResult, AnalysisResult, AnalyzeOptions } from '../types.js';
import { executeDockerCommand } from '../../claude/docker/dockerExecutor.js';
import { verifyWorktreeStructure, verifyWorktreePostExecution, setWorktreeOwnership, UsageLimitError } from '../../claude/claudeHelpers.js';
import { resolveConfigPath } from '../../config/configManager.js';
import { persistLlmLog, createLlmLogFromAnalysis, createLlmLogFromAgentExecution, buildTaskWorkRef, buildAnalysisWorkRef, formatUsageMetrics } from '../../utils/llmLogger.js';
import { executeWithUsageTracking, type UsageTrackingMetrics } from './utils/index.js';
import { buildOpenCodeDockerArgs, buildOpenCodePrompt, parseOpenCodeJsonl, type OpenCodeDockerArgsParams, type ParsedOpenCodeOutput } from './openCodeUtils.js';
import type { ExecutionType } from '../../utils/llmMetrics.types.js';

export { UsageLimitError };

const DEFAULT_OPENCODE_TIMEOUT_MS = 3600000;

export class OpenCodeAgent implements Agent {
    readonly config: AgentConfig;
    private readonly timeoutMs: number;

    constructor(config: AgentConfig) {
        this.config = config;
        this.timeoutMs = parseInt(process.env.OPENCODE_TIMEOUT_MS || String(DEFAULT_OPENCODE_TIMEOUT_MS), 10);
    }

    async executeTask(options: AgentTaskOptions): Promise<AgentExecutionResult> {
        const { worktreePath, issueRef, prompt: customPrompt, model, systemPrompt, isRetry = false, retryReason, branchName, issueDetails, onSessionId, onContainerId, githubToken, taskId, prNumber } = options;
        const startTime = Date.now();
        const effectiveModel = model || this.config.defaultModel;
        const repo = `${issueRef.repoOwner}/${issueRef.repoName}`;
        let prompt = customPrompt ?? '';

        logger.info({ issueNumber: issueRef.number, repository: repo, worktreePath, dockerImage: this.config.dockerImage, agentAlias: this.config.alias, isRetry, retryReason }, isRetry ? 'Starting OpenCode agent execution (RETRY)...' : 'Starting OpenCode agent execution...');

        try {
            prompt = buildOpenCodePrompt({
                customPrompt,
                issueRef,
                branchName,
                modelName: effectiveModel,
                issueDetails,
                isRetry,
                retryReason,
                systemPrompt
            });
            await setWorktreeOwnership(worktreePath, issueRef.number);
            const worktreeGitContent = verifyWorktreeStructure(worktreePath, issueRef.number);
            const dockerArgs = this.buildDockerArgs({ worktreePath, githubToken, modelName: effectiveModel, issueNumber: issueRef.number, taskId });

            const { result, usageMetrics } = await executeWithUsageTracking(
                'opencode',
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

            const executionTime = Date.now() - startTime;
            const parsedOutput = this.parseOpenCodeJsonl(result.stdout);
            const modelUsed = parsedOutput.modelUsed || effectiveModel || 'unknown';
            const success = result.exitCode === 0 && !parsedOutput.error;
            const errorText = success ? undefined : (parsedOutput.error || result.stderr || `OpenCode exited with code ${result.exitCode ?? 'unknown'}`);
            const response: AgentExecutionResult = {
                success,
                executionTimeMs: executionTime,
                logs: result.stdout + (result.stderr ? `\n\nSTDERR:\n${result.stderr}` : ''),
                exitCode: result.exitCode,
                rawOutput: result.stdout,
                modelUsed,
                sessionId: parsedOutput.sessionId,
                conversationLog: parsedOutput.conversationLog,
                modifiedFiles: [],
                commitMessage: null,
                summary: parsedOutput.summary,
                prompt,
                error: errorText,
                tokenUsage: parsedOutput.tokenUsage,
                usageMetrics: usageMetrics ?? undefined
            };

            await this.persistExecutionLogSafely({ response, executionTime, modelUsed, prompt, issueRef, taskId, prNumber, isRetry, retryReason, usageMetrics });

            if (!response.success) {
                logger.error({ issueNumber: issueRef.number, exitCode: result.exitCode, stderr: result.stderr, agentAlias: this.config.alias, error: parsedOutput.error }, 'OpenCode agent execution failed');
            } else {
                logger.info({ issueNumber: issueRef.number, model: modelUsed, agentAlias: this.config.alias }, 'OpenCode agent execution succeeded');
                verifyWorktreePostExecution(worktreePath, issueRef.number, worktreeGitContent);
            }

            return response;
        } catch (error) {
            if (error instanceof UsageLimitError) throw error;
            const executionTime = Date.now() - startTime;
            const err = error as Error;
            logger.error({ issueNumber: issueRef.number, repository: repo, executionTime, error: err.message, agentAlias: this.config.alias }, 'Error during OpenCode agent execution');
            const response: AgentExecutionResult = { success: false, error: err.message, executionTimeMs: executionTime, logs: (error as { stderr?: string }).stderr || err.message, modifiedFiles: [], commitMessage: null, summary: undefined, modelUsed: effectiveModel || 'unknown', prompt };
            await this.persistExecutionLogSafely({ response, executionTime, modelUsed: response.modelUsed, prompt, issueRef, taskId, prNumber, isRetry, retryReason });
            return response;
        }
    }

    async analyze(prompt: string, options?: AnalyzeOptions): Promise<AnalysisResult> {
        const { context, model, taskId, taskNumber, prNumber, executionType, correlationId, repository, metadata } = options || {};
        const startTime = Date.now();
        const effectiveModel = model || this.config.defaultModel || 'unknown';
        const suffix = '\n\nCRITICAL: Do not modify any files. Do not run any commands. Only provide your analysis as plain text output.';
        const analysisPrompt = context ? `${prompt}\n\nContext:\n${context}${suffix}` : `${prompt}${suffix}`;
        const analysisWorkspace = this.ensureAnalysisWorkspace();
        const analysisConfigPath = this.createAnalysisConfigSnapshot();

        try {
            const dockerArgs = this.buildDockerArgs({ worktreePath: analysisWorkspace, githubToken: process.env.GITHUB_TOKEN || '', modelName: effectiveModel === 'unknown' ? undefined : effectiveModel, issueNumber: 0, taskId, executionType, readOnlyWorkspace: true, allowDangerousPermissions: false, configPath: analysisConfigPath });
            const { result, usageMetrics } = await executeWithUsageTracking(
                'opencode',
                async () => executeDockerCommand('docker', dockerArgs, { timeout: 1800000, stdinData: analysisPrompt, taskId })
            );
            const executionTimeMs = Date.now() - startTime;
            const parsedOutput = this.parseOpenCodeJsonl(result.stdout);
            const analysisText = (parsedOutput.summary || '').trim();

            const modelUsed = parsedOutput.modelUsed || effectiveModel;
            const success = result.exitCode === 0 && !parsedOutput.error && analysisText.length > 0;

            const errorMsg = parsedOutput.error || result.stderr || 'No assistant text returned';
            await this.persistAnalysisLogSafely({ executionType, modelUsed, executionTimeMs, success, error: success ? undefined : errorMsg, sessionId: parsedOutput.sessionId, taskId, correlationId, repository, metadata, taskNumber, prNumber, tokenUsage: parsedOutput.tokenUsage, usageMetrics });
            return success
                ? { response: analysisText, modelUsed, executionTimeMs, success: true, sessionId: parsedOutput.sessionId, tokenUsage: parsedOutput.tokenUsage }
                : { response: analysisText, modelUsed, executionTimeMs, success: false, error: `Analysis failed: ${errorMsg}`, tokenUsage: parsedOutput.tokenUsage };
        } catch (error) {
            const executionTimeMs = Date.now() - startTime;
            const err = error as Error;
            logger.error({ agentAlias: this.config.alias, error: err.message, executionTimeMs }, 'OpenCode lightweight analysis failed');
            await this.persistAnalysisLogSafely({ executionType, modelUsed: effectiveModel, executionTimeMs, success: false, error: err.message, taskId, correlationId, repository, metadata, taskNumber, prNumber });
            return { response: '', modelUsed: effectiveModel, executionTimeMs, success: false, error: err.message };
        } finally {
            this.cleanupAnalysisWorkspace(analysisWorkspace);
            this.cleanupAnalysisConfigSnapshot(analysisConfigPath);
        }
    }

    async healthCheck(): Promise<boolean> {
        try {
            const result = await executeDockerCommand('docker', ['images', '-q', this.config.dockerImage], { timeout: 10000 });
            return !!result.stdout.trim();
        } catch (error) {
            logger.error({ agentAlias: this.config.alias, error: (error as Error).message }, 'OpenCode health check failed');
            return false;
        }
    }

    private parseOpenCodeJsonl(output: string): ParsedOpenCodeOutput {
        return parseOpenCodeJsonl(output);
    }

    private async persistExecutionLog(opts: {
        response: AgentExecutionResult;
        executionTime: number;
        modelUsed: string;
        prompt: string;
        issueRef: { number: number; repoOwner: string; repoName: string };
        taskId?: string;
        prNumber?: number;
        isRetry: boolean;
        retryReason?: string;
        usageMetrics?: UsageTrackingMetrics | null;
    }): Promise<void> {
        const { response, executionTime, modelUsed, issueRef, taskId, prNumber, isRetry, retryReason, usageMetrics } = opts;
        const repository = `${issueRef.repoOwner}/${issueRef.repoName}`;
        await persistLlmLog(createLlmLogFromAgentExecution({
            executionType: 'implementation',
            modelUsed,
            executionTimeMs: executionTime,
            success: response.success,
            tokenUsage: response.tokenUsage,
            error: response.success ? undefined : (response.error || 'Execution failed'),
            sessionId: response.sessionId,
            draftId: taskId,
            repository,
            agentAlias: this.config.alias,
            metadata: { isRetry, retryReason },
            ...formatUsageMetrics(usageMetrics),
            workRef: buildTaskWorkRef(taskId, issueRef.number, repository, prNumber),
        }));
    }

    private async persistExecutionLogSafely(opts: Parameters<OpenCodeAgent['persistExecutionLog']>[0]): Promise<void> {
        try {
            await this.persistExecutionLog(opts);
        } catch (persistError) {
            logger.warn({ agentAlias: this.config.alias, error: (persistError as Error).message }, 'Failed to persist OpenCode execution log');
        }
    }

    private async persistAnalysisLogSafely(opts: {
        executionType?: string;
        modelUsed: string;
        executionTimeMs: number;
        success: boolean;
        error?: string;
        sessionId?: string;
        taskId?: string;
        correlationId?: string;
        repository?: string;
        metadata?: Record<string, unknown>;
        taskNumber?: number;
        prNumber?: number;
        tokenUsage?: AgentExecutionResult['tokenUsage'];
        usageMetrics?: UsageTrackingMetrics | null;
    }): Promise<void> {
        try {
            await persistLlmLog(createLlmLogFromAnalysis({
                executionType: (opts.executionType || 'other') as ExecutionType,
                modelUsed: opts.modelUsed,
                executionTimeMs: opts.executionTimeMs,
                success: opts.success,
                tokenUsage: opts.tokenUsage,
                error: opts.success ? undefined : opts.error,
                sessionId: opts.sessionId,
                draftId: opts.taskId,
                correlationId: opts.correlationId,
                repository: opts.repository,
                metadata: opts.metadata,
                agentAlias: this.config.alias,
                ...formatUsageMetrics(opts.usageMetrics),
                workRef: buildAnalysisWorkRef(opts.executionType, opts.taskId, opts.repository, { taskNumber: opts.taskNumber, prNumber: opts.prNumber }),
            }));
        } catch (persistError) {
            logger.warn({ agentAlias: this.config.alias, error: (persistError as Error).message }, 'Failed to persist OpenCode analysis log');
        }
    }

    private ensureAnalysisWorkspace(): string {
        const workspace = fs.mkdtempSync('/tmp/opencode-analysis-');
        try {
            const runAsNode = process.getuid?.() === 0;
            if (runAsNode) fs.chownSync(workspace, 1000, 1000);
            const execOptions = { cwd: workspace, stdio: 'pipe' as const, ...(runAsNode ? { uid: 1000, gid: 1000 } : {}) };
            execSync('git init', execOptions);
            execSync('git config user.email "opencode@propr.dev"', execOptions);
            execSync('git config user.name "OpenCode Analysis"', execOptions);
        } catch (initError) {
            logger.warn({ error: (initError as Error).message }, 'Failed to initialize OpenCode analysis workspace');
        }
        return workspace;
    }

    private cleanupAnalysisWorkspace(workspace: string): void {
        if (!workspace.startsWith('/tmp/opencode-analysis-')) return;
        try {
            fs.rmSync(workspace, { recursive: true, force: true });
        } catch (cleanupError) {
            logger.warn({ workspace, error: (cleanupError as Error).message }, 'Failed to remove OpenCode analysis workspace');
        }
    }

    private createAnalysisConfigSnapshot(): string {
        const sourceConfigPath = resolveConfigPath(this.config.configPath);
        const snapshotPath = fs.mkdtempSync('/tmp/opencode-analysis-config-');
        try {
            if (fs.existsSync(sourceConfigPath)) {
                fs.cpSync(sourceConfigPath, snapshotPath, { recursive: true, force: true });
            }
            const runAsNode = process.getuid?.() === 0;
            if (runAsNode) fs.chownSync(snapshotPath, 1000, 1000);
        } catch (error) {
            logger.warn({ sourceConfigPath, snapshotPath, agentAlias: this.config.alias, error: (error as Error).message }, 'Failed to copy OpenCode config for analysis');
        }
        return snapshotPath;
    }

    private cleanupAnalysisConfigSnapshot(configPath: string): void {
        if (!configPath.startsWith('/tmp/opencode-analysis-config-')) return;
        try {
            fs.rmSync(configPath, { recursive: true, force: true });
        } catch (cleanupError) {
            logger.warn({ configPath, error: (cleanupError as Error).message }, 'Failed to remove OpenCode analysis config snapshot');
        }
    }

    private buildDockerArgs(params: Omit<OpenCodeDockerArgsParams, 'config' | 'ensureConfigPath'>): string[] {
        return buildOpenCodeDockerArgs({
            ...params,
            config: this.config,
            ensureConfigPath: (configPath) => this.ensureHostConfigPath(configPath)
        });
    }

    private ensureHostConfigPath(configPath: string): void {
        try {
            if (!fs.existsSync(configPath)) {
                fs.mkdirSync(configPath, { recursive: true, mode: 0o700 });
                logger.info({ configPath, agentAlias: this.config.alias }, 'Created missing OpenCode config directory before Docker mount');
            }
        } catch (error) {
            logger.warn({ configPath, agentAlias: this.config.alias, error: (error as Error).message }, 'Failed to ensure OpenCode config directory before Docker mount');
        }
    }
}
