import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

await mock.module('@propr/core', {
    namedExports: {
        logger: { info: () => undefined, warn: () => undefined },
        TaskStates: {},
        db: () => undefined,
        filterCommentByAuthor: () => true,
    },
});await mock.module('../src/jobs/prCompletionComment.js', { namedExports: { buildCompletionComment: async () => '' } });

const { fetchLinkedIssueContext } = await import('../src/jobs/prCommentJobHelpers.ts');

const logger = { info: () => undefined, warn: () => undefined } as never;
const repoContext = { repoOwner: 'integry', repoName: 'propr', pullRequestNumber: 34 };

function octokit(nodes: unknown[] | Error) {
    return {
        graphql: async () => {
            if (nodes instanceof Error) throw nodes;
            return { repository: { pullRequest: { closingIssuesReferences: { nodes } } } };
        },
        request: async () => ({ data: { title: 'Issue', body: '', labels: [], user: { login: 'someone' } } }),
    } as never;
}

describe('the linked issue keeps its repository', () => {
    test('a closing reference to another repository keeps that repository', async () => {
        const result = await fetchLinkedIssueContext(octokit([
            { number: 77, repository: { name: 'tracker', owner: { login: 'acme' } } },
        ]), { data: { body: '', user: { login: 'bot' } } }, repoContext, { correlationId: 'c', correlatedLogger: logger });
        assert.deepEqual(result.linkedIssue, { owner: 'acme', repo: 'tracker', number: 77 });
    });

    test('a local closing reference is the pull request\'s repository', async () => {
        const result = await fetchLinkedIssueContext(octokit([
            { number: 12, repository: { name: 'propr', owner: { login: 'integry' } } },
        ]), { data: { body: '', user: { login: 'bot' } } }, repoContext, { correlationId: 'c', correlatedLogger: logger });
        assert.deepEqual(result.linkedIssue, { owner: 'integry', repo: 'propr', number: 12 });
    });

    test('the body fallback after a GraphQL failure is local', async () => {
        const result = await fetchLinkedIssueContext(octokit(new Error('graphql down')),
            { data: { body: 'Closes #12', user: { login: 'bot' } } }, repoContext, { correlationId: 'c', correlatedLogger: logger });
        assert.deepEqual(result.linkedIssue, { owner: 'integry', repo: 'propr', number: 12 });
    });

    test('no linked issue resolves none', async () => {
        const result = await fetchLinkedIssueContext(octokit([]),
            { data: { body: '', user: { login: 'bot' } } }, repoContext, { correlationId: 'c', correlatedLogger: logger });
        assert.equal(result.linkedIssue, null);
    });
});
