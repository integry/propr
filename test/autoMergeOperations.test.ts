import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

/**
 * Arming must apply the policy decision only to the head it evaluated: a head
 * pushed between the evaluation and the arming request needs its own decision.
 */
let currentPullRequest: Record<string, unknown> = { node_id: 'PR_node', head: { sha: 'evaluated-head' }, base: { ref: 'main' } };
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

test('GitHub refusing to arm at all is reported as unavailable so callers merge directly', async () => {
    currentPullRequest = { ...currentPullRequest, head: { sha: 'evaluated-head' }, base: { ref: 'main' } };
    for (const message of ['Auto merge is not allowed for this repository', 'Pull request is in clean status']) {
        graphql.mock.mockImplementationOnce(async () => { throw Object.assign(new Error('GraphQL'), { errors: [{ message }] }); });
        const result = await enableAutoMerge({ owner: 'acme', repoName: 'repo', prNumber: 7, expectedHead });
        assert.deepEqual(result, { success: false, error: message, unavailable: true });
    }
    graphql.mock.mockImplementationOnce(async () => { throw Object.assign(new Error('GraphQL'), { errors: [{ message: 'Head sha did not match' }] }); });
    const other = await enableAutoMerge({ owner: 'acme', repoName: 'repo', prNumber: 7, expectedHead });
    assert.equal(other.unavailable, undefined);
});

test('the merge commit headline carries no title status slot', async () => {
    graphql.mock.resetCalls();
    currentPullRequest = { node_id: 'PR_node', title: '✅⑧ [12 by Claude Opus 5.5] Add retries', head: { sha: 'evaluated-head', label: 'acme:feature' }, base: { ref: 'main' } };
    await enableAutoMerge({ owner: 'acme', repoName: 'repo', prNumber: 7, mergeMethod: 'SQUASH', expectedHead });
    assert.equal(graphql.mock.calls[0].arguments[1].commitHeadline, '[12 by Claude Opus 5.5] Add retries (#7)');
    assert.equal(graphql.mock.calls[0].arguments[1].commitBody, null);

    graphql.mock.resetCalls();
    await enableAutoMerge({ owner: 'acme', repoName: 'repo', prNumber: 7, mergeMethod: 'MERGE', expectedHead });
    assert.equal(graphql.mock.calls[0].arguments[1].commitHeadline, 'Merge pull request #7 from acme/feature');
    assert.equal(graphql.mock.calls[0].arguments[1].commitBody, '[12 by Claude Opus 5.5] Add retries');

    graphql.mock.resetCalls();
    await enableAutoMerge({ owner: 'acme', repoName: 'repo', prNumber: 7, mergeMethod: 'SQUASH', commitHeadline: 'Given headline', expectedHead });
    assert.equal(graphql.mock.calls[0].arguments[1].commitHeadline, 'Given headline');
});
