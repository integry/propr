import logger from '../../utils/logger.js';
import { Agent, AgentConfig, AgentTaskOptions, AgentExecutionResult } from '../types.js';
import { executeDockerCommand } from '../../claude/docker/dockerExecutor.js';
import {
    verifyWorktreeStructure,
    verifyWorktreePostExecution,
    setWorktreeOwnership,
    UsageLimitError
} from '../../claude/claudeHelpers.js';
import { resolveConfigPath } from '../../config/configManager.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Re-export UsageLimitError for convenience
export { UsageLimitError };

const DEFAULT_GEMINI_TIMEOUT_MS = 300000;

// Container path for Gemini config
const CONTAINER_CONFIG_PATH = '/home/node/.gemini';

// Gemini JSONL event types (from --output-format stream-json)
interface GeminiInitEvent { type: 'init'; timestamp: string; session_id: string; model: string; }
interface GeminiMessageEvent { type: 'message'; role: 'user' | 'assistant'; content: string; timestamp: string; delta?: boolean; }
interface GeminiToolUseEvent { type: 'tool_use'; tool_name: string; tool_id: string; parameters: Record<string, unknown>; timestamp: string; }
interface GeminiToolResultEvent { type: 'tool_result'; tool_id: string; status: 'success' | 'error'; output: string; timestamp: string; }
interface GeminiResultEvent { type: 'result'; status: 'success' | 'error'; stats: { total_tokens?: number; input_tokens?: number; output_tokens?: number; duration_ms?: number; tool_calls?: number; }; timestamp: string; }
type GeminiEvent = GeminiInitEvent | GeminiMessageEvent | GeminiToolUseEvent | GeminiToolResultEvent | GeminiResultEvent | { type: 'error'; message: string; timestamp: string };

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
        const { worktreePath, issueRef, prompt: customPrompt, model, isRetry = false, retryReason, onSessionId, onContainerId, githubToken } = options;
        const startTime = Date.now();
        const effectiveModel = model || this.config.defaultModel;

        logger.info({
            issueNumber: issueRef.number, repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
            worktreePath, dockerImage: this.config.dockerImage, agentAlias: this.config.alias, isRetry, retryReason
        }, isRetry ? 'Starting Gemini agent execution (RETRY)...' : 'Starting Gemini agent execution...');

        try {
            const prompt = this.buildPromptWithRetryContext(customPrompt, isRetry, retryReason);
            const stdinData = `${prompt}\n\n/quit`;

            await setWorktreeOwnership(worktreePath, issueRef.number);
            const worktreeGitContent = verifyWorktreeStructure(worktreePath, issueRef.number);
            const dockerArgs = this.buildDockerArgs({ worktreePath, githubToken, modelName: effectiveModel, issueNumber: issueRef.number });

            const result = await executeDockerCommand('docker', dockerArgs, {
                timeout: this.timeoutMs, cwd: worktreePath, onSessionId, onContainerId, worktreePath, stdinData
            });

            const executionTime = Date.now() - startTime;
            return this.processExecutionResult({ result, executionTime, issueRef, effectiveModel, prompt, worktreePath, worktreeGitContent, onSessionId });
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
    }): Promise<AgentExecutionResult> {
        const { result, executionTime, issueRef, effectiveModel, prompt, worktreePath, worktreeGitContent, onSessionId } = opts;
        logger.info({ issueNumber: issueRef.number, repository: `${issueRef.repoOwner}/${issueRef.repoName}`, executionTime, outputLength: result.stdout?.length || 0, success: result.exitCode === 0, exitCode: result.exitCode, agentAlias: this.config.alias }, 'Gemini agent execution completed');
        const { sessionId, modelUsed: parsedModel, summary, conversationLog } = this.parseGeminiJsonl(result.stdout);
        if (sessionId && onSessionId) onSessionId(sessionId);
        if (sessionId && conversationLog.length > 0) await this.writeConversationFile(sessionId, conversationLog);
        const modelUsed = parsedModel || effectiveModel || 'unknown';
        const response: AgentExecutionResult = { success: result.exitCode === 0, executionTimeMs: executionTime, logs: result.stdout + (result.stderr ? `\n\nSTDERR:\n${result.stderr}` : ''), exitCode: result.exitCode, rawOutput: result.stdout, modelUsed, modifiedFiles: [], commitMessage: null, summary: summary ?? undefined, prompt, sessionId, conversationLog };
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

    async analyze(prompt: string, context?: string, model?: string, taskId?: string): Promise<string> {
        logger.info({
            agentAlias: this.config.alias,
            promptLength: prompt.length,
            hasContext: !!context,
            requestedModel: model,
            taskId
        }, 'Running lightweight analysis via Gemini agent...');

        // Use provided model or fallback to gemini-2.5-flash for lightweight analysis
        const effectiveModel = model || 'gemini-2.5-flash';

        const analysisPrompt = context
            ? `${prompt}\n\nContext:\n${context}\n\nCRITICAL: Do not modify any files. Do not run any commands. Only provide your analysis as plain text output.`
            : `${prompt}\n\nCRITICAL: Do not modify any files. Do not run any commands. Only provide your analysis as plain text output.`;

        // Append /quit to terminate the session
        const stdinData = `${analysisPrompt}\n\n/quit`;

        try {
            const dockerArgs = this.buildDockerArgs({
                worktreePath: '/tmp/gemini-analysis',
                githubToken: process.env.GITHUB_TOKEN || '',
                modelName: effectiveModel,
                issueNumber: 0
            });

            const result = await executeDockerCommand('docker', dockerArgs, {
                timeout: 1800000, // 30 minute timeout for analysis (planning tasks can take longer)
                stdinData,
                taskId // Pass taskId for abort signal checking
            });

            const cleanedOutput = this.stripAnsiCodes(result.stdout);
            const extractedResult = this.extractGeminiResult(cleanedOutput);

            if (result.exitCode === 0 || extractedResult) {
                const analysisText = (extractedResult || cleanedOutput || '').trim();
                logger.info({
                    agentAlias: this.config.alias,
                    responseLength: analysisText.length,
                    model: effectiveModel
                }, 'Lightweight analysis completed');
                return analysisText;
            }

            throw new Error(`Analysis failed: ${result.stderr || 'No result returned'}`);
        } catch (error) {
            const err = error as Error;
            logger.error({
                agentAlias: this.config.alias,
                error: err.message
            }, 'Lightweight analysis failed');
            throw error;
        }
    }

    async healthCheck(): Promise<boolean> {
        logger.debug({
            agentAlias: this.config.alias,
            dockerImage: this.config.dockerImage
        }, 'Running health check for Gemini agent...');

        try {
            const result = await executeDockerCommand('docker', [
                'images', '-q', this.config.dockerImage
            ], { timeout: 10000 });

            const imageExists = !!result.stdout.trim();

            logger.info({
                agentAlias: this.config.alias,
                dockerImage: this.config.dockerImage,
                imageExists
            }, imageExists ? 'Health check passed' : 'Health check failed: Docker image not found');

            return imageExists;
        } catch (error) {
            const err = error as Error;
            logger.error({
                agentAlias: this.config.alias,
                error: err.message
            }, 'Health check failed with error');
            return false;
        }
    }

    /**
     * Strips ANSI escape codes from output.
     * Gemini CLI is a TUI that produces ANSI-formatted output.
     */
    private stripAnsiCodes(text: string): string {
        return text.replace(ANSI_REGEX, '');
    }

    /**
     * Extracts the meaningful result from Gemini CLI output.
     * The TUI may include navigation elements, prompts, and other decorations.
     */
    private extractGeminiResult(cleanedOutput: string): string | undefined {
        // The output may contain multiple sections separated by prompts
        // We try to extract the main assistant response
        const lines = cleanedOutput.split('\n');
        const resultLines: string[] = [];
        let inResponse = false;

        for (const line of lines) {
            const trimmedLine = line.trim();

            // Skip empty lines at the beginning
            if (!inResponse && !trimmedLine) continue;

            // Skip common TUI elements
            if (trimmedLine.startsWith('>') || // User prompt indicator
                trimmedLine === '/quit' ||
                trimmedLine.startsWith('Gemini') ||
                trimmedLine.includes('Press') ||
                trimmedLine.includes('Ctrl+')) {
                continue;
            }

            // Start collecting response
            inResponse = true;
            resultLines.push(line);
        }

        const result = resultLines.join('\n').trim();
        return result || undefined;
    }

    /**
     * Builds Docker arguments for running Gemini in a container.
     */
    private buildDockerArgs(params: {
        worktreePath: string;
        githubToken: string;
        modelName?: string;
        issueNumber: number;
    }): string[] {
        const {
            worktreePath,
            githubToken,
            modelName,
            issueNumber
        } = params;

        const dockerImage = this.config.dockerImage;
        const configPath = resolveConfigPath(this.config.configPath);

        // Inject any custom environment variables from config
        const envVars: string[] = [];
        if (this.config.envVars) {
            for (const [key, value] of Object.entries(this.config.envVars)) {
                envVars.push('-e', `${key}=${value}`);
            }
        }

        // Build Docker run arguments
        const dockerArgs: string[] = [
            'run', '--rm',
            '-i', // Allow stdin for piping prompt
            '--security-opt', 'no-new-privileges',
            '--cap-add', 'CHOWN',
            '--network', 'bridge',
            '--user', '0:0',
            '-v', `${worktreePath}:/home/node/workspace:rw`,
            '-v', '/tmp/git-processor:/tmp/git-processor:rw',
            '-v', `${configPath}:${CONTAINER_CONFIG_PATH}:rw`,
            '-e', `GH_TOKEN=${githubToken}`,
            '-e', `GITHUB_TOKEN=${githubToken}`,
            '-e', 'GEMINI_CLI=1', // Environment variable to indicate Gemini CLI context
            ...envVars,
            '-w', '/home/node/workspace',
            dockerImage,
            // Gemini CLI - runs in headless mode with streaming JSON output
            'gemini',
            '--prompt', // Headless mode
            '--yolo', // Auto-approve tool calls
            '--output-format', 'stream-json' // JSONL output for live tracking
        ];

        // Add model selection via -m flag
        if (modelName) {
            dockerArgs.push('-m', modelName);
            logger.info({
                issueNumber,
                requestedModel: modelName,
                agentAlias: this.config.alias
            }, 'Model specified for Gemini agent');
        } else {
            logger.debug({
                issueNumber,
                agentAlias: this.config.alias
            }, 'No model specified, Gemini agent will use default');
        }

        logger.info({
            issueNumber,
            agentAlias: this.config.alias
        }, 'Docker args built for Gemini agent');

        return dockerArgs;
    }

    /**
     * Parses Gemini JSONL output from streaming JSON format.
     * Extracts session ID, model, summary, and conversation log.
     */
    private parseGeminiJsonl(output: string): {
        sessionId: string | undefined;
        modelUsed: string | undefined;
        summary: string | undefined;
        conversationLog: GeminiEvent[];
    } {
        const events: GeminiEvent[] = [];
        let sessionId: string | undefined;
        let modelUsed: string | undefined;
        let summary: string | undefined;

        const lines = output.split('\n');
        for (const line of lines) {
            if (!line.trim()) continue;

            try {
                const event = JSON.parse(line) as GeminiEvent;
                events.push(event);

                // Extract session_id and model from init event
                if (event.type === 'init') {
                    sessionId = (event as GeminiInitEvent).session_id;
                    modelUsed = (event as GeminiInitEvent).model;
                    logger.debug({ sessionId, model: modelUsed }, 'Parsed Gemini init event');
                }

                // Extract final assistant response as summary
                if (event.type === 'message' && (event as GeminiMessageEvent).role === 'assistant') {
                    summary = (event as GeminiMessageEvent).content;
                }
            } catch {
                // Not JSON, might be non-JSONL output - log for debugging
                logger.debug({ linePreview: line.substring(0, 100) }, 'Non-JSON line in Gemini output');
            }
        }

        return { sessionId, modelUsed, summary, conversationLog: events };
    }

    private async writeConversationFile(sessionId: string, events: GeminiEvent[]): Promise<void> {
        try {
            const projectDir = path.join(os.homedir(), '.claude', 'projects', '-home-node-workspace');
            await fs.promises.mkdir(projectDir, { recursive: true });
            const conversationPath = path.join(projectDir, `${sessionId}.jsonl`);
            const claudeFormatEvents = events.map(event => this.convertEventToClaudeFormat(event));
            await fs.promises.writeFile(conversationPath, claudeFormatEvents.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
            logger.info({ sessionId, path: conversationPath, eventCount: events.length }, 'Wrote Gemini conversation file');
        } catch (error) {
            logger.warn({ sessionId, error: (error as Error).message }, 'Failed to write Gemini conversation file');
        }
    }

    private convertEventToClaudeFormat(event: GeminiEvent): unknown {
        if (event.type === 'message') {
            const e = event as GeminiMessageEvent;
            return { type: e.role === 'assistant' ? 'assistant' : 'user', timestamp: e.timestamp, message: { content: [{ type: 'text', text: e.content }] } };
        } else if (event.type === 'tool_use') {
            const e = event as GeminiToolUseEvent;
            return { type: 'assistant', timestamp: e.timestamp, message: { content: [{ type: 'tool_use', name: e.tool_name, id: e.tool_id, input: e.parameters }] } };
        } else if (event.type === 'tool_result') {
            const e = event as GeminiToolResultEvent;
            return { type: 'user', timestamp: e.timestamp, message: { content: [{ type: 'tool_result', tool_use_id: e.tool_id, content: e.output, is_error: e.status === 'error' }] } };
        } else if (event.type === 'result') {
            const e = event as GeminiResultEvent;
            return { type: 'result', timestamp: e.timestamp, message: { usage: { input_tokens: e.stats.input_tokens, output_tokens: e.stats.output_tokens } } };
        }
        return event;
    }
}
