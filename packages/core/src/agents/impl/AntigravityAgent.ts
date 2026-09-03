import logger from '../../utils/logger.js';
import { isManagedAgentConfigPath } from '@propr/shared';
import { Agent, AgentConfig, AgentTaskOptions, AgentExecutionResult, AnalysisResult, AnalyzeOptions, type TokenUsage } from '../types.js';
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
import { buildAnalysisSafetySuffix, executeWithUsageTracking, type UsageTrackingMetrics } from './utils/index.js';
import type { ExecutionType } from '../../utils/llmMetrics.types.js';
import { DEFAULT_AGENT_EXECUTION_TIMEOUT_MS } from '../constants.js';
import {
    aggregateDeltaMessages,
    convertEventToClaudeFormat,
    parseAntigravityJsonl,
    filterAntigravityAnalysisEvents,
    normalizeAntigravityModelId,
    type AntigravityOutputEvent
} from './utils/antigravityOutputParser.js';
import { estimateTokens } from '../../utils/tokenCalculation.js';
import { antigravityModelIdsMatch, toAntigravityCliModelId } from './antigravityModelIds.js';
import { resolveAntigravityProtocolError } from './utils/antigravityProtocol.js';
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'node:crypto';
import { resolveAgentTerminationReason } from '../termination.js';
import { createContainerExecutionId } from './utils/containerExecutionId.js';
import {
    buildAntigravityRepositoryScoutMcpConfig,
    buildAntigravityRepositoryScoutPermissions,
    REPOSITORY_SCOUT_CONTAINER_ROOT,
} from './utils/repositoryScoutMcpServer.js';

// Re-export UsageLimitError for convenience
export { UsageLimitError };

const ANALYSIS_AGENT_TANK_TIMEOUT_MS = parseInt(process.env.ANALYSIS_AGENT_TANK_TIMEOUT_MS || '2000', 10);

const ANTIGRAVITY_CONTAINER_SOURCE_CONFIG_PATH = '/home/node/.gemini-source';
const DEFAULT_ANTIGRAVITY_TRANSCRIPT_ROOT = '/tmp/git-processor/propr-cache/transcripts/antigravity';
const GITHUB_CREDENTIAL_ENV_PATTERN = /^(?:GH|GITHUB)_.*(?:TOKEN|KEY|SECRET|PASSWORD|PAT|PRIVATE_KEY)$/;

function isSuccessfulAnalysisResult(
    result: { timedOut?: boolean; exitCode: number | null },
    summary: string | undefined,
    protocolError?: string,
): boolean {
    return !protocolError && !result.timedOut && (result.exitCode === 0 || !!summary);
}

function resolveAntigravityModelIdentity(reportedModel: string | undefined, requestedModel: string | undefined, requireReportedModel: boolean): { modelUsed: string; error?: string } { const reported = reportedModel || undefined; const requested = requestedModel ? normalizeAntigravityModelId(requestedModel) : undefined; const missingReported = requireReportedModel && !!requested && !reported; const matches = !reported || !requested || antigravityModelIdsMatch(requested, reported); return { modelUsed: missingReported ? 'unknown' : matches && requested ? requested : reported ?? requested ?? 'unknown', error: missingReported ? `Antigravity stream did not report a model identity for requested model "${requested}"` : matches ? undefined : `Antigravity reported model "${reported}" but "${requested}" was requested` }; }

function resolveAntigravityExecutionError(terminalStatus: 'success' | 'error' | undefined, protocolError: string | undefined, hasStreamEnvelopes: boolean, modelIdentityError: string | undefined): string | undefined { return resolveAntigravityProtocolError(terminalStatus, protocolError, hasStreamEnvelopes) ?? modelIdentityError; }

function resolveAntigravityEvidenceConflict(stdoutModel: string | undefined, transcriptModel: string | undefined, stdoutConversation: string | undefined, transcriptConversation: string | undefined): string | undefined { if (stdoutConversation && transcriptConversation && stdoutConversation !== transcriptConversation) return `Conflicting Antigravity conversation identities: stdout reported "${stdoutConversation}" but transcript reported "${transcriptConversation}"`; const stdout = stdoutModel && normalizeAntigravityModelId(stdoutModel); const transcript = transcriptModel && normalizeAntigravityModelId(transcriptModel); return stdout && transcript && stdout !== transcript ? `Conflicting Antigravity model identities: stdout reported "${stdout}" but transcript reported "${transcript}"` : undefined; }

function buildAgentEnvironmentArgs(
    repositoryInspection: boolean,
    ...sources: Array<Record<string, string> | undefined>
): string[] {
    const args: string[] = [];
    for (const source of sources) {
        if (!source) continue;
        for (const [key, value] of Object.entries(source)) {
            if (repositoryInspection && GITHUB_CREDENTIAL_ENV_PATTERN.test(key.toUpperCase())) continue;
            args.push('-e', `${key}=${value}`);
        }
    }
    return args;
}

function assertRepositoryInspectionMode(repositoryInspection: boolean, readOnlyWorkspace: boolean): void {
    if (repositoryInspection && !readOnlyWorkspace) {
        throw new Error('Repository inspection requires a read-only workspace');
    }
}

function getAntigravityTranscriptRoot(): string {
    return process.env.PROPR_ANTIGRAVITY_TRANSCRIPT_ROOT || DEFAULT_ANTIGRAVITY_TRANSCRIPT_ROOT;
}

export class AntigravityAgent implements Agent {
    readonly config: AgentConfig;
    private readonly timeoutMs: number;

    constructor(config: AgentConfig) {
        this.config = config;
        this.timeoutMs = parseInt(process.env.ANTIGRAVITY_TIMEOUT_MS || String(DEFAULT_AGENT_EXECUTION_TIMEOUT_MS), 10);
    }

    private getRuntimeName(): 'antigravity' {
        return 'antigravity';
    }

    private getContainerConfigPath(): string {
        return ANTIGRAVITY_CONTAINER_SOURCE_CONFIG_PATH;
    }

    private getCliCommand(): string {
        return 'agy';
    }

    private getHostConfigPath(): string {
        // Provider-wide environment overrides remain the compatibility path for
        // existing host credentials. ProPR-managed paths are per-agent and must
        // win so multiple Antigravity accounts do not collapse onto one mount.
        const configPath = isManagedAgentConfigPath(this.config.configPath)
            ? this.config.configPath
            : process.env.ANTIGRAVITY_CONFIG_PATH || this.config.configPath;
        const configuredPath = resolveConfigPath(configPath);
        if (configuredPath.endsWith(`${path.sep}.antigravity`)) {
            const geminiPath = path.join(path.dirname(configuredPath), '.gemini');
            if (fs.existsSync(geminiPath)) {
                return geminiPath;
            }
        }
        return configuredPath;
    }

    async executeTask(options: AgentTaskOptions): Promise<AgentExecutionResult> {
        const { worktreePath, issueRef, prompt: customPrompt, model, isRetry = false, retryReason, onSessionId, onContainerId, githubToken, environment, taskId, prNumber, metadata } = options;
        const startTime = Date.now();
        const effectiveModel = model || this.config.defaultModel;
        const transcriptPath = this.createTransientTranscriptPath(taskId);

        logger.info({
            issueNumber: issueRef.number, repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
            worktreePath, dockerImage: this.config.dockerImage, agentAlias: this.config.alias, isRetry, retryReason
        }, isRetry ? 'Starting Antigravity agent execution (RETRY)...' : 'Starting Antigravity agent execution...');

        try {
            const prompt = this.buildPromptWithRetryContext(customPrompt, isRetry, retryReason);
            await setWorktreeOwnership(worktreePath, issueRef.number);
            const worktreeGitContent = verifyWorktreeStructure(worktreePath, issueRef.number);
            const dockerArgs = this.buildDockerArgs({ worktreePath, githubToken, modelName: effectiveModel, issueNumber: issueRef.number, environment, taskId, transcriptPath });

            const { result, usageMetrics } = await executeWithUsageTracking(
                this.getRuntimeName(),
                async () => executeDockerCommand('docker', dockerArgs, {
                    timeout: this.timeoutMs, cwd: worktreePath, onSessionId, onContainerId, worktreePath, stdinData: prompt,
                    taskId, streamToRedis: true, preserveOutputOnTimeout: true
                })
            );

            const executionTime = Date.now() - startTime;
            return this.processExecutionResult({ result, executionTime, issueRef, effectiveModel, prompt, worktreePath, worktreeGitContent, onSessionId, taskId, prNumber, isRetry, retryReason, usageMetrics, transcriptPath, metadata });
        } catch (error) {
            return this.handleExecutionError(error, Date.now() - startTime, issueRef, effectiveModel);
        } finally {
            this.cleanupTransientTranscript(transcriptPath);
        }
    }

    private buildPromptWithRetryContext(prompt: string, isRetry: boolean, retryReason?: string): string {
        if (isRetry && retryReason) {
            return `${prompt}\n\n---\n\n**RETRY CONTEXT**: This is a retry attempt. Previous attempt failed with: ${retryReason}\n\nPlease address the issues from the previous attempt.`;
        }
        return prompt;
    }

    private async processExecutionResult(opts: {
        result: { stdout: string; stderr: string; exitCode: number | null; timedOut?: boolean }; executionTime: number;
        issueRef: { number: number; repoOwner: string; repoName: string }; effectiveModel: string | undefined;
        prompt: string; worktreePath: string; worktreeGitContent: string | null; onSessionId?: (sessionId: string, conversationId?: string) => void;
        taskId?: string; prNumber?: number; isRetry?: boolean; retryReason?: string; usageMetrics?: UsageTrackingMetrics | null;
        transcriptPath?: string; metadata?: Record<string, unknown>;
    }): Promise<AgentExecutionResult> {
        const { result, executionTime, issueRef, effectiveModel, prompt, worktreePath, worktreeGitContent, onSessionId, taskId, prNumber, isRetry, retryReason, usageMetrics, transcriptPath, metadata } = opts;
        logger.info({ issueNumber: issueRef.number, repository: `${issueRef.repoOwner}/${issueRef.repoName}`, executionTime, outputLength: result.stdout?.length || 0, success: result.exitCode === 0, exitCode: result.exitCode, agentAlias: this.config.alias }, 'Antigravity agent execution completed');

        const parsed = this.resolveSessionOutput(result.stdout, transcriptPath, onSessionId);
        const { response } = await parsed;

        const finalTokenUsage = this.resolveTokenUsage(response.tokenUsage, prompt, response.summary, response.rawConversationLog);
        const modelIdentity = resolveAntigravityModelIdentity(response.modelUsed, effectiveModel, response.hasStreamEnvelopes); const resolvedModel = modelIdentity.modelUsed;
        const terminationReason = resolveAgentTerminationReason({ timedOut: result.timedOut, error: result.stderr });
        const executionError = resolveAntigravityExecutionError(response.terminalStatus, response.protocolError, response.hasStreamEnvelopes, modelIdentity.error);
        const success = result.exitCode === 0 && !terminationReason && !executionError;
        const agentResult: AgentExecutionResult = {
            success, executionTimeMs: executionTime,
            logs: result.stdout + (result.stderr ? `\n\nSTDERR:\n${result.stderr}` : ''),
            exitCode: result.exitCode, rawOutput: result.stdout, modelUsed: resolvedModel, modifiedFiles: [],
            commitMessage: null, summary: response.summary ?? undefined, prompt, sessionId: response.sessionId, conversationId: response.conversationId, conversationLog: response.conversationLog,
            tokenUsage: finalTokenUsage, usageMetrics: usageMetrics ?? undefined,
            error: success ? undefined : result.stderr || executionError || 'Antigravity execution failed',
            terminationReason
        };

        await this.persistImplementationLog({ executionTime, issueRef, resolvedModel, finalTokenUsage, agentResult, taskId, prNumber, isRetry, retryReason, usageMetrics, metadata });

        if (!agentResult.success) logger.error({ issueNumber: issueRef.number, exitCode: result.exitCode, stderr: result.stderr, agentAlias: this.config.alias }, 'Antigravity agent execution failed');
        else { logger.info({ issueNumber: issueRef.number, model: resolvedModel, agentAlias: this.config.alias }, 'Antigravity agent execution succeeded'); verifyWorktreePostExecution(worktreePath, issueRef.number, worktreeGitContent); }
        return agentResult;
    }

    private async resolveSessionOutput(stdout: string, transcriptPath?: string, onSessionId?: (sessionId: string, conversationId?: string) => void) {
        const parsedOutput = parseAntigravityJsonl(stdout);
        const sessionOutput = await this.readTransientSessionOutput(transcriptPath, parsedOutput.sessionId);
        const sessionId = sessionOutput.sessionId || parsedOutput.sessionId;
        const conversationId = parsedOutput.conversationId || sessionOutput.conversationId;
        const summary = sessionOutput.summary || parsedOutput.summary;
        const rawConversationLog = sessionOutput.conversationLog.length > 0 ? sessionOutput.conversationLog : parsedOutput.conversationLog;
        const conversationLog = filterAntigravityAnalysisEvents(aggregateDeltaMessages(rawConversationLog))
            .map(convertEventToClaudeFormat);
        const tokenUsage = this.mergeTokenUsage(parsedOutput.tokenUsage, sessionOutput.tokenUsage);
        const evidenceConflict = resolveAntigravityEvidenceConflict(parsedOutput.modelUsed, sessionOutput.modelUsed, parsedOutput.conversationId, sessionOutput.conversationId); const modelUsed = evidenceConflict ? undefined : parsedOutput.modelUsed || sessionOutput.modelUsed;
        const terminalStatus: 'success' | 'error' | undefined = parsedOutput.terminalStatus === 'error' || sessionOutput.terminalStatus === 'error' ? 'error' : parsedOutput.terminalStatus || sessionOutput.terminalStatus;
        const protocolError = resolveAntigravityProtocolError(parsedOutput.terminalStatus, parsedOutput.protocolError, parsedOutput.hasStreamEnvelopes) ?? resolveAntigravityProtocolError(sessionOutput.terminalStatus, sessionOutput.protocolError, sessionOutput.hasStreamEnvelopes) ?? evidenceConflict; const hasStreamEnvelopes = parsedOutput.hasStreamEnvelopes || sessionOutput.hasStreamEnvelopes;
        if (sessionId && onSessionId) onSessionId(sessionId, conversationId);
        // rawConversationLog (full agentic trace: file views, searches, command
        // output, code edits) is kept for token estimation; conversationLog is
        // filtered and converted to the Claude-shaped representation consumed by
        // metrics persistence and execution analysis.
        return { response: { sessionId, conversationId, summary, conversationLog, rawConversationLog, tokenUsage, modelUsed, terminalStatus, protocolError, hasStreamEnvelopes }, modelUsed };
    }

    private createTransientTranscriptPath(taskId?: string): string {
        const suffix = `${Date.now().toString(36)}-${randomBytes(8).toString('hex')}`;
        const safeTaskId = taskId?.slice(-80).replace(/[^a-zA-Z0-9_.-]/g, '-') || 'run';
        const transcriptRoot = getAntigravityTranscriptRoot();
        fs.mkdirSync(transcriptRoot, { recursive: true });
        return path.join(transcriptRoot, `${safeTaskId}-${suffix}.jsonl`);
    }

    private cleanupTransientTranscript(transcriptPath: string | undefined): void {
        const transcriptRoot = path.resolve(getAntigravityTranscriptRoot());
        if (!transcriptPath || !path.resolve(transcriptPath).startsWith(`${transcriptRoot}${path.sep}`)) return;
        try { fs.rmSync(transcriptPath, { force: true }); }
        catch { /* best-effort cleanup */ }
    }

    private async readTransientSessionOutput(transcriptPath: string | undefined, parsedSessionId?: string): Promise<{ sessionId: string | undefined; conversationId?: string; summary: string | undefined; conversationLog: AntigravityOutputEvent[]; tokenUsage?: TokenUsage; modelUsed?: string; terminalStatus?: 'success' | 'error'; protocolError?: string; hasStreamEnvelopes: boolean }> {
        if (!transcriptPath) return { sessionId: parsedSessionId, summary: undefined, conversationLog: [], hasStreamEnvelopes: false };
        try {
            const transcript = await fs.promises.readFile(transcriptPath, 'utf8');
            const parsed = parseAntigravityJsonl(transcript);
            return {
                sessionId: parsed.sessionId || parsedSessionId,
                conversationId: parsed.conversationId,
                summary: parsed.summary,
                conversationLog: parsed.conversationLog,
                tokenUsage: parsed.tokenUsage,
                modelUsed: parsed.modelUsed,
                terminalStatus: parsed.terminalStatus,
                protocolError: parsed.protocolError,
                hasStreamEnvelopes: parsed.hasStreamEnvelopes,
            };
        } catch (error) {
            logger.debug({ transcriptPath, error: (error as Error).message, agentAlias: this.config.alias }, 'Could not read transient Antigravity transcript');
            return { sessionId: parsedSessionId, summary: undefined, conversationLog: [], hasStreamEnvelopes: false };
        } finally {
            this.cleanupTransientTranscript(transcriptPath);
        }
    }

    private mergeTokenUsage(
        primary: TokenUsage,
        fallback?: TokenUsage
    ): TokenUsage {
        return {
            input_tokens: primary.input_tokens ?? fallback?.input_tokens,
            output_tokens: primary.output_tokens ?? fallback?.output_tokens,
            cache_creation_input_tokens: primary.cache_creation_input_tokens ?? fallback?.cache_creation_input_tokens,
            cache_read_input_tokens: primary.cache_read_input_tokens ?? fallback?.cache_read_input_tokens,
            reasoning_output_tokens: primary.reasoning_output_tokens ?? fallback?.reasoning_output_tokens,
        };
    }

    /**
     * Older/plain agy output reports no token usage, so estimate from the full transcript. The model
     * AUTHORS planner responses, code edits, and assistant messages (output); it
     * CONSUMES the prompt, file views, search results, command output, and history
     * (input). Counting only the prompt + final messages undercounts agentic runs
     * by ~10-100x. Reported counts win when present. This is an estimate (it can't
     * capture cumulative re-read context across agentic turns), but it lands in the
     * right order of magnitude instead of near zero.
     */
    private resolveTokenUsage(
        reported: TokenUsage,
        prompt: string,
        summary: string | undefined,
        conversationLog: AntigravityOutputEvent[]
    ): TokenUsage | undefined {
        if (reported.input_tokens || reported.output_tokens || reported.cache_read_input_tokens || reported.reasoning_output_tokens) return reported;

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
        resolvedModel: string; finalTokenUsage?: TokenUsage;
        agentResult: AgentExecutionResult; taskId?: string; prNumber?: number;
        isRetry?: boolean; retryReason?: string; usageMetrics?: UsageTrackingMetrics | null; metadata?: Record<string, unknown>;
    }): Promise<void> {
        const { executionTime, issueRef, resolvedModel, finalTokenUsage, agentResult, taskId, prNumber, isRetry, retryReason, usageMetrics, metadata } = opts;
        const repository = `${issueRef.repoOwner}/${issueRef.repoName}`;
        const logEntry = createLlmLogFromAnalysis({
            executionType: 'implementation', modelUsed: resolvedModel, executionTimeMs: executionTime,
            success: agentResult.success, tokenUsage: finalTokenUsage,
            error: agentResult.success ? undefined : (agentResult.logs || 'Execution failed'),
            sessionId: agentResult.sessionId, draftId: taskId, repository, agentAlias: this.config.alias,
            metadata: { ...metadata, isRetry, retryReason },
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
        const { context, model, taskId, taskNumber, prNumber, executionType, correlationId, repository, metadata, timeoutMs, responseFormat = 'text', suppressLlmLog, readOnlyWorkspacePath, allowReadOnlyCommands = false } = options || {};
        const startTime = Date.now();
        logger.info({ agentAlias: this.config.alias, promptLength: prompt.length, hasContext: !!context, requestedModel: model, taskId, executionType }, 'Running lightweight analysis via Antigravity agent...');
        const effectiveModel = model || 'antigravity-gemini-3.5-flash-medium';
        const suffix = buildAnalysisSafetySuffix(responseFormat, allowReadOnlyCommands, readOnlyWorkspacePath);
        const fullPrompt = context ? `${prompt}\n\nContext:\n${context}${suffix}` : `${prompt}${suffix}`;
        try {
            const dockerArgs = this.buildDockerArgs({ worktreePath: readOnlyWorkspacePath || '/tmp/antigravity-analysis', githubToken: process.env.GITHUB_TOKEN || '', modelName: effectiveModel, issueNumber: 0, taskId, executionType, readOnlyWorkspace: !!readOnlyWorkspacePath, repositoryInspection: !!readOnlyWorkspacePath && allowReadOnlyCommands });

            const { result, usageMetrics } = await executeWithUsageTracking(
                this.getRuntimeName(),
                async () => executeDockerCommand('docker', dockerArgs, { timeout: timeoutMs ?? 1800000, stdinData: fullPrompt, taskId }),
                ANALYSIS_AGENT_TANK_TIMEOUT_MS
            );
            const executionTimeMs = Date.now() - startTime;
            const { summary, tokenUsage, sessionId, modelUsed, terminalStatus, protocolError, hasStreamEnvelopes } = parseAntigravityJsonl(result.stdout);
            const modelIdentity = resolveAntigravityModelIdentity(modelUsed, effectiveModel, hasStreamEnvelopes); const resolvedModel = modelIdentity.modelUsed;
            const resolvedProtocolError = resolveAntigravityExecutionError(terminalStatus, protocolError, hasStreamEnvelopes, modelIdentity.error);

            if (isSuccessfulAnalysisResult(result, summary, resolvedProtocolError)) {
                const analysisText = (summary || '').trim();
                // agy print mode emits plain text with no token stats, so
                // parseAntigravityJsonl returns empty usage. Estimate from the
                // full prompt and the response so reviews / summaries / pr-comments
                // still report (estimated) token counts and cost, matching the
                // executeTask path. Reported counts win when present.
                const antigravityTokenUsage = this.resolveTokenUsage(tokenUsage, fullPrompt, analysisText, []);
                logger.info({ agentAlias: this.config.alias, responseLength: analysisText.length, model: resolvedModel, executionTimeMs, inputTokens: antigravityTokenUsage?.input_tokens, outputTokens: antigravityTokenUsage?.output_tokens, estimatedTokens: !(tokenUsage.input_tokens || tokenUsage.output_tokens), usageMetrics: usageMetrics ? { delta: usageMetrics.delta } : null }, 'Lightweight analysis completed');

                if (!suppressLlmLog) {
                    const usage = formatUsageMetrics(usageMetrics);
                    await persistLlmLog(createLlmLogFromAnalysis({
                        executionType: (executionType || 'other') as ExecutionType, modelUsed: resolvedModel, executionTimeMs, success: true, tokenUsage: antigravityTokenUsage,
                        sessionId, draftId: taskId, correlationId, repository, metadata, agentAlias: this.config.alias,
                        usageMetrics: usage.metrics, usageMetricRecords: usage.records,
                        workRef: buildAnalysisWorkRef(executionType, taskId, repository, { taskNumber, prNumber }),
                    }));
                }

                return { response: analysisText, modelUsed: resolvedModel, executionTimeMs, success: true,
                    tokenUsage: antigravityTokenUsage, sessionId };
            }
            return { response: '', modelUsed: resolvedModel, executionTimeMs, success: false, error: `Analysis failed: ${resolvedProtocolError || result.stderr || 'No result returned'}` };
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

    private buildAntigravityShellCommand(repositoryInspection = false): string {
        // With no prompt flag, agy detects non-TTY stdin and enters print mode.
        // This is required because repo-context prompts routinely exceed Linux's
        // 128 KiB per-argument limit (MAX_ARG_STRLEN). Passing `--print -` does
        // not read stdin: agy treats `-` as the literal prompt. `"$@"` carries
        // only CLI flags such as `--model`, so all flags precede the stdin prompt.
        const safetyArgs = repositoryInspection
            ? '--sandbox --disable-slash-commands'
            : '--dangerously-skip-permissions';
        return ['set -e', `exec ${this.getCliCommand()} ${safetyArgs} "$@"`].join('\n');
    }

    private buildDockerArgs(params: { worktreePath: string; githubToken: string; modelName?: string; issueNumber: number; environment?: Record<string, string>; taskId?: string; executionType?: string; transcriptPath?: string; readOnlyWorkspace?: boolean; repositoryInspection?: boolean }): string[] {
        const { worktreePath, githubToken, modelName, issueNumber, environment, taskId, executionType, transcriptPath, readOnlyWorkspace = false, repositoryInspection = false } = params;
        assertRepositoryInspectionMode(repositoryInspection, readOnlyWorkspace);
        const configPath = this.getHostConfigPath();
        const envVars = buildAgentEnvironmentArgs(repositoryInspection, this.config.envVars, environment);
        const shortTaskId = createContainerExecutionId(taskId);
        const taskType = executionType || (issueNumber === 0 ? 'analysis' : `issue-${issueNumber}`);
        const runtimeName = this.getRuntimeName();
        const containerName = this.buildContainerName(this.config.alias || runtimeName, taskType, shortTaskId, modelName);
        const dockerArgs: string[] = [
            'run', '--rm', '-i', '--name', containerName, '--security-opt', 'no-new-privileges', '--cap-add', 'CHOWN', '--network', 'bridge', '--user', '0:0',
            '-v', `${worktreePath}:${repositoryInspection ? REPOSITORY_SCOUT_CONTAINER_ROOT : '/home/node/workspace'}:${readOnlyWorkspace ? 'ro' : 'rw'}`,
            ...(repositoryInspection ? [] : ['-v', `/tmp/git-processor:/tmp/git-processor:${readOnlyWorkspace ? 'ro' : 'rw'}`]),
            '-v', `${configPath}:${this.getContainerConfigPath()}:rw`,
            ...(repositoryInspection ? [] : ['-e', `GH_TOKEN=${githubToken}`, '-e', `GITHUB_TOKEN=${githubToken}`]),
            '-e', 'ANTIGRAVITY_CLI=1', '-e', 'ANTIGRAVITY_CLI_TRUST_WORKSPACE=true',
            ...(readOnlyWorkspace ? ['-e', 'PROPR_REPO_SETUP=0'] : []),
            '-e', 'PROPR_EPHEMERAL_STATE=1', '-e', `PROPR_ANTIGRAVITY_SOURCE_CONFIG=${this.getContainerConfigPath()}`,
            ...(repositoryInspection ? [
                '-e', 'PROPR_REPOSITORY_INSPECTION=1',
                '-e', `PROPR_REPOSITORY_SCOUT_ANTIGRAVITY_MCP_CONFIG=${buildAntigravityRepositoryScoutMcpConfig()}`,
                '-e', `PROPR_REPOSITORY_SCOUT_ANTIGRAVITY_PERMISSIONS=${buildAntigravityRepositoryScoutPermissions()}`,
            ] : []),
            ...(transcriptPath ? ['-e', `PROPR_ANTIGRAVITY_TRANSCRIPT_PATH=${transcriptPath}`] : []),
            ...envVars, '-w', '/home/node/workspace',
            this.config.dockerImage, '/bin/bash', '-lc', this.buildAntigravityShellCommand(repositoryInspection), 'propr-antigravity'
        ];
        // The prompt is delivered through non-TTY stdin, not as an argv element,
        // to avoid spawn E2BIG on large repo-context prompts. Only CLI flags such
        // as the model selection are appended here.
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

}
