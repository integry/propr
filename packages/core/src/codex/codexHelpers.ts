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
    model?: string;
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

export function parseCodexStreamOutput(stdout: string): CodexOutput {
    let logs = '';
    let result: string | undefined;
    let isError = false;
    let errorMessage: string | undefined;
    const conversationLog: CodexEvent[] = [];
    let sessionId: string | undefined;
    let conversationId: string | undefined;
    let model: string | undefined;

    const lines = stdout.split('\n');
    for (const line of lines) {
        if (!line.trim()) continue;

        try {
            const event: CodexEvent = JSON.parse(line);
            conversationLog.push(event);

            // Capture metadata
            if (event.session_id) sessionId = event.session_id;
            if (event.conversation_id) conversationId = event.conversation_id;
            if (event.model) model = event.model;

            if (event.type === 'message') {
                logs += `[${event.role || 'unknown'}] ${event.content || ''}\n`;
            } else if (event.type === 'tool_use') {
                logs += `[Tool] ${event.tool} params: ${JSON.stringify(event.params)}\n`;
            } else if (event.type === 'error') {
                isError = true;
                errorMessage = event.message;
                logs += `[Error] ${event.message}\n`;
            } else if (event.type === 'result') {
                result = event.result || event.content;
                if (event.status === 'error') {
                    isError = true;
                    errorMessage = event.message || 'Unknown error';
                }
            } else {
                logs += `[${event.type || 'unknown'}] ${JSON.stringify(event)}\n`;
            }
        } catch {
            // Fallback for non-JSON lines
            logs += line + '\n';
        }
    }

    return {
        success: !isError,
        logs,
        result,
        error: errorMessage,
        conversationLog,
        sessionId,
        conversationId,
        model
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
