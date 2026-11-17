/**
 * The one count of an epic's progress ("N of M issues merged"), shared by
 * its progress, ready and final-merge comments, its status line and its title.
 */
import { PlanIssueStatus, type PlanIssue } from '../config/planIssueManager.js';
import { EPIC_BRANCH_PATTERN } from '../services/epicPRService.js';

export interface EpicChildPullRequest {
    number: number;
    merged: boolean;
    mergedAt?: string;
    /** Resolves a merge that shares its second with an epic boundary. */
    mergeCommitSha?: string | null;
    /** Closed without being merged; such PRs are not counted towards the epic. */
    abandoned: boolean;
    /** Still open: in progress towards the epic. */
    open?: boolean;
    title?: string;
    /** The branch the child PR comes from. */
    headRef?: string;
    /** Open child PRs: the head commit and GitHub's last update, which any status write to the child changes. */
    headSha?: string; updatedAt?: string;
}

export interface EpicMergeProgress {
    merged: number;
    total: number;
    /** Plan issues that were closed without a merge and are excluded from the total. */
    excluded: number;
    mergedPullRequests: number[];
    /**
     * What `merged` and `total` count: the epic's plan issues, or, for an
     * epic without a plan, the pull requests into its branch. Absent: issues.
     */
    unit?: 'pullRequests';
}

/**
 * The issue a child PR's branch was cut for (`3594/…` or `3594-…`), or null.
 * An epic branch (`3589-epic-short-name-x7y`) starts with a number too, which
 * names its first issue, not the PR's; an issue branch that merely starts
 * with `3589-epic-…` is still that issue's.
 */
export function epicChildBranchIssue(headRef: string | undefined): number | null {
    if (!headRef || EPIC_BRANCH_PATTERN.test(headRef)) return null;
    const issue = Number(headRef.match(/^(\d+)[/-]/)?.[1]);
    return Number.isSafeInteger(issue) && issue > 0 ? issue : null;
}

/**
 * Counts an epic's progress: "N of M issues merged". With plan issues, M is
 * the plan issues not closed without a merge, and N those of them whose work
 * is merged into the epic branch: the issue is recorded as merged, or a pull
 * request for it (its linked PR, or one from a branch cut for the issue) is
 * merged. A pull request into the epic branch without a plan issue (a human
 * PR) changes neither, and two PRs for one issue count once. The triggering
 * PR is always merged, even if GitHub's list has not caught up with the
 * merge yet. Only an epic without a plan (`planIssues` absent) counts
 * every non-abandoned pull request into the epic branch once instead; a
 * plan whose issues were all filtered out (e.g. shipped by a predecessor
 * epic) still counts issues, so it reads 0 of 0 rather than its human PRs.
 */
export function computeEpicMergeProgress(
    childPullRequests: EpicChildPullRequest[],
    mergedChildPrNumber: number | null,
    planIssues?: PlanIssue[],
): EpicMergeProgress {
    const mergedNumbers = mergedChildNumbers(childPullRequests, mergedChildPrNumber);
    const mergedPullRequests = [...mergedNumbers].sort((a, b) => a - b);

    if (!planIssues) {
        const childNumbers = new Set(childPullRequests.filter(pr => !pr.abandoned).map(pr => pr.number));
        if (mergedChildPrNumber !== null) childNumbers.add(mergedChildPrNumber);
        const merged = [...childNumbers].filter(number => mergedNumbers.has(number)).length;
        return { merged, total: childNumbers.size, excluded: 0, mergedPullRequests, unit: 'pullRequests' };
    }

    const mergedIssues = epicIssuesWithMergedWork(childPullRequests, mergedChildPrNumber, planIssues);

    let merged = 0;
    let total = 0;
    let excluded = 0;
    const counted = new Set<number>();
    for (const issue of planIssues) {
        if (counted.has(issue.issue_number)) continue;
        counted.add(issue.issue_number);
        const issueMerged = mergedIssues.has(issue.issue_number);
        if (!issueMerged && issue.status === PlanIssueStatus.CLOSED) {
            excluded++;
            continue;
        }
        total++;
        if (issueMerged) merged++;
    }

    return { merged, total, excluded, mergedPullRequests };
}

function mergedChildNumbers(childPullRequests: EpicChildPullRequest[], mergedChildPrNumber: number | null): Set<number> {
    const mergedNumbers = new Set(childPullRequests.filter(pr => pr.merged).map(pr => pr.number));
    if (mergedChildPrNumber !== null) mergedNumbers.add(mergedChildPrNumber);
    return mergedNumbers;
}

/**
 * The plan issues whose work is merged into the epic branch: the issue is
 * recorded as merged, its linked PR merged, or a PR from a branch cut for it
 * merged (the triggering PR always counts as merged). An issue in this set
 * stays part of the epic even when its status is closed, e.g. after its
 * linked PR was abandoned and an alternate PR merged.
 */
export function epicIssuesWithMergedWork(
    childPullRequests: EpicChildPullRequest[],
    mergedChildPrNumber: number | null,
    planIssues: PlanIssue[],
): Set<number> {
    const mergedNumbers = mergedChildNumbers(childPullRequests, mergedChildPrNumber);
    const planIssueNumbers = new Set(planIssues.map(issue => issue.issue_number));
    const mergedIssues = new Set<number>();
    for (const pr of childPullRequests) {
        const issue = epicChildBranchIssue(pr.headRef);
        if (issue !== null && planIssueNumbers.has(issue) && mergedNumbers.has(pr.number)) mergedIssues.add(issue);
    }
    for (const issue of planIssues) {
        if (issue.status === PlanIssueStatus.MERGED || (issue.pr_number != null && mergedNumbers.has(issue.pr_number))) {
            mergedIssues.add(issue.issue_number);
        }
    }
    return mergedIssues;
}

/**
 * The plan issues whose work already shipped through a predecessor epic PR:
 * a pull request in `shipped` is the issue's linked PR, or comes from a
 * branch cut for the issue, by the same attribution epicIssuesWithMergedWork
 * uses. Such an issue no longer counts towards a successor epic, even when its
 * linked PR is still open and an alternate PR is the one that shipped.
 */
export function epicIssuesShippedBefore(
    childPullRequests: EpicChildPullRequest[],
    shipped: ReadonlySet<number>,
    planIssues: PlanIssue[],
): Set<number> {
    const planIssueNumbers = new Set(planIssues.map(issue => issue.issue_number));
    const shippedIssues = new Set<number>();
    for (const pr of childPullRequests) {
        if (!shipped.has(pr.number)) continue;
        const issue = epicChildBranchIssue(pr.headRef);
        if (issue !== null && planIssueNumbers.has(issue)) shippedIssues.add(issue);
    }
    for (const issue of planIssues) {
        if (issue.pr_number != null && shipped.has(issue.pr_number)) shippedIssues.add(issue.issue_number);
    }
    return shippedIssues;
}

export function isEpicMergeComplete(progress: EpicMergeProgress): boolean {
    return progress.total > 0 && progress.merged >= progress.total;
}

/** `N of M issues merged` (or `pull requests` for an epic without a plan): the count every epic writer shows. */
export function epicProgressCountText(progress: Pick<EpicMergeProgress, 'merged' | 'total' | 'unit'>): string {
    return `${progress.merged} of ${progress.total} ${progressNoun(progress, progress.total)} merged`;
}

export function progressNoun(progress: Pick<EpicMergeProgress, 'unit'>, count: number): string {
    const noun = progress.unit === 'pullRequests' ? 'pull request' : 'issue';
    return count === 1 ? noun : `${noun}s`;
}
