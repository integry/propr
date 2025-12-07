import logger from './logger.ts';
import type { Logger } from 'pino';

/**
 * Centralized comment filtering logic
 * Used by both polling (daemon) and webhook handlers
 */

interface FilterResult {
    shouldFilter: boolean;
    reason: string | null;
}

interface TriggerResult {
    isTriggered: boolean;
    extractedLlm: string | null;
}

/**
 * Check if a comment should be filtered out based on author
 * @param commentAuthor - The comment author's username
 * @param userType - The user type (e.g., 'Bot', 'User') - optional
 * @param correlationId - Correlation ID for logging
 * @returns Object with shouldFilter boolean and reason string
 */
export function filterCommentByAuthor(commentAuthor: string, userType: string | null = null, correlationId: string | null = null): FilterResult {
    if (typeof userType === 'string' && userType.length === 36 && userType.includes('-')) {
        correlationId = userType;
        userType = null;
    }

    const correlatedLogger: Logger = correlationId ? logger.withCorrelation(correlationId) : logger as unknown as Logger;

    const GITHUB_BOT_USERNAME = process.env.GITHUB_BOT_USERNAME;
    const GITHUB_USER_WHITELIST: string[] = (process.env.GITHUB_USER_WHITELIST ?? '').split(',').filter(u => u).map(u => u.trim());
    const GITHUB_USER_BLACKLIST: string[] = (process.env.GITHUB_USER_BLACKLIST ?? '').split(',').filter(u => u).map(u => u.trim());

    if (GITHUB_USER_WHITELIST.length > 0) {
        const normalizedAuthor = commentAuthor.replace('[bot]', '');

        if (!GITHUB_USER_WHITELIST.includes(commentAuthor) && !GITHUB_USER_WHITELIST.includes(normalizedAuthor)) {
            correlatedLogger.debug({ commentAuthor }, 'Comment author not in whitelist, skipping');
            return { shouldFilter: true, reason: 'not_in_whitelist' };
        }
        return { shouldFilter: false, reason: null };
    }

    if (GITHUB_BOT_USERNAME && commentAuthor === GITHUB_BOT_USERNAME) {
        correlatedLogger.debug({ commentAuthor }, 'Skipping configured bot username');
        return { shouldFilter: true, reason: 'bot_own_comment' };
    }

    const isBotAccount =
        commentAuthor.endsWith('[bot]') ||
        commentAuthor.includes('[bot]') ||
        userType === 'Bot';

    if (isBotAccount) {
        correlatedLogger.debug({ commentAuthor, userType }, 'Skipping bot account comment');
        return { shouldFilter: true, reason: 'bot_account' };
    }

    if (GITHUB_USER_BLACKLIST.length > 0 && GITHUB_USER_BLACKLIST.includes(commentAuthor)) {
        correlatedLogger.debug({ commentAuthor }, 'Comment author in blacklist, skipping');
        return { shouldFilter: true, reason: 'in_blacklist' };
    }

    return { shouldFilter: false, reason: null };
}

/**
 * Check if a comment should trigger processing based on keywords
 * @param commentBody - The comment body text
 * @param correlationId - Correlation ID for logging
 * @returns Object with isTriggered boolean and extractedLlm string or null
 */
export function checkCommentTrigger(commentBody: string | null | undefined, correlationId: string | null = null): TriggerResult {
    const correlatedLogger: Logger = correlationId ? logger.withCorrelation(correlationId) : logger as unknown as Logger;

    const PR_FOLLOWUP_TRIGGER_KEYWORDS: string[] = (process.env.PR_FOLLOWUP_TRIGGER_KEYWORDS !== undefined ? process.env.PR_FOLLOWUP_TRIGGER_KEYWORDS : '').split(',').filter(k => k.trim()).map(k => k.trim());

    if (!commentBody) {
        return { isTriggered: false, extractedLlm: null };
    }

    let isTriggered = false;
    let extractedLlm: string | null = null;

    if (PR_FOLLOWUP_TRIGGER_KEYWORDS.length > 0) {
        isTriggered = PR_FOLLOWUP_TRIGGER_KEYWORDS.some(keyword => commentBody.includes(keyword));

        for (const keyword of PR_FOLLOWUP_TRIGGER_KEYWORDS) {
            const llmMatch = commentBody.match(new RegExp(`${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:([\\w.-]+)`));
            if (llmMatch) {
                extractedLlm = llmMatch[1];
                break;
            }
        }
    } else {
        isTriggered = true;
    }

    if (!isTriggered) {
        correlatedLogger.debug({
            hasKeywords: PR_FOLLOWUP_TRIGGER_KEYWORDS.length > 0
        }, 'Comment does not contain trigger keywords, skipping');
    }

    return { isTriggered, extractedLlm };
}
