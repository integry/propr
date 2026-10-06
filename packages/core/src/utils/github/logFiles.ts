import { Redis } from 'ioredis';
import fs from 'fs';
import path from 'path';
import os from 'os';
import logger from '../logger.js';
import { getModelPricing } from '../../services/pricingService.js';
import { getOpenRouterId, getModelName } from '../../config/modelAliases.js';
import { getDetailedUsageStats, calculateCostWithCachePricing } from '../tokenCalculation.js';
import type { DetailedUsageStats, ClaudeResult as TokenCalcClaudeResult } from '../tokenCalculation.js';
import { formatSubscriptionUsage } from './formatSubscriptionUsage.js';
import type { SubscriptionUsageMetrics } from './formatSubscriptionUsage.js';
import { describeAgentTermination, resolveAgentTerminationReason } from '../../agents/termination.js';
import { sanitizeAgentReport } from '../../agents/agentReportSanitizer.js';
import { redactVisualPreviewPaths } from '../../services/visualPreviewPaths.js';
import { redactSecrets } from '../secretRedaction.js';

export { redactSecrets };

interface IssueRef {
    number: number;
    repoOwner: string;
    repoName: string;
}

interface CompletionCommentOptions {
    publishedAs?: 'pull_request' | 'issue_comment';
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
    /** Container-observed workflow validation report, independent of agent prose. */
    repositoryValidation?: string;
    success?: boolean;
    sessionId?: string | null;
    conversationId?: string | null;
    model?: string | null;
    executionTime?: number;
    conversationLog?: ConversationMessage[];
    rawOutput?: string;
    finalResult?: FinalResult;
    summary?: string;
    error?: string;
    terminationReason?: 'timeout' | 'max_turns' | 'cost_cap' | 'stalled' | 'degenerate_output';
    modifiedFiles?: string[];
    tokenUsage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
    usageMetrics?: SubscriptionUsageMetrics | null;
}

interface LogFiles {
    conversation?: string;
    output?: string;
}

/**
 * Recursively walk a JSON-serializable value and redact any secrets found in
 * string leaves.  Preserves JSON serialization semantics: objects with a
 * `toJSON(key)` method (e.g. `Date`, `URL`) are invoked with the same key
 * argument that `JSON.stringify` would supply, then the result is redacted
 * recursively.
 *
 * @param obj  - The value to redact.
 * @param key  - The property name under which `obj` appears in its parent
 *               (empty string `""` for the root), mirroring the `key` argument
 *               that `JSON.stringify` passes to `toJSON`.
 */
export function redactSerializableValue(obj: unknown, key: string = '', seen?: WeakSet<object>): unknown {
    if (typeof obj === 'string') {
        return redactSecrets(obj);
    }
    if (Array.isArray(obj)) {
        const guard = seen ?? new WeakSet();
        if (guard.has(obj)) return '[Circular]';
        guard.add(obj);
        return obj.map((item, index) => redactSerializableValue(item, String(index), guard));
    }
    if (obj !== null && typeof obj === 'object') {
        const guard = seen ?? new WeakSet();
        if (guard.has(obj)) return '[Circular]';
        guard.add(obj);
        // Honour toJSON(key) so Date, URL, etc. serialize the same as JSON.stringify
        if (typeof (obj as Record<string, unknown>).toJSON === 'function') {
            return redactSerializableValue(
                (obj as { toJSON(key: string): unknown }).toJSON(key),
                key,
                guard
            );
        }
        return Object.fromEntries(Object.entries(obj).map(([k, value]) => [
            redactVisualPreviewPaths(k),
            redactSerializableValue(value, k, guard)
        ]));
    }
    return obj;
}

async function calculateExecutionCost(
    claudeResult: ClaudeResult,
    detailedStats: DetailedUsageStats
): Promise<number> {
    const baseCost = claudeResult?.finalResult?.cost_usd || 0;
    if (baseCost > 0 || detailedStats.totalTokens === 0 || !claudeResult?.model) {
        return baseCost;
    }

    try {
        const openRouterId = getOpenRouterId(claudeResult.model);
        const pricing = await getModelPricing(openRouterId);
        if (pricing) {
            return calculateCostWithCachePricing(claudeResult.model, detailedStats, pricing);
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
            messages: redactSerializableValue(claudeResult.conversationLog)
        };
        await fs.promises.writeFile(conversationPath, JSON.stringify(conversationData, null, 2));
        files.conversation = conversationPath;
        logger.info({ conversationPath, messageCount: claudeResult.conversationLog.length }, 'Created conversation log file');
    }

    if (claudeResult?.rawOutput) {
        const outputPath = path.join(logDir, `${filePrefix}-output.txt`);
        await fs.promises.writeFile(outputPath, redactSecrets(claudeResult.rawOutput));
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

function buildStatusText(claudeResult: ClaudeResult): { header: string; status: string } {
    const terminationReason = resolveAgentTerminationReason({
        success: claudeResult.success,
        terminationReason: claudeResult.terminationReason,
        subtype: claudeResult.finalResult?.subtype,
        error: claudeResult.error
    });
    if (!claudeResult.success && terminationReason) {
        return { header: 'Incomplete', status: 'Partial work published for review' };
    }
    const isSuccess = claudeResult?.success || false;
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
    const executionTimeStr = formatDuration(claudeResult?.executionTime || 0);
    const detailedStats = getDetailedUsageStats(claudeResult as unknown as TokenCalcClaudeResult);
    const { totalInputWithCache: inputTokens, outputTokens, totalTokens } = detailedStats;
    const cost = await calculateExecutionCost(claudeResult, detailedStats);
    const { header, status } = buildStatusText(claudeResult);

    const date = new Date(timestamp);
    const formattedTimestamp = date.toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        timeZoneName: 'short'
    });

    const subscriptionLine = formatSubscriptionUsage(claudeResult?.usageMetrics);

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

    if (subscriptionLine) lines.push(`- Subscription usage: ${subscriptionLine}`);

    return lines.join('\n') + '\n\n';
}

function buildSummarySection(claudeResult: ClaudeResult): string {
    const terminationReason = resolveAgentTerminationReason({
        success: claudeResult.success,
        terminationReason: claudeResult.terminationReason,
        subtype: claudeResult.finalResult?.subtype,
        error: claudeResult.error
    });
    if (terminationReason) {
        const changedFiles = claudeResult.modifiedFiles || [];
        let section = `> [!WARNING]\n> **This implementation may be incomplete.** ${describeAgentTermination(terminationReason)} Partial changes were preserved instead of discarded.\n\n`;
        section += '**Work completed before interruption:**\n';
        const publishableSummary = sanitizeAgentReport(claudeResult.summary);
        if (publishableSummary) {
            section += `${redactSecrets(publishableSummary).slice(0, 6000)}\n\n`;
        } else if (changedFiles.length > 0) {
            section += `Changes were committed in ${changedFiles.length} file${changedFiles.length === 1 ? '' : 's'}:\n`;
            section += changedFiles.slice(0, 20).map(file => `- \`${file}\``).join('\n');
            if (changedFiles.length > 20) section += `\n- …and ${changedFiles.length - 20} more`;
            section += '\n\n';
        } else {
            section += 'See the committed diff for the changes completed before execution stopped.\n\n';
        }
        section += '**Remaining work:**\n';
        section += 'The agent stopped before validating every requirement. Review the partial diff against the original request and complete any unaddressed implementation, tests, or documentation before merging.\n\n';
        return section;
    }

    let section = '';
    const publishableSummary = sanitizeAgentReport(claudeResult.summary);
    if (publishableSummary) section += `**Summary:**\n${redactSecrets(publishableSummary)}\n\n`;
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
                const rawContent = msg.message?.content
                    ?.map(block => block.text)
                    .filter(Boolean)
                    .join('\n') || '[content unavailable]';
                const content = redactSecrets(rawContent);
                const preview = content.substring(0, 200);
                lines.push(`ASSISTANT: ${preview}${content.length > 200 ? '...' : ''}\n`);
            }
        });
        lines.push('```');
    }
    lines.push('</details>\n');
    return lines.join('\n') + '\n';
}

export async function generateCompletionComment(
    claudeResultInput: unknown,
    issueRef: IssueRef,
    options: CompletionCommentOptions = {},
): Promise<string> {
    const timestamp = new Date().toISOString();
    const result: ClaudeResult = (claudeResultInput as ClaudeResult) || { success: false };
    let comment = await buildExecutionDetails(result, issueRef, timestamp);
    comment += buildSummarySection(result);
    if (result.repositoryValidation) comment += `${redactSecrets(result.repositoryValidation)}\n\n`;
    try {
        const logFiles = await createLogFiles(result, issueRef);
        comment += buildLogFilesSection(logFiles, result);
    } catch (logError) {
        const err = logError as Error;
        logger.warn({ issueNumber: issueRef.number, error: err.message }, 'Failed to create log files');
    }
    comment += options.publishedAs === 'issue_comment'
        ? `---\n*This processing report was generated automatically by [ProPR](https://propr.dev) for issue #${issueRef.number}.*`
        : `---\n*This PR was created automatically by [ProPR](https://propr.dev) after processing issue #${issueRef.number}.*`;
    return comment;
}
