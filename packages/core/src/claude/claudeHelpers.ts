import path from 'path';
import os from 'os';
import fs from 'fs';
import logger from '../utils/logger.js';
import { generateClaudePrompt, IssueRef, IssueDetails } from './prompts/promptGenerator.js';
import { executeDockerCommand, ExecutionResult } from './docker/dockerExecutor.js';

export class UsageLimitError extends Error {
    resetTimestamp: number;
    retryable: boolean;

    constructor(message: string, resetTimestamp: number) {
        super(message);
        this.name = 'UsageLimitError';
        this.resetTimestamp = resetTimestamp;
        this.retryable = true;
    }
}

export interface BuildClaudePromptOptions {
    customPrompt?: string;
    issueRef: IssueRef;
    branchName?: string;
    modelName?: string;
    issueDetails?: IssueDetails;
    baseBranch?: string;
    isRetry?: boolean;
    retryReason?: string;
}

export interface DockerArgsParams {
    worktreePath: string;
    githubToken: string;
    prompt: string;
    promptFilePath?: string;
    modelName?: string;
    issueNumber: number;
    CLAUDE_DOCKER_IMAGE: string;
    CLAUDE_CONFIG_PATH: string;
    CLAUDE_MAX_TURNS: number;
    systemPrompt?: string;
    tools?: string;
}

export interface ConversationLogEntry {
    type?: string;
    message?: {
        id?: string;
        model?: string;
    };
    timestamp?: string;
    [key: string]: unknown;
}

export interface TokenUsage {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
}

export interface ClaudeOutputResult {
    type: string;
    is_error?: boolean;
    result?: string;
    total_cost_usd?: number;
    cost_usd?: number;
    model?: string;
    conversation_id?: string;
    usage?: TokenUsage;
}

export interface ClaudeOutput {
    success: boolean;
    rawOutput: string;
    error: string;
    conversationLog: ConversationLogEntry[];
    sessionId: string | null;
    conversationId?: string;
    finalResult: ClaudeOutputResult | null;
    model?: string;
    tokenUsage?: TokenUsage;
}

export interface StorePromptOptions {
    claudeOutput: ClaudeOutput;
    prompt: string;
    issueRef: IssueRef;
    model: string;
    isRetry?: boolean;
    retryReason?: string;
}

interface JsonLineMessage {
    type?: string;
    message?: {
        id?: string;
        model?: string;
    };
    session_id?: string;
    conversation_id?: string;
    model?: string;
    result?: string;
    is_error?: boolean;
    total_cost_usd?: number;
    cost_usd?: number;
    usage?: TokenUsage;
}

export function buildClaudePrompt(options: BuildClaudePromptOptions): string {
    const { customPrompt, issueRef, branchName, modelName, issueDetails, baseBranch, isRetry, retryReason } = options;
    const basePrompt = customPrompt || generateClaudePrompt({
        issueRef,
        branchName: branchName ?? null,
        modelName: modelName ?? null,
        issueDetails: issueDetails ?? null,
        baseBranch: baseBranch ?? null
    });
    const prompt = `${basePrompt}

**CRITICAL GIT SAFETY RULES:**
- NEVER run 'rm .git' or delete the .git file/directory
- NEVER run 'git init' in the workspace - this is already a git repository
- If you encounter git errors, report them but DO NOT attempt to reinitialize the repository
- The workspace is a git worktree linked to the main repository
- Only make changes to the specific files mentioned in the issue/request
- If git commands fail, describe the error but do not try destructive recovery methods
- NOTE: You may encounter permission errors when trying to commit - this is expected
- The system will automatically commit your changes after you complete the modifications`;

    logger.debug({
        issueNumber: issueRef.number,
        promptLength: prompt.length,
        hasSafetyRules: prompt.includes('CRITICAL GIT SAFETY RULES'),
        isCustomPrompt: !!customPrompt
    }, 'Generated Claude prompt with safety rules');

    if (isRetry) {
        logger.info({ issueNumber: issueRef.number, retryReason, promptLength: prompt.length }, 'Using enhanced prompt for retry execution');
    }

    return prompt;
}

export async function setWorktreeOwnership(worktreePath: string, issueNumber: number): Promise<void> {
    try {
        await executeDockerCommand('sudo', ['chown', '-R', '1000:1000', worktreePath], { timeout: 10000 });
        logger.debug({ issueNumber, worktreePath }, 'Set worktree ownership to UID 1000 for container compatibility');
    } catch (chownError) {
        const error = chownError as Error;
        logger.warn({ issueNumber, worktreePath, error: error.message }, 'Failed to set worktree ownership - container may have permission issues');
    }
}

export function verifyWorktreeStructure(worktreePath: string, issueNumber: number): string | null {
    const worktreeGitPath = path.join(worktreePath, '.git');
    let worktreeGitContent: string | null = null;

    try {
        if (!fs.existsSync(worktreeGitPath)) {
            logger.warn({ issueNumber, worktreeGitPath }, 'Worktree .git file not found - this may cause issues');
            return null;
        }

        const stats = fs.statSync(worktreeGitPath);
        if (!stats.isFile()) {
            logger.error({ issueNumber, worktreeGitPath, isDirectory: stats.isDirectory() }, 'CRITICAL: Worktree .git is a directory, not a file!');
            return null;
        }

        worktreeGitContent = fs.readFileSync(worktreeGitPath, 'utf8').trim();
        const gitdirMatch = worktreeGitContent.match(/gitdir:\s*(.+)/);
        const mainRepoPath = gitdirMatch ? gitdirMatch[1].trim() : null;

        logger.debug({
            issueNumber,
            worktreeGitPath,
            worktreeGitContent,
            mainRepoPath,
            mainRepoExists: mainRepoPath ? fs.existsSync(mainRepoPath) : false
        }, 'Verified worktree .git file structure');
    } catch (verifyError) {
        const error = verifyError as Error;
        logger.error({ issueNumber, error: error.message }, 'Failed to verify worktree structure');
    }

    return worktreeGitContent;
}

export function verifyWorktreePostExecution(
    worktreePath: string,
    issueNumber: number,
    worktreeGitContent: string | null
): void {
    try {
        const postExecGitPath = path.join(worktreePath, '.git');
        if (!fs.existsSync(postExecGitPath)) return;

        const postStats = fs.statSync(postExecGitPath);
        if (postStats.isDirectory()) {
            logger.error({
                issueNumber,
                worktreePath,
                preExecType: worktreeGitContent ? 'file' : 'unknown',
                postExecType: 'directory'
            }, 'CRITICAL: Worktree .git was converted from file to directory!');

            const gitConfigPath = path.join(postExecGitPath, 'config');
            if (fs.existsSync(gitConfigPath)) {
                const gitConfig = fs.readFileSync(gitConfigPath, 'utf8');
                logger.error({ issueNumber, gitConfigPreview: gitConfig.substring(0, 200) }, 'Found git config - git init was run');
            }
            return;
        }

        const postContent = fs.readFileSync(postExecGitPath, 'utf8').trim();
        if (postContent !== worktreeGitContent) {
            logger.warn({ issueNumber, preContent: worktreeGitContent, postContent }, 'Worktree .git file content changed during execution');
        }
    } catch (postVerifyError) {
        const error = postVerifyError as Error;
        logger.error({ issueNumber, error: error.message }, 'Failed to verify worktree state after execution');
    }
}

export function buildDockerArgs(params: DockerArgsParams): string[] {
    const { worktreePath, githubToken, modelName, issueNumber, CLAUDE_DOCKER_IMAGE, CLAUDE_CONFIG_PATH, CLAUDE_MAX_TURNS, systemPrompt, tools } = params;

    // Always use stdin for prompt to avoid E2BIG errors with large prompts
    const dockerArgs: string[] = [
        'run', '--rm',
        '-i', // Allow stdin for piping prompt
        '--security-opt', 'no-new-privileges',
        '--cap-add', 'CHOWN',
        '--network', 'bridge',
        '--user', '0:0',
        '-v', `${worktreePath}:/home/node/workspace:rw`,
        '-v', '/tmp/git-processor:/tmp/git-processor:rw',
        '-v', '/tmp/claude-logs:/tmp/claude-logs:rw',
        '-v', `${CLAUDE_CONFIG_PATH}:/home/node/.claude:rw`,
        ...(fs.existsSync(path.join(os.homedir(), '.claude.json')) ? ['-v', `${path.join(os.homedir(), '.claude.json')}:/home/node/.claude.json:rw`] : []),
        '-e', `GH_TOKEN=${githubToken}`,
        '-w', '/home/node/workspace',
        CLAUDE_DOCKER_IMAGE,
        'claude', '-p', '-', // Read prompt from stdin
        '--max-turns', CLAUDE_MAX_TURNS.toString(),
        '--output-format', 'stream-json',
        '--verbose',
        '--dangerously-skip-permissions'
    ];

    if (modelName) {
        const maxTurnsIndex = dockerArgs.indexOf('--max-turns');
        dockerArgs.splice(maxTurnsIndex, 0, '--model', modelName);
        logger.info({ issueNumber, requestedModel: modelName }, 'Using specific model for Claude Code execution');
    } else {
        logger.debug({ issueNumber }, 'No model specified, Claude Code will use default');
    }

    if (systemPrompt !== undefined) {
        dockerArgs.push('--system-prompt', systemPrompt);
        logger.info({ issueNumber, systemPromptLength: systemPrompt.length }, 'Using custom system prompt');
    }

    if (tools !== undefined) {
        dockerArgs.push('--tools', tools);
        logger.info({ issueNumber, tools }, 'Using custom tools configuration');
    }

    logger.info({ issueNumber, hasSystemPrompt: systemPrompt !== undefined, hasTools: tools !== undefined }, 'Docker args built');

    return dockerArgs;
}

export function parseStreamJsonOutput(result: ExecutionResult): ClaudeOutput {
    const claudeOutput: ClaudeOutput = {
        success: result.exitCode === 0,
        rawOutput: result.stdout,
        error: result.stderr,
        conversationLog: [],
        sessionId: null,
        finalResult: null
    };

    if (!result.stdout) return claudeOutput;

    const lines = result.stdout.split('\n').filter(line => line.trim());
    for (const line of lines) {
        try {
            const jsonLine: JsonLineMessage = JSON.parse(line);
            processJsonLine(jsonLine, claudeOutput, result.messageTimestamps);
        } catch {
            continue;
        }
    }

    return claudeOutput;
}

function processJsonLine(
    jsonLine: JsonLineMessage,
    claudeOutput: ClaudeOutput,
    messageTimestamps: Map<string, string>
): void {
    if (jsonLine.type === 'user' || jsonLine.type === 'assistant') {
        const messageKey = jsonLine.message?.id || `${jsonLine.type}-${JSON.stringify(jsonLine).substring(0, 100)}`;
        const timestamp = messageTimestamps?.get(messageKey);
        claudeOutput.conversationLog.push({ ...jsonLine, timestamp: timestamp || new Date().toISOString() });

        if (jsonLine.type === 'assistant' && jsonLine.message?.model) {
            claudeOutput.model = jsonLine.message.model;
        }
    }

    if (jsonLine.session_id) claudeOutput.sessionId = jsonLine.session_id;
    if (jsonLine.conversation_id) claudeOutput.conversationId = jsonLine.conversation_id;
    if (jsonLine.model) claudeOutput.model = jsonLine.model;

    if (jsonLine.type === 'result') {
        processResultLine(jsonLine, claudeOutput);
    }
}

function processResultLine(jsonLine: JsonLineMessage, claudeOutput: ClaudeOutput): void {
    claudeOutput.finalResult = {
        type: jsonLine.type || 'result',
        is_error: jsonLine.is_error,
        result: jsonLine.result,
        total_cost_usd: jsonLine.total_cost_usd,
        cost_usd: jsonLine.cost_usd,
        model: jsonLine.model,
        conversation_id: jsonLine.conversation_id,
        usage: jsonLine.usage
    };
    claudeOutput.success = !jsonLine.is_error;

    // Extract token usage from result line
    if (jsonLine.usage) {
        claudeOutput.tokenUsage = {
            input_tokens: jsonLine.usage.input_tokens,
            output_tokens: jsonLine.usage.output_tokens,
            cache_creation_input_tokens: jsonLine.usage.cache_creation_input_tokens,
            cache_read_input_tokens: jsonLine.usage.cache_read_input_tokens
        };
    }

    if (jsonLine.result) {
        const limitMatch = jsonLine.result.match(/Claude AI usage limit reached\|(\d+)/);
        if (limitMatch && limitMatch[1]) {
            const resetTimestamp = parseInt(limitMatch[1], 10);
            logger.warn({ resetTimestamp }, 'Claude usage limit reached. Throwing specific error for requeue.');
            throw new UsageLimitError(`Claude usage limit reached. Limit resets at timestamp ${resetTimestamp}.`, resetTimestamp);
        }
    }

    if (jsonLine.total_cost_usd && !jsonLine.cost_usd) {
        claudeOutput.finalResult.cost_usd = jsonLine.total_cost_usd;
    }
    if (jsonLine.model) claudeOutput.model = jsonLine.model;
    if (jsonLine.conversation_id) claudeOutput.conversationId = jsonLine.conversation_id;
}

export async function storePromptInRedis(options: StorePromptOptions): Promise<void> {
    const { claudeOutput, prompt, issueRef, model, isRetry, retryReason } = options;
    if (!claudeOutput.sessionId && !claudeOutput.conversationId) return;

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
            sessionId: claudeOutput.sessionId,
            conversationId: claudeOutput.conversationId,
            model,
            isRetry,
            retryReason
        };

        const promptKeys: string[] = [];

        if (claudeOutput.sessionId) {
            const sessionKey = `execution:prompt:session:${claudeOutput.sessionId}`;
            await redis.set(sessionKey, JSON.stringify(promptData), 'EX', 86400 * 30);
            promptKeys.push(sessionKey);
        }

        if (claudeOutput.conversationId) {
            const conversationKey = `execution:prompt:conversation:${claudeOutput.conversationId}`;
            await redis.set(conversationKey, JSON.stringify(promptData), 'EX', 86400 * 30);
            promptKeys.push(conversationKey);
        }

        const timestamp = Date.now();
        const issueKey = `execution:prompt:issue:${issueRef.repoOwner}:${issueRef.repoName}:${issueRef.number}:${timestamp}`;
        await redis.set(issueKey, JSON.stringify(promptData), 'EX', 86400 * 30);
        promptKeys.push(issueKey);

        logger.info({
            issueNumber: issueRef.number,
            sessionId: claudeOutput.sessionId,
            conversationId: claudeOutput.conversationId,
            promptKeys,
            promptLength: prompt.length
        }, 'Stored execution prompt in Redis with unique identifiers');

        await redis.quit();
    } catch (redisError) {
        const error = redisError as Error;
        logger.warn({ issueNumber: issueRef.number, error: error.message }, 'Failed to store execution prompt in Redis - continuing');
    }
}
