import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, mock, test } from 'node:test';
import { simpleGit } from 'simple-git';
import {
    cleanupPreparedVisualPreviewEvidence,
    prepareVisualPreviewEvidence,
} from '../packages/core/src/services/visualPreviewService.js';
import { refineWorkflowPreviews } from '../packages/core/src/workflow/repositoryWorkflow.js';
import type { ResolvedRepositoryWorkflow } from '../packages/core/src/workflow/repositoryWorkflow.js';
import * as pushSalvageExports from '../packages/core/src/git/pushSalvage.js';

type Prepared = Awaited<ReturnType<typeof prepareVisualPreviewEvidence>>;

// Instance Settings allow image previews; the workflow snapshot disables them.
const instanceSettings = { enabled: true, types: ['image' as const] };
const workflowWithoutPreviews = {
    revision: 'base-sha', baseBranch: 'main', fileRevision: 'blob-sha',
    config: { previews: { types: [] } }, timeoutMs: 1000, maxParallelTasks: 0,
} as unknown as ResolvedRepositoryWorkflow;

const prepared: Prepared[] = [];
const settingsLoads = mock.fn(async () => instanceSettings);
const stopAfterPreviews = new Error('stop after preview preparation');
const noOp = async () => undefined;
const log = { debug() {}, info() {}, warn() {}, error() {} };

await mock.module('@propr/core', {
    namedExports: {
        ...pushSalvageExports,
        // Real preview preparation and workflow refinement; only the evidence is recorded.
        prepareVisualPreviewEvidence: async (options: Parameters<typeof prepareVisualPreviewEvidence>[0]) => {
            const result = await prepareVisualPreviewEvidence(options);
            prepared.push(result);
            return result;
        },
        cleanupPreparedVisualPreviewEvidence: noOp,
        refineWorkflowPreviews,
        loadRepositoryVisualPreviewSettings: settingsLoads,
        // Stop each run once previews are prepared and before anything is published.
        commitChanges: async () => { throw stopAfterPreviews; },
        createWorktreeForIssue: async (_path: string, _issue: unknown, options: unknown) => { worktreeOptions.push(options); return worktreeInfo; },
        materializeSubmissionAttachments: noOp,
        updateFileChangesFromWorktree: async () => [],
        pushBranch: noOp,
        cleanupWorktree: noOp,
        safeUpdateLabels: async () => ({ success: true, removed: [], added: [], errors: [] }),
        generateCompletionComment: async () => '',
        describeAgentTermination: () => '',
        resolveAgentTerminationReason: () => undefined,
        sanitizeAgentReport: (value: string | null | undefined) => value ?? '',
        redactSecrets: (value: string) => value,
        getAuthenticatedOctokit: noOp,
        linkPRToPlanIssue: noOp,
        validatePRCreation: noOp,
        appendVisualPreviewSection: (body: string) => body,
        renderVisualPreviewSection: () => '',
        renderVisualPreviewUploadFailureSection: () => '',
        db: noOp,
        AI_COMMIT_AUTHOR: { name: 'ProPR AI', email: 'ai@propr.dev' },
        TaskStates: { CANCELLED: 'cancelled', COMPLETED: 'completed' },
        VISUAL_PREVIEW_SLOT: '<!-- slot -->',
    },
});

const agentPreviewSettings: unknown[] = [];
await mock.module('../src/jobs/issueJob/agent.js', {
    namedExports: {
        executeAgentAndRecordMetrics: async (params: { visualPreviewSettings: unknown }) => {
            agentPreviewSettings.push(params.visualPreviewSettings);
            return { success: true, summary: 'Done', modifiedFiles: [], commitMessage: null };
        },
    },
});
await mock.module('../src/jobs/issueJob/github.js', { namedExports: { fetchIssueComments: async () => [] } });
await mock.module('../src/jobs/issueJobHelpers.js', { namedExports: { createPullRequest: noOp, ensureEpicBaseBranchExists: noOp } });
await mock.module('../src/jobs/issueJobPostProcessingHelpers.js', { namedExports: { handleCreatedPlanIssuePR: noOp, handleNoCodeChanges: noOp } });
for (const [name, namedExports] of Object.entries({
    prCompletionComment: { buildCompletionComment: async () => '' },
    prCommentJobUtils: { buildCommitMessage: () => 'commit' },
    reviewCommentGatherer: { markReviewFindingsProcessed: noOp },
    reviewFindingSelector: { selectedReviewFeedbackIds: () => ({ findingIds: [], suggestionIds: [] }) },
    ultrafixJobHelpers: { resolveUltrafixHistoryMeta: async () => ({}) },
    prContinuation: { savePublicationCheckpoint: noOp },
    issueJobAutoAssignment: { autoAssignCompletedPullRequest: noOp },
    notificationRecap: { buildWorkNotificationRecap: () => '' },
})) {
    await mock.module(`../src/jobs/${name}.js`, { namedExports });
}
await mock.module('../src/github/visualPreviewAttachments.js', {
    namedExports: { isVisualPreviewUploadAuthenticationError: () => false, publishPullRequestCommentVisualPreviews: noOp },
});

const { executeWorktreeOperations } = await import('../src/jobs/issueJob/worktree.js');
const { handlePostExecution } = await import('../src/jobs/prCommentPostExecution.js');

let worktreeInfo: { worktreePath: string; branchName: string };
const worktreeOptions: unknown[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(prepared.splice(0).map(result => cleanupPreparedVisualPreviewEvidence(result)));
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
    agentPreviewSettings.length = 0;
    settingsLoads.mock.resetCalls();
});

/** A worktree holding a valid image preview, as a repository lifecycle command could leave it. */
async function worktreeWithPreview() {
    const worktreePath = await mkdtemp(path.join(tmpdir(), 'propr-workflow-previews-'));
    temporaryDirectories.push(worktreePath);
    const git = simpleGit(worktreePath);
    await git.init();
    await git.addConfig('user.name', 'ProPR Test');
    await git.addConfig('user.email', 'test@propr.dev');
    await writeFile(path.join(worktreePath, 'README.md'), 'fixture');
    await git.add('.');
    await git.commit('initial');
    await mkdir(path.join(worktreePath, '.propr/previews'), { recursive: true });
    await writeFile(path.join(worktreePath, '.propr/previews/desktop.png'), 'desktop');
    await writeFile(path.join(worktreePath, '.propr/previews/manifest.json'), JSON.stringify({
        previews: [{ path: 'desktop.png', title: 'Desktop' }],
    }));
    await git.add('.propr/previews');
    worktreeInfo = { worktreePath, branchName: 'propr/42-fix' };
    return worktreeInfo;
}

async function runIssue(repositoryWorkflow?: ResolvedRepositoryWorkflow) {
    await worktreeWithPreview();
    const issueRef = { repoOwner: 'owner', repoName: 'repo', number: 42 };
    await executeWorktreeOperations({
        job: { updateProgress: noOp },
        context: {
            repositoryWorkflow, issueRef, agentAlias: 'agent', modelName: 'model', taskId: 'task-42', jobId: 'job-42',
            correlatedLogger: log, stateManager: { getTaskState: async () => null },
            AI_PROCESSING_TAG: 'AI-processing', AI_DONE_TAG: 'AI-done', PR_LABEL: 'propr',
        },
        octokit: { request: async () => ({ data: {} }) },
        currentIssueData: { data: { title: 'Fix', body: '', labels: [], created_at: '', user: { login: 'author' } } },
        repoValidation: { isValid: true, repoData: { defaultBranch: 'main' } },
        githubToken: { token: 'token' },
        repoUrl: 'https://github.com/owner/repo.git',
        localRepoPath: '/repo',
    } as never);
}

test('an issue run publishes no preview evidence when its workflow disables every preview type', async () => {
    await runIssue(workflowWithoutPreviews);

    assert.equal(prepared.length, 1);
    assert.deepEqual(prepared[0].evidence.assets, []);
    assert.equal(settingsLoads.mock.callCount(), 1, 'post-processing must not reload unrestricted Settings');
    assert.equal((agentPreviewSettings[0] as { enabled: boolean }).enabled, false);
    // Hooks and validation come from the policy commit; the agent starts from that same commit.
    assert.deepEqual((worktreeOptions.at(-1) as { startRevision: unknown }).startRevision,
        { branch: workflowWithoutPreviews.baseBranch, revision: workflowWithoutPreviews.revision });
});

test('an issue run without a workflow restriction still prepares the same preview artifact', async () => {
    await runIssue();

    assert.deepEqual(prepared[0].evidence.assets.map(asset => asset.title), ['Desktop']);
    assert.equal((agentPreviewSettings[0] as { enabled: boolean }).enabled, true);
    assert.equal((worktreeOptions.at(-1) as { startRevision: unknown }).startRevision, null, 'without a policy the branch head is used');
});

async function runPullRequestPostExecution(visualPreviewSettings?: ReturnType<typeof refineWorkflowPreviews>) {
    await worktreeWithPreview();
    const context = { pullRequestNumber: 7, repoOwner: 'owner', repoName: 'repo', publication: {}, correlatedLogger: log };
    await assert.rejects(handlePostExecution({
        state: {
            octokit: {}, worktreeInfo, authorsText: '', unprocessedComments: [],
            claudeResult: { success: true, summary: 'Done' }, startingWorkComment: { data: { id: 1, html_url: '' } },
        },
        job: { data: {} }, taskId: 'task-7', stateManager: {}, context,
        unprocessedReviewComments: [], llm: null, redisClient: {}, prProcessingLockKey: 'lock', prProcessingLockToken: 'token',
        visualPreviewSettings,
    } as never, 'https://propr.test/tasks/task-7'), error => error === stopAfterPreviews);
}

test('a PR follow-up publishes no preview evidence when its workflow disables every preview type', async () => {
    await runPullRequestPostExecution(refineWorkflowPreviews(instanceSettings, workflowWithoutPreviews));

    assert.deepEqual(prepared[0].evidence.assets, []);
    assert.equal(settingsLoads.mock.callCount(), 0, 'post-execution must not reload unrestricted Settings');
});

test('a PR follow-up without a workflow restriction still prepares the same preview artifact', async () => {
    await runPullRequestPostExecution(refineWorkflowPreviews(instanceSettings));

    assert.deepEqual(prepared[0].evidence.assets.map(asset => asset.title), ['Desktop']);
});
