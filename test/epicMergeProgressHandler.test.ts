import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import type { PullRequestEvent } from '@octokit/webhooks-types';

const actualConnection = await import('../packages/core/src/db/connection.js');
const actualGithubAuth = await import('../packages/core/src/auth/githubAuth.js');
const actualCheckRunHelpers = await import('../packages/core/src/webhook/checkRunHelpers.js');
const { EPIC_PROGRESS_RETRY_KEY } = await import('../packages/core/src/webhook/epicMergeProgressRetry.js');
after(actualConnection.closeConnection);

const EPIC_BRANCH = '100-epic-big-plan-abc';
const planIssueRows = [
    { issue_number: 100, draft_id: 'draft-1', pr_number: 201, status: 'under_review' },
    { issue_number: 101, draft_id: 'draft-1', pr_number: null, status: 'pending' },
    { issue_number: 102, draft_id: 'draft-1', pr_number: null, status: 'pending' },
];
// Number of plan-issue list reads that fail before the database recovers.
let failingPlanListReads = 0;
// Number of epic PR lookups that fail before GitHub recovers.
let failingEpicLookups = 0;

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

await mock.module('../packages/core/src/db/connection.js', {
    namedExports: { ...actualConnection, db: (table: string) => fakeQuery(table) },
});
await mock.module('../packages/core/src/auth/githubAuth.js', { namedExports: {
    ...actualGithubAuth,
    getAuthenticatedOctokit: async () => ({ request: async (route: string) => {
        if (route === 'GET /repos/{owner}/{repo}/pulls') {
            if (failingEpicLookups > 0) {
                failingEpicLookups--;
                throw new Error('GitHub unavailable');
            }
            return { data: [{ number: 500, body: '' }] };
        }
        if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}') return { data: { title: 'Issue' } };
        if (route === 'PATCH /repos/{owner}/{repo}/pulls/{pull_number}') return { data: {} };
        throw new Error(`Unexpected request ${route}`);
    } }),
} });

/** In-memory Redis covering the retry hash, the lease, and their compare-and-delete/extend scripts. */
function fakeRedis() {
    const hash = new Map<string, string>();
    const keys = new Map<string, string>();
    return {
        hash,
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
            if (script.includes('HGET')) {
                if (hash.get(args[0]) !== args[1]) return 0;
                return Number(hash.delete(args[0]));
            }
            if (keys.get(key) !== args[0]) return 0;
            if (script.includes('PEXPIRE')) return 1;
            return Number(keys.delete(key));
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
await mock.module('../packages/core/src/webhook/epicMergeProgress.js', { namedExports: {
    updateEpicMergeProgress: async (request: Record<string, unknown>) => {
        if (failingProgressUpdates > 0) {
            failingProgressUpdates--;
            throw new Error('GitHub comment request failed');
        }
        progressRequests.push(request);
        if (completionNotices === 0) completionNotices++;
    },
} });

const { handleEpicPRCreationOnMerge, retryPendingEpicMergeProgress } = await import('../packages/core/src/webhook/epicPRHandler.js');
const logger = (await import('../packages/core/src/utils/logger.js')).default;

beforeEach(() => {
    failingPlanListReads = 0;
    failingEpicLookups = 0;
    failingProgressUpdates = 0;
    completionNotices = 0;
    progressRequests.length = 0;
    redis = fakeRedis();
});

/** Makes every recorded retry due, as if its backoff had elapsed. */
function elapseRetryBackoff() {
    for (const [field, value] of redis.hash) redis.hash.set(field, JSON.stringify({ ...JSON.parse(value), nextAttemptAt: 0 }));
}

const payload = {
    action: 'closed',
    pull_request: { number: 201, merged: true, base: { ref: EPIC_BRANCH } },
    repository: { full_name: 'integry/propr', name: 'propr', owner: { login: 'integry' } },
} as unknown as PullRequestEvent;

test('skips the progress update when the plan cannot be read, keeping a retry', async () => {
    failingPlanListReads = Infinity;
    await handleEpicPRCreationOnMerge(payload, 'test', logger.withCorrelation('test'));
    assert.deepEqual(progressRequests, []);
    const [retry] = [...redis.hash.values()].map(value => JSON.parse(value));
    assert.equal(retry.epicPrNumber, 500);
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
