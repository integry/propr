import assert from 'node:assert/strict';
import { beforeEach, describe, mock, test } from 'node:test';
import * as pushSalvageExports from '../packages/core/src/git/pushSalvage.js';

/**
 * #3686: when post-processing did not leave a pull request, final validation
 * opened one through the API retry ("_PR created via retry mechanism_") or
 * found one, and never added the processing and model labels that normal
 * creation adds. Follow-up intake ignores plain comments on a pull request
 * without a processing label, so every later follow-up on these pull requests
 * (integry/propr#3643, integry/propr-site#222 and #226) was dropped.
 */

type PRInfo = { number: number; url: string; title: string; labels?: string[] };

let validation: { isValid: boolean; pr?: PRInfo } = { isValid: false };
const labelRequests: Array<{ issue_number: number; labels: string[] }> = [];
let labelFailures = 0;

const githubOctokit = {
    create: (async () => ({ data: { number: 77 } })) as () => Promise<{ data: { number: number; labels?: Array<{ name: string }> } }>,
    existing: [] as Array<{ number: number; labels?: Array<{ name: string }> }>,
    async request(route: string, options: Record<string, unknown> = {}) {
        if (route === 'POST /repos/{owner}/{repo}/pulls') return await this.create();
        if (route === 'GET /repos/{owner}/{repo}/pulls') return { data: this.existing };
        if (route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/labels') {
            if (labelFailures > 0) {
                labelFailures -= 1;
                throw Object.assign(new Error('Server error'), { status: 502 });
            }
            labelRequests.push({ issue_number: options.issue_number as number, labels: options.labels as string[] });
            return { data: [] };
        }
        throw new Error(`Unexpected route ${route}`);
    },
};

await mock.module('@propr/core', {
    namedExports: {
        ...pushSalvageExports,
        AI_COMMIT_AUTHOR: { name: 'ProPR AI', email: 'ai@propr.dev' },
        pushBranch: mock.fn(),
        loadRepositoryVisualPreviewSettings: mock.fn(),
        cleanupWorktree: mock.fn(async () => undefined),
        cleanupPreparedVisualPreviewEvidence: mock.fn(async () => undefined),
        commitChanges: mock.fn(),
        prepareVisualPreviewEvidence: mock.fn(),
        TaskStates: { CANCELLED: 'cancelled' },
        describeAgentTermination: mock.fn(() => ''),
        resolveAgentTerminationReason: mock.fn(() => undefined),
        sanitizeAgentReport: (value: string | null | undefined) => value ?? '',
        getAuthenticatedOctokit: mock.fn(async () => githubOctokit),
        linkPRToPlanIssue: mock.fn(async () => undefined),
        safeUpdateLabels: mock.fn(async () => ({ success: true, removed: [], added: ['AI-done'], errors: [] })),
        generateCompletionComment: mock.fn(),
        redactSecrets: (value: string) => value,
        validatePRCreation: mock.fn(async () => validation),
        initialPullRequestStatusBlock: async () => null,
        initialPullRequestTitle: async (_repository: string, title: string) => title,
    },
});

await mock.module('../src/jobs/issueJobHelpers.js', {
    namedExports: {
        createPullRequest: mock.fn(),
        ensureEpicBaseBranchExists: mock.fn(),
        getPullRequestModelLabel: (_issueRef: unknown, modelName: string) => `llm-${modelName}`,
    },
});

await mock.module('../src/jobs/issueJobPostProcessingHelpers.js', {
    namedExports: { handleCreatedPlanIssuePR: mock.fn(), handleNoCodeChanges: mock.fn() },
});

await mock.module('../src/jobs/issueJobAutoAssignment.js', {
    namedExports: { autoAssignCompletedPullRequest: mock.fn(async () => undefined) },
});

const { handlePRValidation } = await import('../src/jobs/issueJobPostProcessing.js');
const { addPullRequestProcessingLabels } = await import('../src/jobs/pullRequestProcessingLabels.js');

const warnings: string[] = [];
const logger = { debug() {}, info() {}, warn: (_fields: unknown, message: string) => { warnings.push(message); }, error() {} } as never;

function validate(labelOptions: { PR_LABEL?: string; modelName?: string } = { PR_LABEL: 'AI', modelName: 'claude-opus-5-5' }) {
    return handlePRValidation({
        claudeResult: { success: true } as never,
        worktreeInfo: { worktreePath: '/tmp/worktree', branchName: 'issue-12' } as never,
        issueRef: { repoOwner: 'integry', repoName: 'propr', number: 12 } as never,
        octokit: githubOctokit as never,
        postProcessingResult: null,
        commitResult: { commitHash: 'abc' } as never,
        repoValidation: { isValid: true, repoData: { defaultBranch: 'main' } } as never,
        AI_PROCESSING_TAG: 'AI-processing', AI_DONE_TAG: 'AI-done',
        correlationId: 'corr', correlatedLogger: logger, jobId: 'job-1',
        ...labelOptions,
    });
}

beforeEach(() => {
    validation = { isValid: false };
    githubOctokit.create = async () => ({ data: { number: 77 } });
    githubOctokit.existing = [];
    labelRequests.length = 0;
    labelFailures = 0;
    warnings.length = 0;
});

describe('labels of a pull request recovered by final validation', () => {
    test('the API retry labels the pull request it creates like normal creation does', async () => {
        await validate();
        assert.deepEqual(labelRequests, [{ issue_number: 77, labels: ['AI', 'llm-claude-opus-5-5'] }]);
    });

    test('the API retry labels the existing pull request it finds after GitHub reports a duplicate', async () => {
        githubOctokit.create = async () => { throw Object.assign(new Error('A pull request already exists'), { status: 422 }); };
        githubOctokit.existing = [{ number: 81 }];
        await validate();
        assert.deepEqual(labelRequests, [{ issue_number: 81, labels: ['AI', 'llm-claude-opus-5-5'] }]);
    });

    test('a pull request found during final validation is labelled', async () => {
        validation = { isValid: true, pr: { number: 55, url: 'https://github.com/integry/propr/pull/55', title: 'Fix' } };
        await validate();
        assert.deepEqual(labelRequests, [{ issue_number: 55, labels: ['AI', 'llm-claude-opus-5-5'] }]);
    });

    test('a pull request found during final validation that already has its labels is not labelled again (#3691)', async () => {
        validation = { isValid: true, pr: { number: 55, url: 'https://github.com/integry/propr/pull/55', title: 'Fix', labels: ['AI', 'llm-claude-opus-5-5', 'ultrafix'] } };
        await validate();
        assert.deepEqual(labelRequests, []);
    });

    test('final validation sends only the labels the found pull request is missing', async () => {
        validation = { isValid: true, pr: { number: 55, url: 'https://github.com/integry/propr/pull/55', title: 'Fix', labels: ['AI'] } };
        await validate();
        assert.deepEqual(labelRequests, [{ issue_number: 55, labels: ['llm-claude-opus-5-5'] }]);
    });

    test('the API retry does not re-send labels the existing pull request already has', async () => {
        githubOctokit.create = async () => { throw Object.assign(new Error('A pull request already exists'), { status: 422 }); };
        githubOctokit.existing = [{ number: 81, labels: [{ name: 'AI' }, { name: 'llm-claude-opus-5-5' }] }];
        await validate();
        assert.deepEqual(labelRequests, []);
    });

    test('without a model the processing label is still added', async () => {
        await validate({ PR_LABEL: 'AI' });
        assert.deepEqual(labelRequests, [{ issue_number: 77, labels: ['AI'] }]);
    });
});

describe('addPullRequestProcessingLabels', () => {
    const ref = { repoOwner: 'integry', repoName: 'propr', prNumber: 90 };

    test('retries a transient failure', async () => {
        labelFailures = 2;
        assert.equal(await addPullRequestProcessingLabels(githubOctokit as never, ref, ['AI'], { correlatedLogger: logger, retryDelayMs: 0 }), true);
        assert.deepEqual(labelRequests, [{ issue_number: 90, labels: ['AI'] }]);
    });

    test('makes no call when the pull request already has every label', async () => {
        assert.equal(await addPullRequestProcessingLabels(githubOctokit as never, ref, ['AI', 'llm-x'], { correlatedLogger: logger, retryDelayMs: 0, presentLabels: ['llm-x', 'AI'] }), true);
        assert.deepEqual(labelRequests, []);
    });

    test('logs and reports a lasting failure instead of throwing', async () => {
        labelFailures = 5;
        assert.equal(await addPullRequestProcessingLabels(githubOctokit as never, ref, ['AI'], { correlatedLogger: logger, retryDelayMs: 0 }), false);
        assert.equal(labelRequests.length, 0);
        assert.match(warnings.join('\n'), /Failed to add processing labels/);
    });
});
