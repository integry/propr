import logger from '../utils/logger.js';
import { generateClaudePrompt, IssueRef, IssueDetails } from '../claude/prompts/promptGenerator.js';

export interface BuildCodexPromptOptions {
    customPrompt?: string;
    issueRef: IssueRef;
    branchName?: string;
    modelName?: string;
    issueDetails?: IssueDetails;
    isRetry?: boolean;
    retryReason?: string;
    systemPrompt?: string;
}

export interface CodexEventItem {
    id?: string;
    type?: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number;
    status?: string;
}

export interface CodexEvent {
    type?: string;
    role?: string;
    content?: string;
    tool?: string;
    params?: Record<string, unknown>;
    message?: string;
    status?: string;
    result?: string;
    session_id?: string;
    conversation_id?: string;
    thread_id?: string;
    model?: string;
    item?: CodexEventItem;
    usage?: Record<string, number>;
}

export interface CodexOutput {
    success: boolean;
    logs: string;
    result?: string;
    error?: string;
    conversationLog: CodexEvent[];
    sessionId?: string;
    conversationId?: string;
    model?: string;
    tokenUsage?: { input_tokens?: number; output_tokens?: number };
}

export interface StoreCodexPromptOptions {
    codexOutput: CodexOutput;
    prompt: string;
    issueRef: IssueRef;
    model: string;
    isRetry?: boolean;
    retryReason?: string;
}

export function buildCodexPrompt(options: BuildCodexPromptOptions): string {
    const {
        customPrompt,
        issueRef,
        branchName,
        modelName,
        issueDetails,
        isRetry,
        retryReason,
        systemPrompt
    } = options;

    // Use the shared prompt generator from Claude to ensure consistent context formatting
    const basePrompt = customPrompt || generateClaudePrompt(
        issueRef,
        branchName ?? null,
        modelName ?? null,
        issueDetails ?? null
    );

    // Prepend system prompt if provided
    const systemContext = systemPrompt ? `SYSTEM INSTRUCTIONS:\n${systemPrompt}\n\n---\n\n` : '';

    const prompt = `${systemContext}${basePrompt}

**CRITICAL GIT SAFETY RULES:**
- NEVER run 'rm .git' or delete the .git file/directory
- NEVER run 'git init' in the workspace - this is already a git repository
- If you encounter git errors, report them but DO NOT attempt to reinitialize the repository
- The workspace is a git worktree linked to the main repository
- Only make changes to the specific files mentioned in the issue/request
- If git commands fail, describe the error but do not try destructive recovery methods
- The system will automatically commit your changes after you complete the modifications`;

    logger.debug({
        issueNumber: issueRef.number,
        promptLength: prompt.length,
        hasSafetyRules: prompt.includes('CRITICAL GIT SAFETY RULES'),
        isCustomPrompt: !!customPrompt
    }, 'Generated Codex prompt with safety rules');

    if (isRetry) {
        logger.info({
            issueNumber: issueRef.number,
            retryReason
        }, 'Using enhanced prompt for retry execution');
    }

    return prompt;
}

interface ParseState {
    logs: string;
    result: string | undefined;
    isError: boolean;
    errorMessage: string | undefined;
    sessionId: string | undefined;
    conversationId: string | undefined;
    model: string | undefined;
    tokenUsage: { input_tokens: number; output_tokens: number };
}

function handleItemCompleted(event: CodexEvent, state: ParseState): void {
    const item = event.item;
    if (!item) return;

    if (item.type === 'agent_message') {
        state.result = item.text;
        state.logs += `[Assistant] ${item.text || ''}\n`;
    } else if (item.type === 'reasoning') {
        state.logs += `[Reasoning] ${item.text || ''}\n`;
    } else if (item.type === 'command_execution') {
        state.logs += `[Command] ${item.command || ''}\n`;
        if (item.aggregated_output) {
            state.logs += `[Output] ${item.aggregated_output}\n`;
        }
    }
}

function handleResultEvent(event: CodexEvent, state: ParseState): void {
    state.result = event.result || event.content;
    if (event.status === 'error') {
        state.isError = true;
        state.errorMessage = event.message || 'Unknown error';
    }
}

function captureEventMetadata(event: CodexEvent, state: ParseState): void {
    if (event.session_id) state.sessionId = event.session_id;
    if (event.conversation_id) state.conversationId = event.conversation_id;
    if (event.thread_id && !state.sessionId) state.sessionId = event.thread_id;
    if (event.model) state.model = event.model;
}

function handleTurnCompleted(event: CodexEvent, state: ParseState): void {
    state.logs += `[${event.type}]\n`;
    if (event.usage) {
        state.tokenUsage.input_tokens += (event.usage.input_tokens ?? 0) + (event.usage.cached_input_tokens ?? 0);
        state.tokenUsage.output_tokens += event.usage.output_tokens ?? 0;
    }
}

function handleErrorEvent(event: CodexEvent, state: ParseState): void {
    state.isError = true;
    state.errorMessage = event.message;
    state.logs += `[Error] ${event.message}\n`;
}

function processEvent(event: CodexEvent, state: ParseState): void {
    captureEventMetadata(event, state);

    switch (event.type) {
        case 'item.completed':
            handleItemCompleted(event, state);
            break;
        case 'thread.started':
            if (event.thread_id) state.sessionId = event.thread_id;
            break;
        case 'message':
            state.logs += `[${event.role || 'unknown'}] ${event.content || ''}\n`;
            break;
        case 'tool_use':
            state.logs += `[Tool] ${event.tool} params: ${JSON.stringify(event.params)}\n`;
            break;
        case 'error':
            handleErrorEvent(event, state);
            break;
        case 'result':
            handleResultEvent(event, state);
            break;
        case 'turn.started':
            state.logs += `[${event.type}]\n`;
            break;
        case 'turn.completed':
            handleTurnCompleted(event, state);
            break;
        case 'item.started':
            break;
        default:
            state.logs += `[${event.type || 'unknown'}] ${JSON.stringify(event)}\n`;
            break;
    }
}

export function parseCodexStreamOutput(stdout: string): CodexOutput {
    const state: ParseState = {
        logs: '',
        result: undefined,
        isError: false,
        errorMessage: undefined,
        sessionId: undefined,
        conversationId: undefined,
        model: undefined,
        tokenUsage: { input_tokens: 0, output_tokens: 0 }
    };
    const conversationLog: CodexEvent[] = [];

    const lines = stdout.split('\n');
    for (const line of lines) {
        if (!line.trim()) continue;

        try {
            const event: CodexEvent = JSON.parse(line);
            conversationLog.push(event);
            processEvent(event, state);
        } catch {
            // Fallback for non-JSON lines
            state.logs += line + '\n';
        }
    }

    return {
        success: !state.isError,
        logs: state.logs,
        result: state.result,
        error: state.errorMessage,
        conversationLog,
        sessionId: state.sessionId,
        conversationId: state.conversationId,
        model: state.model,
        tokenUsage: (state.tokenUsage.input_tokens || state.tokenUsage.output_tokens) ? state.tokenUsage : undefined
    };
}

export async function storeCodexPromptInRedis(options: StoreCodexPromptOptions): Promise<void> {
    const { codexOutput, prompt, issueRef, model, isRetry, retryReason } = options;

    // Skip if we don't have session identifiers to link
    if (!codexOutput.sessionId && !codexOutput.conversationId) return;

    try {
        const Redis = await import('ioredis');
        const redis = new Redis.default({
            host: process.env.REDIS_HOST || 'redis',
            port: parseInt(process.env.REDIS_PORT || '6379', 10)
        });

        const promptData = {
            prompt,
            timestamp: new Date().toISOString(),
            issueRef,
            sessionId: codexOutput.sessionId,
            conversationId: codexOutput.conversationId,
            model,
            isRetry,
            retryReason,
            agentType: 'codex'
        };

        const promptKeys: string[] = [];

        if (codexOutput.sessionId) {
            const sessionKey = `execution:prompt:session:${codexOutput.sessionId}`;
            await redis.set(sessionKey, JSON.stringify(promptData), 'EX', 86400 * 30);
            promptKeys.push(sessionKey);
        }

        if (codexOutput.conversationId) {
            const conversationKey = `execution:prompt:conversation:${codexOutput.conversationId}`;
            await redis.set(conversationKey, JSON.stringify(promptData), 'EX', 86400 * 30);
            promptKeys.push(conversationKey);
        }

        // Also store by issue reference for easy retrieval
        const timestamp = Date.now();
        const issueKey = `execution:prompt:issue:${issueRef.repoOwner}:${issueRef.repoName}:${issueRef.number}:${timestamp}`;
        await redis.set(issueKey, JSON.stringify(promptData), 'EX', 86400 * 30);
        promptKeys.push(issueKey);

        logger.info({
            issueNumber: issueRef.number,
            sessionId: codexOutput.sessionId,
            conversationId: codexOutput.conversationId,
            promptKeys
        }, 'Stored Codex execution prompt in Redis');

        await redis.quit();
    } catch (redisError) {
        const error = redisError as Error;
        logger.warn({
            issueNumber: issueRef.number,
            error: error.message
        }, 'Failed to store Codex execution prompt in Redis');
    }
}
