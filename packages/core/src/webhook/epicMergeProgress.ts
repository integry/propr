import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { getBotUsername } from '../daemon/configLoader.js';
import { PlanIssueStatus, type PlanIssue } from '../config/planIssueManager.js';
import logger from '../utils/logger.js';

export const EPIC_PROGRESS_MARKER = '<!-- propr:epic-merge-progress -->';
export const EPIC_COMPLETE_MARKER = '<!-- propr:epic-merge-complete -->';

export interface EpicChildPullRequest {
    number: number;
    merged: boolean;
    /** Closed without being merged; such PRs are not counted towards the epic. */
    abandoned: boolean;
}

export interface EpicMergeProgress {
    merged: number;
    total: number;
    /** Plan issues that were closed without a merge and are excluded from the total. */
    excluded: number;
    mergedPullRequests: number[];
}

export interface EpicMergeProgressRequest {
    owner: string;
    repo: string;
    epicBranch: string;
    epicPrNumber: number;
    /** The child PR whose merge triggered this update. */
    mergedChildPrNumber: number;
    planName?: string;
    /** Plan issues of the epic; when absent, progress is derived from child PRs alone. */
    planIssues?: PlanIssue[];
}

interface EpicProgressOctokit {
    request: (route: string, parameters: Record<string, unknown>) => Promise<{ data: unknown }>;
    paginate?: (route: string, parameters: Record<string, unknown>) => Promise<unknown[]>;
}

export interface EpicMergeProgressDependencies {
    getOctokit?: () => Promise<EpicProgressOctokit>;
}

export interface EpicMergeProgressResult {
    progress: EpicMergeProgress;
    trackingComment: 'created' | 'updated' | 'unchanged';
    completionPosted: boolean;
}

/**
 * Counts merged children of an epic. Plan issues define the expected total
 * when available; otherwise every non-abandoned child PR targeting the epic
 * branch counts. The triggering PR is always merged, even if GitHub's list
 * has not caught up with the merge yet.
 */
export function computeEpicMergeProgress(
    childPullRequests: EpicChildPullRequest[],
    mergedChildPrNumber: number,
    planIssues?: PlanIssue[],
): EpicMergeProgress {
    const mergedNumbers = new Set(childPullRequests.filter(pr => pr.merged).map(pr => pr.number));
    mergedNumbers.add(mergedChildPrNumber);

    if (planIssues && planIssues.length > 0) {
        const isMerged = (issue: PlanIssue) => issue.status === PlanIssueStatus.MERGED
            || (issue.pr_number != null && mergedNumbers.has(issue.pr_number));
        const counted = planIssues.filter(issue => isMerged(issue) || issue.status !== PlanIssueStatus.CLOSED);
        return {
            merged: counted.filter(isMerged).length,
            total: counted.length,
            excluded: planIssues.length - counted.length,
            mergedPullRequests: [...mergedNumbers].sort((a, b) => a - b),
        };
    }

    const countedNumbers = new Set(childPullRequests.filter(pr => !pr.abandoned).map(pr => pr.number));
    countedNumbers.add(mergedChildPrNumber);
    return {
        merged: mergedNumbers.size,
        total: countedNumbers.size,
        excluded: 0,
        mergedPullRequests: [...mergedNumbers].sort((a, b) => a - b),
    };
}

export function isEpicMergeComplete(progress: EpicMergeProgress): boolean {
    return progress.total > 0 && progress.merged >= progress.total;
}

function renderProgressBar(merged: number, total: number, width = 10): string {
    const filled = total > 0 ? Math.min(width, Math.round((merged / total) * width)) : 0;
    return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

export function buildEpicProgressComment(progress: EpicMergeProgress, planName?: string): string {
    const complete = isEpicMergeComplete(progress);
    const percent = progress.total > 0 ? Math.round((progress.merged / progress.total) * 100) : 0;
    const lines = [
        `### Epic progress${planName ? `: ${planName}` : ''}`,
        '',
        `**${progress.merged} of ${progress.total} PRs merged** ${complete ? '✅' : '⏳'}`,
        '',
        `\`${renderProgressBar(progress.merged, progress.total)}\` ${percent}%`,
    ];
    if (progress.mergedPullRequests.length > 0) {
        lines.push('', `Merged child PRs: ${progress.mergedPullRequests.map(n => `#${n}`).join(', ')}`);
    }
    if (progress.excluded > 0) {
        lines.push('', `_${progress.excluded} planned issue${progress.excluded === 1 ? ' was' : 's were'} closed without a merge and ${progress.excluded === 1 ? 'is' : 'are'} not counted._`);
    }
    lines.push('', '---', '*This comment is updated automatically by ProPR as child PRs merge.*', EPIC_PROGRESS_MARKER);
    return lines.join('\n');
}

export function buildEpicCompleteComment(progress: EpicMergeProgress, planName?: string): string {
    return [
        `### ✅ Epic fully merged${planName ? `: ${planName}` : ''}`,
        '',
        `All ${progress.total} child PR${progress.total === 1 ? ' has' : 's have'} been merged into this epic branch. This epic PR is ready for final review and merge.`,
        '',
        '---',
        '*Posted automatically by ProPR*',
        EPIC_COMPLETE_MARKER,
    ].join('\n');
}

interface IssueComment {
    id: number;
    body: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

async function listBotComments(octokit: EpicProgressOctokit, owner: string, repo: string, issueNumber: number): Promise<IssueComment[]> {
    const parameters = { owner, repo, issue_number: issueNumber, per_page: 100 };
    const data = octokit.paginate
        ? await octokit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', parameters)
        : (await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', parameters)).data;
    const botUsernames = new Set([getBotUsername(), process.env.GITHUB_BOT_USERNAME, 'propr-dev[bot]'].filter(Boolean));
    return (Array.isArray(data) ? data : []).flatMap(comment => {
        if (!isRecord(comment) || typeof comment.id !== 'number' || typeof comment.body !== 'string') return [];
        const login = isRecord(comment.user) && typeof comment.user.login === 'string' ? comment.user.login : '';
        return botUsernames.has(login) ? [{ id: comment.id, body: comment.body }] : [];
    });
}

async function listChildPullRequests(octokit: EpicProgressOctokit, owner: string, repo: string, epicBranch: string): Promise<EpicChildPullRequest[]> {
    const parameters = { owner, repo, base: epicBranch, state: 'all', per_page: 100 };
    const data = octokit.paginate
        ? await octokit.paginate('GET /repos/{owner}/{repo}/pulls', parameters)
        : (await octokit.request('GET /repos/{owner}/{repo}/pulls', parameters)).data;
    return (Array.isArray(data) ? data : []).flatMap(pr => {
        if (!isRecord(pr) || typeof pr.number !== 'number') return [];
        const merged = typeof pr.merged_at === 'string' && pr.merged_at.length > 0;
        return [{ number: pr.number, merged, abandoned: pr.state === 'closed' && !merged }];
    });
}

/**
 * Keeps a single "x of y PRs merged" tracking comment on the epic PR up to
 * date, and posts a one-time confirmation comment once every child PR has
 * merged. Both comments are located by their hidden markers, so webhook
 * redeliveries edit in place instead of posting duplicates.
 */
export async function updateEpicMergeProgress(
    request: EpicMergeProgressRequest,
    correlationId: string,
    dependencies: EpicMergeProgressDependencies = {},
): Promise<EpicMergeProgressResult> {
    const log = logger.withCorrelation(correlationId);
    const getOctokit = dependencies.getOctokit
        ?? (async () => await getAuthenticatedOctokit() as unknown as EpicProgressOctokit);
    const octokit = await getOctokit();
    const { owner, repo, epicPrNumber } = request;

    const children = await listChildPullRequests(octokit, owner, repo, request.epicBranch);
    const progress = computeEpicMergeProgress(children, request.mergedChildPrNumber, request.planIssues);
    const comments = await listBotComments(octokit, owner, repo, epicPrNumber);

    const body = buildEpicProgressComment(progress, request.planName);
    const existing = comments.find(comment => comment.body.includes(EPIC_PROGRESS_MARKER));
    let trackingComment: EpicMergeProgressResult['trackingComment'];
    if (!existing) {
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner, repo, issue_number: epicPrNumber, body,
        });
        trackingComment = 'created';
    } else if (existing.body !== body) {
        await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
            owner, repo, comment_id: existing.id, body,
        });
        trackingComment = 'updated';
    } else {
        trackingComment = 'unchanged';
    }

    let completionPosted = false;
    if (isEpicMergeComplete(progress) && !comments.some(comment => comment.body.includes(EPIC_COMPLETE_MARKER))) {
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner, repo, issue_number: epicPrNumber, body: buildEpicCompleteComment(progress, request.planName),
        });
        completionPosted = true;
    }

    log.info({
        owner, repo, epicPrNumber,
        merged: progress.merged, total: progress.total,
        trackingComment, completionPosted,
    }, 'Updated epic merge progress');
    return { progress, trackingComment, completionPosted };
}
