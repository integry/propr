import assert from 'node:assert/strict';
import { after, before, describe, mock, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * An implementation's pull request is assigned in post-processing, before task
 * completion records `tasks.pr_number`. Opening the task detail page in that
 * window must read the pull request's assignees, not the source issue's.
 */

const root = await mkdtemp(path.join(tmpdir(), 'auto-assign-task-pr-'));
process.env.DATA_DIR = root;
process.env.DB_FILENAME = path.join(root, 'core.sqlite');
process.env.NODE_ENV = 'test';

await mock.module('ioredis', {
    namedExports: {
        Redis: function Redis() {
            return { on: mock.fn(), connect: mock.fn(async () => {}), quit: mock.fn(async () => {}) };
        },
    },
});

const assigned: Record<number, Array<{ id: number; login: string }>> = { 7: [], 88: [] };
const github = {
    async request(route: string, parameters: Record<string, unknown>) {
        if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}') {
            const number = Number(parameters.issue_number);
            return { data: { number, assignees: (assigned[number] ?? []).map(user => ({ ...user, avatar_url: null })) } };
        }
        throw new Error(`Unexpected route ${route}`);
    },
};

const autoAssignImplementationPullRequest = mock.fn(async (options: { prNumber: number }) => {
    assigned[options.prNumber] = [{ id: 101, login: 'alice' }];
    return { status: 'assigned' };
});
await mock.module('../src/github/prAutoAssignment.js', {
    namedExports: { autoAssignImplementationPullRequest, recordAutoAssignmentEvent: mock.fn(async () => {}) },
});

const { db, runMigrations, closeConnection, syncTaskAssignees } = await import('@propr/core');
const { autoAssignCompletedPullRequest } = await import('../src/jobs/issueJobAutoAssignment.js');

const logger = { debug: mock.fn(), info: mock.fn(), warn: mock.fn(), error: mock.fn() } as never;

describe('autoAssignCompletedPullRequest', () => {
    before(async () => { await runMigrations(); });
    after(async () => {
        await closeConnection();
        await rm(root, { recursive: true, force: true });
    });

    test('records the pull request on the task before assigning, so a detail read syncs the pull request', async () => {
        await db('tasks').insert({ task_id: 'issue-7', repository: 'acme/widgets', task_type: 'issue', issue_number: 7 });

        await autoAssignCompletedPullRequest(
            { octokit: github as never, issueRef: { repoOwner: 'acme', repoName: 'widgets', number: 7 } as never, correlatedLogger: logger, taskId: 'issue-7' },
            { pr: { number: 88 } },
        );
        assert.equal(autoAssignImplementationPullRequest.mock.callCount(), 1);
        assert.equal((await db('tasks').where({ task_id: 'issue-7' }).first()).pr_number, 88);

        // The detail page opens before task completion runs.
        const detail = await syncTaskAssignees('issue-7', { github: github as never });
        assert.deepEqual(detail.subject, { owner: 'acme', repo: 'widgets', number: 88, kind: 'pull_request' });
        assert.deepEqual(detail.assignees.map(user => user.login), ['alice']);
    });
});
