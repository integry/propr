import { Redis } from 'ioredis';
import fs from 'fs';
import path from 'path';
import os from 'os';
import logger from '../logger.js';
import { getModelPricing } from '../../services/pricingService.js';
import { getOpenRouterId, getModelName } from '../../config/modelAliases.js';
interface MessageUsage {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
}

interface UsageStats {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
}

function getUsageStats(claudeResult: ClaudeResult | null): UsageStats {
    let inputTokens = 0;
    let outputTokens = 0;

    if (claudeResult?.conversationLog) {
        claudeResult.conversationLog.forEach(msg => {
            const message = msg.message as { usage?: MessageUsage } | undefined;
            if (message?.usage) {
                const usage = message.usage;
                inputTokens += (usage.input_tokens ?? 0);
                inputTokens += (usage.cache_creation_input_tokens ?? 0);
                inputTokens += (usage.cache_read_input_tokens ?? 0);
                outputTokens += (usage.output_tokens ?? 0);
            }
        });
    }

    return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens
    };
}

interface IssueRef {
    number: number;
    repoOwner: string;
    repoName: string;
}

interface ConversationMessage {
    type?: string;
    message?: {
        content?: Array<{ text?: string }>;
    };
}

interface FinalResult {
    cost_usd?: number;
    num_turns?: number;
    subtype?: string;
}

interface ClaudeResult {
    success?: boolean;
    sessionId?: string | null;
    conversationId?: string | null;
    model?: string | null;
    executionTime?: number;
    conversationLog?: ConversationMessage[];
    rawOutput?: string;
    finalResult?: FinalResult;
    summary?: string;
}

interface LogFiles {
    conversation?: string;
    output?: string;
}

async function calculateExecutionCost(
    claudeResult: ClaudeResult,
    inputTokens: number,
    outputTokens: number,
    totalTokens: number
): Promise<number> {
    const baseCost = claudeResult?.finalResult?.cost_usd || 0;
    if (baseCost > 0 || totalTokens === 0 || !claudeResult?.model) {
        return baseCost;
    }

    try {
        const openRouterId = getOpenRouterId(claudeResult.model);
        const pricing = await getModelPricing(openRouterId);
        if (pricing) {
            return (inputTokens * pricing.prompt) + (outputTokens * pricing.completion);
        }
    } catch {
        // Fall back to base cost if pricing lookup fails
    }
    return baseCost;
}

export async function createLogFiles(claudeResultInput: unknown, issueRef: IssueRef): Promise<LogFiles> {
    const claudeResult = claudeResultInput as ClaudeResult;
    const logDir = path.join(os.tmpdir(), 'claude-logs');
    await fs.promises.mkdir(logDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePrefix = `issue-${issueRef.number}-${timestamp}`;

    const files: LogFiles = {};

    if (claudeResult?.conversationLog && claudeResult.conversationLog.length > 0) {
        const conversationPath = path.join(logDir, `${filePrefix}-conversation.json`);
        const conversationData = {
            sessionId: claudeResult.sessionId,
            conversationId: claudeResult.conversationId,
            model: claudeResult.model,
            timestamp: new Date().toISOString(),
            issueNumber: issueRef.number,
            repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
            messages: claudeResult.conversationLog
        };
        await fs.promises.writeFile(conversationPath, JSON.stringify(conversationData, null, 2));
        files.conversation = conversationPath;
        logger.info({ conversationPath, messageCount: claudeResult.conversationLog.length }, 'Created conversation log file');
    }

    if (claudeResult?.rawOutput) {
        const outputPath = path.join(logDir, `${filePrefix}-output.txt`);
        await fs.promises.writeFile(outputPath, claudeResult.rawOutput);
        files.output = outputPath;
        logger.info({ outputPath, size: claudeResult.rawOutput.length }, 'Created raw output log file');
    }

    if (Object.keys(files).length > 0 && (claudeResult.sessionId || claudeResult.conversationId)) {
        try {
            const redis = new Redis({
                host: process.env.REDIS_HOST || 'redis',
                port: parseInt(process.env.REDIS_PORT || '6379', 10)
            });

            const logData = {
                files: files,
                issueNumber: issueRef.number,
                repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
                timestamp: timestamp,
                sessionId: claudeResult.sessionId,
                conversationId: claudeResult.conversationId
            };

            if (claudeResult.sessionId) {
                const sessionKey = `execution:logs:session:${claudeResult.sessionId}`;
                await redis.set(sessionKey, JSON.stringify(logData), 'EX', 86400 * 30);
            }

            if (claudeResult.conversationId) {
                const conversationKey = `execution:logs:conversation:${claudeResult.conversationId}`;
                await redis.set(conversationKey, JSON.stringify(logData), 'EX', 86400 * 30);
            }

            const issueKey = `execution:logs:issue:${issueRef.repoOwner}:${issueRef.repoName}:${issueRef.number}:${timestamp}`;
            await redis.set(issueKey, JSON.stringify(logData), 'EX', 86400 * 30);

            logger.info({
                issueNumber: issueRef.number,
                sessionId: claudeResult.sessionId,
                conversationId: claudeResult.conversationId,
                logFiles: Object.keys(files)
            }, 'Stored log file paths in Redis');

            await redis.quit();
        } catch (redisError) {
            const err = redisError as Error;
            logger.warn({
                issueNumber: issueRef.number,
                error: err.message
            }, 'Failed to store log file paths in Redis');
        }
    }

    return files;
}

function buildStatusText(isSuccess: boolean): { header: string; status: string } {
    return {
        header: isSuccess ? 'Completed' : 'Failed',
        status: isSuccess ? 'Success' : 'Failed'
    };
}

function formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    if (m === 0) return `${s}s`;
    return `${m}m ${s}s`;
}

function formatTokens(count: number): string {
    if (count >= 1000000) {
        return parseFloat((count / 1000000).toFixed(2)) + 'M';
    }
    if (count >= 1000) {
        return parseFloat((count / 1000).toFixed(2)) + 'K';
    }
    return count.toString();
}

function buildOptionalDetails(claudeResult: ClaudeResult): string[] {
    const lines: string[] = [];
    if (claudeResult?.conversationId) {
        lines.push(`- Conversation ID: \`${claudeResult.conversationId}\``);
    }
    if (claudeResult?.model) {
        const modelDisplayName = getModelName(claudeResult.model);
        lines.push(`- LLM Model: ${modelDisplayName}`);
    }
    return lines;
}

async function buildExecutionDetails(claudeResult: ClaudeResult, issueRef: IssueRef, timestamp: string): Promise<string> {
    const isSuccess = claudeResult?.success || false;
    const executionTimeStr = formatDuration(claudeResult?.executionTime || 0);
    const { inputTokens, outputTokens, totalTokens } = getUsageStats(claudeResult);
    const cost = await calculateExecutionCost(claudeResult, inputTokens, outputTokens, totalTokens);
    const { header, status } = buildStatusText(isSuccess);

    const date = new Date(timestamp);
    const formattedTimestamp = date.toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        timeZoneName: 'short'
    });

    const lines = [
        `**AI Processing ${header}**\n`,
        `**Execution Details:**`,
        `- Issue: #${issueRef.number}`,
        `- Repository: ${issueRef.repoOwner}/${issueRef.repoName}`,
        `- Status: ${status}`,
        `- Execution Time: ${executionTimeStr}`,
        `- Tokens used: ${formatTokens(totalTokens)} tokens [${formatTokens(inputTokens)} input + ${formatTokens(outputTokens)} output]`,
        `- API cost: $${cost.toFixed(2)}`,
        `- Timestamp: ${formattedTimestamp}`,
        ...buildOptionalDetails(claudeResult)
    ];

    return lines.join('\n') + '\n\n';
}

function buildSummarySection(claudeResult: ClaudeResult): string {
    let section = '';
    if (claudeResult?.summary) section += `**Summary:**\n${claudeResult.summary}\n\n`;
    if (claudeResult?.finalResult?.subtype === 'error_max_turns') {
        section += `**Max Turns Reached**: Claude reached the maximum number of conversation turns (${claudeResult.finalResult.num_turns}) before completing all tasks. Consider increasing the turn limit or breaking down the task into smaller parts.\n\n`;
    }
    return section;
}

function buildLogFilesSection(logFiles: LogFiles, claudeResult: ClaudeResult): string {
    if (Object.keys(logFiles).length === 0) return '';
    const lines = ['**Detailed Logs:**'];
    if (logFiles.conversation && claudeResult.conversationLog?.length) {
        lines.push(`- Conversation: ${claudeResult.conversationLog.length} messages`);
        lines.push(`- Session: \`${claudeResult.sessionId}\``);
    }
    lines.push('\nLog files stored at:');
    Object.entries(logFiles).forEach(([type, filePath]) => lines.push(`- ${type}: \`${filePath}\``));
    lines.push('\n<details>\n<summary>Latest Conversation Messages</summary>\n');
    if (claudeResult.conversationLog?.length) {
        lines.push('```');
        claudeResult.conversationLog.slice(-3).forEach(msg => {
            if (msg.type === 'assistant') {
                const content = msg.message?.content?.[0]?.text || '[content unavailable]';
                const preview = content.substring(0, 200);
                lines.push(`ASSISTANT: ${preview}${content.length > 200 ? '...' : ''}\n`);
            }
        });
        lines.push('```');
    }
    lines.push('</details>\n');
    return lines.join('\n') + '\n';
}

export async function generateCompletionComment(claudeResultInput: unknown, issueRef: IssueRef): Promise<string> {
    const timestamp = new Date().toISOString();
    const result: ClaudeResult = (claudeResultInput as ClaudeResult) || { success: false };
    let comment = await buildExecutionDetails(result, issueRef, timestamp);
    comment += buildSummarySection(result);
    try {
        const logFiles = await createLogFiles(result, issueRef);
        comment += buildLogFilesSection(logFiles, result);
    } catch (logError) {
        const err = logError as Error;
        logger.warn({ issueNumber: issueRef.number, error: err.message }, 'Failed to create log files');
    }
    comment += `---\n*This PR was created automatically by [ProPR](https://propr.dev) after processing issue #${issueRef.number}.*`;
    return comment;
}
