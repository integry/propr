import { logger } from '@propr/core';
import { handleError } from '@propr/core';
import type { UnprocessedComment } from '@propr/core';
import { filterCommentByAuthor, checkCommentTrigger } from '@propr/core';
import { extractLlmFromLabels, resolveModelAlias } from '@propr/core';
import { hasValidTriggerLabel, wasRefused } from '@propr/core';
import { getCheckRunsStatusForRepo, getCurrentPRHead, triggerUltrafixCheckRunHook } from '@propr/core';
import type { Redis } from 'ioredis';
import { hasUltrafixResumeCandidate } from '../jobs/ultrafixResumeClaim.js';
import { createPollingGate } from './prCommentGate.js';
import { commentTrackingKey, enqueuePRCommentJob } from './prCommentEnqueue.js';

type Octokit = {
    paginate: <T>(endpoint: string, options: Record<string, unknown>) => Promise<T[]>;
};

interface PRLabel {
    name: string;
}

interface PullRequest {
    number: number;
    title: string;
    labels: PRLabel[];
    head: { ref: string; sha?: string };
}

interface PRComment {
    id: number;
    body: string | null;
    user: { id: number; login: string };
    created_at: string;
    pull_request_review_id?: number;
    path?: string;
    line?: number;
    diff_hunk?: string;
}

interface PollingConfig {
    redisClient: Redis;
    GITHUB_BOT_USERNAME?: string;
    PR_FOLLOWUP_TRIGGER_KEYWORDS: string[];
    MODEL_LABEL_PATTERN: string;
    /**
     * Strict catch-up (the Routing resume resync): rethrow failures instead of
     * logging them, treat an unreadable assignment gate as a failure, and count
     * a comment only once a durable job carries it (see prCommentEnqueue.ts).
     */
    throwOnError?: boolean;
    /** Skip the Ultrafix CI pass, for a caller that reconciles PR heads separately. */
    skipUltrafixReconcile?: boolean;
    /** Only consider comments created at or after this ISO instant (a catch-up window). */
    createdSince?: string;
}

interface RepoContext {
    owner: string;
    repo: string;
    repoFullName: string;
    correlationId: string;
}

interface CommentContext {
    owner: string;
    repo: string;
    botUsername: string;
    correlationId: string;
}

interface CollectResult {
    unprocessedComments: UnprocessedComment[];
    selectedLlm: string | null;
    userId?: string;
}

export async function pollForPullRequestComments(
    octokit: Octokit,
    repoFullName: string,
    correlationId: string,
    config: PollingConfig
): Promise<void> {
    const correlatedLogger = logger.withCorrelation(correlationId);
    const [owner, repo] = repoFullName.split('/');

    correlatedLogger.debug({
        repository: repoFullName
    }, 'Checking for PR comments in repository');

    try {
        const prs = await octokit.paginate<PullRequest>('GET /repos/{owner}/{repo}/pulls', {
            owner,
            repo,
            state: 'open',
            per_page: 100
        });

        correlatedLogger.debug({
            repository: repoFullName,
            openPRCount: prs.length
        }, `Found ${prs.length} open pull requests`);

        if (prs.length === 0) {
            correlatedLogger.debug({
                repository: repoFullName
            }, 'No open pull requests found, skipping PR comment check');
            return;
        }

        const repoContext = { owner, repo, repoFullName, correlationId };
        for (const pr of prs) {
            await processPullRequestComments(octokit, pr, repoContext, config);
        }
        if (config.skipUltrafixReconcile) return;
        // After the comment pass: a resume can wait on queue scans, GitHub and
        // the label-transition lease, which must not delay comment pickup.
        for (const pr of prs) {
            await reconcileUltrafixForPR(pr, repoContext, config.redisClient);
        }
    } catch (error) {
        if (config.throwOnError) throw error;
        handleError(error, `Error polling PR comments for repository ${repoFullName}`, { correlationId });
    }
}

/**
 * Polling counterpart of the check_run/check_suite webhooks: when an Ultrafix
 * PR's head is green, fire the Ultrafix hook so a deferred loop resumes (or a
 * stranded one is re-armed) even if no webhook delivery ever arrives.
 */
export async function reconcileUltrafixForPR(
    pr: PullRequest,
    repoContext: RepoContext,
    redisClient: Redis,
    options: { throwOnError?: boolean } = {},
): Promise<void> {
    if (!pr.labels?.some(label => label.name === 'ultrafix')) return;

    const { owner, repo, repoFullName, correlationId } = repoContext;
    const correlatedLogger = logger.withCorrelation(correlationId);

    try {
        // Redis first: a labelled PR with no deferred record or active loop needs
        // no GitHub calls, nor does one whose retry is backing off (as in the sweep).
        if (!await hasUltrafixResumeCandidate(redisClient, { owner, repo, pr: pr.number }, { honourRetryBackoff: true })) {
            correlatedLogger.debug({ repository: repoFullName, pullRequestNumber: pr.number }, 'Ultrafix reconcile skipped: no loop waiting');
            return;
        }
        // The listed PR already carries its head; only fall back to a lookup when it does not.
        const headSha = pr.head.sha || await getCurrentPRHead(owner, repo, pr.number);
        if (!headSha) {
            correlatedLogger.debug({ repository: repoFullName, pullRequestNumber: pr.number }, 'Ultrafix reconcile skipped: PR head SHA unavailable');
            return;
        }
        // The loop's own readiness gate: non-blocking checks never hold it, and a
        // head with no checks at all is ready (no check event will ever come for it).
        if (!(await getCheckRunsStatusForRepo(owner, repo, headSha)).allPassing) {
            correlatedLogger.debug({ repository: repoFullName, pullRequestNumber: pr.number, headSha }, 'Ultrafix reconcile: checks not green yet');
            return;
        }
        correlatedLogger.debug({ repository: repoFullName, pullRequestNumber: pr.number, headSha }, 'Ultrafix reconcile: checks green, triggering check hook');
        await triggerUltrafixCheckRunHook({ owner, repo, prNumber: pr.number, headSha }, correlatedLogger);
    } catch (error) {
        correlatedLogger.warn({ repository: repoFullName, pullRequestNumber: pr.number, error: (error as Error).message }, 'Ultrafix CI reconciliation failed');
        if (options.throwOnError) throw error;
    }
}

async function processPullRequestComments(
    octokit: Octokit,
    pr: PullRequest,
    repoContext: RepoContext,
    config: PollingConfig
): Promise<void> {
    const { owner, repo, repoFullName, correlationId } = repoContext;
    const { GITHUB_BOT_USERNAME, PR_FOLLOWUP_TRIGGER_KEYWORDS } = config;

    const correlatedLogger = logger.withCorrelation(correlationId);

    correlatedLogger.debug({
        repository: repoFullName,
        pullRequestNumber: pr.number,
        pullRequestTitle: pr.title
    }, 'Checking PR for comments');

    const [issueComments, reviewComments] = await Promise.all([
        octokit.paginate<PRComment>('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner,
            repo,
            issue_number: pr.number,
            per_page: 100
        }),
        octokit.paginate<PRComment>('GET /repos/{owner}/{repo}/pulls/{pull_number}/comments', {
            owner,
            repo,
            pull_number: pr.number,
            per_page: 100
        })
    ]);

    const createdSince = config.createdSince ? Date.parse(config.createdSince) : Number.NaN;
    const allComments = [...issueComments, ...reviewComments]
        .filter(comment => Number.isNaN(createdSince) || Date.parse(comment.created_at) >= createdSince);
    const botUsername = GITHUB_BOT_USERNAME || 'propr-dev[bot]';
    const commentsByTime = allComments.sort((a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );

    const triggerComments = commentsByTime.filter(c => {
        if (!c.body) return false;
        if (PR_FOLLOWUP_TRIGGER_KEYWORDS.length > 0) {
            return PR_FOLLOWUP_TRIGGER_KEYWORDS.some(keyword => c.body?.includes(keyword));
        }
        return true;
    });

    correlatedLogger.debug({
        repository: repoFullName,
        pullRequestNumber: pr.number,
        issueComments: issueComments.length,
        reviewComments: reviewComments.length,
        totalComments: allComments.length,
        triggerComments: triggerComments.length
    }, `Found ${allComments.length} comments, ${triggerComments.length} potential triggers`);

    if (allComments.length > 0 && triggerComments.length === 0) {
        correlatedLogger.debug({
            repository: repoFullName,
            pullRequestNumber: pr.number,
            commentBodies: commentsByTime.map(c => ({
                id: c.id,
                author: c.user.login,
                type: c.pull_request_review_id ? 'review' : 'issue',
                bodyPreview: c.body ? c.body.substring(0, 100) + (c.body.length > 100 ? '...' : '') : 'null'
            }))
        }, 'Comment details (no trigger keywords found)');
    }

    const { unprocessedComments, selectedLlm, userId } = await collectUnprocessedComments(
        commentsByTime, pr, { owner, repo, botUsername, correlationId }, config
    );

    if (unprocessedComments.length > 0) {
        await enqueuePRCommentJob(
            { unprocessedComments, selectedLlm, userId, pr, owner, repo },
            { repoFullName, correlationId, redisClient: config.redisClient, strict: config.throwOnError }
        );
    }
}

function extractModelFromPRLabels(pr: PullRequest, modelLabelPattern: string, correlationId: string): string | null {
    if (!pr.labels || !Array.isArray(pr.labels)) return null;
    const correlatedLogger = logger.withCorrelation(correlationId);
    return extractLlmFromLabels(pr.labels, modelLabelPattern, pr.number, correlatedLogger);
}

async function prHasProcessingLabel(pr: PullRequest): Promise<boolean> {
    return hasValidTriggerLabel(pr.labels || []);
}

async function collectUnprocessedComments(
    commentsByTime: PRComment[],
    pr: PullRequest,
    commentContext: CommentContext,
    config: PollingConfig
): Promise<CollectResult> {
    const { owner, repo, botUsername, correlationId } = commentContext;
    const { redisClient, PR_FOLLOWUP_TRIGGER_KEYWORDS, MODEL_LABEL_PATTERN } = config;

    const correlatedLogger = logger.withCorrelation(correlationId);
    const unprocessedComments: UnprocessedComment[] = [];
    const recipientIds = new Set<string>();
    let everyRecipientKnown = true;

    const hasProcessingLabel = await prHasProcessingLabel(pr);
    let selectedLlm: string | null = extractModelFromPRLabels(pr, MODEL_LABEL_PATTERN, correlationId);
    const mayFollowUp = createPollingGate(pr.number, commentContext, redisClient, { strict: config.throwOnError });

    for (const comment of commentsByTime) {
        const commentAuthor = comment.user.login;
        const filterResult = filterCommentByAuthor(commentAuthor, correlationId);
        if (filterResult.shouldFilter) continue;

        // Check trigger: PR must have a processing label OR comment must contain trigger keyword
        const triggerResult = checkCommentTrigger(comment.body || '', correlationId);
        if (!hasProcessingLabel && !triggerResult.isTriggered) continue;

        const [alreadyQueued, alreadyRefused] = await Promise.all([
            redisClient.get(commentTrackingKey(owner, repo, pr.number, comment.id)),
            wasRefused(redisClient, { owner, repo, prNumber: pr.number, commentId: comment.id }),
        ]);

        if (alreadyRefused) {
            correlatedLogger.debug({ pullRequestNumber: pr.number, commentId: comment.id, commentAuthor }, 'PR comment already refused by the assignment gate, skipping');
            continue;
        }

        if (alreadyQueued) {
            correlatedLogger.debug({
                pullRequestNumber: pr.number,
                commentId: comment.id,
                commentAuthor,
                commentType: comment.pull_request_review_id ? 'review' : 'issue'
            }, 'PR comment already queued/processed, skipping');
            continue;
        }

        const commentIndex = commentsByTime.indexOf(comment);
        const subsequentComments = commentsByTime.slice(commentIndex + 1);
        const alreadyProcessed = subsequentComments.some(laterComment => {
            const isBotComment = laterComment.user.login === botUsername;
            if (!isBotComment) return false;
            return laterComment.body?.includes(`${String(comment.id)}✓`);
        });

        if (alreadyProcessed) {
            correlatedLogger.debug({
                pullRequestNumber: pr.number,
                commentId: comment.id,
                commentAuthor,
                commentType: comment.pull_request_review_id ? 'review' : 'issue'
            }, 'PR comment already processed by bot, skipping');
            continue;
        }

        if (!await mayFollowUp(comment)) continue;

        const llm = extractModelFromComment(comment.body || '', PR_FOLLOWUP_TRIGGER_KEYWORDS);
        if (llm) selectedLlm = llm;

        const enhancedCommentBody = buildEnhancedCommentBody(comment, PR_FOLLOWUP_TRIGGER_KEYWORDS);

        unprocessedComments.push({
            id: comment.id,
            body: enhancedCommentBody,
            author: commentAuthor,
            type: comment.pull_request_review_id ? 'review' : 'issue',
            hasCodeContext: !!(comment.pull_request_review_id && comment.diff_hunk)
        });
        if (Number.isSafeInteger(comment.user.id)) recipientIds.add(String(comment.user.id));
        else everyRecipientKnown = false;
    }

    const userId = everyRecipientKnown && recipientIds.size === 1
        ? recipientIds.values().next().value
        : undefined;
    return { unprocessedComments, selectedLlm, userId };
}

function extractModelFromComment(body: string, triggerKeywords: string[]): string | null {
    if (triggerKeywords.length === 0) return null;
    for (const keyword of triggerKeywords) {
        const llmMatch = body.match(new RegExp(`${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:([\\w.-]+)`));
        if (llmMatch) return resolveModelAlias(llmMatch[1]);
    }
    return null;
}

function buildEnhancedCommentBody(comment: PRComment, triggerKeywords: string[]): string {
    let enhancedCommentBody = comment.body || '';
    if (triggerKeywords.length > 0) {
        for (const keyword of triggerKeywords) {
            const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            enhancedCommentBody = enhancedCommentBody.replace(new RegExp(`${escapedKeyword}(:\\w+)?`, 'g'), '');
        }
    }
    enhancedCommentBody = enhancedCommentBody.trim();

    if (comment.pull_request_review_id) {
        const codeContext: string[] = [];
        if (comment.path) codeContext.push(`File: ${comment.path}`);
        if (comment.line) codeContext.push(`Line: ${comment.line}`);
        if (comment.diff_hunk) {
            codeContext.push('Code context:');
            codeContext.push('```diff');
            codeContext.push(comment.diff_hunk);
            codeContext.push('```');
        }

        if (codeContext.length > 0) {
            enhancedCommentBody = `${comment.body}\n\n--- Review Comment Context ---\n${codeContext.join('\n')}`;
        }
    }
    return enhancedCommentBody;
}
