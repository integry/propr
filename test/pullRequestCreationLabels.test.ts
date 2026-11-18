import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closeConnection } from '@propr/core';
import { createPullRequest } from '../src/jobs/issueJobHelpers.js';

/**
 * #3691: the `AI` and `llm-*` labels showed up twice on new pull requests.
 * Every way issue post-processing opens or finds its pull request must send
 * the processing and model labels in one call, and none for labels GitHub
 * already reports on the pull request.
 */

// The template fallback setting is read from the configuration database.
after(() => closeConnection());

type Label = { name: string };
type LabelCall = { issue_number: number; labels: string[] };

function githubFake(options: {
    create?: () => { number: number; labels?: Label[] };
    existing?: Array<{ number: number; labels?: Label[] }>;
    failLabels?: number;
} = {}) {
    const labelCalls: LabelCall[] = [];
    let failLabels = options.failLabels ?? 0;
    return {
        labelCalls,
        async request<T>(endpoint: string, params: Record<string, unknown>): Promise<T> {
            if (endpoint === 'POST /repos/{owner}/{repo}/pulls') {
                const created = (options.create ?? (() => ({ number: 9 })))();
                return { data: { html_url: `https://github.com/acme/app/pull/${created.number}`, title: params.title, ...created } } as T;
            }
            if (endpoint === 'GET /repos/{owner}/{repo}/pulls') {
                return { data: (options.existing ?? []).map(pr => ({ html_url: `https://github.com/acme/app/pull/${pr.number}`, title: 'Fix', base: { ref: 'main' }, ...pr })) } as T;
            }
            if (endpoint === 'POST /repos/{owner}/{repo}/issues/{issue_number}/labels') {
                if (failLabels > 0) {
                    failLabels -= 1;
                    throw Object.assign(new Error('Server error'), { status: 502 });
                }
                labelCalls.push({ issue_number: params.issue_number as number, labels: params.labels as string[] });
                return { data: [] } as T;
            }
            // Template lookups: the repository has no pull request template.
            if (endpoint === 'GET /repos/{owner}/{repo}/commits/{ref}') return { data: { sha: 'base-sha' } } as T;
            throw Object.assign(new Error('Not Found'), { status: 404 });
        },
    };
}

const logger = { info() {}, warn() {}, error() {}, debug() {} };

function create(octokit: ReturnType<typeof githubFake>) {
    return createPullRequest(octokit as never, { repoOwner: 'acme', repoName: 'app', number: 7, baseBranch: 'main' } as never, { branchName: '7-fix-login' } as never, {
        commitResult: null, claudeResult: null, modelName: 'claude-opus-4-5-20251101', repoValidation: {} as never, PR_LABEL: 'AI',
        correlatedLogger: logger as never, issueTitle: 'Fix login',
    });
}

test('a newly created pull request is labelled with one call', async () => {
    const octokit = githubFake();
    const result = await create(octokit);
    assert.equal(result.pr?.number, 9);
    assert.equal(octokit.labelCalls.length, 1);
    assert.equal(octokit.labelCalls[0].issue_number, 9);
    assert.equal(octokit.labelCalls[0].labels[0], 'AI');
    assert.match(octokit.labelCalls[0].labels[1], /^llm-/);
    assert.equal(octokit.labelCalls[0].labels.length, 2);
});

test('labels the creation response already reports are not sent again', async () => {
    const octokit = githubFake({ create: () => ({ number: 9, labels: [{ name: 'AI' }] }) });
    await create(octokit);
    assert.equal(octokit.labelCalls.length, 1);
    assert.equal(octokit.labelCalls[0].labels.length, 1);
    assert.match(octokit.labelCalls[0].labels[0], /^llm-/);
});

test('a pull request found after creation reports a duplicate is labelled with one call', async () => {
    const octokit = githubFake({
        create: () => { throw Object.assign(new Error('A pull request already exists'), { status: 422 }); },
        existing: [{ number: 12 }],
    });
    const result = await create(octokit);
    assert.equal(result.pr?.number, 12);
    assert.equal(octokit.labelCalls.length, 1);
    assert.equal(octokit.labelCalls[0].issue_number, 12);
});

test('an existing pull request that already has both labels is not labelled again', async () => {
    const first = githubFake();
    await create(first);
    const labels = first.labelCalls[0].labels.map(name => ({ name }));
    const octokit = githubFake({
        create: () => { throw Object.assign(new Error('A pull request already exists'), { status: 422 }); },
        existing: [{ number: 12, labels }],
    });
    await create(octokit);
    assert.equal(octokit.labelCalls.length, 0);
});

test('a label failure on a new pull request is not retried through the existing-PR fallback', async () => {
    let creations = 0;
    const octokit = githubFake({ create: () => { creations += 1; return { number: 9 }; }, failLabels: 1 });
    const started = Date.now();
    const result = await create(octokit);
    assert.equal(result.pr?.number, 9);
    assert.equal(creations, 1);
    // One failed attempt and one successful retry: a single applied label call.
    assert.equal(octokit.labelCalls.length, 1);
    assert.ok(Date.now() - started < 10_000);
});
