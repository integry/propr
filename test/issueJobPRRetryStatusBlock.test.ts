import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

/**
 * The API retry is a second way an issue pull request is created. Like normal
 * creation, it must open the pull request with the status block already first
 * in its body, not rely on a later status write to add it.
 */

const BLOCK = '<!-- propr:pr-status -->\n**ProPR** 🔨 Implementing · updated 09:41 UTC\n<!-- /propr:pr-status -->';

let initialBlock: string | null = BLOCK;
const created: Array<Record<string, unknown>> = [];
const blockRequests: string[] = [];

const octokit = {
    async request(route: string, options: Record<string, unknown>) {
        if (route === 'POST /repos/{owner}/{repo}/pulls') {
            created.push(options);
            return { data: { number: 77 } };
        }
        throw new Error(`Unexpected route ${route}`);
    },
};

await mock.module('@propr/core', {
    namedExports: {
        getAuthenticatedOctokit: async () => octokit,
        linkPRToPlanIssue: async () => undefined,
        initialPullRequestStatusBlock: async (repository: string) => {
            blockRequests.push(repository);
            return initialBlock;
        },
        initialPullRequestTitle: async (_repository: string, title: string) => `🔨 ${title}`,
    },
});

const { retryPRCreationViaAPI } = await import('../src/jobs/issueJobPRRetry.js');

const logger = { debug() {}, info() {}, warn() {}, error() {} } as never;

function retry() {
    return retryPRCreationViaAPI({
        worktreeInfo: { worktreePath: '/tmp/worktree', branchName: 'issue-12' } as never,
        issueRef: { repoOwner: 'integry', repoName: 'propr', number: 12 } as never,
        repoValidation: { isValid: true, repoData: { defaultBranch: 'main' } } as never,
        correlatedLogger: logger,
    });
}

beforeEach(() => {
    created.length = 0;
    blockRequests.length = 0;
    initialBlock = BLOCK;
});

test('a pull request the API retry creates opens with the status block first in its body', async () => {
    assert.deepEqual(await retry(), { number: 77 });

    assert.equal(created.length, 1);
    assert.deepEqual(blockRequests, ['integry/propr']);
    assert.equal(created[0].body, `${BLOCK}\n\nResolves #12\n\n_PR created via retry mechanism_`);
    assert.equal(created[0].title, '🔨 Fix issue #12');
});

test('a process that does not maintain the status creates the retry pull request with the body as before', async () => {
    initialBlock = null;
    await retry();

    assert.equal(created[0].body, 'Resolves #12\n\n_PR created via retry mechanism_');
});
