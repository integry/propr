import logger from '../../utils/logger.js';
import { Agent, AgentConfig, AgentTaskOptions, AgentExecutionResult, AnalysisResult, AnalyzeOptions } from '../types.js';
import { executeDockerCommand } from '../../claude/docker/dockerExecutor.js';
import {
    verifyWorktreeStructure,
    verifyWorktreePostExecution,
    setWorktreeOwnership,
    UsageLimitError
} from '../../claude/claudeHelpers.js';
import { resolveConfigPath } from '../../config/configManager.js';
import { persistLlmLog, createLlmLogFromAnalysis, buildTaskWorkRef, buildAnalysisWorkRef, formatUsageMetrics } from '../../utils/llmLogger.js';
import { executeWithUsageTracking, type UsageTrackingMetrics } from './utils/index.js';
import type { ExecutionType } from '../../utils/llmMetrics.types.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Re-export UsageLimitError for convenience
export { UsageLimitError };

const DEFAULT_GEMINI_TIMEOUT_MS = 300000;

// Container path for Gemini config
const CONTAINER_CONFIG_PATH = '/home/node/.gemini';

// Gemini JSONL event types (from --output-format stream-json)
interface GeminiInitEvent { type: 'init'; timestamp: string; session_id: string; model: string }
interface GeminiMessageEvent { type: 'message'; role: 'user' | 'assistant'; content: string; timestamp: string; delta?: boolean }
interface GeminiToolUseEvent { type: 'tool_use'; tool_name: string; tool_id: string; parameters: Record<string, unknown>; timestamp: string }
interface GeminiToolResultEvent { type: 'tool_result'; tool_id: string; status: 'success' | 'error'; output: string; timestamp: string }
interface GeminiResultEvent { type: 'result'; status: 'success' | 'error'; stats: { total_tokens?: number; input_tokens?: number; output_tokens?: number; duration_ms?: number; tool_calls?: number }; timestamp: string }
type GeminiEvent = GeminiInitEvent | GeminiMessageEvent | GeminiToolUseEvent | GeminiToolResultEvent | GeminiResultEvent | { type: 'error'; message: string; timestamp: string }

// ANSI escape code regex for stripping terminal formatting from TUI output
// Using String.fromCharCode() to construct the pattern dynamically, avoiding literal control chars
const ANSI_REGEX = new RegExp('[' + String.fromCharCode(0x1b) + String.fromCharCode(0x9b) + '][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]', 'g');

export class GeminiAgent implements Agent {
    readonly config: AgentConfig;
    private readonly timeoutMs: number;

    constructor(config: AgentConfig) {
        this.config = config;
        this.timeoutMs = parseInt(process.env.GEMINI_TIMEOUT_MS || String(DEFAULT_GEMINI_TIMEOUT_MS), 10);
    }

    async executeTask(options: AgentTaskOptions): Promise<AgentExecutionResult> {
        const { worktreePath, issueRef, prompt: customPrompt, model, isRetry = false, retryReason, onSessionId, onContainerId, githubToken, taskId, prNumber } = options;
        const startTime = Date.now();
        const effectiveModel = model || this.config.defaultModel;

        logger.info({
            issueNumber: issueRef.number, repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
            worktreePath, dockerImage: this.config.dockerImage, agentAlias: this.config.alias, isRetry, retryReason
        }, isRetry ? 'Starting Gemini agent execution (RETRY)...' : 'Starting Gemini agent execution...');

        try {
            const prompt = this.buildPromptWithRetryContext(customPrompt, isRetry, retryReason);
            const stdinData = prompt;

            await setWorktreeOwnership(worktreePath, issueRef.number);
            const worktreeGitContent = verifyWorktreeStructure(worktreePath, issueRef.number);
            const dockerArgs = this.buildDockerArgs({ worktreePath, githubToken, modelName: effectiveModel, issueNumber: issueRef.number, taskId });

            // Wrap execution with Agent Tank usage tracking
            const { result, usageMetrics } = await executeWithUsageTracking(
                'gemini',
                async () => executeDockerCommand('docker', dockerArgs, {
                    timeout: this.timeoutMs, cwd: worktreePath, onSessionId, onContainerId, worktreePath, stdinData,
                    taskId, streamToRedis: true
                })
            );

            const executionTime = Date.now() - startTime;
            return this.processExecutionResult({ result, executionTime, issueRef, effectiveModel, prompt, worktreePath, worktreeGitContent, onSessionId, taskId, prNumber, isRetry, retryReason, usageMetrics });
        } catch (error) {
            return this.handleExecutionError(error, Date.now() - startTime, issueRef, effectiveModel);
        }
    }

    private buildPromptWithRetryContext(prompt: string, isRetry: boolean, retryReason?: string): string {
        if (isRetry && retryReason) {
            return `${prompt}\n\n---\n\n**RETRY CONTEXT**: This is a retry attempt. Previous attempt failed with: ${retryReason}\n\nPlease address the issues from the previous attempt.`;
        }
        return prompt;
    }

    private async processExecutionResult(opts: {
        result: { stdout: string; stderr: string; exitCode: number | null }; executionTime: number;
        issueRef: { number: number; repoOwner: string; repoName: string }; effectiveModel: string | undefined;
        prompt: string; worktreePath: string; worktreeGitContent: string | null; onSessionId?: (sessionId: string) => void;
        taskId?: string; prNumber?: number; isRetry?: boolean; retryReason?: string; usageMetrics?: UsageTrackingMetrics | null;
    }): Promise<AgentExecutionResult> {
        const { result, executionTime, issueRef, effectiveModel, prompt, worktreePath, worktreeGitContent, onSessionId, taskId, prNumber, isRetry, retryReason, usageMetrics } = opts;
        logger.info({ issueNumber: issueRef.number, repository: `${issueRef.repoOwner}/${issueRef.repoName}`, executionTime, outputLength: result.stdout?.length || 0, success: result.exitCode === 0, exitCode: result.exitCode, agentAlias: this.config.alias }, 'Gemini agent execution completed');
        const { sessionId, modelUsed: parsedModel, summary, conversationLog, tokenUsage } = this.parseGeminiJsonl(result.stdout);
        if (sessionId && onSessionId) onSessionId(sessionId);
        if (sessionId && conversationLog.length > 0) await this.writeConversationFile(sessionId, conversationLog);
        const modelUsed = parsedModel || effectiveModel || 'unknown';
        const finalTokenUsage = (tokenUsage.input_tokens || tokenUsage.output_tokens) ? tokenUsage : undefined;
        const response: AgentExecutionResult = { success: result.exitCode === 0, executionTimeMs: executionTime, logs: result.stdout + (result.stderr ? `\n\nSTDERR:\n${result.stderr}` : ''), exitCode: result.exitCode, rawOutput: result.stdout, modelUsed, modifiedFiles: [], commitMessage: null, summary: summary ?? undefined, prompt, sessionId, conversationLog, tokenUsage: finalTokenUsage };

        // Persist LLM log for visibility in the LLM Logs UI (including Agent Tank usage if available)
        const repository = `${issueRef.repoOwner}/${issueRef.repoName}`;
        const logEntry = createLlmLogFromAnalysis({
            executionType: 'implementation',
            modelUsed,
            executionTimeMs: executionTime,
            success: response.success,
            tokenUsage: finalTokenUsage,
            error: response.success ? undefined : (result.stderr || 'Execution failed'),
            sessionId,
            draftId: taskId,
            repository,
            agentAlias: this.config.alias,
            metadata: { isRetry, retryReason },
            usageMetrics: usageMetrics ? {
                preCall: usageMetrics.preCall,
                postCall: usageMetrics.postCall,
                delta: usageMetrics.delta,
                timestamp: usageMetrics.timestamp,
                agent: usageMetrics.agent
            } : undefined,
            usageMetricRecords: usageMetrics?.records,
            workRef: buildTaskWorkRef(taskId, issueRef.number, repository, prNumber),
        });
        await persistLlmLog(logEntry);

        if (!response.success) logger.error({ issueNumber: issueRef.number, exitCode: result.exitCode, stderr: result.stderr, agentAlias: this.config.alias }, 'Gemini agent execution failed');
        else { logger.info({ issueNumber: issueRef.number, model: modelUsed, agentAlias: this.config.alias }, 'Gemini agent execution succeeded'); verifyWorktreePostExecution(worktreePath, issueRef.number, worktreeGitContent); }
        return response;
    }

    private handleExecutionError(error: unknown, executionTime: number, issueRef: { number: number; repoOwner: string; repoName: string }, effectiveModel: string | undefined): AgentExecutionResult {
        if (error instanceof UsageLimitError) throw error;
        const err = error as Error;
        logger.error({ issueNumber: issueRef.number, repository: `${issueRef.repoOwner}/${issueRef.repoName}`, executionTime, error: err.message, agentAlias: this.config.alias }, 'Error during Gemini agent execution');
        return {
            success: false, error: err.message, executionTimeMs: executionTime,
            logs: (error as { stderr?: string }).stderr || err.message, modifiedFiles: [],
            commitMessage: null, summary: undefined, modelUsed: effectiveModel || 'unknown'
        };
    }

    async analyze(prompt: string, options?: AnalyzeOptions): Promise<AnalysisResult> {
        const { context, model, taskId, taskNumber, prNumber, executionType, correlationId, repository, metadata } = options || {};
        const startTime = Date.now();
        logger.info({ agentAlias: this.config.alias, promptLength: prompt.length, hasContext: !!context, requestedModel: model, taskId, executionType }, 'Running lightweight analysis via Gemini agent...');
        const effectiveModel = model || 'gemini-2.5-flash';
        const suffix = '\n\nCRITICAL: Do not modify any files. Do not run any commands. Only provide your analysis as plain text output.';
        const stdinData = context ? `${prompt}\n\nContext:\n${context}${suffix}` : `${prompt}${suffix}`;
        try {
            // Use stream-json to get token usage metrics
            const dockerArgs = this.buildDockerArgs({ worktreePath: '/tmp/gemini-analysis', githubToken: process.env.GITHUB_TOKEN || '', modelName: effectiveModel, issueNumber: 0, outputFormat: 'stream-json', taskId, executionType });

            // Wrap execution with Agent Tank usage tracking
            const { result, usageMetrics } = await executeWithUsageTracking(
                'gemini',
                async () => executeDockerCommand('docker', dockerArgs, { timeout: 1800000, stdinData, taskId })
            );
            const executionTimeMs = Date.now() - startTime;

            // Parse JSONL output to extract response and token usage
            const { summary, tokenUsage, sessionId } = this.parseGeminiJsonl(result.stdout);

            if (result.exitCode === 0 || summary) {
                const analysisText = (summary || '').trim();
                logger.info({
                    agentAlias: this.config.alias,
                    responseLength: analysisText.length,
                    model: effectiveModel,
                    executionTimeMs,
                    inputTokens: tokenUsage.input_tokens,
                    outputTokens: tokenUsage.output_tokens,
                    usageMetrics: usageMetrics ? { delta: usageMetrics.delta } : null
                }, 'Lightweight analysis completed');

                // Persist LLM log with usage metrics for analysis calls
                const usage = formatUsageMetrics(usageMetrics);
                const geminiTokenUsage = (tokenUsage.input_tokens || tokenUsage.output_tokens) ? {
                    input_tokens: tokenUsage.input_tokens,
                    output_tokens: tokenUsage.output_tokens
                } : undefined;
                await persistLlmLog(createLlmLogFromAnalysis({
                    executionType: (executionType || 'other') as ExecutionType,
                    modelUsed: effectiveModel,
                    executionTimeMs,
                    success: true,
                    tokenUsage: geminiTokenUsage,
                    sessionId,
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
                    modelUsed: effectiveModel,
                    executionTimeMs,
                    success: true,
                    tokenUsage: (tokenUsage.input_tokens || tokenUsage.output_tokens) ? {
                        input_tokens: tokenUsage.input_tokens,
                        output_tokens: tokenUsage.output_tokens
                    } : undefined,
                    sessionId
                };
            }
            const errorMsg = result.stderr || 'No result returned';
            return {
                response: '',
                modelUsed: effectiveModel,
                executionTimeMs,
                success: false,
                error: `Analysis failed: ${errorMsg}`
            };
        } catch (error) {
            const executionTimeMs = Date.now() - startTime;
            const err = error as Error;
            logger.error({ agentAlias: this.config.alias, error: err.message, executionTimeMs }, 'Lightweight analysis failed');
            return {
                response: '',
                modelUsed: effectiveModel,
                executionTimeMs,
                success: false,
                error: err.message
            };
        }
    }

    async healthCheck(): Promise<boolean> {
        logger.debug({ agentAlias: this.config.alias, dockerImage: this.config.dockerImage }, 'Running health check for Gemini agent...');
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

    /** Strips ANSI escape codes from output (Gemini CLI is a TUI that produces ANSI-formatted output). */
    private stripAnsiCodes(text: string): string { return text.replace(ANSI_REGEX, ''); }

    /** Extracts the meaningful result from Gemini CLI output, filtering TUI elements. */
    private extractGeminiResult(cleanedOutput: string): string | undefined {
        const resultLines: string[] = [];
        let inResponse = false;
        for (const line of cleanedOutput.split('\n')) {
            const t = line.trim();
            if (!inResponse && !t) continue;
            if (t.startsWith('>') || t === '/quit' || t.startsWith('Gemini') || t.includes('Press') || t.includes('Ctrl+')) continue;
            inResponse = true;
            resultLines.push(line);
        }
        const result = resultLines.join('\n').trim();
        return result || undefined;
    }

    /** Builds Docker arguments for running Gemini in a container. */
    private buildDockerArgs(params: { worktreePath: string; githubToken: string; modelName?: string; issueNumber: number; outputFormat?: 'stream-json' | 'text'; taskId?: string; executionType?: string }): string[] {
        const { worktreePath, githubToken, modelName, issueNumber, outputFormat = 'stream-json', taskId, executionType } = params;
        const configPath = resolveConfigPath(this.config.configPath);
        const envVars: string[] = [];
        if (this.config.envVars) {
            for (const [key, value] of Object.entries(this.config.envVars)) envVars.push('-e', `${key}=${value}`);
        }
        // Generate human-readable container name
        const timestamp = Date.now().toString(36);
        const shortTaskId = taskId ? taskId.slice(-8) : timestamp;
        const taskType = executionType || (issueNumber === 0 ? 'analysis' : `issue-${issueNumber}`);
        const containerName = `${this.config.alias || 'gemini'}-${taskType}-${shortTaskId}`;
        const dockerArgs: string[] = [
            'run', '--rm', '-i', '--name', containerName, '--security-opt', 'no-new-privileges', '--cap-add', 'CHOWN', '--network', 'bridge', '--user', '0:0',
            '-v', `${worktreePath}:/home/node/workspace:rw`, '-v', '/tmp/git-processor:/tmp/git-processor:rw', '-v', `${configPath}:${CONTAINER_CONFIG_PATH}:rw`,
            '-e', `GH_TOKEN=${githubToken}`, '-e', `GITHUB_TOKEN=${githubToken}`, '-e', 'GEMINI_CLI=1', ...envVars, '-w', '/home/node/workspace',
            this.config.dockerImage, 'gemini', '--yolo', '--output-format', outputFormat
        ];
        if (modelName) { dockerArgs.push('-m', modelName); logger.info({ issueNumber, requestedModel: modelName, agentAlias: this.config.alias }, 'Model specified for Gemini agent'); }
        else { logger.debug({ issueNumber, agentAlias: this.config.alias }, 'No model specified, Gemini agent will use default'); }
        logger.info({ issueNumber, agentAlias: this.config.alias }, 'Docker args built for Gemini agent');
        return dockerArgs;
    }

    /** Handles an assistant message event, updating current and last complete assistant messages. */
    private handleAssistantMessage(msgEvent: GeminiMessageEvent, current: string, last: string): { current: string; last: string } {
        if (msgEvent.delta) return { current: current + msgEvent.content, last };
        return { current: '', last: msgEvent.content };
    }

    /** Processes a single parsed Gemini event, extracting metadata and tracking assistant messages. */
    private processGeminiEvent(event: GeminiEvent, state: { sessionId: string | undefined; modelUsed: string | undefined; tokenUsage: { input_tokens?: number; output_tokens?: number }; currentAssistantMessage: string; lastCompleteAssistantMessage: string }): void {
        if (event.type === 'init') {
            state.sessionId = (event as GeminiInitEvent).session_id;
            state.modelUsed = (event as GeminiInitEvent).model;
            logger.debug({ sessionId: state.sessionId, model: state.modelUsed }, 'Parsed Gemini init event');
            return;
        }
        if (event.type === 'message' && (event as GeminiMessageEvent).role === 'assistant') {
            const msgEvent = event as GeminiMessageEvent;
            const result = this.handleAssistantMessage(msgEvent, state.currentAssistantMessage, state.lastCompleteAssistantMessage);
            state.currentAssistantMessage = result.current;
            state.lastCompleteAssistantMessage = result.last;
            return;
        }
        if (event.type === 'result') {
            const resultEvent = event as GeminiResultEvent;
            state.tokenUsage = { input_tokens: resultEvent.stats.input_tokens, output_tokens: resultEvent.stats.output_tokens };
            logger.debug({ tokenUsage: state.tokenUsage }, 'Parsed Gemini result event with token usage');
        }
        if (event.type !== 'message' && state.currentAssistantMessage) {
            state.lastCompleteAssistantMessage = state.currentAssistantMessage;
            state.currentAssistantMessage = '';
        }
    }

    /** Parses Gemini JSONL output from streaming JSON format. Extracts session ID, model, summary, and conversation log. */
    private parseGeminiJsonl(output: string): { sessionId: string | undefined; modelUsed: string | undefined; summary: string | undefined; conversationLog: GeminiEvent[]; tokenUsage: { input_tokens?: number; output_tokens?: number } } {
        const events: GeminiEvent[] = [];
        const state = { sessionId: undefined as string | undefined, modelUsed: undefined as string | undefined, tokenUsage: {} as { input_tokens?: number; output_tokens?: number }, currentAssistantMessage: '', lastCompleteAssistantMessage: '' };
        for (const line of output.split('\n')) {
            if (!line.trim()) continue;
            try { const event = JSON.parse(line) as GeminiEvent; events.push(event); this.processGeminiEvent(event, state); }
            catch { logger.debug({ linePreview: line.substring(0, 100) }, 'Non-JSON line in Gemini output'); }
        }
        if (state.currentAssistantMessage) state.lastCompleteAssistantMessage = state.currentAssistantMessage;
        return { sessionId: state.sessionId, modelUsed: state.modelUsed, summary: state.lastCompleteAssistantMessage || undefined, conversationLog: events, tokenUsage: state.tokenUsage };
    }

    private async writeConversationFile(sessionId: string, events: GeminiEvent[]): Promise<void> {
        try {
            const projectDir = path.join(os.homedir(), '.claude', 'projects', '-home-node-workspace');
            await fs.promises.mkdir(projectDir, { recursive: true });
            const conversationPath = path.join(projectDir, `${sessionId}.jsonl`);
            const aggregatedEvents = this.aggregateDeltaMessages(events);
            const claudeFormatEvents = aggregatedEvents.map(event => this.convertEventToClaudeFormat(event));
            await fs.promises.writeFile(conversationPath, claudeFormatEvents.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
            logger.info({ sessionId, path: conversationPath, eventCount: aggregatedEvents.length, originalCount: events.length }, 'Wrote Gemini conversation file');
        } catch (error) { logger.warn({ sessionId, error: (error as Error).message }, 'Failed to write Gemini conversation file'); }
    }

    /** Flushes pending message to result array and returns null. */
    private flushPendingMessage(result: GeminiEvent[], pending: { content: string; timestamp: string; role: 'user' | 'assistant' } | null): null {
        if (pending) result.push({ type: 'message', role: pending.role, content: pending.content, timestamp: pending.timestamp } as GeminiMessageEvent);
        return null;
    }

    /** Aggregates consecutive delta messages into single messages. Gemini streams assistant responses as multiple delta events. */
    private aggregateDeltaMessages(events: GeminiEvent[]): GeminiEvent[] {
        const result: GeminiEvent[] = [];
        let pending: { content: string; timestamp: string; role: 'user' | 'assistant' } | null = null;
        for (const event of events) {
            if (event.type !== 'message') { pending = this.flushPendingMessage(result, pending); result.push(event); continue; }
            const msgEvent = event as GeminiMessageEvent;
            if (msgEvent.role !== 'assistant') { pending = this.flushPendingMessage(result, pending); result.push(event); continue; }
            if (msgEvent.delta) {
                if (pending && pending.role === 'assistant') { pending.content += msgEvent.content; }
                else { pending = this.flushPendingMessage(result, pending); pending = { content: msgEvent.content, timestamp: msgEvent.timestamp, role: 'assistant' }; }
            } else { pending = this.flushPendingMessage(result, pending); result.push(event); }
        }
        this.flushPendingMessage(result, pending);
        return result;
    }

    private convertEventToClaudeFormat(event: GeminiEvent): unknown {
        if (event.type === 'message') { const e = event as GeminiMessageEvent; return { type: e.role === 'assistant' ? 'assistant' : 'user', timestamp: e.timestamp, message: { content: [{ type: 'text', text: e.content }] } }; }
        if (event.type === 'tool_use') { const e = event as GeminiToolUseEvent; return { type: 'assistant', timestamp: e.timestamp, message: { content: [{ type: 'tool_use', name: e.tool_name, id: e.tool_id, input: e.parameters }] } }; }
        if (event.type === 'tool_result') { const e = event as GeminiToolResultEvent; return { type: 'user', timestamp: e.timestamp, message: { content: [{ type: 'tool_result', tool_use_id: e.tool_id, content: e.output, is_error: e.status === 'error' }] } }; }
        if (event.type === 'result') { const e = event as GeminiResultEvent; return { type: 'result', timestamp: e.timestamp, message: { usage: { input_tokens: e.stats.input_tokens, output_tokens: e.stats.output_tokens } } }; }
        return event;
    }
}
