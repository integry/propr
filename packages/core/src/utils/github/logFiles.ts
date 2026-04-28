import { Redis } from 'ioredis';
import fs from 'fs';
import path from 'path';
import os from 'os';
import logger from '../logger.js';
import { getModelPricing } from '../../services/pricingService.js';
import { getOpenRouterId, getModelName } from '../../config/modelAliases.js';
import { getDetailedUsageStats, calculateCostWithCachePricing } from '../tokenCalculation.js';
import type { DetailedUsageStats, ClaudeResult as TokenCalcClaudeResult } from '../tokenCalculation.js';

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
    tokenUsage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
}

interface LogFiles {
    conversation?: string;
    output?: string;
}

interface SecretPattern {
    pattern: RegExp;
    replacement: string;
    /** When set, the replacement callback is used instead of a literal string substitution. */
    dynamicReplacement?: 'bearer';
}

const SECRET_PATTERNS: SecretPattern[] = [
    // =====================================================================
    // Strict provider patterns — these have distinctive, well-known prefixes
    // and are safe to match with high confidence.
    // =====================================================================

    // --- GitHub ---
    { pattern: /ghp_[A-Za-z0-9_]{36,}/g, replacement: '[REDACTED_GITHUB_TOKEN]' },
    { pattern: /gho_[A-Za-z0-9_]{36,}/g, replacement: '[REDACTED_GITHUB_TOKEN]' },
    { pattern: /ghu_[A-Za-z0-9_]{36,}/g, replacement: '[REDACTED_GITHUB_TOKEN]' },
    { pattern: /ghs_[A-Za-z0-9_]{36,}/g, replacement: '[REDACTED_GITHUB_TOKEN]' },
    { pattern: /github_pat_[A-Za-z0-9_]{22,}/g, replacement: '[REDACTED_GITHUB_TOKEN]' },

    // --- AWS ---
    { pattern: /(?:AKIA|ASIA)[0-9A-Z]{16}/g, replacement: '[REDACTED_AWS_ACCESS_KEY]' },
    { pattern: /(?<=(?:aws_secret_access_key|aws_secret_key|AWS_SECRET_ACCESS_KEY|AWS_SECRET_KEY|secret_access_key)\s*[=:]\s*['"]?)[A-Za-z0-9/+=]{40}/g, replacement: '[REDACTED_AWS_SECRET_KEY]' },
    { pattern: /(?<=["'](?:aws_secret_access_key|aws_secret_key|SecretAccessKey|secretAccessKey)["']\s*[=:]\s*['"]?)[A-Za-z0-9/+=]{40}/g, replacement: '[REDACTED_AWS_SECRET_KEY]' },

    // --- OpenRouter ---
    { pattern: /sk-or-v1-[A-Za-z0-9]{64}/g, replacement: '[REDACTED_OPENROUTER_KEY]' },

    // --- Stripe ---
    { pattern: /sk_live_[A-Za-z0-9]{24,}/g, replacement: '[REDACTED_STRIPE_SECRET_KEY]' },
    { pattern: /sk_test_[A-Za-z0-9]{24,}/g, replacement: '[REDACTED_STRIPE_SECRET_KEY]' },
    { pattern: /rk_live_[A-Za-z0-9]{24,}/g, replacement: '[REDACTED_STRIPE_RESTRICTED_KEY]' },
    { pattern: /rk_test_[A-Za-z0-9]{24,}/g, replacement: '[REDACTED_STRIPE_RESTRICTED_KEY]' },
    { pattern: /pk_live_[A-Za-z0-9]{24,}/g, replacement: '[REDACTED_STRIPE_PUBLISHABLE_KEY]' },
    { pattern: /pk_test_[A-Za-z0-9]{24,}/g, replacement: '[REDACTED_STRIPE_PUBLISHABLE_KEY]' },

    // --- OpenAI --- (legacy keys contain "T3BlbkFJ"; project keys start with "sk-proj-")
    { pattern: /sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}/g, replacement: '[REDACTED_OPENAI_KEY]' },
    { pattern: /sk-proj-[A-Za-z0-9_-]{40,}/g, replacement: '[REDACTED_OPENAI_KEY]' },

    // --- Anthropic ---
    { pattern: /sk-ant-[A-Za-z0-9-]{32,}/g, replacement: '[REDACTED_ANTHROPIC_KEY]' },

    // --- Slack ---
    { pattern: /xoxb-[0-9]{10,}-[A-Za-z0-9]{10,}/g, replacement: '[REDACTED_SLACK_TOKEN]' },
    { pattern: /xoxp-[0-9]{10,}-[A-Za-z0-9]{10,}/g, replacement: '[REDACTED_SLACK_TOKEN]' },
    { pattern: /xapp-[0-9]{1,}-[A-Za-z0-9]{10,}/g, replacement: '[REDACTED_SLACK_TOKEN]' },
    { pattern: /xoxa-[0-9]{10,}-[A-Za-z0-9]{10,}/g, replacement: '[REDACTED_SLACK_TOKEN]' },

    // --- SendGrid ---
    { pattern: /SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g, replacement: '[REDACTED_SENDGRID_KEY]' },

    // --- Twilio ---
    { pattern: /SK[0-9a-fA-F]{32}/g, replacement: '[REDACTED_TWILIO_KEY]' },

    // --- Mailgun ---
    { pattern: /key-[A-Za-z0-9]{32}/g, replacement: '[REDACTED_MAILGUN_KEY]' },

    // --- Google ---
    { pattern: /AIza[A-Za-z0-9_-]{35}/g, replacement: '[REDACTED_GOOGLE_API_KEY]' },

    // =====================================================================
    // Heuristic / generic patterns — these rely on contextual signals (e.g.
    // assignment syntax, "Bearer" scheme) and use broader matching.  Order
    // matters: provider-specific rules above take precedence.
    // =====================================================================

    // Bearer tokens — require at least 20 chars to avoid matching prose
    { pattern: /Bearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi, replacement: '', dynamicReplacement: 'bearer' },
    // Secret/token assignment patterns (catches env vars like SECRET_KEY=... or API_TOKEN=...)
    { pattern: /(?<=(?:^|[_A-Z])(?:SECRET|PASSWORD|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|SECRET_KEY|SECRET_TOKEN|API_TOKEN|AUTH_TOKEN)\s*[=:]\s*['"]?)[A-Za-z0-9/+=_-]{20,}(?=['"]?)/gim, replacement: '[REDACTED_SECRET]' },
];

export function redactSecrets(input: string): string {
    let result = input;
    for (const { pattern, replacement, dynamicReplacement } of SECRET_PATTERNS) {
        if (dynamicReplacement === 'bearer') {
            // Preserve the original casing of "Bearer" / "bearer" / "BEARER"
            result = result.replace(pattern, (match) => {
                const scheme = match.split(/\s/)[0];
                return `${scheme} [REDACTED_BEARER_TOKEN]`;
            });
        } else {
            result = result.replace(pattern, replacement);
        }
    }
    return result;
}

/**
 * Recursively walk a JSON-serializable value and redact any secrets found in
 * string leaves.  Preserves JSON serialization semantics: objects with a
 * `toJSON()` method (e.g. `Date`, `URL`) are serialized via that method first,
 * then the result is redacted recursively.
 */
export function redactSerializableValue(obj: unknown): unknown {
    if (typeof obj === 'string') {
        return redactSecrets(obj);
    }
    if (Array.isArray(obj)) {
        return obj.map(item => redactSerializableValue(item));
    }
    if (obj !== null && typeof obj === 'object') {
        // Honour toJSON() so Date, URL, etc. serialize the same as JSON.stringify
        if (typeof (obj as Record<string, unknown>).toJSON === 'function') {
            return redactSerializableValue((obj as { toJSON(): unknown }).toJSON());
        }
        const redacted: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(obj)) {
            redacted[key] = redactSerializableValue(value);
        }
        return redacted;
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
    const detailedStats = getDetailedUsageStats(claudeResult as unknown as TokenCalcClaudeResult);
    const { totalInputWithCache: inputTokens, outputTokens, totalTokens } = detailedStats;
    const cost = await calculateExecutionCost(claudeResult, detailedStats);
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
    if (claudeResult?.summary) section += `**Summary:**\n${redactSecrets(claudeResult.summary)}\n\n`;
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
