import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

await mock.module('@propr/core', {
    namedExports: {
        logger: { info: () => undefined, warn: () => undefined },
        TaskStates: {},
        getExecutionLogDirectory: () => "/tmp/unused-linked-issue-test-logs",
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

describe('the linked issue acceptance criteria', () => {
    function issueOctokit(bodies: Record<number, string>, numbers: number[]) {
        return {
            graphql: async () => ({ repository: { pullRequest: { closingIssuesReferences: { nodes: numbers.map(number => ({ number })) } } } }),
            request: async (endpoint: string, options: { issue_number: number }) => endpoint.endsWith('/comments')
                ? { data: [] }
                : { data: { title: `Issue ${options.issue_number}`, body: bodies[options.issue_number] ?? '', labels: [], user: { login: 'someone' } } },
        } as never;
    }

    test('come from the first linked issue\'s full body, beyond the truncated objective', async () => {
        const body = `${'Context. '.repeat(200)}\n\n## Acceptance criteria\n\n- [ ] Parses the list\n- [ ] Shows the checklist\n`;
        const result = await fetchLinkedIssueContext(issueOctokit({ 12: body, 13: '## Acceptance criteria\n- other issue' }, [12, 13]),
            { data: { body: '', user: { login: 'bot' } } }, repoContext, { correlationId: 'c', correlatedLogger: logger });
        assert.ok(!result.context.includes('Parses the list'), 'the objective copy of the body is truncated');
        assert.deepEqual(result.acceptanceCriteria, [{ id: 'AC1', text: 'Parses the list' }, { id: 'AC2', text: 'Shows the checklist' }]);
    });

    test('are empty when the issue has no Acceptance criteria heading', async () => {
        const result = await fetchLinkedIssueContext(issueOctokit({ 12: 'Just fix it.' }, [12]),
            { data: { body: '', user: { login: 'bot' } } }, repoContext, { correlationId: 'c', correlatedLogger: logger });
        assert.deepEqual(result.acceptanceCriteria, []);
    });
});
