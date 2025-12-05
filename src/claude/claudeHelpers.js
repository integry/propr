import path from 'path';
import os from 'os';
import fs from 'fs';
import logger from '../utils/logger.js';
import { generateClaudePrompt } from './prompts/promptGenerator.js';
import { executeDockerCommand } from './docker/dockerExecutor.js';

export class UsageLimitError extends Error {
    constructor(message, resetTimestamp) {
        super(message);
        this.name = 'UsageLimitError';
        this.resetTimestamp = resetTimestamp;
        this.retryable = true;
    }
}

export function buildClaudePrompt(options) {
    const { customPrompt, issueRef, branchName, modelName, issueDetails, isRetry, retryReason } = options;
    const basePrompt = customPrompt || generateClaudePrompt(issueRef, branchName, modelName, issueDetails);
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

export async function setWorktreeOwnership(worktreePath, issueNumber) {
    try {
        await executeDockerCommand('sudo', ['chown', '-R', '1000:1000', worktreePath], { timeout: 10000 });
        logger.debug({ issueNumber, worktreePath }, 'Set worktree ownership to UID 1000 for container compatibility');
    } catch (chownError) {
        logger.warn({ issueNumber, worktreePath, error: chownError.message }, 'Failed to set worktree ownership - container may have permission issues');
    }
}

export function verifyWorktreeStructure(worktreePath, issueNumber) {
    const worktreeGitPath = path.join(worktreePath, '.git');
    let worktreeGitContent = null;

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
        logger.error({ issueNumber, error: verifyError.message }, 'Failed to verify worktree structure');
    }

    return worktreeGitContent;
}

export function verifyWorktreePostExecution(worktreePath, issueNumber, worktreeGitContent) {
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
        logger.error({ issueNumber, error: postVerifyError.message }, 'Failed to verify worktree state after execution');
    }
}

export function buildDockerArgs(params) {
    const { worktreePath, githubToken, prompt, modelName, issueNumber, CLAUDE_DOCKER_IMAGE, CLAUDE_CONFIG_PATH, CLAUDE_MAX_TURNS } = params;

    const dockerArgs = [
        'run', '--rm',
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
        'claude', '-p', prompt,
        '--max-turns', CLAUDE_MAX_TURNS.toString(),
        '--output-format', 'stream-json',
        '--verbose',
        '--dangerously-skip-permissions'
    ];

    if (modelName) {
        dockerArgs.splice(-6, 0, '--model', modelName);
        logger.info({ issueNumber, requestedModel: modelName }, 'Using specific model for Claude Code execution');
    } else {
        logger.debug({ issueNumber }, 'No model specified, Claude Code will use default');
    }

    return dockerArgs;
}

export function parseStreamJsonOutput(result) {
    const claudeOutput = {
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
            const jsonLine = JSON.parse(line);
            processJsonLine(jsonLine, claudeOutput, result.messageTimestamps);
        } catch {
            continue;
        }
    }

    return claudeOutput;
}

function processJsonLine(jsonLine, claudeOutput, messageTimestamps) {
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

function processResultLine(jsonLine, claudeOutput) {
    claudeOutput.finalResult = jsonLine;
    claudeOutput.success = !jsonLine.is_error;

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

export async function storePromptInRedis(options) {
    const { claudeOutput, prompt, issueRef, model, isRetry, retryReason } = options;
    if (!claudeOutput.sessionId && !claudeOutput.conversationId) return;

    try {
        const Redis = await import('ioredis');
        const redis = new Redis.default({
            host: process.env.REDIS_HOST || 'redis',
            port: process.env.REDIS_PORT || 6379
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

        const promptKeys = [];

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
        logger.warn({ issueNumber: issueRef.number, error: redisError.message }, 'Failed to store execution prompt in Redis - continuing');
    }
}
