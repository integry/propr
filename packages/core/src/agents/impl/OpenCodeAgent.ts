import fs from 'fs';
import { execSync } from 'child_process';
import logger from '../../utils/logger.js';
import { Agent, AgentConfig, AgentTaskOptions, AgentExecutionResult, AnalysisResult, AnalyzeOptions } from '../types.js';
import { executeDockerCommand } from '../../claude/docker/dockerExecutor.js';
import { wrapDockerRunArgsWithRepoSetup } from '../../claude/docker/repoSetupWrapper.js';
import { verifyWorktreeStructure, verifyWorktreePostExecution, setWorktreeOwnership, UsageLimitError } from '../../claude/claudeHelpers.js';
import { resolveConfigPath } from '../../config/configManager.js';
import { persistLlmLog, createLlmLogFromAnalysis, createLlmLogFromAgentExecution, buildTaskWorkRef, buildAnalysisWorkRef, formatUsageMetrics } from '../../utils/llmLogger.js';
import { executeWithUsageTracking, type UsageTrackingMetrics } from './utils/index.js';
import type { ExecutionType } from '../../utils/llmMetrics.types.js';

export { UsageLimitError };

const DEFAULT_OPENCODE_TIMEOUT_MS = 3600000;
const CONTAINER_CONFIG_PATH = '/home/node/.config/opencode';

interface OpenCodeEvent {
    type?: string;
    timestamp?: number | string;
    sessionID?: string;
    sessionId?: string;
    session_id?: string;
    part?: OpenCodePart;
    parts?: OpenCodePart[];
    message?: OpenCodeMessage;
    error?: { name?: string; data?: { message?: string }; message?: string } | string;
    model?: string;
    text?: string;
    content?: unknown;
    delta?: string;
    response?: OpenCodeTextContainer;
}

interface OpenCodeTextContainer {
    text?: string;
    content?: unknown;
    delta?: string;
}

interface OpenCodePart extends OpenCodeTextContainer {
    type?: string;
    messageID?: string;
    sessionID?: string;
}

interface OpenCodeMessage extends OpenCodeTextContainer {
    role?: string;
    model?: string;
    parts?: OpenCodePart[];
}

interface ParsedOpenCodeOutput {
    sessionId?: string;
    modelUsed?: string;
    summary?: string;
    error?: string;
    conversationLog: OpenCodeEvent[];
}

interface OpenCodeParseState {
    sessionId?: string;
    modelUsed?: string;
    error?: string;
    textParts: string[];
}

export class OpenCodeAgent implements Agent {
    readonly config: AgentConfig;
    private readonly timeoutMs: number;

    constructor(config: AgentConfig) {
        this.config = config;
        this.timeoutMs = parseInt(process.env.OPENCODE_TIMEOUT_MS || String(DEFAULT_OPENCODE_TIMEOUT_MS), 10);
    }

    async executeTask(options: AgentTaskOptions): Promise<AgentExecutionResult> {
        const { worktreePath, issueRef, prompt: customPrompt, model, isRetry = false, retryReason, onSessionId, onContainerId, githubToken, taskId, prNumber } = options;
        const startTime = Date.now();
        const effectiveModel = model || this.config.defaultModel;
        const repo = `${issueRef.repoOwner}/${issueRef.repoName}`;
        let prompt = customPrompt;

        logger.info({ issueNumber: issueRef.number, repository: repo, worktreePath, dockerImage: this.config.dockerImage, agentAlias: this.config.alias, isRetry, retryReason }, isRetry ? 'Starting OpenCode agent execution (RETRY)...' : 'Starting OpenCode agent execution...');

        try {
            prompt = this.buildPrompt(customPrompt, isRetry, retryReason);
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
                error: parsedOutput.error,
                usageMetrics: usageMetrics ?? undefined
            };

            await this.persistExecutionLog({ response, executionTime, modelUsed, prompt, issueRef, taskId, prNumber, isRetry, retryReason, usageMetrics });

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

        try {
            const dockerArgs = this.buildDockerArgs({ worktreePath: analysisWorkspace, githubToken: process.env.GITHUB_TOKEN || '', modelName: effectiveModel === 'unknown' ? undefined : effectiveModel, issueNumber: 0, taskId, executionType, readOnlyWorkspace: true, allowDangerousPermissions: false });
            const { result, usageMetrics } = await executeWithUsageTracking(
                'opencode',
                async () => executeDockerCommand('docker', dockerArgs, { timeout: 1800000, stdinData: analysisPrompt, taskId })
            );
            const executionTimeMs = Date.now() - startTime;
            const parsedOutput = this.parseOpenCodeJsonl(result.stdout);
            const analysisText = (parsedOutput.summary || '').trim();

            const modelUsed = parsedOutput.modelUsed || effectiveModel;
            const success = result.exitCode === 0 && !parsedOutput.error;

            const errorMsg = parsedOutput.error || result.stderr || 'No result returned';
            await this.persistAnalysisLogSafely({ executionType, modelUsed, executionTimeMs, success, error: success ? undefined : errorMsg, sessionId: parsedOutput.sessionId, taskId, correlationId, repository, metadata, taskNumber, prNumber, usageMetrics });
            return success
                ? { response: analysisText, modelUsed, executionTimeMs, success: true, sessionId: parsedOutput.sessionId }
                : { response: analysisText, modelUsed, executionTimeMs, success: false, error: `Analysis failed: ${errorMsg}` };
        } catch (error) {
            const executionTimeMs = Date.now() - startTime;
            const err = error as Error;
            logger.error({ agentAlias: this.config.alias, error: err.message, executionTimeMs }, 'OpenCode lightweight analysis failed');
            await this.persistAnalysisLogSafely({ executionType, modelUsed: effectiveModel, executionTimeMs, success: false, error: err.message, taskId, correlationId, repository, metadata, taskNumber, prNumber });
            return { response: '', modelUsed: effectiveModel, executionTimeMs, success: false, error: err.message };
        } finally {
            this.cleanupAnalysisWorkspace(analysisWorkspace);
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

    private buildPrompt(prompt: string, isRetry: boolean, retryReason?: string): string {
        if (!isRetry || !retryReason) return prompt;
        return `${prompt}\n\n---\n\n**RETRY CONTEXT**: This is a retry attempt. Previous attempt failed with: ${retryReason}\n\nPlease address the issues from the previous attempt.`;
    }

    private parseOpenCodeJsonl(output: string): ParsedOpenCodeOutput {
        const conversationLog: OpenCodeEvent[] = [];
        const state: OpenCodeParseState = { textParts: [] };

        for (const line of output.split('\n')) {
            if (!line.trim()) continue;
            try {
                const event = JSON.parse(line) as OpenCodeEvent;
                conversationLog.push(event);
                this.applyOpenCodeEvent(event, state);
            } catch {
                logger.debug({ linePreview: line.substring(0, 100) }, 'Non-JSON line in OpenCode output');
                state.textParts.push(line);
            }
        }

        return {
            sessionId: state.sessionId,
            modelUsed: state.modelUsed,
            summary: state.textParts.join('').trim() || undefined,
            error: state.error,
            conversationLog
        };
    }

    private applyOpenCodeEvent(event: OpenCodeEvent, state: OpenCodeParseState): void {
        state.sessionId = state.sessionId || event.sessionID || event.sessionId || event.session_id || event.part?.sessionID;
        state.modelUsed = event.message?.model || event.model || state.modelUsed;
        state.textParts.push(...this.extractOpenCodeText(event));
        if (event.type?.toLowerCase() === 'error' || event.error) {
            state.error = this.extractOpenCodeError(event);
        }
    }

    private extractOpenCodeText(event: OpenCodeEvent): string[] {
        const textParts: string[] = [];
        this.addPartText(textParts, event.part);
        this.addPartsText(textParts, event.parts);
        const hasEventParts = Boolean(event.part || event.parts?.length);
        const assistantMessage = event.message?.role === 'assistant' ? event.message : undefined;
        if (assistantMessage) {
            this.addTextContainer(textParts, assistantMessage);
            this.addPartsText(textParts, assistantMessage.parts);
        }
        if (!hasEventParts && !assistantMessage && this.isAssistantTextEvent(event)) {
            this.addTextContainer(textParts, event);
            this.addTextContainer(textParts, event.response);
        }
        return Array.from(new Set(textParts));
    }

    private addPartsText(textParts: string[], parts?: OpenCodePart[]): void {
        for (const part of parts || []) this.addPartText(textParts, part);
    }

    private addPartText(textParts: string[], part?: OpenCodePart): void {
        if (!part) return;
        const partType = part.type?.toLowerCase();
        if (partType && !['text', 'assistant_text', 'message', 'completion'].includes(partType)) return;
        this.addTextContainer(textParts, part);
    }

    private addTextContainer(textParts: string[], container?: OpenCodeTextContainer): void {
        if (!container) return;
        for (const value of [container.text, container.delta, container.content]) {
            if (typeof value === 'string' && value.length > 0) textParts.push(value);
        }
    }

    private isAssistantTextEvent(event: OpenCodeEvent): boolean {
        const type = event.type?.toLowerCase();
        return !!type && ['text', 'assistant', 'message', 'delta', 'completion'].includes(type);
    }

    private extractOpenCodeError(event: OpenCodeEvent): string {
        if (typeof event.error === 'string') return event.error;
        return event.error?.data?.message || event.error?.message || event.error?.name || 'OpenCode execution failed';
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
        usageMetrics?: UsageTrackingMetrics | null;
    }): Promise<void> {
        try {
            await persistLlmLog(createLlmLogFromAnalysis({
                executionType: (opts.executionType || 'other') as ExecutionType,
                modelUsed: opts.modelUsed,
                executionTimeMs: opts.executionTimeMs,
                success: opts.success,
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

    private buildDockerArgs(params: { worktreePath: string; githubToken: string; modelName?: string; issueNumber: number; taskId?: string; executionType?: string; readOnlyWorkspace?: boolean; allowDangerousPermissions?: boolean }): string[] {
        const { worktreePath, githubToken, modelName, issueNumber, taskId, executionType, readOnlyWorkspace, allowDangerousPermissions = true } = params;
        const configPath = resolveConfigPath(this.config.configPath);
        this.ensureHostConfigPath(configPath);
        const envVars: string[] = [];
        if (this.config.envVars) {
            for (const [key, value] of Object.entries(this.config.envVars)) envVars.push('-e', `${key}=${value}`);
        }
        const timestamp = Date.now().toString(36);
        const shortTaskId = taskId ? taskId.slice(-8) : timestamp;
        const taskType = executionType || (issueNumber === 0 ? 'analysis' : `issue-${issueNumber}`);
        const containerName = this.buildContainerName(this.config.alias || 'opencode', taskType, shortTaskId);
        const workspaceMode = readOnlyWorkspace ? 'ro' : 'rw';
        const commandArgs = ['opencode-run', '--format', 'json'];
        if (allowDangerousPermissions) commandArgs.push('--dangerously-skip-permissions');
        const dockerArgs: string[] = [
            'run', '--rm', '-i', '--name', containerName, '--security-opt', 'no-new-privileges', '--cap-add', 'CHOWN', '--network', 'bridge', '--user', '0:0',
            '-v', `${worktreePath}:/home/node/workspace:${workspaceMode}`, '-v', '/tmp/git-processor:/tmp/git-processor:rw',
            '-v', `${configPath}:${CONTAINER_CONFIG_PATH}:rw`,
            '-e', `GH_TOKEN=${githubToken}`, '-e', `GITHUB_TOKEN=${githubToken}`, '-e', 'OPENCODE_CONFIG_DIR=/home/node/.config/opencode',
            '-e', 'XDG_CONFIG_HOME=/home/node/.config', '-e', 'XDG_DATA_HOME=/home/node/.local/share', ...envVars,
            '-w', '/home/node/workspace', this.config.dockerImage, ...commandArgs
        ];

        if (modelName) {
            const cleanModelName = modelName.startsWith('opencode:') ? modelName.slice('opencode:'.length) : modelName;
            dockerArgs.push('--model', cleanModelName);
            logger.info({ issueNumber, requestedModel: cleanModelName, originalModel: modelName, agentAlias: this.config.alias }, 'Model specified for OpenCode agent');
        }

        return wrapDockerRunArgsWithRepoSetup(dockerArgs, this.config.dockerImage, 'opencode');
    }

    private buildContainerName(alias: string, taskType: string, shortTaskId: string): string {
        const rawName = `${alias}-${taskType}-${shortTaskId}`;
        const sanitized = rawName.replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '').slice(0, 120);
        return sanitized || `opencode-${Date.now().toString(36)}`;
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
