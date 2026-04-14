import logger from '../utils/logger.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { isEpicBranch, EPIC_BRANCH_PATTERN } from '../services/taskExecutionService.js';
import { createEpicPRWithDraftFallback } from '../services/epicPRService.js';
import { db } from '../db/connection.js';
import { getPlanIssuesByDraft, type PlanIssue } from '../config/planIssueManager.js';
import type { PullRequestEvent } from '@octokit/webhooks-types';

interface PlanDetails {
    planName: string;
    draftId: string;
    issues: PlanIssue[];
}

interface IssueDetails {
    number: number;
    title: string;
}

/**
 * Extract the first issue ID from an epic branch name.
 * Epic branch format: {id}-epic-{word1}-{word2}-{rand}
 */
function extractFirstIssueId(epicBranchName: string): number | null {
    const match = epicBranchName.match(EPIC_BRANCH_PATTERN);
    if (match) {
        return parseInt(match[1], 10);
    }
    return null;
}

/**
 * Get plan details from database using the epic branch name.
 * Extracts the first issue ID from the branch name and finds the associated plan.
 */
async function getPlanDetailsFromBranch(
    epicBranchName: string,
    repository: string,
    log: ReturnType<typeof logger.withCorrelation>
): Promise<PlanDetails | null> {
    const firstIssueId = extractFirstIssueId(epicBranchName);
    if (!firstIssueId) {
        log.debug({ epicBranchName }, 'Could not extract issue ID from epic branch name');
        return null;
    }

    try {
        // Find the plan issue by repository and issue number
        const planIssue = await db('plan_issues')
            .where({ repository, issue_number: firstIssueId })
            .first();

        if (!planIssue) {
            log.debug({ firstIssueId, repository }, 'No plan issue found for this issue');
            return null;
        }

        // Get the plan name from task_drafts
        const draft = await db('task_drafts')
            .where({ draft_id: planIssue.draft_id })
            .select('name', 'draft_id')
            .first();

        if (!draft) {
            log.debug({ draftId: planIssue.draft_id }, 'No draft found for plan issue');
            return null;
        }

        // Get all issues in this plan
        const issues = await getPlanIssuesByDraft(draft.draft_id);

        return {
            planName: draft.name || 'Untitled Plan',
            draftId: draft.draft_id,
            issues
        };
    } catch (error) {
        log.warn({ error: (error as Error).message, epicBranchName }, 'Failed to get plan details from database');
        return null;
    }
}

/**
 * Fetch issue details from GitHub.
 */
async function fetchIssueDetails(
    owner: string,
    repo: string,
    issueNumbers: number[],
    log: ReturnType<typeof logger.withCorrelation>
): Promise<IssueDetails[]> {
    const octokit = await getAuthenticatedOctokit();
    const details: IssueDetails[] = [];

    for (const issueNumber of issueNumbers) {
        try {
            const response = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
                owner,
                repo,
                issue_number: issueNumber
            });
            details.push({
                number: issueNumber,
                title: response.data.title
            });
        } catch (error) {
            log.debug({ issueNumber, error: (error as Error).message }, 'Failed to fetch issue details');
            // Still include the issue, just without title
            details.push({ number: issueNumber, title: '' });
        }
    }

    return details;
}

/**
 * Build the Epic PR body with issue links and descriptions.
 */
function buildEpicPRBody(
    planName: string,
    issueDetails: IssueDetails[]
): string {
    const issueList = issueDetails
        .map(issue => issue.title
            ? `- #${issue.number}: ${issue.title}`
            : `- #${issue.number}`)
        .join('\n');

    const fixesLine = issueDetails
        .map(issue => `Fixes #${issue.number}`)
        .join('\n');

    return `## ${planName}

This Epic PR aggregates all changes for the plan: **${planName}**

### Issues in this Epic
${issueList}

### Auto-close
When this PR is merged, the following issues will be automatically closed:

${fixesLine}

---
*Created automatically by ProPR*`;
}

/**
 * Ensures Epic PR exists when a child PR is merged to an epic branch.
 * When the epic branch was first created, there were no commits so the PR couldn't be created.
 * Now that a child PR has merged, we can create the Epic PR with proper details.
 */
export async function handleEpicPRCreationOnMerge(
    payload: PullRequestEvent,
    _correlationId: string,
    correlatedLogger: ReturnType<typeof logger.withCorrelation>
): Promise<void> {
    // Only process closed PRs that were merged
    if (payload.action !== 'closed' || !payload.pull_request.merged) {
        return;
    }

    const baseBranch = payload.pull_request.base.ref;

    // Check if the base branch is an Epic branch (child PR merged to epic branch)
    if (!isEpicBranch(baseBranch)) {
        return;
    }

    const repository = payload.repository.full_name;
    const [owner, repo] = repository.split('/');

    correlatedLogger.info({
        prNumber: payload.pull_request.number,
        baseBranch,
        owner,
        repo
    }, 'Child PR merged to epic branch, ensuring Epic PR exists');

    try {
        const octokit = await getAuthenticatedOctokit();

        // Check if Epic PR already exists
        const existingPRs = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
            owner,
            repo,
            head: `${owner}:${baseBranch}`,
            state: 'open'
        });

        if (existingPRs.data.length > 0) {
            // Epic PR exists - update it to include any new issues
            const existingPR = existingPRs.data[0];
            correlatedLogger.debug({
                prNumber: existingPR.number,
                baseBranch
            }, 'Epic PR already exists, updating body');

            // Get plan details and update the PR body
            const planDetails = await getPlanDetailsFromBranch(baseBranch, repository, correlatedLogger);
            if (planDetails) {
                const issueNumbers = planDetails.issues.map(i => i.issue_number);
                const issueDetails = await fetchIssueDetails(owner, repo, issueNumbers, correlatedLogger);
                const newBody = buildEpicPRBody(planDetails.planName, issueDetails);

                await octokit.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', {
                    owner,
                    repo,
                    pull_number: existingPR.number,
                    body: newBody
                });

                correlatedLogger.info({
                    prNumber: existingPR.number,
                    issueCount: issueDetails.length
                }, 'Updated Epic PR body with latest issues');
            }
            return;
        }

        // Get the default branch to use as base
        const repoResponse = await octokit.request('GET /repos/{owner}/{repo}', {
            owner,
            repo
        });
        const defaultBranch = repoResponse.data.default_branch;

        // Get plan details for the Epic PR
        const planDetails = await getPlanDetailsFromBranch(baseBranch, repository, correlatedLogger);

        let title: string;
        let body: string;

        if (planDetails) {
            const issueNumbers = planDetails.issues.map(i => i.issue_number);
            const issueDetails = await fetchIssueDetails(owner, repo, issueNumbers, correlatedLogger);

            title = `[Epic] ${planDetails.planName}`;
            body = buildEpicPRBody(planDetails.planName, issueDetails);
        } else {
            // Fallback if plan details not found
            title = `[Epic] ${baseBranch}`;
            body = `## Epic PR\n\nThis PR aggregates all changes from child PRs merged to the \`${baseBranch}\` branch.\n\n---\n*Created automatically by ProPR*`;
        }

        // Create the Epic PR
        const prResponse = await createEpicPRWithDraftFallback(octokit, {
            owner,
            repo,
            title,
            head: baseBranch,
            base: defaultBranch,
            body
        });

        correlatedLogger.info({
            prNumber: prResponse.data.number,
            prUrl: prResponse.data.html_url,
            baseBranch,
            planName: planDetails?.planName
        }, 'Epic PR created after child PR merge');

    } catch (error) {
        const err = error as Error & { status?: number };
        correlatedLogger.warn({
            error: err.message,
            baseBranch,
            owner,
            repo
        }, 'Failed to create Epic PR after child merge');
    }
}

/**
 * Handles Epic PR label cleanup when an Epic PR is merged.
 * When a PR with an Epic branch name pattern is closed and merged,
 * this function automatically deletes the corresponding `base-{branchName}` label
 * from the repository.
 */
export async function handleEpicPRLabelCleanup(
    payload: PullRequestEvent,
    _correlationId: string,
    correlatedLogger: ReturnType<typeof logger.withCorrelation>
): Promise<void> {
    // Only process closed PRs that were merged
    if (payload.action !== 'closed' || !payload.pull_request.merged) {
        return;
    }

    const branchName = payload.pull_request.head.ref;

    // Check if this is an Epic branch
    if (!isEpicBranch(branchName)) {
        return;
    }

    const [owner, repo] = payload.repository.full_name.split('/');
    const labelName = `base-${branchName}`;

    correlatedLogger.info({
        prNumber: payload.pull_request.number,
        branchName,
        labelName,
        owner,
        repo
    }, 'Epic PR merged, cleaning up base label');

    try {
        const octokit = await getAuthenticatedOctokit();

        // Delete the label from the repository
        await octokit.request('DELETE /repos/{owner}/{repo}/labels/{name}', {
            owner,
            repo,
            name: labelName
        });

        correlatedLogger.info({
            labelName,
            owner,
            repo
        }, 'Epic label deleted successfully');
    } catch (error) {
        const err = error as Error & { status?: number };
        if (err.status === 404) {
            correlatedLogger.debug({
                labelName,
                owner,
                repo
            }, 'Epic label not found, may have already been deleted');
        } else {
            correlatedLogger.warn({
                error: err.message,
                labelName,
                owner,
                repo
            }, 'Failed to delete Epic label');
        }
    }
}
