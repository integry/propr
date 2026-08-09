import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

const request = mock.fn();
const graphql = mock.fn();

await mock.module('@propr/core', {
    namedExports: {
        getAuthenticatedOctokit: mock.fn(async () => ({ request, graphql })),
        logger: {
            info: mock.fn(), warn: mock.fn(), error: mock.fn(), debug: mock.fn(),
        },
        handleError: mock.fn(),
    },
});

const { enableAutoMerge } = await import('../src/github/autoMergeOperations.js');

beforeEach(() => {
    request.mock.resetCalls();
    graphql.mock.resetCalls();
});

test('treats an already enabled auto-merge request as idempotent success', async () => {
    request.mock.mockImplementationOnce(async () => ({
        data: { node_id: 'PR_node', merged: false, auto_merge: { enabled_at: 'now' } },
    }));

    assert.deepEqual(await enableAutoMerge({ owner: 'integry', repoName: 'propr', prNumber: 1806 }), {
        success: true,
        autoMergeEnabled: true,
    });
    assert.equal(graphql.mock.callCount(), 0);
});

test('treats a PR merged during an earlier attempt as idempotent success', async () => {
    request.mock.mockImplementationOnce(async () => ({
        data: { node_id: 'PR_node', merged: true, auto_merge: null },
    }));

    assert.deepEqual(await enableAutoMerge({ owner: 'integry', repoName: 'propr', prNumber: 1806 }), {
        success: true,
        autoMergeEnabled: false,
    });
    assert.equal(graphql.mock.callCount(), 0);
});
