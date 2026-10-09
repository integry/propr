/**
 * Automatic pull request assignment when work on a pull request completes:
 * an implementation reaching the done label, or a follow-up that pushed a
 * commit.
 *
 * Bound to the code that performs the completion (the `AI-processing` ->
 * `AI-done` swap in post-processing, and follow-up publication) rather than to
 * a label webhook, so work starting never assigns. The write is
 * additive (`setTaskAssignees` in `add` mode keeps manual assignees). Two
 * Redis keys scoped to repository, pull request and head SHA keep it
 * idempotent: a short lease marks an attempt in progress, and a completion
 * marker, written only after the assignment, its stored projection and any
 * review request succeed, makes a retry of the same state a no-op. A worker
 * that dies mid-attempt leaves only the lease, so a retry after it expires
 * tries again; a new head after follow-up is a new opportunity. Every failure
 * is logged and reported in the outcome; nothing here throws, because a
 * failed assignment must not fail a successful implementation.
 */

import type { Logger } from 'pino';
import { parseLinkedIssueNumbers } from './linkedIssueReferences.js';
import {
    refreshTaskAssignees,
    resolveRepositoryAutoAssignment,
    setTaskAssignees,
    TaskStates,
    type WorkerStateManager,
    type RepositoryAutoAssignment,
    type SetTaskAssigneesOptions,
    type SetTaskAssigneesResult,
    type TaskAssignmentClient,
    type TaskAssignmentOptions,
    type TaskSubject,
} from '@propr/core';

const CLAIM_KEY_PREFIX = 'propr:pr-auto-assignment';
const COMPLETED_TTL_SECONDS = 30 * 24 * 60 * 60;
// Longer than an attempt's GitHub calls with their retries take, short enough
// that an attempt cut off by a worker crash is retried soon after.
const LEASE_TTL_SECONDS = 10 * 60;

/** The timeline event recorded for an assignment decision. */
export const PR_AUTO_ASSIGNMENT_EVENT = 'pull_request.auto_assignment';

export type AutoAssignmentStatus = 'disabled' | 'skipped' | 'assigned' | 'already_assigned' | 'not_assigned' | 'failed';
export type ReviewRequestStatus = 'requested' | 'skipped' | 'failed';

/** The completion that offered the assignment. */
export type AutoAssignmentOpportunity = 'implementation_done' | 'followup_done';

export interface AutoAssignmentOutcome {
    status: AutoAssignmentStatus;
    opportunity?: AutoAssignmentOpportunity;
    reason: string;
    assignee?: string;
    review?: { status: ReviewRequestStatus; reason: string };
}

type GitHubClient = {
    request: <T = unknown>(route: string, parameters: Record<string, unknown>) => Promise<T>;
};

/** The slice of ioredis the idempotency lease and completion marker use. */
export interface AutoAssignmentClaimStore {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, mode: 'EX', seconds: number, condition?: 'NX'): Promise<unknown>;
    del(key: string): Promise<unknown>;
}

export interface AutoAssignPullRequestOptions {
    owner: string;
    repo: string;
    /** The issue the implementation was created from. */
    issueNumber?: number;
    /**
     * The pull request's linked source issue, when the caller already resolved
     * it. Without either issue number the pull request body's `Closes #n` is read.
     */
    linkedIssueNumber?: number | null;
    prNumber: number;
    taskId?: string;
    /** Defaults to `implementation_done`. */
    opportunity?: AutoAssignmentOpportunity;
    /**
     * The commit the completed work produced. Keys the idempotency guard, so a
     * new commit is a new opportunity; defaults to the pull request's head.
     */
    headSha?: string;
    /** The source issue's author when the caller already read the issue. */
    issueAuthor?: string | null;
    octokit: GitHubClient;
    redis: AutoAssignmentClaimStore;
    logger: Pick<Logger, 'info' | 'warn'>;
    /** Injectable for tests. */
    resolvePolicy?: (owner: string, repo: string) => Promise<RepositoryAutoAssignment>;
    assign?: (taskId: string, logins: string[], options: SetTaskAssigneesOptions) => Promise<SetTaskAssigneesResult>;
    refresh?: (taskId: string, subject: TaskSubject, options: TaskAssignmentOptions) => Promise<unknown>;
}

interface PullRequestState {
    headSha: string;
    body: string | null;
    author: string | null;
    assignees: string[];
}

function sameLogin(a: string | null | undefined, b: string | null | undefined): boolean {
    return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

export function isBotLogin(login: string): boolean {
    return login.toLowerCase().endsWith('[bot]');
}

/** The completion marker's key; the in-progress lease adds a `:lease` suffix. */
export function autoAssignmentClaimKey(owner: string, repo: string, prNumber: number, headSha: string): string {
    return `${CLAIM_KEY_PREFIX}:${owner}/${repo}`.toLowerCase() + `:${prNumber}:${headSha}`;
}

export function autoAssignmentLeaseKey(owner: string, repo: string, prNumber: number, headSha: string): string {
    return `${autoAssignmentClaimKey(owner, repo, prNumber, headSha)}:lease`;
}

function loginOf(user: unknown): string | null {
    const login = (user as { login?: unknown } | null)?.login;
    return typeof login === 'string' && login ? login : null;
}

async function readIssueAuthor(options: AutoAssignPullRequestOptions, issueNumber: number): Promise<string | null> {
    if (options.issueAuthor) return options.issueAuthor;
    const response = await options.octokit.request<{ data: { user?: unknown } }>('GET /repos/{owner}/{repo}/issues/{issue_number}', {
        owner: options.owner, repo: options.repo, issue_number: issueNumber,
    });
    return loginOf(response.data?.user);
}

/** The source issue: the caller's, otherwise the first one the pull request body closes. */
function sourceIssueNumber(options: AutoAssignPullRequestOptions, pullRequest: PullRequestState): number | null {
    return options.issueNumber ?? options.linkedIssueNumber ?? parseLinkedIssueNumbers(pullRequest.body)[0] ?? null;
}

async function readPullRequest(options: AutoAssignPullRequestOptions): Promise<PullRequestState> {
    const response = await options.octokit.request<{ data: { head?: { sha?: unknown }; body?: unknown; user?: unknown; assignees?: unknown[] } }>('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner: options.owner, repo: options.repo, pull_number: options.prNumber,
    });
    const headSha = typeof response.data?.head?.sha === 'string' ? response.data.head.sha : '';
    if (!headSha) throw new Error(`Pull request #${options.prNumber} has no head SHA`);
    return {
        headSha,
        body: typeof response.data?.body === 'string' ? response.data.body : null,
        author: loginOf(response.data?.user),
        assignees: (response.data?.assignees ?? []).map(loginOf).filter((login): login is string => !!login),
    };
}

/**
 * The repository default assignee, otherwise the source issue's author unless
 * that is a bot. Never whoever commented: a follow-up keeps the issue author.
 */
async function resolveTarget(
    options: AutoAssignPullRequestOptions,
    policy: RepositoryAutoAssignment,
    pullRequest: PullRequestState,
): Promise<{ assignee: string } | { skipped: string }> {
    if (policy.defaultAssignee) return { assignee: policy.defaultAssignee };
    const issueNumber = sourceIssueNumber(options, pullRequest);
    if (!issueNumber) return { skipped: 'the pull request has no linked source issue' };
    const author = await readIssueAuthor(options, issueNumber);
    if (!author) return { skipped: 'the source issue has no author' };
    if (isBotLogin(author)) return { skipped: `the source issue author ${author} is a bot` };
    return { assignee: author };
}

async function requestReview(
    options: AutoAssignPullRequestOptions,
    assignee: string,
    pullRequest: PullRequestState,
): Promise<{ status: ReviewRequestStatus; reason: string }> {
    // GitHub refuses a review request from the pull request's own author.
    if (sameLogin(assignee, pullRequest.author)) return { status: 'skipped', reason: `${assignee} authored the pull request` };
    const pending = await options.octokit.request<{ data: { users?: unknown[] } }>('GET /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers', {
        owner: options.owner, repo: options.repo, pull_number: options.prNumber,
    });
    if ((pending.data?.users ?? []).some(user => sameLogin(loginOf(user), assignee))) {
        return { status: 'skipped', reason: `a review from ${assignee} is already requested` };
    }
    await options.octokit.request('POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers', {
        owner: options.owner, repo: options.repo, pull_number: options.prNumber, reviewers: [assignee],
    });
    return { status: 'requested', reason: `requested a review from ${assignee}` };
}

type Claim = { state: 'acquired' | 'unavailable' } | { state: 'completed' } | { state: 'in_progress' };

/**
 * Takes the in-progress lease, then checks the completion marker. Completion
 * is written before the lease is released, so reading it under the lease
 * cannot miss an attempt that finished meanwhile.
 */
async function claim(options: AutoAssignPullRequestOptions, completedKey: string, leaseKey: string): Promise<Claim> {
    try {
        if (await options.redis.set(leaseKey, new Date().toISOString(), 'EX', LEASE_TTL_SECONDS, 'NX') !== 'OK') return { state: 'in_progress' };
        if (await options.redis.get(completedKey)) {
            await release(options, leaseKey);
            return { state: 'completed' };
        }
        return { state: 'acquired' };
    } catch (error) {
        // The writes below are safe to repeat (additive assignment, deduplicated
        // review request), so an unreachable Redis only loses the fast path.
        options.logger.warn({ key: completedKey, error: (error as Error).message }, 'Could not claim pull request auto-assignment; continuing without the idempotency key');
        return { state: 'unavailable' };
    }
}

async function markCompleted(options: AutoAssignPullRequestOptions, key: string): Promise<void> {
    try {
        await options.redis.set(key, new Date().toISOString(), 'EX', COMPLETED_TTL_SECONDS);
    } catch (error) {
        options.logger.warn({ key, error: (error as Error).message }, 'Could not record pull request auto-assignment completion');
    }
}

function isComplete(outcome: AutoAssignmentOutcome): boolean {
    return (outcome.status === 'assigned' || outcome.status === 'already_assigned') && outcome.review?.status !== 'failed';
}

async function release(options: AutoAssignPullRequestOptions, key: string): Promise<void> {
    try {
        await options.redis.del(key);
    } catch (error) {
        options.logger.warn({ key, error: (error as Error).message }, 'Could not release pull request auto-assignment claim');
    }
}

async function assignAndRequestReview(
    options: AutoAssignPullRequestOptions,
    policy: RepositoryAutoAssignment,
    assignee: string,
    pullRequest: PullRequestState,
): Promise<AutoAssignmentOutcome> {
    const { owner, repo, prNumber, taskId } = options;
    const subject: TaskSubject = { owner, repo, number: prNumber, kind: 'pull_request' };
    const github = options.octokit as unknown as TaskAssignmentClient;
    let outcome: AutoAssignmentOutcome;
    if (pullRequest.assignees.some(login => sameLogin(login, assignee))) {
        // An earlier attempt may have assigned on GitHub and then failed to
        // store the result; bring the task's stored assignees up to date.
        await (options.refresh ?? refreshTaskAssignees)(taskId!, subject, { github });
        outcome = { status: 'already_assigned', reason: `${assignee} is already assigned`, assignee };
    } else {
        const assign = options.assign ?? setTaskAssignees;
        const result = await assign(taskId!, [assignee], { mode: 'add', subject, github });
        outcome = result.rejected.length > 0
            ? { status: 'not_assigned', reason: `GitHub did not assign ${assignee}, who may lack repository access`, assignee }
            : { status: 'assigned', reason: `assigned ${assignee}`, assignee };
    }
    options.logger.info({ repository: `${owner}/${repo}`, prNumber, opportunity: options.opportunity, assignee, status: outcome.status, reason: outcome.reason }, 'Pull request auto-assignment decision');
    // Nobody to request a review from: GitHub refuses reviewers it would not assign.
    if (outcome.status === 'not_assigned') return outcome;

    if (policy.requestReview) {
        try {
            outcome.review = await requestReview(options, assignee, pullRequest);
        } catch (error) {
            outcome.review = { status: 'failed', reason: (error as Error).message };
        }
        const log = outcome.review.status === 'failed' ? options.logger.warn.bind(options.logger) : options.logger.info.bind(options.logger);
        log({ repository: `${owner}/${repo}`, prNumber, reviewer: assignee, status: outcome.review.status, reason: outcome.review.reason }, 'Pull request auto-assignment review request decision');
    }
    return outcome;
}

/**
 * Assigns a pull request whose work completed to the repository default
 * assignee or the source issue's author, and optionally requests their review.
 * Disabled repositories return before any GitHub call. Never throws.
 */
export async function autoAssignImplementationPullRequest(options: AutoAssignPullRequestOptions): Promise<AutoAssignmentOutcome> {
    const { owner, repo, prNumber, logger } = options;
    const opportunity = options.opportunity ?? 'implementation_done';
    const context = { repository: `${owner}/${repo}`, prNumber, issueNumber: options.issueNumber ?? options.linkedIssueNumber, opportunity };
    let leaseKey: string | null = null;

    try {
        const policy = await (options.resolvePolicy ?? resolveRepositoryAutoAssignment)(owner, repo);
        if (!policy.enabled) {
            logger.info({ ...context, reason: 'disabled for the repository' }, 'Pull request auto-assignment skipped');
            return { status: 'disabled', reason: 'disabled for the repository', opportunity };
        }
        if (!options.taskId) {
            logger.info({ ...context, reason: 'no task to record the assignment on' }, 'Pull request auto-assignment skipped');
            return { status: 'skipped', reason: 'no task to record the assignment on', opportunity };
        }

        const pullRequest = await readPullRequest(options);
        const target = await resolveTarget(options, policy, pullRequest);
        if ('skipped' in target) {
            logger.info({ ...context, reason: target.skipped }, 'Pull request auto-assignment skipped');
            return { status: 'skipped', reason: target.skipped, opportunity };
        }

        const headSha = options.headSha || pullRequest.headSha;
        const head = headSha.slice(0, 12);
        const completedKey = autoAssignmentClaimKey(owner, repo, prNumber, headSha);
        const claimed = await claim(options, completedKey, autoAssignmentLeaseKey(owner, repo, prNumber, headSha));
        if (claimed.state === 'completed') {
            const reason = `already handled for head ${head}`;
            logger.info({ ...context, assignee: target.assignee, reason }, 'Pull request auto-assignment skipped: already assigned');
            return { status: 'already_assigned', reason, assignee: target.assignee, opportunity };
        }
        if (claimed.state === 'in_progress') {
            const reason = `another attempt for head ${head} is in progress`;
            logger.info({ ...context, assignee: target.assignee, reason }, 'Pull request auto-assignment skipped');
            return { status: 'skipped', reason, assignee: target.assignee, opportunity };
        }
        if (claimed.state === 'acquired') leaseKey = autoAssignmentLeaseKey(owner, repo, prNumber, headSha);

        const outcome: AutoAssignmentOutcome = { opportunity, ...await assignAndRequestReview({ ...options, opportunity }, policy, target.assignee, pullRequest) };
        // Only a finished attempt suppresses retries; after a rejection or a
        // failed review request a retry of the same head tries again.
        if (isComplete(outcome)) await markCompleted(options, completedKey);
        if (leaseKey) await release(options, leaseKey);
        return outcome;
    } catch (error) {
        const reason = (error as Error).message;
        logger.warn({ ...context, error: reason }, 'Pull request auto-assignment failed');
        if (leaseKey) await release(options, leaseKey);
        return { status: 'failed', reason, opportunity };
    }
}

/** The one-line timeline summary of an outcome. */
export function describeAutoAssignmentOutcome(outcome: AutoAssignmentOutcome): string {
    const summary = describeAssignment(outcome);
    return outcome.opportunity === 'followup_done' ? `After follow-up: ${summary}` : summary;
}

function describeAssignment(outcome: AutoAssignmentOutcome): string {
    const review = !outcome.review ? ''
        : outcome.review.status === 'requested' ? ' and requested their review'
            : outcome.review.status === 'skipped' ? `; review not requested: ${outcome.review.reason}`
                : `; review request failed: ${outcome.review.reason}`;
    switch (outcome.status) {
        case 'assigned': return `Assigned pull request to ${outcome.assignee}${review}`;
        case 'already_assigned': return `Pull request already assigned to ${outcome.assignee}${review}`;
        case 'not_assigned': return `Could not assign pull request: ${outcome.reason}`;
        case 'failed': return `Pull request assignment failed: ${outcome.reason}`;
        default: return `Pull request assignment skipped: ${outcome.reason}`;
    }
}

export type TimelineStateManager = Pick<WorkerStateManager, 'getTaskState' | 'updateTaskState'>;

/**
 * Records an assignment decision as its own task timeline entry. The entry
 * keeps the task's current state, so the pipeline position is unchanged. A
 * disabled repository records nothing, leaving the timeline as it was.
 */
export async function recordAutoAssignmentEvent(event: {
    stateManager: TimelineStateManager;
    taskId: string;
    prNumber: number;
    outcome: AutoAssignmentOutcome;
    logger?: Pick<Logger, 'warn'>;
}): Promise<void> {
    const { stateManager, taskId, prNumber, outcome, logger: log } = event;
    if (outcome.status === 'disabled') return;
    try {
        const current = await stateManager.getTaskState(taskId);
        const terminal: string[] = [TaskStates.COMPLETED, TaskStates.FAILED, TaskStates.CANCELLED];
        if (!current || terminal.includes(current.state)) return;
        const description = describeAutoAssignmentOutcome(outcome);
        await stateManager.updateTaskState(taskId, current.state, {
            reason: description,
            historyMetadata: { event: PR_AUTO_ASSIGNMENT_EVENT, autoAssignment: { ...outcome, prNumber }, description },
        });
    } catch (error) {
        log?.warn({ taskId, error: (error as Error).message }, 'Failed to record pull request auto-assignment timeline event');
    }
}
