import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

/**
 * When Ultrafix reaches its goal, CI has usually finished already, so no later
 * check event will merge the PR. If GitHub cannot arm auto-merge, Ultrafix
 * merges through ProPR's own gates instead, ignoring only its own job.
 */
const requests: Array<{ route: string; params: Record<string, unknown> }> = [];
const octokit = {
    request: async (route: string, params: Record<string, unknown>) => {
        requests.push({ route, params });
        if (route.startsWith('GET /repos/{owner}/{repo}/issues/')) return { data: { labels: [{ name: 'auto-merge' }] } };
        return { data: {} };
    },
};
const reevaluatePRAutoMerge = mock.fn(async (..._args: unknown[]) => undefined);
let armResult: Record<string, unknown> = { success: true, autoMergeEnabled: true };
const enableAutoMerge = mock.fn(async () => armResult);

await mock.module('@propr/core', {
    namedExports: {
        findPlanIssueByRepoAndPR: async () => ({ issue_number: 23 }),
        gateAutoMergeArming: async () => ({ arm: true, mergeMethod: 'SQUASH', pullRequest: { headSha: 'head', baseRef: 'epic' } }),
        getAuthenticatedOctokit: async () => octokit,
        reevaluatePRAutoMerge,
        retryConfigs: { githubApi: {} },
        safeRemoveLabel: async () => undefined,
        withRetry: async (fn: () => unknown) => fn(),
    },
});
await mock.module('../src/github/autoMergeOperations.js', { namedExports: { enableAutoMerge } });

const { maybeEnableAutoMerge } = await import('../src/jobs/ultrafixLoopGithub.js');
const pr = { owner: 'integry', repo: 'agent-tank-website', pullRequestNumber: 43 };
const log = { info() {}, warn() {}, error() {}, debug() {} } as never;
const comments = () => requests.filter(r => r.route.startsWith('POST /repos/{owner}/{repo}/issues/{issue_number}/comments'));

beforeEach(() => {
    requests.length = 0;
    reevaluatePRAutoMerge.mock.resetCalls();
});

test('a repository with auto-merge disabled gets a suggestion and a direct merge', async () => {
    armResult = { success: false, unavailable: true, error: 'Auto merge is not allowed for this repository' };
    await maybeEnableAutoMerge({ ...pr, correlationId: 'corr', currentJobId: 'pr-comments-batch-1' }, log);
    assert.equal(comments().length, 1);
    assert.match(String(comments()[0].params.body), /Allow auto-merge/);
    assert.deepEqual(reevaluatePRAutoMerge.mock.calls[0].arguments, ['integry', 'agent-tank-website', 43, { correlationId: 'corr', ignoreWorkIds: ['pr-comments-batch-1'] }]);
});

test('an already mergeable PR is merged directly without a settings comment', async () => {
    armResult = { success: false, unavailable: true, error: 'Pull request is in clean status' };
    await maybeEnableAutoMerge({ ...pr, correlationId: 'corr', currentJobId: 'job' }, log);
    assert.equal(comments().length, 0);
    assert.equal(reevaluatePRAutoMerge.mock.callCount(), 1);
});

test('armed auto-merge and other failures do not merge directly', async () => {
    armResult = { success: true, autoMergeEnabled: true };
    await maybeEnableAutoMerge(pr, log);
    armResult = { success: false, headChanged: true, error: 'Pull request head or base changed' };
    await maybeEnableAutoMerge(pr, log);
    assert.equal(reevaluatePRAutoMerge.mock.callCount(), 0);
    assert.equal(comments().length, 0);
});
