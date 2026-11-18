import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// Each run stops once the agent would start: only the start notice matters here.
const stopAtAgent = new Error('stop at agent');
const noOp = async () => undefined;
const log = { debug() {}, info() {}, warn() {}, error() {} };
let branchName = 'propr/42-fix';

await mock.module('@propr/core', { namedExports: {
    db: noOp,
    materializeSubmissionAttachments: noOp,
    createWorktreeForIssue: async () => ({ worktreePath: `/worktrees/${branchName}`, branchName }),
    pushBranch: noOp,
    TaskStates: { CANCELLED: 'cancelled', COMPLETED: 'completed' },
    updateFileChangesFromWorktree: async () => [],
    loadRepositoryVisualPreviewSettings: async () => ({ enabled: false, types: [] }),
    refineWorkflowPreviews: (settings: unknown) => settings,
} });
await mock.module('simple-git', { namedExports: { simpleGit: () => ({ revparse: async () => 'base-sha\n' }) } });
await mock.module('../src/taskReplacement/store.js', { namedExports: { recordPushedBranch: noOp } });
await mock.module('../src/jobs/issueJob/github.js', { namedExports: { fetchIssueComments: async () => [] } });
await mock.module('../src/jobs/issueJob/agent.js', { namedExports: { executeAgentAndRecordMetrics: async () => { throw stopAtAgent; } } });
await mock.module('../src/jobs/issueJobPostProcessing.js', { namedExports: { performPostProcessing: noOp } });
await mock.module('../src/jobs/blockedRunText.js', { namedExports: { workflowReportsBlockers: () => false } });

const { executeWorktreeOperations } = await import('../src/jobs/issueJob/worktree.js');

type Comment = { id: number; body: string; user: { type: string; login: string } };

function thread() {
    const comments: Comment[] = [];
    const request = async (route: string, params: { body?: string; comment_id?: number }) => {
        if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments') return { data: comments.map(comment => ({ ...comment })) };
        if (route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments') {
            const comment = { id: comments.length + 1, body: params.body!, user: { type: 'Bot', login: 'propr-dev[bot]' } };
            comments.push(comment);
            return { data: comment };
        }
        if (route === 'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}') {
            comments.find(comment => comment.id === params.comment_id)!.body = params.body!;
            return { data: {} };
        }
        throw new Error(`unexpected route ${route}`);
    };
    return { comments, octokit: { request } };
}

function startRun(octokit: unknown, taskId: string) {
    return assert.rejects(executeWorktreeOperations({
        job: { updateProgress: noOp },
        context: {
            issueRef: { repoOwner: 'owner', repoName: 'repo', number: 42 }, agentAlias: 'claude', modelName: 'opus',
            taskId, jobId: `job-${taskId}`, correlatedLogger: log, stateManager: { getTaskState: async () => null },
            AI_PROCESSING_TAG: 'AI-processing', AI_DONE_TAG: 'AI-done', PR_LABEL: 'propr',
        },
        octokit,
        currentIssueData: { data: { title: 'Fix', body: '', labels: [], created_at: '', user: { login: 'author' } } },
        repoValidation: { isValid: true, repoData: { defaultBranch: 'main' } },
        githubToken: { token: 'token' },
        repoUrl: 'https://github.com/owner/repo.git',
        localRepoPath: '/repo',
    } as never), stopAtAgent);
}

test('a retry of the same task updates its start notice instead of announcing a new run', async () => {
    const { comments, octokit } = thread();
    branchName = 'propr/42-fix';
    await startRun(octokit, 'task-42');
    // Rate-limit retries keep the task identity (an issue that may by now have its PR and done label).
    branchName = 'propr/42-fix-retry';
    await startRun(octokit, 'task-42');
    await startRun(octokit, 'task-42');
    assert.equal(comments.length, 1);
    assert.match(comments[0].body, /🤖 AI processing has started for this issue/);
    assert.match(comments[0].body, /Branch: `propr\/42-fix-retry`/, 'the notice shows the latest attempt');
    assert.match(comments[0].body, /Reported 3 times/);
});

test('a new task, a new run, posts its own start notice', async () => {
    const { comments, octokit } = thread();
    await startRun(octokit, 'task-42-opus');
    await startRun(octokit, 'task-42-sonnet');
    assert.equal(comments.length, 2);
});
