import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import type { PullRequestEvent } from '@octokit/webhooks-types';

const actualConnection = await import('../packages/core/src/db/connection.js');
const actualGithubAuth = await import('../packages/core/src/auth/githubAuth.js');
after(actualConnection.closeConnection);

const EPIC_BRANCH = '100-epic-big-plan-abc';
const planIssueRows = [
    { issue_number: 100, draft_id: 'draft-1', pr_number: 201, status: 'under_review' },
    { issue_number: 101, draft_id: 'draft-1', pr_number: null, status: 'pending' },
    { issue_number: 102, draft_id: 'draft-1', pr_number: null, status: 'pending' },
];
// Number of plan-issue list reads that fail before the database recovers.
let failingPlanListReads = 0;

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
        if (route === 'GET /repos/{owner}/{repo}/pulls') return { data: [{ number: 500, body: '' }] };
        if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}') return { data: { title: 'Issue' } };
        if (route === 'PATCH /repos/{owner}/{repo}/pulls/{pull_number}') return { data: {} };
        throw new Error(`Unexpected request ${route}`);
    } }),
} });
const progressRequests: Array<Record<string, unknown>> = [];
await mock.module('../packages/core/src/webhook/epicMergeProgress.js', { namedExports: {
    updateEpicMergeProgress: async (request: Record<string, unknown>) => { progressRequests.push(request); },
} });

const { handleEpicPRCreationOnMerge } = await import('../packages/core/src/webhook/epicPRHandler.js');
const logger = (await import('../packages/core/src/utils/logger.js')).default;

beforeEach(() => {
    failingPlanListReads = 0;
    progressRequests.length = 0;
});

const payload = {
    action: 'closed',
    pull_request: { number: 201, merged: true, base: { ref: EPIC_BRANCH } },
    repository: { full_name: 'integry/propr', name: 'propr', owner: { login: 'integry' } },
} as unknown as PullRequestEvent;

test('skips the progress update when the plan cannot be read', async () => {
    failingPlanListReads = Infinity;
    await handleEpicPRCreationOnMerge(payload, 'test', logger.withCorrelation('test'));
    assert.deepEqual(progressRequests, []);
});

test('retries a failed plan read and counts the planned issues once it recovers', async () => {
    failingPlanListReads = 1;
    await handleEpicPRCreationOnMerge(payload, 'test', logger.withCorrelation('test'));
    assert.equal(progressRequests.length, 1);
    assert.equal((progressRequests[0].planIssues as unknown[]).length, 3);
    assert.equal(progressRequests[0].planName, 'Big Plan');
});
