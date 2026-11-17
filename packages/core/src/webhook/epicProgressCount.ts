/**
 * The one count of an epic's progress ("N of M issues merged"), shared by
 * its progress, ready and final-merge comments, its status line and its title.
 */
import { PlanIssueStatus, type PlanIssue } from '../config/planIssueManager.js';

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

/** An epic branch starts with a number too (`3589-epic-…`), which names its first issue, not the PR's. */
const EPIC_HEAD_PATTERN = /^\d+-epic-/;

/** The issue a child PR's branch was cut for (`3594/…` or `3594-…`), or null. */
export function epicChildBranchIssue(headRef: string | undefined): number | null {
    if (!headRef || EPIC_HEAD_PATTERN.test(headRef)) return null;
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
 * merge yet. Without plan issues (an epic without a plan), every
 * non-abandoned pull request into the epic branch counts once instead.
 */
export function computeEpicMergeProgress(
    childPullRequests: EpicChildPullRequest[],
    mergedChildPrNumber: number | null,
    planIssues: PlanIssue[] = [],
): EpicMergeProgress {
    const mergedNumbers = new Set(childPullRequests.filter(pr => pr.merged).map(pr => pr.number));
    if (mergedChildPrNumber !== null) mergedNumbers.add(mergedChildPrNumber);
    const mergedPullRequests = [...mergedNumbers].sort((a, b) => a - b);

    if (planIssues.length === 0) {
        const childNumbers = new Set(childPullRequests.filter(pr => !pr.abandoned).map(pr => pr.number));
        if (mergedChildPrNumber !== null) childNumbers.add(mergedChildPrNumber);
        const merged = [...childNumbers].filter(number => mergedNumbers.has(number)).length;
        return { merged, total: childNumbers.size, excluded: 0, mergedPullRequests, unit: 'pullRequests' };
    }

    // Issues with merged work in the epic branch, by their linked PR or a PR from a branch cut for them.
    const mergedIssues = new Set<number>();
    const planIssueNumbers = new Set(planIssues.map(issue => issue.issue_number));
    for (const pr of childPullRequests) {
        const issue = epicChildBranchIssue(pr.headRef);
        if (issue !== null && planIssueNumbers.has(issue) && mergedNumbers.has(pr.number)) mergedIssues.add(issue);
    }

    let merged = 0;
    let total = 0;
    let excluded = 0;
    const counted = new Set<number>();
    for (const issue of planIssues) {
        if (counted.has(issue.issue_number)) continue;
        counted.add(issue.issue_number);
        const issueMerged = issue.status === PlanIssueStatus.MERGED
            || mergedIssues.has(issue.issue_number)
            || (issue.pr_number != null && mergedNumbers.has(issue.pr_number));
        if (!issueMerged && issue.status === PlanIssueStatus.CLOSED) {
            excluded++;
            continue;
        }
        total++;
        if (issueMerged) merged++;
    }

    return { merged, total, excluded, mergedPullRequests };
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
