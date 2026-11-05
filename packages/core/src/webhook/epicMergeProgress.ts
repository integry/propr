import { getBotUsername } from '../daemon/configLoader.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { PlanIssueStatus, type PlanIssue } from '../config/planIssueManager.js';
import logger from '../utils/logger.js';
import { epicHeadSha, isMergeContained, isRecord, type EpicProgressOctokit } from './epicMergeEvidence.js';

export const EPIC_PROGRESS_MARKER = '<!-- propr:epic-merge-progress -->';
export const EPIC_FINAL_MERGE_MARKER = '<!-- propr:epic-final-merge -->';
export const EPIC_COMPLETE_MARKER = '<!-- propr:epic-merge-complete -->';

export interface EpicChildPullRequest {
    number: number;
    merged: boolean;
    mergedAt?: string;
    /** Resolves a merge that shares its second with an epic boundary. */
    mergeCommitSha?: string | null;
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
    /** The child PR whose merge triggered this update; null for the epic PR merge. */
    mergedChildPrNumber: number | null;
    planName?: string;
    /** Plan issues of the epic; planned work without a child PR yet counts as unmerged. */
    planIssues?: PlanIssue[];
}

export interface EpicMergeProgressDependencies {
    getOctokit?: () => Promise<EpicProgressOctokit>;
    /**
     * Confirms the caller still holds the epic's update lease; throws if not.
     * Runs after the reads and before each comment write.
     */
    assertOwned?: () => Promise<void>;
}

export interface EpicMergeProgressResult {
    progress: EpicMergeProgress;
    /** 'skipped': nothing to track yet (no children or planned issues), so no comment was posted. */
    trackingComment: 'created' | 'updated' | 'unchanged' | 'skipped';
    completionPosted: boolean;
}

/**
 * Counts merged children of an epic. Every non-abandoned child PR targeting
 * the epic branch counts once; plan issues add a placeholder for planned work
 * that has no such PR yet, so the total covers both unstarted plan issues and
 * child PRs outside the plan. The triggering PR is always merged, even if
 * GitHub's list has not caught up with the merge yet.
 */
export function computeEpicMergeProgress(
    childPullRequests: EpicChildPullRequest[],
    mergedChildPrNumber: number | null,
    planIssues: PlanIssue[] = [],
): EpicMergeProgress {
    const mergedNumbers = new Set(childPullRequests.filter(pr => pr.merged).map(pr => pr.number));
    if (mergedChildPrNumber !== null) mergedNumbers.add(mergedChildPrNumber);
    const childNumbers = new Set(childPullRequests.filter(pr => !pr.abandoned).map(pr => pr.number));
    if (mergedChildPrNumber !== null) childNumbers.add(mergedChildPrNumber);

    let merged = [...childNumbers].filter(number => mergedNumbers.has(number)).length;
    let total = childNumbers.size;
    let excluded = 0;
    const placeholderPrNumbers = new Set<number>();
    for (const issue of planIssues) {
        if (issue.pr_number != null && (childNumbers.has(issue.pr_number) || placeholderPrNumbers.has(issue.pr_number))) continue;
        const issueMerged = issue.status === PlanIssueStatus.MERGED;
        if (!issueMerged && issue.status === PlanIssueStatus.CLOSED) {
            excluded++;
            continue;
        }
        if (issue.pr_number != null) placeholderPrNumbers.add(issue.pr_number);
        total++;
        if (issueMerged) merged++;
    }

    return {
        merged,
        total,
        excluded,
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

/** `mergedInto` names the branch the epic PR has merged into, once it has. */
export function buildEpicProgressComment(progress: EpicMergeProgress, planName?: string, mergedInto?: string): string {
    const complete = isEpicMergeComplete(progress);
    const percent = progress.total > 0 ? Math.round((progress.merged / progress.total) * 100) : 0;
    const lines = [
        `### Epic progress${planName ? `: ${planName}` : ''}`,
        '',
        `**${progress.merged} out of ${progress.total} PRs merged** ${complete ? '✅' : '⏳'}`,
        '',
        `\`${renderProgressBar(progress.merged, progress.total)}\` ${percent}%`,
    ];
    if (progress.mergedPullRequests.length > 0) {
        lines.push('', `Merged child PRs: ${progress.mergedPullRequests.map(n => `#${n}`).join(', ')}`);
    }
    if (progress.excluded > 0) {
        lines.push('', `_${progress.excluded} planned issue${progress.excluded === 1 ? ' was' : 's were'} closed without a merge and ${progress.excluded === 1 ? 'is' : 'are'} not counted._`);
    }
    if (mergedInto) lines.push('', `✅ This epic PR has been merged into ${mergedInto}.`);
    lines.push('', '---', '*This comment is updated automatically by ProPR as child PRs merge.*', EPIC_PROGRESS_MARKER);
    return lines.join('\n');
}

export function buildEpicCompleteComment(progress: EpicMergeProgress, planName?: string): string {
    return [
        `### ✅ Epic ready for final merge${planName ? `: ${planName}` : ''}`,
        '',
        `All ${progress.total} child PR${progress.total === 1 ? ' has' : 's have'} been merged into this epic branch. This epic PR is ready for final review and merge.`,
        '',
        '---',
        '*Posted automatically by ProPR*',
        EPIC_COMPLETE_MARKER,
    ].join('\n');
}

export function buildEpicFinalMergeComment(
    progress: EpicMergeProgress,
    { epicPrNumber, baseBranch, planName }: { epicPrNumber: number; baseBranch: string; planName?: string },
): string {
    return [
        `### ✅ Epic merged${planName ? `: ${planName}` : ''}`,
        '',
        `Epic PR #${epicPrNumber} has been merged into ${baseBranch}.`,
        '',
        progress.total === 0
            ? 'No child PRs or planned issues were tracked for this epic.'
            : `**${progress.merged} out of ${progress.total} PRs merged** into ${baseBranch} through this epic PR.`,
        ...(isEpicMergeComplete(progress) ? ['', 'All planned epic work is now merged.'] : []),
        '', '*Posted automatically by ProPR*', EPIC_FINAL_MERGE_MARKER,
    ].join('\n');
}

interface IssueComment {
    id: number;
    body: string;
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
        return [{
            number: pr.number, merged, mergedAt: merged ? pr.merged_at as string : undefined,
            mergeCommitSha: typeof pr.merge_commit_sha === 'string' ? pr.merge_commit_sha : null,
            abandoned: pr.state === 'closed' && !merged,
        }];
    });
}

interface MergeBoundary {
    mergedAt: number;
    /** The epic PR's pre-merge head; same-second children are settled against it. */
    headSha: string | null;
}

/**
 * Children merged before the boundary, or in its second and proven contained
 * in the epic's pre-merge head. An unresolved same-second child throws.
 */
async function childrenWithin(
    octokit: EpicProgressOctokit,
    request: EpicMergeProgressRequest,
    children: EpicChildPullRequest[],
    boundary: MergeBoundary,
): Promise<Set<number>> {
    const within = new Set<number>();
    for (const pr of children) {
        if (!pr.mergedAt) continue;
        const time = Date.parse(pr.mergedAt);
        if (time < boundary.mergedAt
            || (time === boundary.mergedAt && await isMergeContained(octokit, request, pr.mergeCommitSha, boundary.headSha))) {
            within.add(pr.number);
        }
    }
    return within;
}

/** Only confirmed earlier merges establish work shipped by a predecessor. */
async function listShippedChildren(
    octokit: EpicProgressOctokit,
    request: EpicMergeProgressRequest,
    children: EpicChildPullRequest[],
    { baseBranch, mergedAt, epicMerged }: { baseBranch?: string; mergedAt: number; epicMerged: boolean },
): Promise<Set<number>> {
    if (!baseBranch) return new Set<number>();
    const { owner, repo, epicBranch, epicPrNumber } = request;
    const parameters = { owner, repo, head: `${owner}:${epicBranch}`, base: baseBranch, state: 'closed', per_page: 100 };
    const data = octokit.paginate
        ? await octokit.paginate('GET /repos/{owner}/{repo}/pulls', parameters)
        : (await octokit.request('GET /repos/{owner}/{repo}/pulls', parameters)).data;
    // The latest predecessor merge is the cutoff; everything it carried has shipped.
    let cutoff: MergeBoundary = { mergedAt: -Infinity, headSha: null };
    for (const pr of Array.isArray(data) ? data : []) {
        if (!isRecord(pr) || typeof pr.number !== 'number' || pr.number >= epicPrNumber || typeof pr.merged_at !== 'string') continue;
        const time = Date.parse(pr.merged_at);
        if (!Number.isFinite(time) || time >= (epicMerged ? mergedAt : Infinity) || time <= cutoff.mergedAt) continue;
        cutoff = { mergedAt: time, headSha: epicHeadSha(pr) };
    }
    return await childrenWithin(octokit, request, children, cutoff);
}

async function readEpicMergeState(octokit: EpicProgressOctokit, request: EpicMergeProgressRequest) {
    const { owner, repo, epicPrNumber } = request;
    const comments = await listBotComments(octokit, owner, repo, epicPrNumber);
    const finalComment = comments.find(comment => comment.body.includes(EPIC_FINAL_MERGE_MARKER));
    // A confirmation proves the merge happened, but cannot establish which
    // children it included. Always read the immutable aggregate merge time.
    const epic = (await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner, repo, pull_number: epicPrNumber,
    })).data;
    const epicMerged = !!finalComment || request.mergedChildPrNumber === null || (isRecord(epic) && epic.merged === true);
    const baseBranch = isRecord(epic) && isRecord(epic.base) && typeof epic.base.ref === 'string'
        ? epic.base.ref : undefined;
    const mergedAt = isRecord(epic) && typeof epic.merged_at === 'string' ? Date.parse(epic.merged_at) : NaN;
    const headSha = isRecord(epic) ? epicHeadSha(epic) : null;
    if (epicMerged && !Number.isFinite(mergedAt)) throw new Error('Epic merge boundary unavailable');
    if (epicMerged && request.mergedChildPrNumber !== null) {
        const repository = (await octokit.request('GET /repos/{owner}/{repo}', { owner, repo })).data;
        if (!baseBranch || !isRecord(repository) || baseBranch !== repository.default_branch) {
            throw new Error('Merged epic does not target the default branch');
        }
    }
    return { comments, epicMerged, baseBranch, mergedAt, headSha };
}

/** PRs whose merge the list has not confirmed but that must be merged for a correct report. */
function listUnconfirmedChildren(request: EpicMergeProgressRequest, children: EpicChildPullRequest[], epicMerged: boolean): Set<number> {
    const listedMerged = (number: number) => children.some(pr => pr.number === number && pr.merged);
    const unconfirmed = new Set<number>();
    if (request.mergedChildPrNumber !== null && !listedMerged(request.mergedChildPrNumber)) unconfirmed.add(request.mergedChildPrNumber);
    if (!epicMerged) return unconfirmed;
    for (const issue of request.planIssues ?? []) {
        if (issue.status === PlanIssueStatus.MERGED && issue.pr_number != null && !listedMerged(issue.pr_number)) unconfirmed.add(issue.pr_number);
    }
    return unconfirmed;
}

/** Reads one PR; returns its merge evidence only if it merged into the epic branch. */
async function readMergedChild(
    octokit: EpicProgressOctokit, request: EpicMergeProgressRequest, number: number,
): Promise<EpicChildPullRequest | null> {
    const { owner, repo, epicBranch } = request;
    const pr = (await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner, repo, pull_number: number })).data;
    if (!isRecord(pr)) return null;
    const mergedAt = typeof pr.merged_at === 'string' && Number.isFinite(Date.parse(pr.merged_at)) ? pr.merged_at : undefined;
    const base = isRecord(pr.base) && typeof pr.base.ref === 'string' ? pr.base.ref : epicBranch;
    if (!mergedAt || base !== epicBranch) return null;
    return { number, merged: true, mergedAt, abandoned: false, mergeCommitSha: typeof pr.merge_commit_sha === 'string' ? pr.merge_commit_sha : null };
}

/**
 * Recover merge-time evidence when GitHub's child list lags a merge. The
 * triggering child is merged by contract, and a final report must not demote
 * plan issues recorded as merged because their list row is missing or still
 * shows the pre-merge state. Each such PR is read individually; a read that
 * fails propagates, and a triggering child whose merge cannot be confirmed
 * throws, so the obligation is retried rather than reported from stale rows.
 * Returns the plan PRs that remained unconfirmed (not merged, or merged
 * into a different base) for the caller to report.
 */
async function reconcileChildEvidence(
    octokit: EpicProgressOctokit,
    request: EpicMergeProgressRequest,
    children: EpicChildPullRequest[],
    epicMerged: boolean,
): Promise<number[]> {
    const unresolved: number[] = [];
    for (const number of listUnconfirmedChildren(request, children, epicMerged)) {
        const evidence = await readMergedChild(octokit, request, number);
        if (!evidence) {
            if (number === request.mergedChildPrNumber) throw new Error(`Merge of triggering child PR #${number} could not be confirmed`);
            unresolved.push(number);
            continue;
        }
        const row = children.find(pr => pr.number === number);
        if (row) Object.assign(row, evidence); else children.push(evidence);
    }
    return unresolved;
}

/**
 * Plan issues as this report may count them: work shipped by a predecessor
 * is dropped, and once the epic has merged a recorded merge only counts if
 * the PR is proven inside this epic's merge. Issues a final report keeps
 * outstanding are demoted to under review and collected into `demoted`;
 * issues whose PR is proven included keep their merged status.
 */
function reportablePlanIssues(
    request: EpicMergeProgressRequest,
    { epicMerged, shipped, included }: { epicMerged: boolean; shipped: Set<number>; included: Set<number> },
    demoted: number[],
): PlanIssue[] | undefined {
    return request.planIssues?.filter(issue => issue.pr_number == null || !shipped.has(issue.pr_number))
        .map(issue => {
            if (!epicMerged || issue.status !== PlanIssueStatus.MERGED) return issue;
            if (issue.pr_number != null && included.has(issue.pr_number)) return issue;
            demoted.push(issue.issue_number);
            return { ...issue, status: PlanIssueStatus.UNDER_REVIEW };
        });
}

/**
 * Creates or updates the "x out of y" tracking comment. A first comment is
 * skipped while there is nothing to track (e.g. a successor whose only child
 * shipped through its predecessor), as "0 out of 0" would only confuse.
 */
async function syncTrackingComment(
    octokit: EpicProgressOctokit,
    { owner, repo, epicPrNumber }: EpicMergeProgressRequest,
    comments: IssueComment[],
    { body, empty, assertOwned }: { body: string; empty: boolean; assertOwned: () => Promise<void> },
): Promise<EpicMergeProgressResult['trackingComment']> {
    const existing = comments.find(comment => comment.body.includes(EPIC_PROGRESS_MARKER));
    if (!existing && empty) return 'skipped';
    if (!existing) {
        await assertOwned();
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner, repo, issue_number: epicPrNumber, body,
        });
        return 'created';
    }
    if (existing.body === body) return 'unchanged';
    await assertOwned();
    await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
        owner, repo, comment_id: existing.id, body,
    });
    return 'updated';
}

/**
 * Keeps a single "x out of y PRs merged" tracking comment on the epic PR up to
 * date, posts a readiness notice once every child PR has merged, and
 * confirms completion separately when the aggregate epic PR merges.
 * Progress, readiness, and final-merge comments each have a hidden marker,
 * so webhook redeliveries update in place without posting duplicates.
 * Ownership is re-checked before every write to reject a lost lease.
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
    const assertOwned = dependencies.assertOwned ?? (async () => {});
    const { owner, repo, epicPrNumber } = request;

    const children = await listChildPullRequests(octokit, owner, repo, request.epicBranch);
    const { comments, epicMerged, baseBranch, mergedAt, headSha } = await readEpicMergeState(octokit, request);
    const unresolved = await reconcileChildEvidence(octokit, request, children, epicMerged);
    const shipped = await listShippedChildren(octokit, request, children, { baseBranch, mergedAt, epicMerged });
    // For a final report, neither current plan status nor the triggering event
    // proves inclusion. Keep later/unknown children outstanding for this PR.
    const included = epicMerged ? await childrenWithin(octokit, request, children, { mergedAt, headSha }) : new Set<number>();
    const displayBase = baseBranch ?? 'the target branch';
    const demoted: number[] = [];
    const progress = computeEpicMergeProgress(
        children.filter(pr => !shipped.has(pr.number)).map(pr => epicMerged ? { ...pr, merged: included.has(pr.number) } : pr),
        epicMerged || (request.mergedChildPrNumber !== null && shipped.has(request.mergedChildPrNumber)) ? null : request.mergedChildPrNumber,
        reportablePlanIssues(request, { epicMerged, shipped, included }, demoted),
    );
    if (demoted.length > 0) {
        // No later event revises a final report; name the issues it keeps outstanding.
        log.debug({ owner, repo, epicPrNumber, issues: demoted, unresolvedPullRequests: unresolved },
            'Merged plan issues not carried by this epic PR remain outstanding in its final report');
    }

    const trackingComment = await syncTrackingComment(octokit, request, comments, {
        body: buildEpicProgressComment(progress, request.planName, epicMerged ? displayBase : undefined),
        empty: progress.total === 0 && progress.excluded === 0,
        assertOwned,
    });

    let completionPosted = false;
    const completionMarker = epicMerged ? EPIC_FINAL_MERGE_MARKER : EPIC_COMPLETE_MARKER;
    const completion = comments.find(comment => comment.body.includes(completionMarker));
    if (epicMerged || isEpicMergeComplete(progress)) {
        const completionBody = epicMerged
            ? buildEpicFinalMergeComment(progress, { epicPrNumber, baseBranch: displayBase, planName: request.planName })
            : buildEpicCompleteComment(progress, request.planName);
        if (!completion) {
            await assertOwned();
            await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                owner, repo, issue_number: epicPrNumber, body: completionBody,
            });
            completionPosted = true;
        } else if (epicMerged && completion.body !== completionBody) {
            await assertOwned();
            await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
                owner, repo, comment_id: completion.id, body: completionBody,
            });
        }
    }

    log.info({
        owner, repo, epicPrNumber,
        merged: progress.merged, total: progress.total,
        trackingComment, completionPosted,
    }, 'Updated epic merge progress');
    return { progress, trackingComment, completionPosted };
}
