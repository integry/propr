/** The epic PR body: its plan's issues and the `Fixes` lines that close them. */
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { PlanIssueStatus, type PlanIssue } from '../config/planIssueManager.js';
import type logger from '../utils/logger.js';
import type { EpicProgressOctokit } from './epicMergeEvidence.js';
import { listChildPullRequests, withTriggeringChildEvidence } from './epicMergeProgress.js';
import { epicIssuesWithMergedWork } from './epicProgressCount.js';

export interface IssueDetails {
    number: number;
    title: string;
    /** GitHub closed the issue as not planned (or as a duplicate): it is no longer part of the epic. */
    notPlanned?: boolean;
}

/**
 * Fetch issue details from GitHub.
 */
export async function fetchIssueDetails(
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
            const data = response.data as { title: string; state?: string; state_reason?: string | null };
            const notPlanned = data.state === 'closed' && (data.state_reason === 'not_planned' || data.state_reason === 'duplicate');
            details.push({
                number: issueNumber, title: data.title, ...(notPlanned ? { notPlanned } : {})
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
 * The plan issues an epic body lists and closes: those still counted towards
 * the epic (computeEpicMergeProgress). An issue closed without a merge, or
 * closed on GitHub as not planned, is left out of both the list and its
 * `Fixes` line. `mergedIssues` (epicIssuesWithMergedWork) keeps a closed
 * issue whose work did merge, e.g. through an alternate PR after its linked
 * PR was abandoned.
 */
export function epicBodyIssueNumbers(issues: PlanIssue[], mergedIssues: ReadonlySet<number> = new Set()): number[] {
    return issues
        .filter(issue => issue.status !== PlanIssueStatus.CLOSED || mergedIssues.has(issue.issue_number))
        .map(issue => issue.issue_number);
}

/**
 * epicBodyIssueNumbers with the merged work read from the pull requests into
 * the epic branch, including the triggering PR's own evidence when the list
 * lags its merge (withTriggeringChildEvidence). They are only listed when a
 * plan issue is closed, the only case they decide.
 */
export async function loadEpicBodyIssueNumbers(
    octokit: EpicProgressOctokit,
    { owner, repo, baseBranch, mergedChildPrNumber }: { owner: string; repo: string; baseBranch: string; mergedChildPrNumber: number | null },
    issues: PlanIssue[],
): Promise<number[]> {
    if (!issues.some(issue => issue.status === PlanIssueStatus.CLOSED)) return epicBodyIssueNumbers(issues);
    // GitHub's list may not include the triggering PR yet; read its branch so an alternate PR still keeps its issue.
    const listed = await listChildPullRequests(octokit, owner, repo, baseBranch);
    const children = await withTriggeringChildEvidence(octokit, { owner, repo, epicBranch: baseBranch, mergedChildPrNumber }, listed);
    return epicBodyIssueNumbers(issues, epicIssuesWithMergedWork(children, mergedChildPrNumber, issues));
}

/**
 * Build the Epic PR body with issue links and descriptions.
 */
export function buildEpicPRBody(
    planName: string,
    allIssueDetails: IssueDetails[]
): string {
    const issueDetails = allIssueDetails.filter(issue => !issue.notPlanned);
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
