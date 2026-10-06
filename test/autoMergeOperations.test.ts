import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

/**
 * Arming must apply the policy decision only to the head it evaluated: a head
 * pushed between the evaluation and the arming request needs its own decision.
 */
let currentPullRequest = { node_id: 'PR_node', head: { sha: 'evaluated-head' }, base: { ref: 'main' } };
const graphql = mock.fn(async (_query: string, _variables: Record<string, unknown>) => ({
    enablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: { enabledAt: 'now', enabledBy: { login: 'propr-dev[bot]' }, mergeMethod: 'SQUASH' } } },
}));

await mock.module('@propr/core', {
    namedExports: {
        getAuthenticatedOctokit: async () => ({ request: async () => ({ data: currentPullRequest }), graphql }),
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        handleError: () => undefined,
    },
});

const { enableAutoMerge } = await import('../src/github/autoMergeOperations.js');

const expectedHead = { headSha: 'evaluated-head', baseRef: 'main' };

test('auto-merge is armed for the evaluated head, pinned so GitHub rejects a later head', async () => {
    graphql.mock.resetCalls();
    const result = await enableAutoMerge({ owner: 'acme', repoName: 'repo', prNumber: 7, mergeMethod: 'REBASE', expectedHead });
    assert.deepEqual(result, { success: true, autoMergeEnabled: true });
    assert.equal(graphql.mock.callCount(), 1);
    assert.equal(graphql.mock.calls[0].arguments[1].expectedHeadOid, 'evaluated-head');
});

test('a head pushed after the evaluation is not armed with the earlier decision', async () => {
    graphql.mock.resetCalls();
    currentPullRequest = { ...currentPullRequest, head: { sha: 'protected-head' } };
    const result = await enableAutoMerge({ owner: 'acme', repoName: 'repo', prNumber: 7, expectedHead });
    assert.equal(result.success, false);
    assert.equal(result.headChanged, true);
    assert.equal(graphql.mock.callCount(), 0);
});

test('a PR retargeted after the evaluation is not armed with the old base policy', async () => {
    graphql.mock.resetCalls();
    currentPullRequest = { ...currentPullRequest, head: { sha: 'evaluated-head' }, base: { ref: 'release' } };
    const result = await enableAutoMerge({ owner: 'acme', repoName: 'repo', prNumber: 7, expectedHead });
    assert.equal(result.headChanged, true);
    assert.equal(graphql.mock.callCount(), 0);
});
