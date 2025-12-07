import { logger } from '@gitfix/core';
import { generateCorrelationId } from '@gitfix/core';
import { handleError } from '@gitfix/core';
import { issueQueue, COMMENT_BATCH_DELAY_MS } from '@gitfix/core';
import { filterCommentByAuthor, checkCommentTrigger } from '@gitfix/core';
import { resolveModelAlias } from '@gitfix/core';
export async function pollForPullRequestComments(octokit, repoFullName, correlationId, config) {
    const correlatedLogger = logger.withCorrelation(correlationId);
    const [owner, repo] = repoFullName.split('/');
    correlatedLogger.debug({
        repository: repoFullName
    }, 'Checking for PR comments in repository');
    try {
        const prs = await octokit.paginate('GET /repos/{owner}/{repo}/pulls', {
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
        for (const pr of prs) {
            await processPullRequestComments(octokit, pr, { owner, repo, repoFullName, correlationId }, config);
        }
    }
    catch (error) {
        handleError(error, `Error polling PR comments for repository ${repoFullName}`, { correlationId });
    }
}
async function processPullRequestComments(octokit, pr, repoContext, config) {
    const { owner, repo, repoFullName, correlationId } = repoContext;
    const { GITHUB_BOT_USERNAME, PR_FOLLOWUP_TRIGGER_KEYWORDS } = config;
    const correlatedLogger = logger.withCorrelation(correlationId);
    correlatedLogger.debug({
        repository: repoFullName,
        pullRequestNumber: pr.number,
        pullRequestTitle: pr.title
    }, 'Checking PR for comments');
    const [issueComments, reviewComments] = await Promise.all([
        octokit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner,
            repo,
            issue_number: pr.number,
            per_page: 100
        }),
        octokit.paginate('GET /repos/{owner}/{repo}/pulls/{pull_number}/comments', {
            owner,
            repo,
            pull_number: pr.number,
            per_page: 100
        })
    ]);
    const allComments = [...issueComments, ...reviewComments];
    const botUsername = GITHUB_BOT_USERNAME || 'gitfixio[bot]';
    const commentsByTime = allComments.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    const triggerComments = commentsByTime.filter(c => {
        if (!c.body)
            return false;
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
    const { unprocessedComments, selectedLlm } = await collectUnprocessedComments(commentsByTime, pr, { owner, repo, botUsername, correlationId }, config);
    if (unprocessedComments.length > 0) {
        await enqueuePRCommentJob({ unprocessedComments, selectedLlm, pr, owner, repo }, { repoFullName, correlationId, redisClient: config.redisClient });
    }
}
async function collectUnprocessedComments(commentsByTime, pr, commentContext, config) {
    const { owner, repo, botUsername, correlationId } = commentContext;
    const { redisClient, PR_FOLLOWUP_TRIGGER_KEYWORDS, MODEL_LABEL_PATTERN } = config;
    const correlatedLogger = logger.withCorrelation(correlationId);
    const unprocessedComments = [];
    let selectedLlm = null;
    if (pr.labels && Array.isArray(pr.labels)) {
        const modelLabelRegex = new RegExp(MODEL_LABEL_PATTERN);
        for (const label of pr.labels) {
            const labelName = typeof label === 'string' ? label : label.name;
            const match = labelName.match(modelLabelRegex);
            if (match) {
                selectedLlm = resolveModelAlias(match[1]);
                correlatedLogger.debug({
                    pullRequestNumber: pr.number,
                    label: labelName,
                    resolvedModel: selectedLlm
                }, 'Extracted model from PR label');
                break;
            }
        }
    }
    for (const comment of commentsByTime) {
        const commentAuthor = comment.user.login;
        const filterResult = filterCommentByAuthor(commentAuthor, correlationId);
        if (filterResult.shouldFilter)
            continue;
        const triggerResult = checkCommentTrigger(comment.body || '', correlationId);
        if (!triggerResult.isTriggered)
            continue;
        const commentTrackingKey = `pr-comment-processed:${owner}:${repo}:${pr.number}:${comment.id}`;
        const alreadyQueued = await redisClient.get(commentTrackingKey);
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
            if (!isBotComment)
                return false;
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
        const llm = extractModelFromComment(comment.body || '', PR_FOLLOWUP_TRIGGER_KEYWORDS);
        if (llm)
            selectedLlm = llm;
        const enhancedCommentBody = buildEnhancedCommentBody(comment, PR_FOLLOWUP_TRIGGER_KEYWORDS);
        unprocessedComments.push({
            id: comment.id,
            body: enhancedCommentBody,
            author: commentAuthor,
            type: comment.pull_request_review_id ? 'review' : 'issue',
            hasCodeContext: !!(comment.pull_request_review_id && comment.diff_hunk)
        });
    }
    return { unprocessedComments, selectedLlm };
}
function extractModelFromComment(body, triggerKeywords) {
    if (triggerKeywords.length === 0)
        return null;
    for (const keyword of triggerKeywords) {
        const llmMatch = body.match(new RegExp(`${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:([\\w.-]+)`));
        if (llmMatch)
            return resolveModelAlias(llmMatch[1]);
    }
    return null;
}
function buildEnhancedCommentBody(comment, triggerKeywords) {
    let enhancedCommentBody = comment.body || '';
    if (triggerKeywords.length > 0) {
        for (const keyword of triggerKeywords) {
            const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            enhancedCommentBody = enhancedCommentBody.replace(new RegExp(`${escapedKeyword}(:\\w+)?`, 'g'), '');
        }
    }
    enhancedCommentBody = enhancedCommentBody.trim();
    if (comment.pull_request_review_id) {
        const codeContext = [];
        if (comment.path)
            codeContext.push(`File: ${comment.path}`);
        if (comment.line)
            codeContext.push(`Line: ${comment.line}`);
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
async function enqueuePRCommentJob(jobDetails, options) {
    const { unprocessedComments, selectedLlm, pr, owner, repo } = jobDetails;
    const { repoFullName, correlationId, redisClient } = options;
    const correlatedLogger = logger.withCorrelation(correlationId);
    const activeJobs = await issueQueue.getActive();
    const waitingJobs = await issueQueue.getWaiting();
    const delayedJobs = await issueQueue.getDelayed();
    const existingJobs = [...activeJobs, ...waitingJobs, ...delayedJobs];
    const jobExists = existingJobs.some(job => job.name === 'processPullRequestComment' &&
        job.data.pullRequestNumber === pr.number &&
        job.data.repoOwner === owner &&
        job.data.repoName === repo);
    if (jobExists) {
        correlatedLogger.info({
            pullRequestNumber: pr.number,
            repository: repoFullName
        }, 'A job for this PR is already active, waiting, or delayed, skipping new job creation.');
        return;
    }
    const jobData = {
        pullRequestNumber: pr.number,
        comments: unprocessedComments,
        repoOwner: owner,
        repoName: repo,
        branchName: pr.head.ref,
        llm: selectedLlm,
        correlationId: generateCorrelationId(),
    };
    const timestamp = Date.now();
    const jobId = `pr-comments-batch-${owner}-${repo}-${pr.number}-${timestamp}`;
    try {
        await issueQueue.add('processPullRequestComment', jobData, {
            jobId,
            delay: COMMENT_BATCH_DELAY_MS
        });
        const pipeline = redisClient.pipeline();
        for (const comment of unprocessedComments) {
            const trackingKey = `pr-comment-processed:${owner}:${repo}:${pr.number}:${comment.id}`;
            pipeline.setex(trackingKey, 86400, Date.now().toString());
        }
        await pipeline.exec();
        correlatedLogger.info({
            jobId,
            pullRequestNumber: pr.number,
            commentsCount: unprocessedComments.length,
            commentIds: unprocessedComments.map(c => c.id),
            commentTypes: unprocessedComments.map(c => c.type),
            delayMs: COMMENT_BATCH_DELAY_MS
        }, `Successfully added batch PR comments job (${unprocessedComments.length} comments)`);
    }
    catch (error) {
        const err = error;
        if (err.message?.includes('Job already exists')) {
            correlatedLogger.debug({
                pullRequestNumber: pr.number,
                commentsCount: unprocessedComments.length,
            }, 'PR comments batch job already in queue, skipping');
        }
        else {
            handleError(error, `Failed to add PR comments batch to queue`, { correlationId });
        }
    }
}
