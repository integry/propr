import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import type { PullRequestEvent } from '@octokit/webhooks-types';

const actualProgress = await import('../packages/core/src/webhook/epicMergeProgress.js');
const actualConnection = await import('../packages/core/src/db/connection.js');
const actualGithubAuth = await import('../packages/core/src/auth/githubAuth.js');
const actualCheckRunHelpers = await import('../packages/core/src/webhook/checkRunHelpers.js');
const actualEpicPRService = await import('../packages/core/src/services/epicPRService.js');
const { EPIC_PROGRESS_RETRY_KEY, EPIC_PROGRESS_SCRIPTS, epicProgressRetryField } = await import('../packages/core/src/webhook/epicMergeProgressRetry.js');
after(actualConnection.closeConnection);

const EPIC_BRANCH = '100-epic-big-plan-abc';
type PlanIssueRow = { issue_number: number; draft_id: string; pr_number: number | null; status: string };
const initialPlanIssueRows = (): PlanIssueRow[] => [
    { issue_number: 100, draft_id: 'draft-1', pr_number: 201, status: 'under_review' },
    { issue_number: 101, draft_id: 'draft-1', pr_number: null, status: 'pending' },
    { issue_number: 102, draft_id: 'draft-1', pr_number: null, status: 'pending' },
];
let planIssueRows = initialPlanIssueRows();
// Number of plan-issue list reads that fail before the database recovers.
let failingPlanListReads = 0;
// Number of epic PR lookups that fail before GitHub recovers.
let failingEpicLookups = 0;
// Whether the epic branch has an open epic PR (#500) to find.
let epicPrExists = true;
let closedHistoryCount = 0;
let epicPrMerged = false;
let epicBase = 'main';
let childMergedAt: string | null = '2026-10-10T19:00:00Z';
let childMergeCommitSha: string | null = null;
// The epic PR's head as GitHub preserves it after the merge, whatever the merge method.
let epicHeadSha: string | null = null;
// `ahead_by` reported for any epic-head/child-merge-commit comparison.
let compareAheadBy = 1;
// A 422 message GitHub refuses epic PR creation with, if any.
let epicCreationRefusal: string | null = null;
let failingChildReads = 0;
// Every GitHub request route the handler issued.
const githubRequests: string[] = [];
const bodyUpdates: number[] = [];
// Number of epic PR creations that fail before GitHub recovers.
let failingEpicCreations = 0;
let createdEpicPRs = 0;
// Parameters of every epic PR creation request.
const epicPRCreations: Array<Record<string, unknown>> = [];
// Runs while the handler fetches issue details for the epic PR body.
let onIssueFetch: () => void | Promise<void> = () => {};

function fakeQuery(table: string) {
    let filter: Record<string, unknown> = {};
    const query = {
        where(conditions: Record<string, unknown>) { filter = conditions; return query; },
        select() { return query; },
        async first() {
            if (table === 'task_drafts') return { name: 'Big Plan', draft_id: 'draft-1' };
            return planIssueRows.find(row => row.issue_number === filter.issue_number);
        },
        async orderBy() {
            if (failingPlanListReads > 0) {
                failingPlanListReads--;
                throw new Error('database unavailable');
            }
            return planIssueRows.filter(row => row.draft_id === filter.draft_id);
        },
    };
    return query;
}

/** Epic PR #500 as GitHub reports it: a merge boundary exists only once it has merged. */
function epicPullRequest() {
    return {
        number: 500, base: { ref: epicBase }, state: epicPrMerged ? 'closed' : 'open',
        merged_at: epicPrMerged ? '2026-10-10T20:00:00Z' : null, merge_commit_sha: epicPrMerged ? 'squashed-e1' : null,
        head: { ref: EPIC_BRANCH, sha: epicHeadSha },
    };
}

await mock.module('../packages/core/src/db/connection.js', {
    namedExports: { ...actualConnection, db: (table: string) => fakeQuery(table) },
});
await mock.module('../packages/core/src/auth/githubAuth.js', { namedExports: {
    ...actualGithubAuth,
    getAuthenticatedOctokit: async () => ({
        paginate: async (route: string, parameters: Record<string, unknown>) => {
            githubRequests.push(route);
            assert.equal(route, 'GET /repos/{owner}/{repo}/pulls');
            assert.equal(parameters.per_page, 100);
            if (failingEpicLookups > 0) {
                failingEpicLookups--;
                throw new Error('GitHub unavailable');
            }
            return [
                ...Array.from({ length: closedHistoryCount }, (_, i) => ({ number: 600 + i, state: 'closed', merged_at: null })),
                ...(epicPrExists ? [epicPullRequest()] : []),
                ...(createdEpicPRs ? [{ number: 501, state: 'open', merged_at: null }] : []),
            ];
        },
        request: async (route: string, parameters: { pull_number?: number }) => {
        githubRequests.push(parameters.pull_number ? `${route}:${parameters.pull_number}` : route);
        if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
            if (parameters.pull_number === 500) return { data: epicPullRequest() };
            if (parameters.pull_number === 501) return { data: { state: 'open', merged_at: null } };
            if (failingChildReads > 0) {
                failingChildReads--;
                throw new Error('Child merge time unavailable');
            }
            return { data: {
                merged_at: additionalChildren.find(pr => pr.number === parameters.pull_number)?.merged_at ?? childMergedAt,
                merge_commit_sha: childMergeCommitSha,
            } };
        }
        if (route === 'GET /repos/{owner}/{repo}') return { data: { default_branch: 'main' } };
        if (route === 'GET /repos/{owner}/{repo}/compare/{basehead}') return { data: { ahead_by: compareAheadBy } };
        if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}') {
            await onIssueFetch();
            return { data: { title: 'Issue' } };
        }
        if (route === 'PATCH /repos/{owner}/{repo}/pulls/{pull_number}') {
            bodyUpdates.push(parameters.pull_number!);
            return { data: {} };
        }
        throw new Error(`Unexpected request ${route}`);
    } }),
} });
await mock.module('../packages/core/src/services/epicPRService.js', { namedExports: {
    ...actualEpicPRService,
    createEpicPRWithDraftFallback: async (_octokit: unknown, parameters: Record<string, unknown>) => {
        if (failingEpicCreations > 0) {
            failingEpicCreations--;
            throw new Error('GitHub unavailable');
        }
        if (epicCreationRefusal) throw Object.assign(new Error(epicCreationRefusal), { status: 422 });
        createdEpicPRs++;
        epicPRCreations.push(parameters);
        return { data: { number: 501, html_url: 'https://github.com/integry/propr/pull/501' } };
    },
} });

/** In-memory Redis covering the retry hash, the lease, and their compare-and-delete/extend scripts. */
function fakeRedis() {
    const hash = new Map<string, string>();
    const keys = new Map<string, string>();
    return {
        hash,
        loseLease() { keys.clear(); },
        async hget(key: string, field: string) { assert.equal(key, EPIC_PROGRESS_RETRY_KEY); return hash.get(field) ?? null; },
        async hset(key: string, field: string, value: string) { assert.equal(key, EPIC_PROGRESS_RETRY_KEY); hash.set(field, value); return 1; },
        async hgetall(key: string) { assert.equal(key, EPIC_PROGRESS_RETRY_KEY); return Object.fromEntries(hash); },
        async set(key: string, value: string, ...args: unknown[]) {
            assert.ok(args.includes('NX'));
            if (keys.has(key)) return null;
            keys.set(key, value);
            return 'OK';
        },
        async eval(script: string, _numberOfKeys: number, key: string, ...args: string[]) {
            switch (script) {
                case EPIC_PROGRESS_SCRIPTS.compareAndDeleteField:
                    if (hash.get(args[0]) !== args[1]) return 0;
                    return Number(hash.delete(args[0]));
                case EPIC_PROGRESS_SCRIPTS.migrateLegacyField:
                    if (hash.get(args[0]) !== args[1] || (hash.get(args[2]) ?? '') !== args[3]) return 0;
                    hash.set(args[2], args[4]);
                    return Number(hash.delete(args[0]));
                case EPIC_PROGRESS_SCRIPTS.compareAndExtendKey:
                    return keys.get(key) === args[0] ? 1 : 0;
                case EPIC_PROGRESS_SCRIPTS.compareAndDeleteKey:
                    return keys.get(key) === args[0] ? Number(keys.delete(key)) : 0;
                default:
                    throw new Error(`Unknown script: ${script}`);
            }
        },
    };
}
let redis = fakeRedis();
await mock.module('../packages/core/src/webhook/checkRunHelpers.js', {
    namedExports: { ...actualCheckRunHelpers, getUltrafixStateRedis: () => redis },
});

// Mirrors the epic PR's bot comments: one completion notice, posted once the epic is complete.
const progressRequests: Array<Record<string, unknown>> = [];
let failingProgressUpdates = 0;
let completionNotices = 0;
let useRealProgress = false;
let failingHistoryReads = 0;
let onHistoryRead: () => void = () => {};
let additionalChildren: Array<{ number: number; state: string; merged_at: string }> = [];
const comments: Array<{ id: number; issue_number: number; body: string; user: { login: string } }> = [];
const progressOctokit = {
    async paginate(route: string, parameters: Record<string, unknown>) {
        if (parameters.head) onHistoryRead();
        if (parameters.head && failingHistoryReads > 0) {
            failingHistoryReads--;
            throw new Error('History unavailable');
        }
        if (route === 'GET /repos/{owner}/{repo}/pulls') return parameters.head
            ? [{ number: 500, base: { ref: epicBase }, state: epicPrMerged ? 'closed' : 'open', merged_at: epicPrMerged ? '2026-10-10T20:00:00Z' : null }]
            : [{ number: 201, state: 'closed', merged_at: childMergedAt }, ...additionalChildren];
        return comments.filter(comment => comment.issue_number === parameters.issue_number).map(comment => ({ ...comment }));
    },
    async request(route: string, parameters: Record<string, unknown>) {
        if (route === 'GET /repos/{owner}/{repo}') return { data: { default_branch: 'main' } };
        if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
            const number = parameters.pull_number as number;
            if (number === 500) return { data: { merged: epicPrMerged, ...epicPullRequest() } };
            if (number === 501) return { data: { merged: false, state: 'open', merged_at: null, base: { ref: 'main' } } };
            const child = number === 201 ? { merged_at: childMergedAt } : additionalChildren.find(pr => pr.number === number);
            return { data: { merged_at: child?.merged_at ?? null, base: { ref: EPIC_BRANCH } } };
        }
        if (route === 'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}') {
            comments.find(comment => comment.id === parameters.comment_id)!.body = parameters.body as string;
        } else {
            assert.equal(route, 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments');
            comments.push({ id: comments.length + 1, issue_number: parameters.issue_number as number,
                body: parameters.body as string, user: { login: 'propr-dev[bot]' } });
        }
        return { data: {} };
    },
};
// Holds the next progress update open, as if its GitHub requests were in flight.
let holdNextProgressUpdate: { until: Promise<void>; onHeld: () => void } | null = null;
await mock.module('../packages/core/src/webhook/epicMergeProgress.js', { namedExports: {
    ...actualProgress,
    updateEpicMergeProgress: async (request: Record<string, unknown>, correlationId: string, dependencies: import('../packages/core/src/webhook/epicMergeProgress.js').EpicMergeProgressDependencies) => {
        if (failingProgressUpdates > 0) {
            failingProgressUpdates--;
            throw new Error('GitHub comment request failed');
        }
        const hold = holdNextProgressUpdate;
        holdNextProgressUpdate = null;
        if (hold) {
            hold.onHeld();
            await hold.until;
        }
        if (useRealProgress) await actualProgress.updateEpicMergeProgress(
            request as unknown as import('../packages/core/src/webhook/epicMergeProgress.js').EpicMergeProgressRequest,
            correlationId, { ...dependencies, getOctokit: async () => progressOctokit },
        );
        progressRequests.push(request);
        if (completionNotices === 0) completionNotices++;
    },
} });

const { handleEpicPRCreationOnMerge, retryPendingEpicMergeProgress } = await import('../packages/core/src/webhook/epicPRHandler.js');
const logger = (await import('../packages/core/src/utils/logger.js')).default;

beforeEach(() => {
    planIssueRows = initialPlanIssueRows();
    failingPlanListReads = 0;
    failingEpicLookups = 0;
    epicPrExists = true;
    closedHistoryCount = 0;
    epicPrMerged = false;
    epicBase = 'main';
    childMergedAt = '2026-10-10T19:00:00Z';
    childMergeCommitSha = null;
    epicHeadSha = null;
    compareAheadBy = 1;
    epicCreationRefusal = null;
    failingChildReads = 0;
    githubRequests.length = 0;
    bodyUpdates.length = 0;
    failingEpicCreations = 0;
    createdEpicPRs = 0;
    epicPRCreations.length = 0;
    onIssueFetch = () => {};
    failingProgressUpdates = 0;
    completionNotices = 0;
    useRealProgress = false;
    failingHistoryReads = 0;
    additionalChildren = [];
    onHistoryRead = () => {};
    comments.length = 0;
    holdNextProgressUpdate = null;
    progressRequests.length = 0;
    redis = fakeRedis();
});

/** Makes every recorded retry due, as if its backoff had elapsed. */
function elapseRetryBackoff() {
    for (const [field, value] of redis.hash) redis.hash.set(field, JSON.stringify({ ...JSON.parse(value), nextAttemptAt: 0 }));
}

/** A due obligation whose epic PR had been resolved when it was recorded. */
function seedSavedRetry(epicPrNumber: number, mergedChildPrNumber: number) {
    const target = { owner: 'integry', repo: 'propr', epicBranch: EPIC_BRANCH, epicPrNumber, mergedChildPrNumber };
    redis.hash.set(epicProgressRetryField(target), JSON.stringify({ ...target, attempts: 1, firstFailedAt: Date.now(), nextAttemptAt: 0 }));
}

const payload = {
    action: 'closed',
    pull_request: { number: 201, merged: true, base: { ref: EPIC_BRANCH } },
    repository: { default_branch: 'main', full_name: 'integry/propr', name: 'propr', owner: { login: 'integry' } },
} as unknown as PullRequestEvent;

test('skips the progress update when the plan cannot be read, keeping a retry', async () => {
    failingPlanListReads = Infinity;
    await handleEpicPRCreationOnMerge(payload, 'test', logger.withCorrelation('test'));
    assert.deepEqual(progressRequests, []);
    const [retry] = [...redis.hash.values()].map(value => JSON.parse(value));
    assert.equal(retry.epicPrNumber, null);
    assert.equal(retry.epicBranch, EPIC_BRANCH);
    assert.equal(retry.attempts, 1);
});

test('recovers the final merge after the plan becomes readable again', async () => {
    failingPlanListReads = Infinity;
    await handleEpicPRCreationOnMerge(payload, 'test', logger.withCorrelation('test'));
    // Not due yet: the backoff has not elapsed.
    assert.equal(await retryPendingEpicMergeProgress(), 0);
    assert.equal(progressRequests.length, 0);

    failingPlanListReads = 0;
    elapseRetryBackoff();
    assert.equal(await retryPendingEpicMergeProgress(), 1);
    assert.equal(progressRequests.length, 1);
    assert.equal((progressRequests[0].planIssues as unknown[]).length, 3);
    assert.equal(progressRequests[0].mergedChildPrNumber, 201);
    assert.equal(completionNotices, 1);
    assert.equal(redis.hash.size, 0);
});

test('recovers a failed comment write on the final merge with exactly one completion notice', async () => {
    failingProgressUpdates = 2;
    await handleEpicPRCreationOnMerge(payload, 'test', logger.withCorrelation('test'));
    assert.equal(completionNotices, 0);
    assert.equal(redis.hash.size, 1);

    // The first retry fails too; the obligation survives with a longer backoff.
    elapseRetryBackoff();
    assert.equal(await retryPendingEpicMergeProgress(), 0);
    const retry = JSON.parse([...redis.hash.values()][0]);
    assert.equal(retry.attempts, 2);
    assert.ok(retry.nextAttemptAt > Date.now());

    elapseRetryBackoff();
    assert.equal(await retryPendingEpicMergeProgress(), 1);
    assert.equal(completionNotices, 1);
    assert.equal(redis.hash.size, 0);

    // Nothing left to retry, so no further updates or notices.
    elapseRetryBackoff();
    assert.equal(await retryPendingEpicMergeProgress(), 0);
    assert.equal(progressRequests.length, 1);
    assert.equal(completionNotices, 1);
});

test('a successful update clears a retry left by an earlier failed merge', async () => {
    failingProgressUpdates = 1;
    await handleEpicPRCreationOnMerge(payload, 'test', logger.withCorrelation('test'));
    assert.equal(redis.hash.size, 1);
    await handleEpicPRCreationOnMerge(payload, 'test', logger.withCorrelation('test'));
    assert.equal(progressRequests.length, 1);
    assert.equal(redis.hash.size, 0);
});

test('retries a failed plan read and counts the planned issues once it recovers', async () => {
    failingPlanListReads = 1;
    await handleEpicPRCreationOnMerge(payload, 'test', logger.withCorrelation('test'));
    assert.equal(progressRequests.length, 1);
    assert.equal((progressRequests[0].planIssues as unknown[]).length, 3);
    assert.equal(progressRequests[0].planName, 'Big Plan');
});

test('recovers the final merge when the epic PR lookup fails', async () => {
    failingEpicLookups = 1;
    await handleEpicPRCreationOnMerge(payload, 'test', logger.withCorrelation('test'));
    assert.equal(progressRequests.length, 0);
    const [retry] = [...redis.hash.values()].map(value => JSON.parse(value));
    assert.equal(retry.epicPrNumber, null);
    assert.equal(retry.epicBranch, EPIC_BRANCH);
    assert.equal(retry.mergedChildPrNumber, 201);

    // GitHub recovers; the sweep resolves the epic PR and confirms completion.
    elapseRetryBackoff();
    assert.equal(await retryPendingEpicMergeProgress(), 1);
    assert.equal(progressRequests.length, 1);
    assert.equal(progressRequests[0].epicPrNumber, 500);
    assert.equal(progressRequests[0].mergedChildPrNumber, 201);
    assert.equal(completionNotices, 1);
    assert.equal(redis.hash.size, 0);
});

test('keeps the obligation when the epic PR lookup fails again during a retry', async () => {
    failingEpicLookups = 2;
    await handleEpicPRCreationOnMerge(payload, 'test', logger.withCorrelation('test'));
    elapseRetryBackoff();
    assert.equal(await retryPendingEpicMergeProgress(), 0);
    const retry = JSON.parse([...redis.hash.values()][0]);
    assert.equal(retry.epicPrNumber, null);
    assert.equal(retry.attempts, 2);

    elapseRetryBackoff();
    assert.equal(await retryPendingEpicMergeProgress(), 1);
    assert.equal(completionNotices, 1);
});

test('counts a child PR linked while the epic PR body was being updated', async () => {
    // Child B's PR is linked and merged while this handler waits on GitHub,
    // after it read the plan for the epic PR body but before it took the lease.
    onIssueFetch = () => { planIssueRows[1] = { ...planIssueRows[1], pr_number: 202, status: 'merged' }; };
    await handleEpicPRCreationOnMerge(payload, 'test', logger.withCorrelation('test'));
    assert.equal(progressRequests.length, 1);
    const planIssues = progressRequests[0].planIssues as PlanIssueRow[];
    assert.deepEqual(planIssues.map(issue => [issue.issue_number, issue.pr_number]), [[100, 201], [101, 202], [102, null]]);
});

test('creates the epic PR during a retry after its creation failed on the final merge', async () => {
    epicPrExists = false;
    failingEpicCreations = 1;
    await handleEpicPRCreationOnMerge(payload, 'test', logger.withCorrelation('test'));
    assert.equal(progressRequests.length, 0);
    assert.equal(createdEpicPRs, 0);
    const [retry] = [...redis.hash.values()].map(value => JSON.parse(value));
    assert.equal(retry.epicPrNumber, null);

    // GitHub recovers; there is still no epic PR, so the sweep creates it and confirms completion.
    elapseRetryBackoff();
    assert.equal(await retryPendingEpicMergeProgress(), 1);
    assert.equal(createdEpicPRs, 1);
    assert.equal(progressRequests.length, 1);
    assert.equal(progressRequests[0].epicPrNumber, 501);
    assert.equal(completionNotices, 1);
    assert.equal(redis.hash.size, 0);
});

test('keeps the obligation while the epic PR can be neither found nor created', async () => {
    epicPrExists = false;
    failingEpicCreations = 2;
    await handleEpicPRCreationOnMerge(payload, 'test', logger.withCorrelation('test'));
    elapseRetryBackoff();
    assert.equal(await retryPendingEpicMergeProgress(), 0);
    assert.equal(progressRequests.length, 0);
    assert.equal(completionNotices, 0);
    const retry = JSON.parse([...redis.hash.values()][0]);
    assert.equal(retry.epicPrNumber, null);
    assert.equal(retry.attempts, 2);

    elapseRetryBackoff();
    assert.equal(await retryPendingEpicMergeProgress(), 1);
    assert.equal(createdEpicPRs, 1);
    assert.equal(completionNotices, 1);
    assert.equal(redis.hash.size, 0);
});

test('creates the epic PR on the first child merge and tracks progress on it', async () => {
    epicPrExists = false;
    await handleEpicPRCreationOnMerge(payload, 'test', logger.withCorrelation('test'));
    assert.equal(createdEpicPRs, 1);
    assert.equal(epicPRCreations[0].title, '[Epic] Big Plan');
    assert.equal(epicPRCreations[0].head, EPIC_BRANCH);
    assert.equal(epicPRCreations[0].base, 'main');

    // The new epic PR's number and the plan's membership reach the progress update.
    assert.equal(progressRequests.length, 1);
    assert.equal(progressRequests[0].epicPrNumber, 501);
    assert.equal(progressRequests[0].epicBranch, EPIC_BRANCH);
    assert.equal(progressRequests[0].mergedChildPrNumber, 201);
    assert.equal(progressRequests[0].planName, 'Big Plan');
    const planIssues = progressRequests[0].planIssues as PlanIssueRow[];
    assert.deepEqual(planIssues.map(issue => issue.issue_number), [100, 101, 102]);
    assert.equal(completionNotices, 1);
    assert.equal(redis.hash.size, 0);
});

test('creates the epic PR without a plan and still tracks progress on it', async () => {
    epicPrExists = false;
    planIssueRows = [];
    await handleEpicPRCreationOnMerge(payload, 'test', logger.withCorrelation('test'));
    assert.equal(createdEpicPRs, 1);
    assert.equal(epicPRCreations[0].title, `[Epic] ${EPIC_BRANCH}`);
    assert.equal(progressRequests.length, 1);
    assert.equal(progressRequests[0].epicPrNumber, 501);
    assert.equal(progressRequests[0].planName, undefined);
    assert.equal(progressRequests[0].planIssues, undefined);
    assert.equal(redis.hash.size, 0);
});

test('overlapping child merge deliveries run one update at a time and the sweep delivers the deferred one', async () => {
    // Child #201 and child #202 merge back to back; the second delivery
    // arrives while the first one's progress update is still in flight.
    let releaseFirst!: () => void;
    let onHeld!: () => void;
    const held = new Promise<void>(resolve => { onHeld = resolve; });
    holdNextProgressUpdate = { until: new Promise<void>(resolve => { releaseFirst = resolve; }), onHeld };
    const secondPayload = { ...payload, pull_request: { ...payload.pull_request, number: 202 } } as unknown as PullRequestEvent;

    const first = handleEpicPRCreationOnMerge(payload, 'first', logger.withCorrelation('first'));
    await held;
    await handleEpicPRCreationOnMerge(secondPayload, 'second', logger.withCorrelation('second'));

    // The second delivery deferred instead of updating alongside the first.
    assert.equal(progressRequests.length, 0);
    assert.equal(redis.hash.size, 1);
    const [retry] = [...redis.hash.values()].map(value => JSON.parse(value));
    assert.equal(retry.mergedChildPrNumber, 202);
    assert.equal(retry.epicPrNumber, null);

    releaseFirst();
    await first;
    assert.equal(progressRequests.length, 1);
    assert.equal(progressRequests[0].mergedChildPrNumber, 201);
    // The first delivery's success does not release the obligation recorded after it started.
    assert.equal(redis.hash.size, 1);

    elapseRetryBackoff();
    assert.equal(await retryPendingEpicMergeProgress(), 1);
    assert.equal(progressRequests.length, 2);
    assert.equal(progressRequests[1].mergedChildPrNumber, 202);
    assert.equal(progressRequests[1].epicPrNumber, 500);
    assert.equal(redis.hash.size, 0);
});

const finalPayload = {
    ...payload,
    pull_request: {
        number: 500, merged: true, head: { ref: EPIC_BRANCH }, base: { ref: 'main' },
    },
} as unknown as PullRequestEvent;

test('the aggregate merge reports completion through the same retry lifecycle', async () => {
    failingProgressUpdates = 1;
    await handleEpicPRCreationOnMerge(finalPayload, 'test', logger.withCorrelation('test'));
    assert.equal(redis.hash.size, 1);
    assert.equal(JSON.parse([...redis.hash.values()][0]).mergedChildPrNumber, null);
    elapseRetryBackoff();
    assert.equal(await retryPendingEpicMergeProgress(), 1);
    assert.equal(progressRequests[0].epicPrNumber, 500);
    assert.equal(progressRequests[0].mergedChildPrNumber, null);
    assert.equal(redis.hash.size, 0);
    assert.equal(createdEpicPRs, 0);
});

test('closing an epic without merging, or merging an ordinary PR, posts nothing', async () => {
    await handleEpicPRCreationOnMerge({
        ...finalPayload, pull_request: { ...finalPayload.pull_request, merged: false },
    } as PullRequestEvent, 'test', logger.withCorrelation('test'));
    await handleEpicPRCreationOnMerge({
        ...finalPayload, pull_request: { ...finalPayload.pull_request, head: { ref: 'feature' } },
    } as PullRequestEvent, 'test', logger.withCorrelation('test'));
    assert.equal(progressRequests.length, 0);
    assert.equal(redis.hash.size, 0);
});

test('a delayed child delivery locates the already merged epic instead of creating another', async () => {
    epicPrMerged = true;
    await handleEpicPRCreationOnMerge(payload, 'test', logger.withCorrelation('test'));
    assert.equal(createdEpicPRs, 0);
    assert.equal(progressRequests[0].epicPrNumber, 500);
});


test('a child merged after the epic creates a new epic PR and reports progress there', async () => {
    epicPrMerged = true;
    childMergedAt = '2026-10-10T21:00:00Z';
    await handleEpicPRCreationOnMerge(payload, 'test', logger.withCorrelation('test'));
    assert.equal(createdEpicPRs, 1);
    assert.equal(progressRequests[0].epicPrNumber, 501);
    assert.equal(progressRequests[0].mergedChildPrNumber, 201);
    assert.deepEqual(bodyUpdates, []);
    assert.equal(redis.hash.size, 0);
});

for (const mergedAt of [null, 'invalid']) {
    test(`does not reuse a merged epic without an earlier child merge time (${mergedAt})`, async () => {
        epicPrMerged = true;
        childMergedAt = mergedAt;
        await handleEpicPRCreationOnMerge(payload, 'test', logger.withCorrelation('test'));
        assert.equal(createdEpicPRs, 1);
        assert.equal(progressRequests[0].epicPrNumber, 501);
    });
}

test('a child merged in the epic\'s second but after its head creates a successor', async () => {
    epicPrMerged = true;
    childMergedAt = '2026-10-10T20:00:00Z';
    childMergeCommitSha = 'c1';
    epicHeadSha = 'h1';
    compareAheadBy = 1;
    await handleEpicPRCreationOnMerge(payload, 'test', logger.withCorrelation('test'));
    assert.equal(createdEpicPRs, 1);
    assert.equal(progressRequests[0].epicPrNumber, 501);
    assert.equal(redis.hash.size, 0);
});

test('reuses a squash-merged epic from the same second once its pre-merge head proves inclusion', async () => {
    epicPrMerged = true;
    childMergedAt = '2026-10-10T20:00:00Z';
    childMergeCommitSha = 'c1';
    epicHeadSha = 'h1';
    compareAheadBy = 0;
    await handleEpicPRCreationOnMerge(payload, 'test', logger.withCorrelation('test'));
    assert.equal(createdEpicPRs, 0);
    assert.equal(progressRequests[0].epicPrNumber, 500);
    assert.equal(redis.hash.size, 0);
    assert.ok(githubRequests.includes('GET /repos/{owner}/{repo}/compare/{basehead}'));
});

for (const [detail, prepare] of [
    ['epic head', () => { epicHeadSha = null; }],
    ['child merge commit', () => { childMergeCommitSha = null; }],
] as const) {
    test(`a same-second child with no ${detail} evidence keeps the obligation rather than creating a successor`, async () => {
        epicPrMerged = true;
        childMergedAt = '2026-10-10T20:00:00Z';
        childMergeCommitSha = 'c1';
        epicHeadSha = 'h1';
        compareAheadBy = 0;
        prepare();
        await handleEpicPRCreationOnMerge(payload, 'test', logger.withCorrelation('test'));
        assert.equal(createdEpicPRs, 0);
        assert.equal(progressRequests.length, 0);
        assert.equal(redis.hash.size, 1);
    });
}

test('a successor refused for lack of commits attributes the child to the last merged epic', async () => {
    epicPrMerged = true;
    childMergedAt = '2026-10-10T21:00:00Z';
    epicCreationRefusal = `Validation Failed: No commits between main and ${EPIC_BRANCH}`;
    await handleEpicPRCreationOnMerge(payload, 'test', logger.withCorrelation('test'));
    assert.equal(createdEpicPRs, 0);
    assert.equal(progressRequests.length, 1);
    assert.equal(progressRequests[0].epicPrNumber, 500);
    assert.equal(progressRequests[0].mergedChildPrNumber, 201);
    assert.equal(redis.hash.size, 0);
    // The settled epic is not re-read before each write.
    assert.equal(githubRequests.filter(route => route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}:500').length, 0);
});

test('a successor refused for lack of commits keeps the obligation when no merged epic exists', async () => {
    epicPrExists = false;
    epicCreationRefusal = `Validation Failed: No commits between main and ${EPIC_BRANCH}`;
    await handleEpicPRCreationOnMerge(payload, 'test', logger.withCorrelation('test'));
    assert.equal(createdEpicPRs, 0);
    assert.equal(progressRequests.length, 0);
    assert.equal(redis.hash.size, 1);
});

test('other 422 refusals of a successor keep the obligation', async () => {
    epicPrMerged = true;
    childMergedAt = '2026-10-10T21:00:00Z';
    epicCreationRefusal = 'Validation Failed: A pull request already exists';
    await handleEpicPRCreationOnMerge(payload, 'test', logger.withCorrelation('test'));
    assert.equal(progressRequests.length, 0);
    assert.equal(redis.hash.size, 1);
});

test('a merged epic\'s child evidence is read once and reused by every containment check', async () => {
    epicPrMerged = true;
    await handleEpicPRCreationOnMerge(payload, 'test', logger.withCorrelation('test'));
    assert.equal(progressRequests[0].epicPrNumber, 500);
    assert.equal(githubRequests.filter(route => route === 'GET /repos/{owner}/{repo}').length, 1);
    assert.equal(githubRequests.filter(route => route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}:201').length, 1);
    // The epic itself is re-read for every check, as its state can change.
    assert.equal(githubRequests.filter(route => route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}:500').length, 3);
});

test('concurrent late child merges resolve the successor under the lease, creating it once', async () => {
    epicPrMerged = true;
    childMergedAt = '2026-10-10T21:00:00Z';
    let releaseFirst!: () => void;
    let onHeld!: () => void;
    const held = new Promise<void>(resolve => { onHeld = resolve; });
    // The first delivery is held while creating the successor's body.
    onIssueFetch = () => { onIssueFetch = () => {}; onHeld(); return new Promise<void>(resolve => { releaseFirst = resolve; }); };
    const secondPayload = { ...payload, pull_request: { ...payload.pull_request, number: 202 } } as unknown as PullRequestEvent;

    const first = handleEpicPRCreationOnMerge(payload, 'first', logger.withCorrelation('first'));
    await held;
    await handleEpicPRCreationOnMerge(secondPayload, 'second', logger.withCorrelation('second'));
    // The second delivery deferred before looking the epic up or creating anything.
    assert.equal(createdEpicPRs, 0);
    assert.equal(redis.hash.size, 1);
    assert.equal(JSON.parse([...redis.hash.values()][0]).mergedChildPrNumber, 202);

    releaseFirst();
    await first;
    assert.equal(createdEpicPRs, 1);
    assert.equal(progressRequests[0].epicPrNumber, 501);
    elapseRetryBackoff();
    assert.equal(await retryPendingEpicMergeProgress(), 1);
    assert.equal(createdEpicPRs, 1);
    assert.equal(progressRequests[1].epicPrNumber, 501);
    assert.equal(progressRequests[1].mergedChildPrNumber, 202);
    assert.equal(redis.hash.size, 0);
});

test('prefers the open successor even when a merged epic appears first in the lookup', async () => {
    epicPrMerged = true;
    createdEpicPRs = 1;
    await handleEpicPRCreationOnMerge(payload, 'test', logger.withCorrelation('test'));
    assert.equal(createdEpicPRs, 1);
    assert.deepEqual(bodyUpdates, [501]);
    assert.equal(progressRequests[0].epicPrNumber, 501);
});

test('a late child retry resolves an unknown epic to a new PR', async () => {
    epicPrMerged = true;
    childMergedAt = '2026-10-10T21:00:00Z';
    failingEpicLookups = 1;
    await handleEpicPRCreationOnMerge(payload, 'test', logger.withCorrelation('test'));
    assert.equal(JSON.parse([...redis.hash.values()][0]).epicPrNumber, null);
    elapseRetryBackoff();
    assert.equal(await retryPendingEpicMergeProgress(), 1);
    assert.equal(createdEpicPRs, 1);
    assert.equal(progressRequests[0].epicPrNumber, 501);
    assert.equal(redis.hash.size, 0);
});

test('revalidates a saved epic PR before releasing a late child retry', async () => {
    childMergedAt = '2026-10-10T21:00:00Z';
    seedSavedRetry(500, 201);
    epicPrMerged = true;
    failingEpicCreations = 1;
    assert.equal(await retryPendingEpicMergeProgress(), 0);
    assert.equal(redis.hash.size, 1);
    assert.equal(progressRequests.length, 0);
    elapseRetryBackoff();
    assert.equal(await retryPendingEpicMergeProgress(), 1);
    assert.equal(createdEpicPRs, 1);
    assert.equal(progressRequests[0].epicPrNumber, 501);
    assert.equal(redis.hash.size, 0);
});

test('revalidates an open lookup after awaited body reads reveal an earlier epic merge', async () => {
    childMergedAt = '2026-10-10T21:00:00Z';
    onIssueFetch = () => { epicPrMerged = true; };
    await handleEpicPRCreationOnMerge(payload, 'test', logger.withCorrelation('test'));
    assert.equal(createdEpicPRs, 1);
    assert.equal(progressRequests[0].epicPrNumber, 501);
    assert.equal(redis.hash.size, 0);
});

test('keeps the obligation when child containment cannot be read and recovers on retry', async () => {
    epicPrMerged = true;
    failingChildReads = 1;
    await handleEpicPRCreationOnMerge(payload, 'test', logger.withCorrelation('test'));
    assert.equal(progressRequests.length, 0);
    assert.equal(redis.hash.size, 1);
    elapseRetryBackoff();
    assert.equal(await retryPendingEpicMergeProgress(), 1);
    assert.equal(createdEpicPRs, 0);
    assert.equal(progressRequests[0].epicPrNumber, 500);
    assert.equal(redis.hash.size, 0);
});


test('does not create a successor after losing the lease during its body reads', async () => {
    childMergedAt = '2026-10-10T21:00:00Z';
    failingProgressUpdates = 1;
    await handleEpicPRCreationOnMerge(payload, 'test', logger.withCorrelation('test'));
    epicPrMerged = true;
    onIssueFetch = () => redis.loseLease();
    elapseRetryBackoff();
    assert.equal(await retryPendingEpicMergeProgress(), 0);
    assert.equal(createdEpicPRs, 0);
    assert.equal(progressRequests.length, 0);
    assert.equal(redis.hash.size, 1);

    onIssueFetch = () => {};
    elapseRetryBackoff();
    assert.equal(await retryPendingEpicMergeProgress(), 1);
    assert.equal(createdEpicPRs, 1);
    assert.equal(progressRequests[0].epicPrNumber, 501);
    assert.equal(redis.hash.size, 0);
});

test('refreshes plan membership after resolving a successor for a saved retry', async () => {
    childMergedAt = '2026-10-10T21:00:00Z';
    failingProgressUpdates = 1;
    await handleEpicPRCreationOnMerge(payload, 'test', logger.withCorrelation('test'));
    epicPrMerged = true;
    onIssueFetch = () => { planIssueRows[1] = { ...planIssueRows[1], pr_number: 202, status: 'merged' }; };
    elapseRetryBackoff();
    assert.equal(await retryPendingEpicMergeProgress(), 1);
    assert.equal(progressRequests[0].epicPrNumber, 501);
    const planIssues = progressRequests[0].planIssues as PlanIssueRow[];
    assert.equal(planIssues[1].pr_number, 202);
    assert.equal(redis.hash.size, 0);
});

for (const aggregateFirst of [true, false]) {
    for (const secondFails of [true, false]) {
        test(`preserves independent aggregate and successor retries (aggregate first: ${aggregateFirst}, second fails: ${secondFails})`, async () => {
            useRealProgress = true;
            epicPrMerged = true;
            childMergedAt = '2026-10-10T21:00:00Z';
            const first = aggregateFirst ? finalPayload : payload;
            const second = aggregateFirst ? payload : finalPayload;
            failingProgressUpdates = 1;
            await handleEpicPRCreationOnMerge(first, 'test', logger.withCorrelation('test'));
            const [firstField, firstValue] = [...redis.hash.entries()][0];
            failingProgressUpdates = secondFails ? 1 : 0;
            await handleEpicPRCreationOnMerge(second, 'test', logger.withCorrelation('test'));
            assert.equal(createdEpicPRs, 1);
            assert.equal(redis.hash.get(firstField), firstValue);
            assert.equal(redis.hash.size, secondFails ? 2 : 1);

            elapseRetryBackoff();
            assert.equal(await retryPendingEpicMergeProgress(), secondFails ? 2 : 1);
            assert.equal(redis.hash.size, 0);
            assert.equal(comments.filter(c => c.issue_number === 500 && c.body.includes(actualProgress.EPIC_FINAL_MERGE_MARKER)).length, 1);
            assert.ok(comments.some(c => c.issue_number === 500 && c.body.includes(actualProgress.EPIC_PROGRESS_MARKER) && c.body.includes('merged into main')));
            assert.ok(comments.some(c => c.issue_number === 501 && c.body.includes(actualProgress.EPIC_PROGRESS_MARKER)));
            assert.equal(await retryPendingEpicMergeProgress(), 0);
        });
    }
}

test('redirecting a saved child retry does not fulfil the original epic confirmation', async () => {
    childMergedAt = '2026-10-10T21:00:00Z';
    failingProgressUpdates = 1;
    await handleEpicPRCreationOnMerge(payload, 'test', logger.withCorrelation('test'));
    epicPrMerged = true;
    failingProgressUpdates = 1;
    await handleEpicPRCreationOnMerge(finalPayload, 'test', logger.withCorrelation('test'));
    assert.equal(redis.hash.size, 2);
    // Only the child retry is due; its success on #501 cannot release #500.
    for (const [field, value] of redis.hash) {
        if (JSON.parse(value).mergedChildPrNumber !== null) redis.hash.set(field, JSON.stringify({ ...JSON.parse(value), nextAttemptAt: 0 }));
    }
    assert.equal(await retryPendingEpicMergeProgress(), 1);
    assert.equal(progressRequests[0].epicPrNumber, 501);
    assert.equal(redis.hash.size, 1);
    assert.equal(JSON.parse([...redis.hash.values()][0]).mergedChildPrNumber, null);
    elapseRetryBackoff();
    assert.equal(await retryPendingEpicMergeProgress(), 1);
    assert.equal(progressRequests[1].epicPrNumber, 500);
    assert.equal(redis.hash.size, 0);
});

for (const merged of [true, false]) {
    test(`finds an eligible epic beyond the first page (merged: ${merged})`, async () => {
        closedHistoryCount = 100;
        epicPrMerged = merged;
        await handleEpicPRCreationOnMerge(payload, 'test', logger.withCorrelation('test'));
        assert.equal(createdEpicPRs, 0);
        assert.equal(progressRequests[0].epicPrNumber, 500);
    });
}

for (const base of ['release/next', '200-epic-other-plan-abc']) {
    test(`does not report a final aggregate merge into ${base}`, async () => {
        const event = { ...finalPayload, pull_request: { ...finalPayload.pull_request, base: { ref: base } } } as PullRequestEvent;
        await handleEpicPRCreationOnMerge(event, 'test', logger.withCorrelation('test'));
        assert.ok(!progressRequests.some(r => r.mergedChildPrNumber === null));
        if (base.includes('-epic-')) assert.ok(progressRequests.some(r => r.epicBranch === base));
        else assert.equal(progressRequests.length, 0);
    });
}

test('reports aggregate merges into a non-main default branch', async () => {
    const event = {
        ...finalPayload,
        repository: { ...finalPayload.repository, default_branch: 'trunk' },
        pull_request: { ...finalPayload.pull_request, base: { ref: 'trunk' } },
    } as PullRequestEvent;
    await handleEpicPRCreationOnMerge(event, 'test', logger.withCorrelation('test'));
    assert.equal(progressRequests[0].mergedChildPrNumber, null);
});

test('history failure retains the successor obligation until scoped progress is written', async () => {
    useRealProgress = true;
    epicPrMerged = true;
    childMergedAt = '2026-10-10T21:00:00Z';
    failingHistoryReads = 1;
    await handleEpicPRCreationOnMerge(payload, 'test', logger.withCorrelation('test'));
    assert.equal(createdEpicPRs, 1);
    assert.equal(comments.length, 0);
    assert.equal(redis.hash.size, 1);
    elapseRetryBackoff();
    assert.equal(await retryPendingEpicMergeProgress(), 1);
    assert.equal(redis.hash.size, 0);
    assert.ok(comments.some(c => c.issue_number === 501 && c.body.includes('1 out of 3 PRs merged')));
});

for (const savedRetry of [false, true]) {
    test(`non-default merged aggregate cannot discharge child work (saved retry: ${savedRetry})`, async () => {
        useRealProgress = true;
        if (savedRetry) seedSavedRetry(500, 201);
        epicPrMerged = true;
        epicBase = 'release/next';
        if (savedRetry) {
            assert.equal(await retryPendingEpicMergeProgress(), 1);
        } else {
            await handleEpicPRCreationOnMerge(payload, 'test', logger.withCorrelation('test'));
        }
        assert.equal(createdEpicPRs, 1);
        assert.equal(epicPRCreations[0].base, 'main');
        assert.equal(progressRequests.at(-1)!.epicPrNumber, 501);
        assert.ok(!comments.some(c => c.issue_number === 500));
        assert.equal(redis.hash.size, 0);
    });
}

test('late child resolution skips body edits on an already merged epic', async () => {
    epicPrMerged = true;
    await handleEpicPRCreationOnMerge(payload, 'test', logger.withCorrelation('test'));
    assert.deepEqual(bodyUpdates, []);
    assert.equal(progressRequests[0].epicPrNumber, 500);
});

test('body refresh skips an epic that merges during awaited issue reads', async () => {
    onIssueFetch = () => { epicPrMerged = true; };
    await handleEpicPRCreationOnMerge(payload, 'test', logger.withCorrelation('test'));
    assert.deepEqual(bodyUpdates, []);
    assert.equal(progressRequests[0].epicPrNumber, 500);
});

test('original aggregate retry keeps successor child work outstanding until its own merge', async () => {
    useRealProgress = true;
    planIssueRows = [
        { issue_number: 100, draft_id: 'draft-1', pr_number: 201, status: 'merged' },
        { issue_number: 101, draft_id: 'draft-1', pr_number: 202, status: 'under_review' },
    ];
    epicPrMerged = true;
    failingProgressUpdates = 1;
    await handleEpicPRCreationOnMerge(finalPayload, 'test', logger.withCorrelation('test'));
    assert.equal(redis.hash.size, 1);
    additionalChildren = [{ number: 202, state: 'closed', merged_at: '2026-10-10T21:00:00Z' }];
    planIssueRows[1] = { ...planIssueRows[1], status: 'merged' };
    const nextPayload = { ...payload, pull_request: { ...payload.pull_request, number: 202 } } as PullRequestEvent;
    await handleEpicPRCreationOnMerge(nextPayload, 'test', logger.withCorrelation('test'));
    assert.equal(createdEpicPRs, 1);
    elapseRetryBackoff();
    assert.equal(await retryPendingEpicMergeProgress(), 1);
    const final = comments.find(c => c.issue_number === 500 && c.body.includes(actualProgress.EPIC_FINAL_MERGE_MARKER))!;
    assert.match(final.body, /1 out of 2 PRs merged/);
    assert.ok(!final.body.includes('All planned epic work'));
    assert.ok(!comments.some(c => c.issue_number === 501 && c.body.includes(actualProgress.EPIC_FINAL_MERGE_MARKER)));
    assert.equal(redis.hash.size, 0);
});

test('retargeting and merging during awaited history keeps the child retry and writes nothing', async () => {
    useRealProgress = true;
    onHistoryRead = () => { epicPrMerged = true; epicBase = 'release/next'; };
    await handleEpicPRCreationOnMerge(payload, 'test', logger.withCorrelation('test'));
    assert.equal(comments.length, 0);
    assert.equal(redis.hash.size, 1);
    onHistoryRead = () => {};
    elapseRetryBackoff();
    assert.equal(await retryPendingEpicMergeProgress(), 1);
    assert.equal(createdEpicPRs, 1);
    assert.equal(redis.hash.size, 0);
    assert.ok(comments.every(c => c.issue_number === 501));
});
