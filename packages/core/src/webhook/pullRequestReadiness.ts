/**
 * Read-only pull request readiness: one verdict, with a coded reason per gate,
 * from the same signals the auto-merge path evaluates (`processPRAutoMerge`).
 * It never writes to GitHub or Redis, never updates the branch, never merges
 * and never arms or withdraws auto-merge: CI is classified by
 * {@link readCiMergeReadiness}, which reads the head observation without
 * recording it, and the policy is read through the side-effect-free
 * {@link evaluatePullRequestAutoMerge}.
 */
import type { Redis } from 'ioredis';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { loadUltrafixRatingGoal } from '../config/configManagerUltrafix.js';
import { getNonBlockingChecksForRepository } from '../daemon/configLoader.js';
import { evaluatePullRequestAutoMerge, type AutoMergeGateOctokit } from '../services/autoMergeGate.js';
import type { AutoMergeReason } from '../workflow/autoMergePolicy.js';
import logger from '../utils/logger.js';
import {
    getUltrafixLoopState, readActiveTasksForPR, readCiMergeReadiness, readLinkedIssueAutoMergeLabel,
    type ActivePRWork, type CiMergeClassification, type CiMergeReadiness, type PRAutoMergeInfo,
} from './checkRunHelpers.js';
import {
    evaluateAutoMergeEligibilityWithReason, type AutoMergeEligibility, type AutoMergeEligibilityReason,
} from './autoMergeEvaluation.js';
import {
    activeWorkGate, aiReviewGate, checksGate, decideVerdict, draftGate, humanReviewGate, mergeableGate, openGate, policyGate,
    summarizeReview, ultrafixGate,
    type HumanReviewFacts, type PullRequestState, type ReadinessGate, type ReadinessVerdict, type ReviewScoreFact, type ReviewSummary,
    type UltrafixFacts,
} from './pullRequestReadinessGates.js';

export * from './pullRequestReadinessGates.js';

/** GitHub reads the evaluation needs; the App installation client by default. */
export interface ReadinessOctokit {
    request(route: string, params?: Record<string, unknown>): Promise<{ data: any }>; // eslint-disable-line @typescript-eslint/no-explicit-any
    graphql?<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T>;
}

export interface PullRequestReadinessDeps {
    /** Persisted review scores of the PR, oldest first (for example the API's score loader). */
    loadReviewScores: (repository: string, prNumber: number) => Promise<readonly ReviewScoreFact[]>;
    octokit?: ReadinessOctokit;
    /** Read-only view of the head-observation store; defaults to the shared Ultrafix state Redis. */
    observations?: Pick<Redis, 'get'>;
    loadNonBlockingChecks?: (owner: string, repo: string) => Promise<string[]>;
    loadUltrafixState?: typeof getUltrafixLoopState;
    /** Must throw when the work cannot be read; an error is reported as `active_work_unavailable`. */
    loadActiveWork?: (repository: string, prNumber: number) => Promise<ActivePRWork>;
    loadRatingGoal?: () => Promise<number>;
    now?: () => number;
}

export interface PullRequestReadiness {
    repository: string;
    number: number;
    head: string;
    base: string;
    state: PullRequestState;
    draft: boolean;
    verdict: ReadinessVerdict;
    gates: ReadinessGate[];
    /** Reason codes of gates with status `fail`. */
    blockingReasons: string[];
    /** Reason codes of gates with status `waiting` or `unknown`. */
    waitingReasons: string[];
    review: ReviewSummary | null;
    ultrafix: { active: boolean; completionStatus: 'succeeded' | 'failed' | null; labelPresent: boolean } | null;
    checks: { reason: CiMergeReadiness['reason']; blockingFailed: string[]; blockingPending: string[]; nonBlockingCount: number };
    autoMerge: { eligible: AutoMergeEligibility; reason: AutoMergeEligibilityReason; policy: AutoMergeReason | null };
    evaluatedAt: string;
}

/** The pull request itself could not be read; nothing was evaluated. `status` is GitHub's, when it answered. */
export class PullRequestReadinessUnavailableError extends Error {
    constructor(message: string, readonly status?: number) {
        super(message);
        this.name = 'PullRequestReadinessUnavailableError';
    }
}

interface PullRequestFacts {
    state: PullRequestState;
    draft: boolean;
    head: string;
    headRef: string;
    base: string;
    labels: string[];
    mergeable: boolean | null;
    mergeableState: string;
    autoMergeArmed: boolean;
}

async function readPullRequest(octokit: ReadinessOctokit, owner: string, repo: string, prNumber: number): Promise<PullRequestFacts> {
    let data;
    try {
        ({ data } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner, repo, pull_number: prNumber }));
    } catch (error) {
        const status = (error as { status?: unknown }).status;
        throw new PullRequestReadinessUnavailableError((error as Error).message, typeof status === 'number' ? status : undefined);
    }
    const labels = Array.isArray(data.labels) ? (data.labels as Array<{ name?: string } | string>).map(label => typeof label === 'string' ? label : label.name ?? '') : [];
    return {
        state: data.merged || data.merged_at ? 'merged' : data.state === 'open' ? 'open' : 'closed',
        draft: data.draft === true,
        head: data.head.sha,
        headRef: data.head.ref,
        base: data.base.ref,
        labels,
        mergeable: typeof data.mergeable === 'boolean' ? data.mergeable : null,
        mergeableState: typeof data.mergeable_state === 'string' ? data.mergeable_state : 'unknown',
        autoMergeArmed: Boolean(data.auto_merge),
    };
}

const REVIEW_DECISION_QUERY = 'query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewDecision}}}';
const REVIEWS_PER_PAGE = 100;
/** GitHub lists reviews oldest first; past this many pages the history is reported unavailable rather than truncated. */
export const MAX_REVIEW_PAGES = 30;

type ReviewRecord = { state?: string; user?: { login?: string } | null };

/** The full review history, oldest first. Throws when a page is malformed or the history exceeds {@link MAX_REVIEW_PAGES}. */
async function readAllReviews(octokit: ReadinessOctokit, owner: string, repo: string, prNumber: number): Promise<ReviewRecord[]> {
    const reviews: ReviewRecord[] = [];
    for (let page = 1; page <= MAX_REVIEW_PAGES; page++) {
        const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews', {
            owner, repo, pull_number: prNumber, per_page: REVIEWS_PER_PAGE, page,
        });
        if (!Array.isArray(data)) throw new Error(`reviews page ${page} is not a list`);
        reviews.push(...(data as ReviewRecord[]));
        if (data.length < REVIEWS_PER_PAGE) return reviews;
    }
    // A later page could hold the verdict that supersedes one already read.
    throw new Error(`review history exceeds ${MAX_REVIEW_PAGES} pages`);
}

/** Latest review per reviewer, and GitHub's review decision when the client speaks GraphQL. Null when unreadable. */
async function readHumanReviews(octokit: ReadinessOctokit, owner: string, repo: string, prNumber: number): Promise<HumanReviewFacts | null> {
    try {
        const [reviews, decision] = await Promise.all([
            readAllReviews(octokit, owner, repo, prNumber),
            octokit.graphql?.<{ repository?: { pullRequest?: { reviewDecision?: string | null } | null } | null }>(
                REVIEW_DECISION_QUERY, { owner, repo, number: prNumber }),
        ]);
        const latest = new Map<string, string>();
        for (const review of reviews) {
            const login = review.user?.login;
            // Comments neither approve nor request changes, so they do not replace a reviewer's verdict.
            if (!login || !review.state || review.state === 'COMMENTED' || review.state === 'PENDING') continue;
            latest.set(login, review.state);
        }
        return {
            reviewDecision: decision?.repository?.pullRequest?.reviewDecision ?? null,
            changesRequestedBy: [...latest].filter(([, state]) => state === 'CHANGES_REQUESTED').map(([login]) => login),
        };
    } catch (error) {
        logger.debug({ owner, repo, prNumber, error: (error as Error).message }, 'Readiness: pull request reviews unavailable');
        return null;
    }
}

const settle = async <T>(read: () => Promise<T>): Promise<T | null> => {
    try { return await read(); } catch { return null; }
};

/** The eligibility evaluation logs as if it were deciding a merge; a read must not. */
const quietLog = { info() {}, warn() {}, debug() {}, error() {} } as unknown as ReturnType<typeof logger.withCorrelation>;

type UltrafixState = UltrafixFacts['state'];

function autoMergeInfo(pr: PullRequestFacts, ultrafixState: UltrafixState): PRAutoMergeInfo {
    return {
        state: pr.state === 'open' ? 'open' : 'closed', hasLabel: pr.labels.includes('auto-merge'), hasUltrafixLabel: pr.labels.includes('ultrafix'),
        hasActiveUltrafixLoop: ultrafixState?.active ?? false, ultrafixCompletionStatus: ultrafixState?.completionStatus ?? null,
        ultrafixStateUnavailable: ultrafixState?.unavailable === true, isDraft: pr.draft, baseBranch: pr.base, headBranch: pr.headRef,
        mergeable: pr.mergeable, mergeableState: pr.mergeableState, autoMergeArmed: pr.autoMergeArmed,
    };
}

function ultrafixProjection(state: UltrafixState, labelPresent: boolean): PullRequestReadiness['ultrafix'] {
    if (state?.unavailable) return null;
    return { active: state?.active ?? false, completionStatus: state?.completionStatus ?? null, labelPresent };
}

function checksProjection(ci: CiMergeClassification): PullRequestReadiness['checks'] {
    return {
        reason: ci.reason,
        blockingFailed: ci.summary?.blockingFailed ?? [],
        blockingPending: ci.summary?.blockingPending ?? [],
        nonBlockingCount: ci.summary?.nonBlockingCount ?? 0,
    };
}

function reviewFacts(scores: readonly ReviewScoreFact[] | null, ratingGoal: number | null, head: string): { review: ReviewSummary | null; scoresUnavailable: boolean } {
    if (scores === null) return { review: null, scoresUnavailable: true };
    if (scores.length === 0) return { review: null, scoresUnavailable: false };
    if (ratingGoal === null) return { review: null, scoresUnavailable: true };
    return { review: summarizeReview(scores, head, ratingGoal), scoresUnavailable: false };
}

/**
 * The auto-merge policy for the snapshot this verdict reports. `requested` is three-state: the PR or a linked
 * issue carries `auto-merge` (true), neither does (false), or the linked issue could not be read (null), which
 * leaves the request unknown, never absent. Only a request reads the policy, and only then can it change the verdict.
 */
async function readPolicy(
    target: { owner: string; repo: string; prNumber: number; octokit: ReadinessOctokit }, pr: PullRequestFacts, requested: boolean | null,
): Promise<{ gate: ReadinessGate; reason: AutoMergeReason | null }> {
    const { owner, repo, prNumber, octokit } = target;
    if (requested === null) return { gate: policyGate('request_unavailable'), reason: null };
    if (!requested) return { gate: policyGate(null), reason: null };
    const { decision, pullRequest } = await evaluatePullRequestAutoMerge(
        { owner, repo, prNumber, opportunity: 'check_merge' }, { octokit: octokit as AutoMergeGateOctokit });
    // The policy reads the PR again; its decision applies here only when it saw the same head and base.
    // A missing snapshot already yields an unreadable-policy decision, which the gate reports as unknown.
    if (pullRequest && (pullRequest.headSha !== pr.head || pullRequest.baseRef !== pr.base)) {
        return { gate: policyGate('head_changed'), reason: null };
    }
    return { gate: policyGate(decision), reason: decision.reason };
}

const isUnsettled = (item: ReadinessGate) => item.status === 'waiting' || item.status === 'unknown';

/**
 * Evaluate one pull request's readiness without side effects. Throws
 * {@link PullRequestReadinessUnavailableError} only when the PR itself cannot
 * be read; every other unreadable signal becomes a gate with status `unknown`.
 */
export async function evaluatePullRequestReadiness(
    owner: string,
    repo: string,
    prNumber: number,
    deps: PullRequestReadinessDeps,
): Promise<PullRequestReadiness> {
    const repository = `${owner}/${repo}`;
    const now = (deps.now ?? Date.now)();
    const octokit = deps.octokit ?? await getAuthenticatedOctokit() as unknown as ReadinessOctokit;
    const pr = await readPullRequest(octokit, owner, repo, prNumber);
    const hasLabel = pr.labels.includes('auto-merge');
    const ultrafixLabel = pr.labels.includes('ultrafix');

    let linkedIssueLabel: Promise<boolean | null> | undefined;
    const readLinkedIssueLabel = () => linkedIssueLabel ??= readLinkedIssueAutoMergeLabel(owner, repo, prNumber, octokit);

    const [ci, humanReviews, scores, ultrafixState, activeWork, ratingGoal, issueLabel] = await Promise.all([
        readCiMergeReadiness(owner, repo, pr.head, {
            prNumber, now, octokit, observations: deps.observations,
            loadNonBlockingChecks: deps.loadNonBlockingChecks ?? getNonBlockingChecksForRepository,
        }),
        readHumanReviews(octokit, owner, repo, prNumber),
        settle(() => deps.loadReviewScores(repository, prNumber)),
        (deps.loadUltrafixState ?? getUltrafixLoopState)(owner, repo, prNumber),
        settle(() => (deps.loadActiveWork ?? readActiveTasksForPR)(repository, prNumber)),
        settle(() => (deps.loadRatingGoal ?? loadUltrafixRatingGoal)()),
        hasLabel ? Promise.resolve(true) : readLinkedIssueLabel(),
    ]);

    const { review, scoresUnavailable } = reviewFacts(scores, ratingGoal, pr.head);
    const prInfo = autoMergeInfo(pr, ultrafixState);
    const eligibility = await evaluateAutoMergeEligibilityWithReason({ owner, repoName: repo, prNumber, prInfo, log: quietLog, readLinkedIssueLabel });
    const policy = await readPolicy({ owner, repo, prNumber, octokit }, pr, hasLabel || issueLabel === true ? true : issueLabel === null ? null : false);
    const checks = checksGate(ci);
    const human = humanReviewGate(humanReviews);
    const gates: ReadinessGate[] = [
        openGate(pr.state),
        draftGate(pr.draft),
        checks,
        mergeableGate({ mergeable: pr.mergeable, mergeableState: pr.mergeableState, othersWaiting: [checks, human].some(isUnsettled) }),
        human,
        aiReviewGate({ review, scoresUnavailable, ultrafixLabel }),
        ultrafixGate({ labelPresent: ultrafixLabel, state: ultrafixState }),
        activeWorkGate(activeWork),
        policy.gate,
    ];
    return {
        repository, number: prNumber, head: pr.head, base: pr.base, state: pr.state, draft: pr.draft,
        verdict: decideVerdict(pr.state, gates),
        gates,
        blockingReasons: gates.filter(item => item.status === 'fail').map(item => item.reason),
        waitingReasons: gates.filter(isUnsettled).map(item => item.reason),
        review,
        ultrafix: ultrafixProjection(ultrafixState, ultrafixLabel),
        checks: checksProjection(ci),
        autoMerge: { eligible: eligibility.eligibility, reason: eligibility.reason, policy: policy.reason },
        evaluatedAt: new Date(now).toISOString(),
    };
}
