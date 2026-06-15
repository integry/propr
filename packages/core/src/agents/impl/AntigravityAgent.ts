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
import {
    parseAntigravityJsonl, aggregateDeltaMessages, convertEventToClaudeFormat,
    filterAntigravityAnalysisEvents,
    type AntigravityOutputEvent
} from './utils/antigravityOutputParser.js';
import { estimateTokens } from '../../utils/tokenCalculation.js';
import { toAntigravityCliModelId } from './antigravityModelIds.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Re-export UsageLimitError for convenience
export { UsageLimitError };

const DEFAULT_ANTIGRAVITY_TIMEOUT_MS = 3600000;
const ANALYSIS_AGENT_TANK_TIMEOUT_MS = parseInt(process.env.ANALYSIS_AGENT_TANK_TIMEOUT_MS || '2000', 10);

const ANTIGRAVITY_CONTAINER_CONFIG_PATH = '/home/node/.gemini';
const ANTIGRAVITY_CONTAINER_WORKSPACE_PATH = '/home/node/workspace';

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
            await setWorktreeOwnership(worktreePath, issueRef.number);
            const worktreeGitContent = verifyWorktreeStructure(worktreePath, issueRef.number);
            const dockerArgs = this.buildDockerArgs({ worktreePath, githubToken, modelName: effectiveModel, issueNumber: issueRef.number, environment, taskId });

            const { result, usageMetrics } = await executeWithUsageTracking(
                this.getRuntimeName(),
                async () => executeDockerCommand('docker', dockerArgs, {
                    timeout: this.timeoutMs, cwd: worktreePath, onSessionId, onContainerId, worktreePath, stdinData: prompt,
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

        const parsed = this.resolveSessionOutput(result.stdout, worktreePath, onSessionId);
        const { response, modelUsed } = await parsed;

        const finalTokenUsage = this.resolveTokenUsage(response.tokenUsage, prompt, response.summary, response.rawConversationLog);
        const resolvedModel = response.modelUsed || effectiveModel || 'unknown';
        const agentResult: AgentExecutionResult = {
            success: result.exitCode === 0, executionTimeMs: executionTime,
            logs: result.stdout + (result.stderr ? `\n\nSTDERR:\n${result.stderr}` : ''),
            exitCode: result.exitCode, rawOutput: result.stdout, modelUsed: resolvedModel, modifiedFiles: [],
            commitMessage: null, summary: response.summary ?? undefined, prompt, sessionId: response.sessionId, conversationLog: response.conversationLog,
            tokenUsage: finalTokenUsage, usageMetrics: usageMetrics ?? undefined
        };

        await this.persistImplementationLog({ executionTime, issueRef, resolvedModel, finalTokenUsage, agentResult, taskId, prNumber, isRetry, retryReason, usageMetrics });

        if (!agentResult.success) logger.error({ issueNumber: issueRef.number, exitCode: result.exitCode, stderr: result.stderr, agentAlias: this.config.alias }, 'Antigravity agent execution failed');
        else { logger.info({ issueNumber: issueRef.number, model: modelUsed, agentAlias: this.config.alias }, 'Antigravity agent execution succeeded'); verifyWorktreePostExecution(worktreePath, issueRef.number, worktreeGitContent); }
        return agentResult;
    }

    private async resolveSessionOutput(stdout: string, worktreePath: string, onSessionId?: (sessionId: string) => void) {
        const parsedOutput = parseAntigravityJsonl(stdout);
        const sessionOutput = await this.readPersistedSessionOutput(worktreePath, parsedOutput.sessionId);
        const sessionId = sessionOutput.sessionId || parsedOutput.sessionId;
        const summary = sessionOutput.summary || parsedOutput.summary;
        const rawConversationLog = sessionOutput.conversationLog.length > 0 ? sessionOutput.conversationLog : parsedOutput.conversationLog;
        const conversationLog = filterAntigravityAnalysisEvents(rawConversationLog);
        const tokenUsage = this.mergeTokenUsage(parsedOutput.tokenUsage, sessionOutput.tokenUsage);
        const modelUsed = parsedOutput.modelUsed || sessionOutput.modelUsed;
        if (sessionId && onSessionId) onSessionId(sessionId);
        if (sessionId && conversationLog.length > 0) await this.writeConversationFile(sessionId, conversationLog);
        // rawConversationLog (full agentic trace: file views, searches, command
        // output, code edits) is kept for token estimation; conversationLog stays
        // filtered to the displayed assistant responses.
        return { response: { sessionId, summary, conversationLog, rawConversationLog, tokenUsage, modelUsed }, modelUsed };
    }

    private mergeTokenUsage(
        primary: { input_tokens?: number; output_tokens?: number },
        fallback?: { input_tokens?: number; output_tokens?: number }
    ): { input_tokens?: number; output_tokens?: number } {
        return {
            input_tokens: primary.input_tokens ?? fallback?.input_tokens,
            output_tokens: primary.output_tokens ?? fallback?.output_tokens
        };
    }

    /**
     * agy reports no token usage, so estimate from the full transcript. The model
     * AUTHORS planner responses, code edits, and assistant messages (output); it
     * CONSUMES the prompt, file views, search results, command output, and history
     * (input). Counting only the prompt + final messages undercounts agentic runs
     * by ~10-100x. Reported counts win when present. This is an estimate (it can't
     * capture cumulative re-read context across agentic turns), but it lands in the
     * right order of magnitude instead of near zero.
     */
    private resolveTokenUsage(
        reported: { input_tokens?: number; output_tokens?: number },
        prompt: string,
        summary: string | undefined,
        conversationLog: AntigravityOutputEvent[]
    ): { input_tokens?: number; output_tokens?: number } | undefined {
        if (reported.input_tokens || reported.output_tokens) return reported;

        let inputText = '';
        let outputText = '';
        for (const event of conversationLog) {
            const content = 'content' in event && typeof event.content === 'string' ? event.content : '';
            if (!content) continue;
            if (this.isModelAuthoredEvent(event)) outputText += `${content}\n`;
            else inputText += `${content}\n`;
        }

        // Fallbacks when the transcript has no usable content (e.g. plain-text
        // --print output, as in the analyze path): estimate from prompt + summary.
        if (!inputText && !outputText) {
            inputText = prompt;
            outputText = summary || '';
        } else if (!inputText) {
            inputText = prompt; // transcript had only model output; still count the prompt
        }

        const inputTokens = estimateTokens(inputText);
        const outputTokens = estimateTokens(outputText);
        return inputTokens || outputTokens
            ? { input_tokens: inputTokens, output_tokens: outputTokens }
            : undefined;
    }

    /** Whether a transcript event's content was authored by the model (output) vs consumed by it (input). */
    private isModelAuthoredEvent(event: AntigravityOutputEvent): boolean {
        const role = (event as { role?: string }).role;
        if (role === 'assistant') return true;
        const type = (event as { type?: string }).type;
        // PLANNER_RESPONSE = model's text; CODE_ACTION = edits the model wrote.
        // VIEW_FILE / GREP_SEARCH / RUN_COMMAND content is dominated by results the
        // model reads, so treat those as input.
        return type === 'PLANNER_RESPONSE' || type === 'CODE_ACTION';
    }

    private async persistImplementationLog(opts: {
        executionTime: number; issueRef: { number: number; repoOwner: string; repoName: string };
        resolvedModel: string; finalTokenUsage?: { input_tokens?: number; output_tokens?: number };
        agentResult: AgentExecutionResult; taskId?: string; prNumber?: number;
        isRetry?: boolean; retryReason?: string; usageMetrics?: UsageTrackingMetrics | null;
    }): Promise<void> {
        const { executionTime, issueRef, resolvedModel, finalTokenUsage, agentResult, taskId, prNumber, isRetry, retryReason, usageMetrics } = opts;
        const repository = `${issueRef.repoOwner}/${issueRef.repoName}`;
        const logEntry = createLlmLogFromAnalysis({
            executionType: 'implementation', modelUsed: resolvedModel, executionTimeMs: executionTime,
            success: agentResult.success, tokenUsage: finalTokenUsage,
            error: agentResult.success ? undefined : (agentResult.logs || 'Execution failed'),
            sessionId: agentResult.sessionId, draftId: taskId, repository, agentAlias: this.config.alias,
            metadata: { isRetry, retryReason },
            usageMetrics: usageMetrics ? { preCall: usageMetrics.preCall, postCall: usageMetrics.postCall, delta: usageMetrics.delta, timestamp: usageMetrics.timestamp, agent: usageMetrics.agent } : undefined,
            usageMetricRecords: usageMetrics?.records,
            workRef: buildTaskWorkRef(taskId, issueRef.number, repository, prNumber),
        });
        await persistLlmLog(logEntry);
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
        const { context, model, taskId, taskNumber, prNumber, executionType, correlationId, repository, metadata, timeoutMs, responseFormat = 'text', suppressLlmLog } = options || {};
        const startTime = Date.now();
        logger.info({ agentAlias: this.config.alias, promptLength: prompt.length, hasContext: !!context, requestedModel: model, taskId, executionType }, 'Running lightweight analysis via Antigravity agent...');
        const effectiveModel = model || 'antigravity-gemini-3.5-flash-medium';
        const suffix = responseFormat === 'json'
            ? '\n\nCRITICAL: Do not modify any files. Do not run any commands. Return only valid JSON matching the requested schema. Do not include markdown or explanatory text.'
            : '\n\nCRITICAL: Do not modify any files. Do not run any commands. Only provide your analysis as plain text output.';
        const fullPrompt = context ? `${prompt}\n\nContext:\n${context}${suffix}` : `${prompt}${suffix}`;
        try {
            const dockerArgs = this.buildDockerArgs({ worktreePath: '/tmp/antigravity-analysis', githubToken: process.env.GITHUB_TOKEN || '', modelName: effectiveModel, issueNumber: 0, taskId, executionType });

            const { result, usageMetrics } = await executeWithUsageTracking(
                this.getRuntimeName(),
                async () => executeDockerCommand('docker', dockerArgs, { timeout: timeoutMs ?? 1800000, stdinData: fullPrompt, taskId }),
                ANALYSIS_AGENT_TANK_TIMEOUT_MS
            );
            const executionTimeMs = Date.now() - startTime;
            const { summary, tokenUsage, sessionId } = parseAntigravityJsonl(result.stdout);

            if (result.exitCode === 0 || summary) {
                const analysisText = (summary || '').trim();
                // agy --print emits plain text with no token stats, so
                // parseAntigravityJsonl returns empty usage. Estimate from the
                // full prompt and the response so reviews / summaries / pr-comments
                // still report (estimated) token counts and cost, matching the
                // executeTask path. Reported counts win when present.
                const antigravityTokenUsage = this.resolveTokenUsage(tokenUsage, fullPrompt, analysisText, []);
                logger.info({ agentAlias: this.config.alias, responseLength: analysisText.length, model: effectiveModel, executionTimeMs, inputTokens: antigravityTokenUsage?.input_tokens, outputTokens: antigravityTokenUsage?.output_tokens, estimatedTokens: !(tokenUsage.input_tokens || tokenUsage.output_tokens), usageMetrics: usageMetrics ? { delta: usageMetrics.delta } : null }, 'Lightweight analysis completed');

                if (!suppressLlmLog) {
                    const usage = formatUsageMetrics(usageMetrics);
                    await persistLlmLog(createLlmLogFromAnalysis({
                        executionType: (executionType || 'other') as ExecutionType, modelUsed: effectiveModel, executionTimeMs, success: true, tokenUsage: antigravityTokenUsage,
                        sessionId, draftId: taskId, correlationId, repository, metadata, agentAlias: this.config.alias,
                        usageMetrics: usage.metrics, usageMetricRecords: usage.records,
                        workRef: buildAnalysisWorkRef(executionType, taskId, repository, { taskNumber, prNumber }),
                    }));
                }

                return { response: analysisText, modelUsed: effectiveModel, executionTimeMs, success: true,
                    tokenUsage: antigravityTokenUsage, sessionId };
            }
            return { response: '', modelUsed: effectiveModel, executionTimeMs, success: false, error: `Analysis failed: ${result.stderr || 'No result returned'}` };
        } catch (error) {
            const executionTimeMs = Date.now() - startTime;
            const err = error as Error;
            logger.error({ agentAlias: this.config.alias, error: err.message, executionTimeMs }, 'Lightweight analysis failed');
            return { response: '', modelUsed: effectiveModel, executionTimeMs, success: false, error: err.message };
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

    private buildAntigravityShellCommand(): string {
        // `--print -` makes agy read the prompt from STDIN (the `-` convention).
        // This is required because the prompt is passed via stdin (see executeTask
        // / analyze): repo-context prompts routinely exceed Linux's 128 KiB
        // per-argument limit (MAX_ARG_STRLEN), so passing it as an argv element
        // fails with spawn E2BIG. `"$@"` carries only the `--model` flag.
        return ['set -e', `exec ${this.getCliCommand()} --dangerously-skip-permissions --print - "$@"`].join('\n');
    }

    private buildDockerArgs(params: { worktreePath: string; githubToken: string; modelName?: string; issueNumber: number; environment?: Record<string, string>; taskId?: string; executionType?: string }): string[] {
        const { worktreePath, githubToken, modelName, issueNumber, environment, taskId, executionType } = params;
        const configPath = this.getHostConfigPath();
        const envVars: string[] = [];
        if (this.config.envVars) { for (const [key, value] of Object.entries(this.config.envVars)) envVars.push('-e', `${key}=${value}`); }
        if (environment) { for (const [key, value] of Object.entries(environment)) envVars.push('-e', `${key}=${value}`); }
        const timestamp = Date.now().toString(36);
        const shortTaskId = taskId ? taskId.slice(-8) : timestamp;
        const taskType = executionType || (issueNumber === 0 ? 'analysis' : `issue-${issueNumber}`);
        const runtimeName = this.getRuntimeName();
        const containerName = this.buildContainerName(this.config.alias || runtimeName, taskType, shortTaskId, modelName);
        const dockerArgs: string[] = [
            'run', '--rm', '-i', '--name', containerName, '--security-opt', 'no-new-privileges', '--cap-add', 'CHOWN', '--network', 'bridge', '--user', '0:0',
            '-v', `${worktreePath}:/home/node/workspace:rw`, '-v', '/tmp/git-processor:/tmp/git-processor:rw', '-v', `${configPath}:${this.getContainerConfigPath()}:rw`,
            '-e', `GH_TOKEN=${githubToken}`, '-e', `GITHUB_TOKEN=${githubToken}`, '-e', 'ANTIGRAVITY_CLI=1', '-e', 'ANTIGRAVITY_CLI_TRUST_WORKSPACE=true', ...envVars, '-w', '/home/node/workspace',
            this.config.dockerImage, '/bin/bash', '-lc', this.buildAntigravityShellCommand(), 'propr-antigravity'
        ];
        // Note: the prompt is delivered via STDIN (`--print -`), NOT as an argv
        // element, to avoid spawn E2BIG on large repo-context prompts. Only the
        // model flag goes here.
        if (modelName) {
            // Convert ProPR's namespaced id (e.g. 'antigravity-gpt-oss-120b-medium')
            // to the Antigravity CLI's native model name. Passing the prefixed id
            // makes `agy` fall back to its default model.
            const cleanModelName = toAntigravityCliModelId(modelName);
            dockerArgs.push('--model', cleanModelName);
            logger.info({ issueNumber, requestedModel: cleanModelName, originalModel: modelName, agentAlias: this.config.alias }, 'Model specified for Antigravity agent');
        } else { logger.debug({ issueNumber, agentAlias: this.config.alias }, 'No model specified, Antigravity agent will use default'); }
        logger.info({ issueNumber, agentAlias: this.config.alias }, 'Docker args built for Antigravity agent');
        return wrapDockerRunArgsWithRepoSetup(dockerArgs, this.config.dockerImage, runtimeName);
    }

    private buildContainerName(alias: string, taskType: string, shortTaskId: string, modelName?: string): string {
        const suffix = `-${shortTaskId}`;
        const rawPrefix = modelName
            ? `${alias}-${taskType}-${modelName}`
            : `${alias}-${taskType}`;
        const maxPrefixLength = Math.max(1, 120 - suffix.length);
        const sanitizedPrefix = rawPrefix.replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '').slice(0, maxPrefixLength).replace(/[^a-zA-Z0-9]+$/, '');
        return `${sanitizedPrefix || 'antigravity'}${suffix}`.slice(0, 128);
    }

    private getLastConversationsPath(): string {
        return path.join(this.getHostConfigPath(), 'antigravity-cli', 'cache', 'last_conversations.json');
    }

    private async readLastConversationId(worktreePath: string): Promise<string | undefined> {
        try {
            const raw = await fs.promises.readFile(this.getLastConversationsPath(), 'utf8');
            const conversations = JSON.parse(raw) as Record<string, unknown>;
            for (const key of [ANTIGRAVITY_CONTAINER_WORKSPACE_PATH, worktreePath, path.resolve(worktreePath)]) {
                const sessionId = conversations[key];
                if (typeof sessionId === 'string' && sessionId.trim()) return sessionId;
            }
        } catch (error) {
            logger.debug({ error: (error as Error).message, agentAlias: this.config.alias }, 'Could not read Antigravity last conversations cache');
        }
        return undefined;
    }

    private async readPersistedSessionOutput(worktreePath: string, parsedSessionId?: string): Promise<{ sessionId: string | undefined; summary: string | undefined; conversationLog: AntigravityOutputEvent[]; tokenUsage?: { input_tokens?: number; output_tokens?: number }; modelUsed?: string }> {
        const sessionId = parsedSessionId || await this.readLastConversationId(worktreePath);
        if (!sessionId) return { sessionId: undefined, summary: undefined, conversationLog: [] };
        const transcriptPath = path.join(this.getHostConfigPath(), 'antigravity-cli', 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl');
        try {
            const transcript = await fs.promises.readFile(transcriptPath, 'utf8');
            const parsed = parseAntigravityJsonl(transcript);
            return { sessionId, summary: parsed.summary, conversationLog: parsed.conversationLog, tokenUsage: parsed.tokenUsage, modelUsed: parsed.modelUsed };
        } catch (error) {
            logger.debug({ sessionId, transcriptPath, error: (error as Error).message, agentAlias: this.config.alias }, 'Could not read Antigravity transcript');
            return { sessionId, summary: undefined, conversationLog: [] };
        }
    }

    private async writeConversationFile(sessionId: string, events: AntigravityOutputEvent[]): Promise<void> {
        try {
            const projectDir = path.join(os.homedir(), '.claude', 'projects', '-home-node-workspace');
            await fs.promises.mkdir(projectDir, { recursive: true });
            const conversationPath = path.join(projectDir, `${sessionId}.jsonl`);
            const aggregatedEvents = aggregateDeltaMessages(events);
            const claudeFormatEvents = aggregatedEvents.map(event => convertEventToClaudeFormat(event));
            await fs.promises.writeFile(conversationPath, claudeFormatEvents.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
            logger.info({ sessionId, path: conversationPath, eventCount: aggregatedEvents.length, originalCount: events.length }, 'Wrote Antigravity conversation file');
        } catch (error) { logger.warn({ sessionId, error: (error as Error).message }, 'Failed to write Antigravity conversation file'); }
    }
}
