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
import type { ExecutionType } from '../../utils/llmMetrics.types.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Re-export UsageLimitError for convenience
export { UsageLimitError };

const DEFAULT_ANTIGRAVITY_TIMEOUT_MS = 300000;
const ANALYSIS_AGENT_TANK_TIMEOUT_MS = parseInt(process.env.ANALYSIS_AGENT_TANK_TIMEOUT_MS || '2000', 10);

const ANTIGRAVITY_CONTAINER_CONFIG_PATH = '/home/node/.gemini';
const ANTIGRAVITY_CONTAINER_WORKSPACE_PATH = '/home/node/workspace';
const ANTIGRAVITY_MODEL_LABELS: Record<string, string> = {
    'antigravity-gemini-3.5-flash-medium': 'Gemini 3.5 Flash (Medium)',
    'antigravity-gemini-3.5-flash-high': 'Gemini 3.5 Flash (High)',
    'antigravity-gemini-3.5-flash-low': 'Gemini 3.5 Flash (Low)',
    'antigravity-gemini-3.1-pro-low': 'Gemini 3.1 Pro (Low)',
    'antigravity-gemini-3.1-pro-high': 'Gemini 3.1 Pro (High)',
    'antigravity-claude-sonnet-4.6-thinking': 'Claude Sonnet 4.6 (Thinking)',
    'antigravity-claude-opus-4.6-thinking': 'Claude Opus 4.6 (Thinking)',
    'antigravity-gpt-oss-120b-medium': 'GPT-OSS 120B (Medium)'
};

// Antigravity JSONL event types. The current CLI prints plain text in
// non-interactive mode, but keep JSONL parsing for forward compatibility.
interface AntigravityInitEvent { type: 'init'; timestamp: string; session_id: string; model: string }
interface AntigravityMessageEvent { type: 'message'; role: 'user' | 'assistant'; content: string; timestamp: string; delta?: boolean }
interface AntigravityToolUseEvent { type: 'tool_use'; tool_name: string; tool_id: string; parameters: Record<string, unknown>; timestamp: string }
interface AntigravityToolResultEvent { type: 'tool_result'; tool_id: string; status: 'success' | 'error'; output: string; timestamp: string }
interface AntigravityResultEvent { type: 'result'; status: 'success' | 'error'; stats: { total_tokens?: number; input_tokens?: number; output_tokens?: number; duration_ms?: number; tool_calls?: number }; timestamp: string }
type AntigravityEvent = AntigravityInitEvent | AntigravityMessageEvent | AntigravityToolUseEvent | AntigravityToolResultEvent | AntigravityResultEvent | { type: 'error'; message: string; timestamp: string }
interface AntigravityTranscriptEvent { step_index?: number; source: string; type: string; status?: string; created_at?: string; content?: string }
type AntigravityOutputEvent = AntigravityEvent | AntigravityTranscriptEvent;

// ANSI escape code regex for stripping terminal formatting from TUI output
// Using String.fromCharCode() to construct the pattern dynamically, avoiding literal control chars
const ANSI_REGEX = new RegExp('[' + String.fromCharCode(0x1b) + String.fromCharCode(0x9b) + '][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]', 'g');

export class AntigravityAgent implements Agent {
    readonly config: AgentConfig;
    private readonly timeoutMs: number;

    constructor(config: AgentConfig) {
        this.config = config;
        this.timeoutMs = parseInt(process.env.ANTIGRAVITY_TIMEOUT_MS || String(DEFAULT_ANTIGRAVITY_TIMEOUT_MS), 10);
    }

    private getRuntimeName(): 'antigravity' {
        return 'antigravity';
    }

    private getContainerConfigPath(): string {
        return ANTIGRAVITY_CONTAINER_CONFIG_PATH;
    }

    private getCliCommand(): string {
        return 'agy';
    }

    private getHostConfigPath(): string {
        const configuredPath = resolveConfigPath(process.env.ANTIGRAVITY_CONFIG_PATH || this.config.configPath);
        if (configuredPath.endsWith(`${path.sep}.antigravity`)) {
            const geminiPath = path.join(path.dirname(configuredPath), '.gemini');
            if (fs.existsSync(geminiPath)) {
                return geminiPath;
            }
        }
        return configuredPath;
    }

    async executeTask(options: AgentTaskOptions): Promise<AgentExecutionResult> {
        const { worktreePath, issueRef, prompt: customPrompt, model, isRetry = false, retryReason, onSessionId, onContainerId, githubToken, environment, taskId, prNumber } = options;
        const startTime = Date.now();
        const effectiveModel = model || this.config.defaultModel;

        logger.info({
            issueNumber: issueRef.number, repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
            worktreePath, dockerImage: this.config.dockerImage, agentAlias: this.config.alias, isRetry, retryReason
        }, isRetry ? 'Starting Antigravity agent execution (RETRY)...' : 'Starting Antigravity agent execution...');

        try {
            const prompt = this.buildPromptWithRetryContext(customPrompt, isRetry, retryReason);
            const stdinData = prompt;

            await setWorktreeOwnership(worktreePath, issueRef.number);
            const worktreeGitContent = verifyWorktreeStructure(worktreePath, issueRef.number);
            const dockerArgs = this.buildDockerArgs({ worktreePath, githubToken, modelName: effectiveModel, issueNumber: issueRef.number, environment, taskId });

            // Wrap execution with Agent Tank usage tracking
            const { result, usageMetrics } = await executeWithUsageTracking(
                this.getRuntimeName(),
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
        logger.info({ issueNumber: issueRef.number, repository: `${issueRef.repoOwner}/${issueRef.repoName}`, executionTime, outputLength: result.stdout?.length || 0, success: result.exitCode === 0, exitCode: result.exitCode, agentAlias: this.config.alias }, 'Antigravity agent execution completed');
        const parsedOutput = this.parseAntigravityJsonl(result.stdout);
        const sessionOutput = await this.readPersistedSessionOutput(worktreePath, parsedOutput.sessionId);
        const sessionId = sessionOutput.sessionId || parsedOutput.sessionId;
        const parsedModel = parsedOutput.modelUsed;
        const summary = sessionOutput.summary || parsedOutput.summary;
        const conversationLog = sessionOutput.conversationLog.length > 0 ? sessionOutput.conversationLog : parsedOutput.conversationLog;
        const tokenUsage = parsedOutput.tokenUsage;
        if (sessionId && onSessionId) onSessionId(sessionId);
        if (sessionId && conversationLog.length > 0) await this.writeConversationFile(sessionId, conversationLog);
        const modelUsed = parsedModel || effectiveModel || 'unknown';
        const finalTokenUsage = (tokenUsage.input_tokens || tokenUsage.output_tokens) ? tokenUsage : undefined;
        const response: AgentExecutionResult = {
            success: result.exitCode === 0, executionTimeMs: executionTime,
            logs: result.stdout + (result.stderr ? `\n\nSTDERR:\n${result.stderr}` : ''),
            exitCode: result.exitCode, rawOutput: result.stdout, modelUsed, modifiedFiles: [],
            commitMessage: null, summary: summary ?? undefined, prompt, sessionId, conversationLog,
            tokenUsage: finalTokenUsage,
            usageMetrics: usageMetrics ?? undefined
        };

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

        if (!response.success) logger.error({ issueNumber: issueRef.number, exitCode: result.exitCode, stderr: result.stderr, agentAlias: this.config.alias }, 'Antigravity agent execution failed');
        else { logger.info({ issueNumber: issueRef.number, model: modelUsed, agentAlias: this.config.alias }, 'Antigravity agent execution succeeded'); verifyWorktreePostExecution(worktreePath, issueRef.number, worktreeGitContent); }
        return response;
    }

    private handleExecutionError(error: unknown, executionTime: number, issueRef: { number: number; repoOwner: string; repoName: string }, effectiveModel: string | undefined): AgentExecutionResult {
        if (error instanceof UsageLimitError) throw error;
        const err = error as Error;
        logger.error({ issueNumber: issueRef.number, repository: `${issueRef.repoOwner}/${issueRef.repoName}`, executionTime, error: err.message, agentAlias: this.config.alias }, 'Error during Antigravity agent execution');
        return {
            success: false, error: err.message, executionTimeMs: executionTime,
            logs: (error as { stderr?: string }).stderr || err.message, modifiedFiles: [],
            commitMessage: null, summary: undefined, modelUsed: effectiveModel || 'unknown'
        };
    }

    async analyze(prompt: string, options?: AnalyzeOptions): Promise<AnalysisResult> {
        const { context, model, taskId, taskNumber, prNumber, executionType, correlationId, repository, metadata, timeoutMs, responseFormat = 'text' } = options || {};
        const startTime = Date.now();
        logger.info({ agentAlias: this.config.alias, promptLength: prompt.length, hasContext: !!context, requestedModel: model, taskId, executionType }, 'Running lightweight analysis via Antigravity agent...');
        const effectiveModel = model || 'antigravity-gemini-3.5-flash-medium';
        const suffix = responseFormat === 'json'
            ? '\n\nCRITICAL: Do not modify any files. Do not run any commands. Return only valid JSON matching the requested schema. Do not include markdown or explanatory text.'
            : '\n\nCRITICAL: Do not modify any files. Do not run any commands. Only provide your analysis as plain text output.';
        const stdinData = context ? `${prompt}\n\nContext:\n${context}${suffix}` : `${prompt}${suffix}`;
        try {
            const dockerArgs = this.buildDockerArgs({ worktreePath: '/tmp/antigravity-analysis', githubToken: process.env.GITHUB_TOKEN || '', modelName: effectiveModel, issueNumber: 0, taskId, executionType });

            // Wrap execution with Agent Tank usage tracking
            const { result, usageMetrics } = await executeWithUsageTracking(
                this.getRuntimeName(),
                async () => executeDockerCommand('docker', dockerArgs, { timeout: timeoutMs ?? 1800000, stdinData, taskId }),
                ANALYSIS_AGENT_TANK_TIMEOUT_MS
            );
            const executionTimeMs = Date.now() - startTime;

            // Parse JSONL output to extract response and token usage
            const { summary, tokenUsage, sessionId } = this.parseAntigravityJsonl(result.stdout);

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
                const antigravityTokenUsage = (tokenUsage.input_tokens || tokenUsage.output_tokens) ? {
                    input_tokens: tokenUsage.input_tokens,
                    output_tokens: tokenUsage.output_tokens
                } : undefined;
                await persistLlmLog(createLlmLogFromAnalysis({
                    executionType: (executionType || 'other') as ExecutionType,
                    modelUsed: effectiveModel,
                    executionTimeMs,
                    success: true,
                    tokenUsage: antigravityTokenUsage,
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
        logger.debug({ agentAlias: this.config.alias, dockerImage: this.config.dockerImage }, 'Running health check for Antigravity agent...');
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

    /** Strips ANSI escape codes from output (Antigravity CLI is a TUI that produces ANSI-formatted output). */
    private stripAnsiCodes(text: string): string { return text.replace(ANSI_REGEX, ''); }

    /** Extracts the meaningful result from Antigravity CLI output, filtering TUI elements. */
    private extractAntigravityResult(cleanedOutput: string): string | undefined {
        const resultLines: string[] = [];
        let inResponse = false;
        for (const line of cleanedOutput.split('\n')) {
            const t = line.trim();
            if (!inResponse && !t) continue;
            if (t.startsWith('>') || t === '/quit' || t.startsWith('Antigravity') || t.includes('Press') || t.includes('Ctrl+')) continue;
            inResponse = true;
            resultLines.push(line);
        }
        const result = resultLines.join('\n').trim();
        return result || undefined;
    }

    private buildAntigravityShellCommand(): string {
        return [
            'set -e',
            'prompt="$(cat)"',
            `exec ${this.getCliCommand()} --dangerously-skip-permissions "$@" --print "$prompt"`
        ].join('\n');
    }

    /** Builds Docker arguments for running Antigravity in a container. */
    private buildDockerArgs(params: { worktreePath: string; githubToken: string; modelName?: string; issueNumber: number; environment?: Record<string, string>; taskId?: string; executionType?: string }): string[] {
        const { worktreePath, githubToken, modelName, issueNumber, environment, taskId, executionType } = params;
        const configPath = this.getHostConfigPath();
        const envVars: string[] = [];
        if (this.config.envVars) {
            for (const [key, value] of Object.entries(this.config.envVars)) envVars.push('-e', `${key}=${value}`);
        }
        if (environment) {
            for (const [key, value] of Object.entries(environment)) envVars.push('-e', `${key}=${value}`);
        }
        // Generate human-readable container name
        const timestamp = Date.now().toString(36);
        const shortTaskId = taskId ? taskId.slice(-8) : timestamp;
        const taskType = executionType || (issueNumber === 0 ? 'analysis' : `issue-${issueNumber}`);
        const runtimeName = this.getRuntimeName();
        const containerName = `${this.config.alias || runtimeName}-${taskType}-${shortTaskId}`;
        const dockerArgs: string[] = [
            'run', '--rm', '-i', '--name', containerName, '--security-opt', 'no-new-privileges', '--cap-add', 'CHOWN', '--network', 'bridge', '--user', '0:0',
            '-v', `${worktreePath}:/home/node/workspace:rw`, '-v', '/tmp/git-processor:/tmp/git-processor:rw', '-v', `${configPath}:${this.getContainerConfigPath()}:rw`,
            '-e', `GH_TOKEN=${githubToken}`, '-e', `GITHUB_TOKEN=${githubToken}`, '-e', 'ANTIGRAVITY_CLI=1', '-e', 'ANTIGRAVITY_CLI_TRUST_WORKSPACE=true', ...envVars, '-w', '/home/node/workspace',
            this.config.dockerImage, '/bin/bash', '-lc', this.buildAntigravityShellCommand(), 'propr-antigravity'
        ];
        if (modelName) {
            // Strip agent prefix if present (e.g., "antigravity:antigravity-gemini-3-flash-preview" -> "antigravity-gemini-3-flash-preview")
            const unscopedModelName = modelName.includes(':') ? modelName.split(':').pop()! : modelName;
            const cleanModelName = ANTIGRAVITY_MODEL_LABELS[unscopedModelName]
                || (runtimeName === 'antigravity' && unscopedModelName.startsWith('antigravity-')
                    ? unscopedModelName.slice('antigravity-'.length)
                    : unscopedModelName);
            dockerArgs.push('--model', cleanModelName);
            logger.info({ issueNumber, requestedModel: cleanModelName, originalModel: modelName, agentAlias: this.config.alias }, 'Model specified for Antigravity agent');
        }
        else { logger.debug({ issueNumber, agentAlias: this.config.alias }, 'No model specified, Antigravity agent will use default'); }
        logger.info({ issueNumber, agentAlias: this.config.alias }, 'Docker args built for Antigravity agent');
        return wrapDockerRunArgsWithRepoSetup(dockerArgs, this.config.dockerImage, runtimeName);
    }

    /** Handles an assistant message event, updating current and last complete assistant messages. */
    private handleAssistantMessage(msgEvent: AntigravityMessageEvent, current: string, last: string): { current: string; last: string } {
        if (msgEvent.delta) return { current: current + msgEvent.content, last };
        return { current: '', last: msgEvent.content };
    }

    private isAntigravityTranscriptEvent(event: unknown): event is AntigravityTranscriptEvent {
        const candidate = event as Partial<AntigravityTranscriptEvent>;
        return typeof candidate.source === 'string'
            && typeof candidate.type === 'string'
            && !['init', 'message', 'tool_use', 'tool_result', 'result', 'error'].includes(candidate.type);
    }

    private updateFromTranscriptEvent(event: AntigravityTranscriptEvent, state: { lastCompleteAssistantMessage: string }): void {
        if (event.source === 'MODEL' && typeof event.content === 'string' && event.content.trim()) {
            state.lastCompleteAssistantMessage = event.content;
        }
    }

    /** Processes a single parsed Antigravity event, extracting metadata and tracking assistant messages. */
    private processAntigravityEvent(event: AntigravityEvent, state: { sessionId: string | undefined; modelUsed: string | undefined; tokenUsage: { input_tokens?: number; output_tokens?: number }; currentAssistantMessage: string; lastCompleteAssistantMessage: string }): void {
        if (event.type === 'init') {
            state.sessionId = (event as AntigravityInitEvent).session_id;
            state.modelUsed = (event as AntigravityInitEvent).model;
            logger.debug({ sessionId: state.sessionId, model: state.modelUsed }, 'Parsed Antigravity init event');
            return;
        }
        if (event.type === 'message' && (event as AntigravityMessageEvent).role === 'assistant') {
            const msgEvent = event as AntigravityMessageEvent;
            const result = this.handleAssistantMessage(msgEvent, state.currentAssistantMessage, state.lastCompleteAssistantMessage);
            state.currentAssistantMessage = result.current;
            state.lastCompleteAssistantMessage = result.last;
            return;
        }
        if (event.type === 'result') {
            const resultEvent = event as AntigravityResultEvent;
            state.tokenUsage = { input_tokens: resultEvent.stats.input_tokens, output_tokens: resultEvent.stats.output_tokens };
            logger.debug({ tokenUsage: state.tokenUsage }, 'Parsed Antigravity result event with token usage');
        }
        if (event.type !== 'message' && state.currentAssistantMessage) {
            state.lastCompleteAssistantMessage = state.currentAssistantMessage;
            state.currentAssistantMessage = '';
        }
    }

    private getLastConversationsPath(): string {
        return path.join(this.getHostConfigPath(), 'antigravity-cli', 'cache', 'last_conversations.json');
    }

    private async readLastConversationId(worktreePath: string): Promise<string | undefined> {
        try {
            const lastConversationsPath = this.getLastConversationsPath();
            const raw = await fs.promises.readFile(lastConversationsPath, 'utf8');
            const conversations = JSON.parse(raw) as Record<string, unknown>;
            const candidates = [
                ANTIGRAVITY_CONTAINER_WORKSPACE_PATH,
                worktreePath,
                path.resolve(worktreePath)
            ];
            for (const key of candidates) {
                const sessionId = conversations[key];
                if (typeof sessionId === 'string' && sessionId.trim()) return sessionId;
            }
        } catch (error) {
            logger.debug({ error: (error as Error).message, agentAlias: this.config.alias }, 'Could not read Antigravity last conversations cache');
        }
        return undefined;
    }

    private async readTranscriptForSession(sessionId: string): Promise<string | undefined> {
        const transcriptPath = path.join(this.getHostConfigPath(), 'antigravity-cli', 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl');
        try {
            return await fs.promises.readFile(transcriptPath, 'utf8');
        } catch (error) {
            logger.debug({ sessionId, transcriptPath, error: (error as Error).message, agentAlias: this.config.alias }, 'Could not read Antigravity transcript');
            return undefined;
        }
    }

    private async readPersistedSessionOutput(worktreePath: string, parsedSessionId?: string): Promise<{ sessionId: string | undefined; summary: string | undefined; conversationLog: AntigravityOutputEvent[] }> {
        const sessionId = parsedSessionId || await this.readLastConversationId(worktreePath);
        if (!sessionId) return { sessionId: undefined, summary: undefined, conversationLog: [] };

        const transcript = await this.readTranscriptForSession(sessionId);
        if (!transcript) return { sessionId, summary: undefined, conversationLog: [] };

        const parsed = this.parseAntigravityJsonl(transcript);
        return { sessionId, summary: parsed.summary, conversationLog: parsed.conversationLog };
    }

    /** Parses Antigravity output. JSONL is supported when present; otherwise plain text is used as the summary. */
    private parseAntigravityJsonl(output: string): { sessionId: string | undefined; modelUsed: string | undefined; summary: string | undefined; conversationLog: AntigravityOutputEvent[]; tokenUsage: { input_tokens?: number; output_tokens?: number } } {
        const events: AntigravityOutputEvent[] = [];
        const state = { sessionId: undefined as string | undefined, modelUsed: undefined as string | undefined, tokenUsage: {} as { input_tokens?: number; output_tokens?: number }, currentAssistantMessage: '', lastCompleteAssistantMessage: '' };
        let sawJsonEvent = false;
        for (const line of output.split('\n')) {
            if (!line.trim()) continue;
            try {
                const event = JSON.parse(line) as AntigravityOutputEvent;
                events.push(event);
                sawJsonEvent = true;
                if (this.isAntigravityTranscriptEvent(event)) this.updateFromTranscriptEvent(event, state);
                else this.processAntigravityEvent(event as AntigravityEvent, state);
            }
            catch { logger.debug({ linePreview: line.substring(0, 100) }, 'Non-JSON line in Antigravity output'); }
        }
        if (state.currentAssistantMessage) state.lastCompleteAssistantMessage = state.currentAssistantMessage;
        const plainTextSummary = sawJsonEvent ? undefined : this.extractAntigravityResult(this.stripAnsiCodes(output));
        return { sessionId: state.sessionId, modelUsed: state.modelUsed, summary: state.lastCompleteAssistantMessage || plainTextSummary || undefined, conversationLog: events, tokenUsage: state.tokenUsage };
    }

    private async writeConversationFile(sessionId: string, events: AntigravityOutputEvent[]): Promise<void> {
        try {
            const projectDir = path.join(os.homedir(), '.claude', 'projects', '-home-node-workspace');
            await fs.promises.mkdir(projectDir, { recursive: true });
            const conversationPath = path.join(projectDir, `${sessionId}.jsonl`);
            const aggregatedEvents = this.aggregateDeltaMessages(events);
            const claudeFormatEvents = aggregatedEvents.map(event => this.convertEventToClaudeFormat(event));
            await fs.promises.writeFile(conversationPath, claudeFormatEvents.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
            logger.info({ sessionId, path: conversationPath, eventCount: aggregatedEvents.length, originalCount: events.length }, 'Wrote Antigravity conversation file');
        } catch (error) { logger.warn({ sessionId, error: (error as Error).message }, 'Failed to write Antigravity conversation file'); }
    }

    /** Flushes pending message to result array and returns null. */
    private flushPendingMessage(result: AntigravityOutputEvent[], pending: { content: string; timestamp: string; role: 'user' | 'assistant' } | null): null {
        if (pending) result.push({ type: 'message', role: pending.role, content: pending.content, timestamp: pending.timestamp } as AntigravityMessageEvent);
        return null;
    }

    /** Aggregates consecutive delta messages into single messages. Antigravity streams assistant responses as multiple delta events. */
    private aggregateDeltaMessages(events: AntigravityOutputEvent[]): AntigravityOutputEvent[] {
        const result: AntigravityOutputEvent[] = [];
        let pending: { content: string; timestamp: string; role: 'user' | 'assistant' } | null = null;
        for (const event of events) {
            if (this.isAntigravityTranscriptEvent(event)) { pending = this.flushPendingMessage(result, pending); result.push(event); continue; }
            if (event.type !== 'message') { pending = this.flushPendingMessage(result, pending); result.push(event); continue; }
            const msgEvent = event as AntigravityMessageEvent;
            if (msgEvent.role !== 'assistant') { pending = this.flushPendingMessage(result, pending); result.push(event); continue; }
            if (msgEvent.delta) {
                if (pending && pending.role === 'assistant') { pending.content += msgEvent.content; }
                else { pending = this.flushPendingMessage(result, pending); pending = { content: msgEvent.content, timestamp: msgEvent.timestamp, role: 'assistant' }; }
            } else { pending = this.flushPendingMessage(result, pending); result.push(event); }
        }
        this.flushPendingMessage(result, pending);
        return result;
    }

    private convertEventToClaudeFormat(event: AntigravityOutputEvent): unknown {
        if (this.isAntigravityTranscriptEvent(event)) {
            const role = event.source === 'MODEL' ? 'assistant' : event.source === 'USER_EXPLICIT' ? 'user' : 'system';
            return { type: role, timestamp: event.created_at, message: { content: [{ type: 'text', text: event.content || '' }] }, antigravity: { source: event.source, type: event.type, status: event.status, step_index: event.step_index } };
        }
        if (event.type === 'message') { const e = event as AntigravityMessageEvent; return { type: e.role === 'assistant' ? 'assistant' : 'user', timestamp: e.timestamp, message: { content: [{ type: 'text', text: e.content }] } }; }
        if (event.type === 'tool_use') { const e = event as AntigravityToolUseEvent; return { type: 'assistant', timestamp: e.timestamp, message: { content: [{ type: 'tool_use', name: e.tool_name, id: e.tool_id, input: e.parameters }] } }; }
        if (event.type === 'tool_result') { const e = event as AntigravityToolResultEvent; return { type: 'user', timestamp: e.timestamp, message: { content: [{ type: 'tool_result', tool_use_id: e.tool_id, content: e.output, is_error: e.status === 'error' }] } }; }
        if (event.type === 'result') { const e = event as AntigravityResultEvent; return { type: 'result', timestamp: e.timestamp, message: { usage: { input_tokens: e.stats.input_tokens, output_tokens: e.stats.output_tokens } } }; }
        return event;
    }
}
