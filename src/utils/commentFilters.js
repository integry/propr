import logger from './logger.js';

/**
 * Centralized comment filtering logic
 * Used by both polling (daemon) and webhook handlers
 */

/**
 * Check if a comment should be filtered out based on author
 * @param {string} commentAuthor - The comment author's username
 * @param {string} userType - The user type (e.g., 'Bot', 'User') - optional
 * @param {string} correlationId - Correlation ID for logging
 * @returns {Object} { shouldFilter: boolean, reason: string }
 */
export function filterCommentByAuthor(commentAuthor, userType = null, correlationId = null) {
    // Handle overloaded parameters (backwards compatibility)
    if (typeof userType === 'string' && userType.length === 36 && userType.includes('-')) {
        // userType is actually correlationId
        correlationId = userType;
        userType = null;
    }

    const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

    const GITHUB_BOT_USERNAME = process.env.GITHUB_BOT_USERNAME;
    const GITHUB_USER_WHITELIST = (process.env.GITHUB_USER_WHITELIST || '').split(',').filter(u => u);
    const GITHUB_USER_BLACKLIST = (process.env.GITHUB_USER_BLACKLIST || '').split(',').filter(u => u);

    // Filter out bot accounts automatically
    // Check if username ends with [bot], contains [bot], or user type is Bot
    const isBotAccount =
        commentAuthor.endsWith('[bot]') ||
        commentAuthor.includes('[bot]') ||
        userType === 'Bot';

    if (isBotAccount) {
        correlatedLogger.debug({ commentAuthor, userType }, 'Skipping bot account comment');
        return { shouldFilter: true, reason: 'bot_account' };
    }

    // Also filter if explicitly configured bot username matches
    if (GITHUB_BOT_USERNAME && commentAuthor === GITHUB_BOT_USERNAME) {
        correlatedLogger.debug({ commentAuthor }, 'Skipping configured bot username');
        return { shouldFilter: true, reason: 'bot_own_comment' };
    }

    // Check whitelist
    if (GITHUB_USER_WHITELIST.length > 0) {
        if (!GITHUB_USER_WHITELIST.includes(commentAuthor)) {
            correlatedLogger.debug({ commentAuthor }, 'Comment author not in whitelist, skipping');
            return { shouldFilter: true, reason: 'not_in_whitelist' };
        }
    } else {
        // Check blacklist (only if no whitelist)
        if (GITHUB_USER_BLACKLIST.length > 0 && GITHUB_USER_BLACKLIST.includes(commentAuthor)) {
            correlatedLogger.debug({ commentAuthor }, 'Comment author in blacklist, skipping');
            return { shouldFilter: true, reason: 'in_blacklist' };
        }
    }

    return { shouldFilter: false, reason: null };
}

/**
 * Check if a comment should trigger processing based on keywords
 * @param {string} commentBody - The comment body text
 * @param {string} correlationId - Correlation ID for logging
 * @returns {Object} { isTriggered: boolean, extractedLlm: string|null }
 */
export function checkCommentTrigger(commentBody, correlationId = null) {
    const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

    const PR_FOLLOWUP_TRIGGER_KEYWORDS = (process.env.PR_FOLLOWUP_TRIGGER_KEYWORDS !== undefined ? process.env.PR_FOLLOWUP_TRIGGER_KEYWORDS : '').split(',').filter(k => k.trim()).map(k => k.trim());

    if (!commentBody) {
        return { isTriggered: false, extractedLlm: null };
    }

    let isTriggered = false;
    let extractedLlm = null;

    if (PR_FOLLOWUP_TRIGGER_KEYWORDS.length > 0) {
        isTriggered = PR_FOLLOWUP_TRIGGER_KEYWORDS.some(keyword => commentBody.includes(keyword));

        // Try to extract LLM from trigger keyword
        for (const keyword of PR_FOLLOWUP_TRIGGER_KEYWORDS) {
            const llmMatch = commentBody.match(new RegExp(`${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:([\\w.-]+)`));
            if (llmMatch) {
                extractedLlm = llmMatch[1];
                break;
            }
        }
    } else {
        // No trigger keywords configured - all comments trigger
        isTriggered = true;
    }

    if (!isTriggered) {
        correlatedLogger.debug({
            hasKeywords: PR_FOLLOWUP_TRIGGER_KEYWORDS.length > 0
        }, 'Comment does not contain trigger keywords, skipping');
    }

    return { isTriggered, extractedLlm };
}
