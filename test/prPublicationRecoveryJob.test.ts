import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import knex from 'knex';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHooklessGit as realGit } from '../packages/core/src/git/hooklessGit.js';
import { sanitizeAgentReport } from '../packages/core/src/agents/agentReportSanitizer.js';
import { up, down } from '../packages/core/src/db/migrations/20260914000000_add_pr_continuations.js';

import { up as checkpointUp, down as checkpointDown } from '../packages/core/src/db/migrations/20260914010000_add_pr_publication_checkpoint.js';

import { up as completionUp, down as completionDown } from '../packages/core/src/db/migrations/20260914020000_add_pr_publication_completion.js';

const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
await up(database);
await checkpointUp(database);
await completionUp(database);
const root = await mkdtemp(path.join(tmpdir(), 'pr-continuation-'));
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test Worker', '-c', 'user.email=worker@example.test', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
// All repositories are disposable fixtures; no workspace Git metadata is modified.
git(root, 'init', '--bare', 'upstream.git');
git(root, 'clone', path.join(root, 'upstream.git'), 'seed');
const seed = path.join(root, 'seed');
await writeFile(path.join(seed, 'base.txt'), 'base\n');
git(seed, 'add', '.'); git(seed, 'commit', '-m', 'Base');
git(seed, 'branch', '-M', 'release'); git(seed, 'push', 'origin', 'release');
const baseSha = git(seed, 'rev-parse', 'HEAD');
git(root, 'clone', '--bare', path.join(root, 'upstream.git'), 'fork.git');
git(seed, 'checkout', '-b', 'contribution');
await writeFile(path.join(seed, 'contributor.txt'), 'contribution\n');
git(seed, 'add', '.'); git(seed, 'commit', '--author=Original Contributor <contributor@example.test>', '-m', 'Contributor change');
const sourceSha = git(seed, 'rev-parse', 'HEAD');
git(seed, 'push', path.join(root, 'fork.git'), 'contribution');
// GitHub's PR refs make the contribution commit available in the upstream repository.
git(seed, 'push', 'origin', 'HEAD:refs/pull/42/head');

let probeError: Error | undefined;
let finalPushError: Error | undefined;
let continuationPushError: Error | undefined;
let failPRCreate = false;
let losePushResponse = false;
let comparisonError: Error | undefined;
let onPRCreated: (() => Promise<void>) | undefined;
const heldLocks = new Set<string>();
let forcePushBeforeClone = false;
let calls: Array<{ operation: string; args: unknown }> = [];
let cloneIndex = 0;
const token = 'ghs_worker_installation_token';
const repoPath = (owner: string) => path.join(root, owner === 'upstream' ? 'upstream.git' : 'fork.git');

let events: string[] = [];
let pendingComments: Array<{ id: number; body: string; author: string; type: string }> = [];
let restoredComments: unknown[] = [];
let skipValidation = false;
let prompts: string[] = [];
let produced: string[] = [];
let expectedAgentHead: string | undefined;
let afterAgentExecution: (() => Promise<void>) | undefined;
let completionBodies: string[] = [];
let failCompletion = false;
let failTaskCompletion = false;
const missingCommentIds = new Set<number>();
let promptHistories: string[] = [];
let partialResult = false;
let completedCheckHeads = new Set<string>();
let deferredReviews: Array<{ pr: number; nextAction: string; reason: string }> = [];
const log = { info() {}, warn() {}, error() {}, debug() {} };
const noOp = async () => {};
const completions: Array<{ taskId: string; metadata: any }> = [];
const taskStates = new Map<string, string>();
const stateManager = {
    getTaskState: async (taskId: string) => taskStates.has(taskId) ? { state: taskStates.get(taskId) } : null, updateHistoryMetadata: noOp,
    updateTaskState: async (taskId: string, state: string, metadata: any) => {
        if (state === 'completed' && failTaskCompletion) throw new Error('Task completion failed');
        if (taskStates.get(taskId) === 'failed' && !(state === 'processing' && metadata.isRetry === true)) return;
        taskStates.set(taskId, state);
        if (state === 'completed') { completions.push({ taskId, metadata }); events.push(`complete:${taskId}`); }
    },
};
await database.schema.createTable('tasks', table => { table.string('task_id'); table.string('commit_hash'); });
await mock.module('ioredis', { namedExports: { Redis: class {} } });
await mock.module('@propr/core', { namedExports: {
    db: database, AI_COMMIT_AUTHOR: { name: 'Test Worker', email: 'worker@example.test' },
    logger: { ...log, withCorrelation: () => log },
    getStateManager: () => stateManager,
    hashTaskAttemptToken: () => 'hash',
    retryConfigs: { githubApi: {} }, withRetry: async (fn: () => unknown) => fn(),
    runWithExecutionAbortSignal: async (_signal: unknown, fn: () => unknown) => fn(),
    TaskStates: { PROCESSING: 'processing', COMPLETED: 'completed', CLAUDE_EXECUTION: 'claude_execution', FAILED: 'failed', CANCELLED: 'cancelled' },
    ensureGitRepository: async () => { calls.push({ operation: 'ensureGitRepository', args: [] }); }, createLogFiles: noOp, UsageLimitError: class extends Error {},
    recordLLMMetrics: noOp, loadPrimaryProcessingLabels: async () => ['propr'], sanitizeAgentReport,
    loadRepositoryVisualPreviewSettings: noOp,
    prepareVisualPreviewEvidence: async () => { calls.push({ operation: 'prepareVisualPreviewEvidence', args: [] }); return { evidence: { assets: [], toolSuggestions: [] } }; },
    cleanupPreparedVisualPreviewEvidence: noOp,
    appendVisualPreviewSection: (body: string) => body,
    renderVisualPreviewSection: () => '', renderVisualPreviewUploadFailureSection: () => '',
    resolveAgentTerminationReason: (result: { success: boolean }) => result.success ? undefined : 'timeout', VISUAL_PREVIEW_SLOT: '',
    commitChanges: async (worktree: string, message: string) => {
        git(worktree, 'add', '.');
        git(worktree, 'commit', '-m', message);
        produced.push(git(worktree, 'rev-parse', 'HEAD'));
        return { commitHash: produced.at(-1), commitMessage: message, filesChanged: ['implementation.txt'] };
    },
    getAuthenticatedOctokit: async () => octokit,
    getCurrentPRHead: async (_owner: string, _repo: string, pr: number) => {
        assert.equal(pr, 100);
        return git(repoPath('upstream'), 'rev-parse', 'refs/heads/propr/continuation-pr-42');
    },
    getCheckRunsStatus: async (_owner: string, _repo: string, sha: string) => {
        events.push(`checks:${sha}`);
        const allPassing = completedCheckHeads.has(sha);
        return { count: 1, allPassing, anyPending: !allPassing, anyFailed: false };
    },
    getRepoUrl: ({ repoOwner }: { repoOwner: string }) => repoPath(repoOwner),
    createHooklessGit: (worktree: string) => {
        const actual = realGit(worktree);
        return {
            raw: async (args: string[]) => {
                calls.push({ operation: 'git', args });
                if (args.includes('--dry-run') && probeError) throw probeError;
                if (args[0] === 'push' && args.includes('HEAD:refs/heads/propr/continuation-pr-42') && continuationPushError) throw continuationPushError;
                const result = await actual.raw(args);
                if (args[0] === 'push' && args.includes('HEAD:refs/heads/propr/continuation-pr-42') && losePushResponse) throw new Error('Lost push response');
                return result;
            },
            revparse: (args: string[]) => actual.revparse(args),
        };
    },
    ensureRepoCloned: async ({ owner, authToken }: { owner: string; authToken: string }) => {
        assert.equal(authToken, token);
        if (owner === 'contributor' && forcePushBeforeClone) {
            git(repoPath(owner), 'update-ref', 'refs/heads/contribution', `${sourceSha}^`);
        }
        return repoPath(owner);
    },
    createWorktreeFromExistingBranch: async (repo: string, branchName: string) => {
        const worktreePath = path.join(root, `work-${++cloneIndex}`);
        git(root, 'clone', '--no-local', '--single-branch', '--branch', branchName, repo, worktreePath);
        if (forcePushBeforeClone) assert.throws(() => git(worktreePath, 'cat-file', '-e', sourceSha));
        git(worktreePath, 'config', 'user.name', 'Test Worker');
        git(worktreePath, 'config', 'user.email', 'worker@example.test');
        calls.push({ operation: 'worktree', args: { repo, branchName, worktreePath } });
        return { worktreePath, branchName };
    },
    cleanupWorktree: async (_repo: string, worktree: string) => { await rm(worktree, { recursive: true, force: true }); },
    pushBranch: async (worktree: string, branchName: string, options: { repoUrl: string; authToken: string }) => {
        assert.equal(options.authToken, token);
        calls.push({ operation: 'forkPush', args: { worktree, branchName, options } });
        if (finalPushError) throw finalPushError;
        git(worktree, 'push', options.repoUrl, `HEAD:refs/heads/${branchName}`);
        return { rebased: false, commitHash: git(worktree, 'rev-parse', 'HEAD') };
    },
} });

const ref = { repoOwner: 'upstream', repoName: 'project', pullRequestNumber: 42 };
const source = {
    head: { ref: 'contribution', sha: sourceSha, repo: { owner: { login: 'contributor' }, name: 'project' } },
    base: { ref: 'release' }, title: 'Contribution', body: 'Original objective', user: { login: 'contributor' },
};
type FakePR = { number: number; state: string; html_url: string; body: string; base: { ref: string }; head: { ref: string; sha?: string; repo: { full_name: string } } };
let prs: FakePR[] = [];
let comments: Array<{ id: number; body: string; user: { type: string } }> = [];
let loseCreateResponse = false;
let failComment = false;
const octokit = {
    auth: async (options: unknown) => {
        calls.push({ operation: 'auth', args: options });
        assert.deepEqual(options, { type: 'installation' });
        return { token };
    },
    paginate: async (endpoint: string) => endpoint.endsWith('/pulls') ? [...prs] : [...comments],
    request: async (endpoint: string, options: Record<string, any>) => {
        calls.push({ operation: endpoint, args: options });
        if (endpoint === 'POST /repos/{owner}/{repo}/git/refs') {
            try { git(repoPath('upstream'), 'show-ref', '--verify', options.ref); }
            catch { git(repoPath('upstream'), 'update-ref', options.ref, options.sha); return { data: {} }; }
            throw Object.assign(new Error('Reference already exists'), { status: 422 });
        }
        if (endpoint.includes('/compare/')) {
            if (comparisonError) throw comparisonError;
            const [base, head] = options.basehead.split('...');
            let tip: string;
            try {
                git(repoPath('upstream'), 'cat-file', '-e', base);
                tip = git(repoPath('upstream'), 'rev-parse', head);
            } catch { throw Object.assign(new Error('Commit not found'), { status: 404 }); }
            let status = 'diverged';
            try { git(repoPath('upstream'), 'merge-base', '--is-ancestor', base, tip); status = base === tip ? 'identical' : 'ahead'; } catch { /* Not published. */ }
            return { data: { status } };
        }
        if (endpoint === 'POST /repos/{owner}/{repo}/pulls') {
            if (failPRCreate) throw new Error('PR creation network error');
            if (prs.length) throw Object.assign(new Error('PR already exists'), { status: 422 });
            // GitHub rejects a head with no commits ahead of the base.
            const emptyHead = (() => { try { git(repoPath('upstream'), 'merge-base', '--is-ancestor', `refs/heads/${options.head}`, `refs/heads/${options.base}`); return true; } catch { return false; } })();
            if (emptyHead) throw Object.assign(new Error('Validation Failed'), { status: 422, response: { data: { errors: [{ message: `No commits between ${options.base} and ${options.head}` }] } } });
            const pr = { number: 100, state: 'open', html_url: 'https://github.com/upstream/project/pull/100', body: options.body, base: { ref: options.base }, head: { ref: options.head, repo: { full_name: 'upstream/project' } } };
            prs.push(pr);
            await onPRCreated?.();
            if (loseCreateResponse) { loseCreateResponse = false; throw new Error('ECONNRESET after create'); }
            return { data: pr };
        }
        if (endpoint === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
            if (options.pull_number === 42) return { data: { ...source, labels: [{ name: 'propr' }] } };
            const pr = prs[0];
            if (pr.state === 'open') pr.head.sha = git(repoPath('upstream'), 'rev-parse', pr.head.ref);
            return { data: { ...pr, labels: [{ name: 'propr' }] } };
        }
        if (endpoint.startsWith('PATCH')) {
            if (missingCommentIds.has(options.comment_id)) throw Object.assign(new Error('Not Found'), { status: 404 });
            if (failCompletion) throw Object.assign(new Error('Completion comment failed'), { status: 503 });
            completionBodies.push(options.body);
            return { data: { html_url: `https://github.com/upstream/project/pull/42#issuecomment-${options.comment_id}`, body: options.body } };
        }
        if (endpoint.endsWith('/comments') && endpoint.startsWith('POST')) {
            assert.ok([42, 100].includes(options.issue_number));
            if (failComment) throw new Error('Comment network error');
            const comment = { id: comments.length + 1, html_url: `https://github.com/upstream/project/pull/${options.issue_number}#issuecomment-${comments.length + 1}`, body: options.body, user: { type: 'Bot' } };
            comments.push(comment);
            return { data: comment };
        }
        throw new Error(`Unexpected endpoint: ${endpoint}`);
    },
};
const modules: Record<string, Record<string, unknown>> = {
    // The follow-up CI suspension is covered by test/followupCiSuspension.test.ts.
    followupCiSuspension: { suspendObsoleteValidationForImplementation: noOp, releaseFollowupCiSuspensionsForTask: noOp },
    prCommentJobHelpers: {
        validateAndFilterComments: async (comments: unknown) => skipValidation ? [] : comments,
        filterUnprocessedComments: (comments: unknown) => comments,
        fetchLinkedIssueContext: async () => ({ context: '' }), buildCommentHistory: () => 'Prior review findings and scores',
        updateTaskTitleForPR: noOp, resolvePrReasoningLevelOverride: () => undefined,
    },
    issueJobHelpers: { localizeContentImages: async (body: string) => body },
    prCommentJobUtils: {
        buildCombinedComment: (comments: Array<{ body: string }>) => ({ combinedCommentBody: comments.map(c => c.body).join('\n'), commentAuthors: ['contributor'] }),
        extractModelFromLabels: () => 'model', fetchAllComments: async () => [], buildPrompt: ({ combinedCommentBody, commentHistory }: { combinedCommentBody: string; commentHistory: string }) => { promptHistories.push(commentHistory); return combinedCommentBody; },
        handleJobError: async (_error: unknown, job: { id: string }) => { taskStates.set(job.id, 'failed'); },
        cleanupJob: async ({ worktreeInfo, lockKey }: { worktreeInfo?: { worktreePath: string }; lockKey: string }) => { heldLocks.delete(lockKey); if (worktreeInfo) await rm(worktreeInfo.worktreePath, { recursive: true, force: true }); }, buildCommitMessage: () => 'Implementation', toClaudeResult: noOp, buildStartingWorkCommentBody: () => 'Starting work',
    },
    prPendingComments: {
        restorePendingComments: async (comments: unknown[]) => { restoredComments.push(...comments); },
        pickUpPendingCommentsWithClaim: async (comments: unknown[]) => ({ commentsToProcess: [...comments, ...pendingComments], pickedUpComments: pendingComments }),
        applyPendingCommentCommandContext: noOp,
    },
    prCommentReviewJob: { executeReviewProcessing: async (params: { context: { pullRequestNumber: number } }) => { events.push(`review:${params.context.pullRequestNumber}`); return { status: 'complete' }; } },
    prCommentAgentUtils: { generateSummaryTitle: async () => 'Saved subtitle', resolveAndExecuteAgent: async ({ worktreePath, prompt }: { worktreePath: string; prompt: string }) => { events.push('agent'); prompts.push(prompt); await afterAgentExecution?.(); if (produced.length) assert.equal(git(worktreePath, 'rev-parse', 'HEAD'), expectedAgentHead ?? produced[0]); await writeFile(path.join(worktreePath, 'implementation.txt'), `execution ${prompts.length}\n`); return { claudeResult: { success: !partialResult, summary: 'Saved agent summary', sessionId: 'saved-session', model: 'saved-model' }, agentType: 'test' }; }, resolvePRCommentModelName: async () => 'model' },
    reviewCommentFormatter: { isReviewComment: () => false },
    reviewFindingSelector: { hasAuthorizedFixFeedback: () => true, prepareFixReviewFeedback: async () => ({ isFixMode: false, selectedReviewComments: [] }) },
    ultrafixOrchestrationService: {
        retainOriginalScope: noOp, stopLoop: async () => { events.push('stop'); },
        saveDeferredContinuation: async (_redis: unknown, deferred: typeof deferredReviews[number]) => { deferredReviews.push(deferred); },
    },
    ultrafixJobHelpers: { resolveUltrafixHistoryMeta: async () => ({}), handleUltrafixContinuation: noOp, markSelectedUltrafixFindings: noOp, restorePendingCommentsIfUltrafixJobSuperseded: async () => false },
    prCommentNoAuthorizedFindings: { handleNoAuthorizedFindings: noOp },
    prTaskTitleHelpers: Object.fromEntries(['buildDeterministicPrTaskSubtitle', 'buildPrTaskTitle', 'buildPrTaskTitleContext', 'buildPrTaskTitleContextHistoryMetadata', 'getPrTaskWorkflowLabel', 'resolvePrTaskWorkflow'].map(name => [name, noOp])),
    prProcessingLock: {
        acquirePRProcessingLock: async (_redis: unknown, key: string) => { events.push(key); if (heldLocks.has(key)) return false; heldLocks.add(key); return true; },
        ensurePRProcessingLockToken: async () => 'token', releasePRProcessingLock: async (_redis: unknown, key: string) => { heldLocks.delete(key); },
        startPRProcessingLockHeartbeat: () => noOp,
    },
    prCommentCollisionRecovery: { createPRCommentTaskStateIfMissing: async ({ taskId }: { taskId: string }) => { if (!taskStates.has(taskId)) taskStates.set(taskId, 'processing'); }, evaluatePRCommentPreExecutionRecovery: async () => ({}), handlePRCommentLockContention: async () => ({ status: 'deferred' }) },
    prCompletionComment: { buildCompletionComment: async (commit: unknown, comments: unknown, options: unknown, result: unknown) => JSON.stringify({ commit, comments, options, result }) },
    reviewCommentGatherer: { markReviewFindingsProcessed: noOp },
};
for (const [name, namedExports] of Object.entries(modules)) {
    await mock.module(`../src/jobs/${name}.js`, { namedExports });
}
await mock.module('../src/github/visualPreviewAttachments.js', { namedExports: {
    isVisualPreviewUploadAuthenticationError: () => false, publishPullRequestCommentVisualPreviews: noOp,
} });

const { processPullRequestCommentJob } = await import('../src/jobs/processPullRequestCommentJob.js');
const { findPRContinuation } = await import('../src/jobs/prContinuation.js');
const job = (id = 'task-1', commentId = 5, body = 'Original instructions') => ({
    id, updateData: noOp,
    data: { ...ref, commandMode: 'default', correlationId: 'correlation', commentId, commentBody: body, commentAuthor: 'contributor' },
});
const run = (request = job()) => processPullRequestCommentJob(request as never);
const denial = () => new Error('remote: Write access to repository not granted. fatal: HTTP 403');
beforeEach(async () => {
    expectedAgentHead = undefined; afterAgentExecution = undefined;
    missingCommentIds.clear(); failTaskCompletion = false; promptHistories = [];
    heldLocks.clear(); losePushResponse = false; comparisonError = undefined; onPRCreated = undefined;
    completedCheckHeads = new Set([sourceSha]); deferredReviews = [];
    taskStates.clear(); pendingComments = []; restoredComments = []; skipValidation = false;
    await database('pr_continuations').delete();
    await database('tasks').delete();
    await database('tasks').insert({ task_id: 'task-1' });
    git(repoPath('upstream'), 'update-ref', '-d', 'refs/heads/propr/continuation-pr-42');
    git(repoPath('upstream'), 'update-ref', 'refs/heads/release', baseSha);
    git(repoPath('contributor'), 'update-ref', 'refs/heads/contribution', sourceSha);
    forcePushBeforeClone = false;
    calls = []; prs = []; comments = []; prompts = []; events = []; produced = []; completionBodies = []; completions.length = 0;
    probeError = undefined; finalPushError = denial(); continuationPushError = undefined;
    failPRCreate = false; failComment = false; loseCreateResponse = false; failCompletion = false; partialResult = false;
});
after(async () => {
    await completionDown(database); await checkpointDown(database); await down(database);
    await database.destroy(); await rm(root, { recursive: true, force: true });
});

async function assertSavedCheckpoint() {
    const record = (await findPRContinuation(ref))!;
    assert.ok(record.publication_bundle);
    const completion = JSON.parse(record.publication_completion!);
    assert.equal(completion.taskId, 'task-1');
    assert.deepEqual(completion.instructionCommentIds, [5]);
    assert.equal(completion.claudeResult.summary, 'Saved agent summary');
    assert.equal(completion.jobData.subtitle, 'Saved subtitle');
    assert.equal(completion.commitResult.commitHash, produced[0]);
    for (const call of calls.filter(c => c.operation === 'worktree')) {
        await assert.rejects(import('node:fs/promises').then(fs => fs.access((call.args as any).worktreePath)), { code: 'ENOENT' });
    }
}

for (const failure of ['PR creation', 'continuation push']) {
    for (const retryTaskId of ['task-1', 'replacement-task']) {
        test(`${failure}: retry ${retryTaskId} recovers and completes after worktree deletion with exactly one agent execution`, async () => {
            if (failure === 'PR creation') failPRCreate = true;
            else continuationPushError = new Error('Connection timed out');
            await assert.rejects(run(), /network error|Connection timed out/);
            await assertSavedCheckpoint();
            assert.equal(completions.length, 0);
            failPRCreate = false; continuationPushError = undefined;
            const result = await run(job(retryTaskId));
            assert.equal(result.status, 'complete');
            assert.equal(result.commit, produced[0]);
            assert.equal(prompts.length, 1);
            assert.equal(git(repoPath('upstream'), 'rev-parse', 'propr/continuation-pr-42'), produced[0]);
            assert.ok(completions.some(c => c.taskId === 'task-1'));
            assert.equal(taskStates.get('task-1'), 'completed');
            assert.equal(taskStates.get(retryTaskId), 'completed');
            if (retryTaskId !== 'task-1') {
                assert.equal(
                    completions.find(c => c.taskId === retryTaskId)?.metadata.historyMetadata.notificationRecap,
                    'Recovered and published the pending follow-up result.',
                );
            }
            assert.equal((await database('tasks').first()).commit_hash, produced[0]);
            assert.match(completionBodies[0], /Saved agent summary/);
            assert.match(completionBodies[0], /saved-session/);
            const record = (await findPRContinuation(ref))!;
            assert.equal(record.publication_bundle, null);
            assert.equal(record.publication_completion, null);
        });
    }
}

test('a new instruction first finishes the outstanding task and then runs only the new instructions', async () => {
    failPRCreate = true;
    await assert.rejects(run(), /network error/);
    await assertSavedCheckpoint();
    failPRCreate = false;
    const result = await run(job('task-2', 6, 'New instructions'));
    assert.equal(result.status, 'complete');
    assert.equal(prompts.length, 2);
    assert.ok(prompts[1].includes('New instructions'));
    assert.ok(!prompts[1].includes('Original instructions'));
    assert.ok(events.indexOf('complete:task-1') < events.lastIndexOf('agent'));
    assert.deepEqual(completions.map(c => c.taskId), ['task-1', 'task-2']);
    git(repoPath('upstream'), 'merge-base', '--is-ancestor', produced[0], produced[1]);
});

for (const initialChecksPassing of [true, false]) {
    test(`continuation review recovers publication before deferring on pending checks (initial checks passing: ${initialChecksPassing})`, async () => {
        continuationPushError = new Error('Connection timed out');
        await assert.rejects(run(), /Connection timed out/);
        await assertSavedCheckpoint();
        assert.equal((await findPRContinuation(ref))!.continuation_pr, 100);
        assert.equal(git(repoPath('upstream'), 'rev-parse', 'propr/continuation-pr-42'), sourceSha);
        if (!initialChecksPassing) completedCheckHeads.clear();
        continuationPushError = undefined;
        events = [];

        pendingComments = [{ id: 7, body: 'Pending instructions', author: 'contributor', type: 'issue' }];
        const request = job('review-task', 6, '/ultrafix');
        const result = await run({ ...request, data: {
            ...request.data, pullRequestNumber: 100, commandMode: 'review',
            ultrafixMeta: { mode: 'ultrafix', instructions: '' },
        } } as never);

        assert.equal(result.status, 'deferred');
        assert.equal(result.reason, 'ultrafix_waiting_for_exact_head_checks');
        assert.deepEqual(restoredComments, pendingComments);
        assert.equal(taskStates.get('review-task'), 'completed');
        assert.equal(completions.find(c => c.taskId === 'review-task')?.metadata.historyMetadata.deferred, true);
        assert.equal(
            completions.find(c => c.taskId === 'review-task')?.metadata.historyMetadata.notificationRecap,
            'Review deferred until the continuation pull request passes its exact-head checks.',
        );
        assert.equal(heldLocks.size, 0);
        assert.equal(git(repoPath('upstream'), 'rev-parse', 'propr/continuation-pr-42'), produced[0]);
        const record = (await findPRContinuation(ref))!;
        assert.equal(record.publication_bundle, null);
        assert.equal(record.publication_completion, null);
        assert.equal(taskStates.get('task-1'), 'completed');
        assert.deepEqual(events.filter(event => event.startsWith('checks:')), [`checks:${produced[0]}`]);
        assert.ok(events.indexOf('complete:task-1') < events.indexOf(`checks:${produced[0]}`));
        assert.equal(deferredReviews.length, 1);
        assert.equal(deferredReviews[0].pr, 100);
        assert.equal(deferredReviews[0].nextAction, 'review');
        assert.equal(deferredReviews[0].reason, 'pre_execution_checks_not_passing');
        assert.ok(!events.includes('review:100'));
        assert.equal(prompts.length, 1);
    });
}

test('repeated publication and completion failures retain the inputs without rerunning the agent', async () => {
    continuationPushError = new Error('Connection timed out');
    await assert.rejects(run(), /Connection timed out/);
    await assertSavedCheckpoint();
    await assert.rejects(run(), /Connection timed out/);
    await assertSavedCheckpoint();
    continuationPushError = undefined;
    failCompletion = true;
    await assert.rejects(run(), /Completion comment failed/);
    const published = (await findPRContinuation(ref))!;
    assert.equal(published.publication_bundle, null);
    assert.ok(published.publication_completion);
    failCompletion = false;
    assert.equal((await run()).status, 'complete');
    assert.equal(prompts.length, 1);
    assert.equal((await findPRContinuation(ref))!.publication_completion, null);
});

test('recovery preserves partial execution disposition and original instruction IDs', async () => {
    partialResult = true; failPRCreate = true;
    await assert.rejects(run(), /network error/);
    failPRCreate = false;
    const result = await run();
    assert.equal(result.status, 'partial');
    assert.equal(prompts.length, 1);
    assert.deepEqual(completions[0].metadata.historyMetadata.incompleteExecution, { reason: 'timeout' });
    assert.deepEqual(JSON.parse(completionBodies[0].split('\n\n').at(-1)!).comments.map((c: any) => c.id), [5]);
});

test('completion recovery runs even when the instruction comments would now be filtered out', async () => {
    failCompletion = true;
    await assert.rejects(run(), /Completion comment failed/);
    assert.equal((await findPRContinuation(ref))!.publication_bundle, null);
    failCompletion = false; skipValidation = true;
    assert.equal((await run()).status, 'complete');
    assert.equal(taskStates.get('task-1'), 'completed');
    assert.equal(prompts.length, 1);
});

test('a force push that removes the captured baseline fails before execution and allows preparation retry', async () => {
    forcePushBeforeClone = true;
    await assert.rejects(run(), /retry preparation before implementation/);
    assert.equal(prompts.length, 0);
    assert.equal(await findPRContinuation(ref), undefined);
    const worktree = calls.find(c => c.operation === 'worktree')!.args as { worktreePath: string };
    await assert.rejects(import('node:fs/promises').then(fs => fs.access(worktree.worktreePath)), { code: 'ENOENT' });

    forcePushBeforeClone = false;
    git(repoPath('contributor'), 'update-ref', 'refs/heads/contribution', sourceSha);
    failPRCreate = true;
    await assert.rejects(run(job('retry-task')), /network error/);
    assert.ok((await findPRContinuation(ref))!.publication_bundle);
    failPRCreate = false;
    assert.equal((await run(job('retry-task'))).status, 'complete');
    assert.equal(prompts.length, 1);
    assert.equal(git(repoPath('upstream'), 'rev-parse', 'propr/continuation-pr-42'), produced[0]);
});

test('/fix retries preflight adoption after PR creation fails, then stops once the destination exists', async () => {
    probeError = denial();
    failPRCreate = true;
    const request = job();
    request.data.commandMode = 'fix';
    await assert.rejects(run(request), /PR creation network error/);
    const reservation = (await findPRContinuation(ref))!;
    assert.equal(reservation.continuation_pr, null);
    assert.equal(reservation.publication_bundle, null);
    assert.equal(reservation.publication_completion, null);
    assert.equal(prompts.length, 0);
    assert.ok(!events.includes('stop'));

    failPRCreate = false;
    assert.equal((await run({ ...request, id: 'retry-task' })).status, 'complete');
    assert.equal(prompts.length, 1);
    assert.equal(prs.length, 1);
    assert.equal((await findPRContinuation(ref))!.continuation_pr, 100);
    const next = job('task-2', 6);
    next.data.commandMode = 'fix';
    assert.equal((await run(next)).status, 'skipped');
    assert.equal(prompts.length, 1);
    assert.match(
        completions.find(c => c.taskId === 'task-2')?.metadata.historyMetadata.notificationRecap,
        /Automated review\/fix processing has stopped on this original PR/,
    );
});

test('preflight denial after the base incorporated the source SHA defers PR creation until implementation is published', async () => {
    probeError = denial();
    git(repoPath('upstream'), 'update-ref', 'refs/heads/release', sourceSha);
    const result = await run();
    assert.equal(result.status, 'complete');
    assert.equal(result.commit, produced[0]);
    assert.equal(prompts.length, 1);
    assert.equal(prs.length, 1);
    const record = (await findPRContinuation(ref))!;
    assert.equal(record.continuation_pr, 100);
    assert.equal(record.publication_bundle, null);
    assert.equal(record.publication_completion, null);
    assert.equal(git(repoPath('upstream'), 'rev-parse', 'propr/continuation-pr-42'), produced[0]);
    // Implementation ran on the reserved upstream branch, never on the contributor's fork.
    assert.deepEqual(calls.filter(c => c.operation === 'worktree').map(c => (c.args as any).branchName), ['contribution', 'propr/continuation-pr-42']);
    assert.ok(!calls.some(c => c.operation === 'forkPush'));
    // The preflight create was rejected as empty; the PR exists only after the implementation HEAD was published.
    const creates = calls.map((c, index) => ({ ...c, index })).filter(c => c.operation === 'POST /repos/{owner}/{repo}/pulls');
    assert.ok(creates.length >= 2);
    assert.ok(creates.at(-1)!.index > calls.findIndex(c => c.operation === 'git' && (c.args as string[])[0] === 'push' && (c.args as string[]).includes('HEAD:refs/heads/propr/continuation-pr-42')));
    assert.ok(comments.some(c => c.body.includes('propr-continuation-link:42:100')));
    assert.match(completionBodies[0], /pull\/100/);
    assert.equal(taskStates.get('task-1'), 'completed');
});

for (const interruption of ['agent failure', 'PR creation failure', 'continuation push failure']) {
    test(`deferred preflight PR creation recovers after ${interruption} with at most one successful agent execution`, async () => {
        probeError = denial();
        git(repoPath('upstream'), 'update-ref', 'refs/heads/release', sourceSha);
        if (interruption === 'agent failure') afterAgentExecution = async () => { throw new Error('Agent crashed'); };
        if (interruption === 'PR creation failure') afterAgentExecution = async () => { failPRCreate = true; };
        if (interruption === 'continuation push failure') continuationPushError = new Error('Connection timed out');
        await assert.rejects(run(), /Agent crashed|PR creation network error|Connection timed out/);
        assert.equal(prompts.length, 1);
        const reservation = (await findPRContinuation(ref))!;
        assert.equal(reservation.continuation_pr, null);
        assert.equal(prs.length, 0);
        assert.equal(git(repoPath('upstream'), 'rev-parse', 'propr/continuation-pr-42'), sourceSha);
        if (interruption === 'agent failure') assert.equal(reservation.publication_bundle, null);
        else await assertSavedCheckpoint();

        afterAgentExecution = undefined; failPRCreate = false; continuationPushError = undefined;
        const result = await run(job('retry-task'));
        assert.equal(result.status, 'complete');
        assert.equal(prompts.length, interruption === 'agent failure' ? 2 : 1);
        assert.equal(prs.length, 1);
        assert.equal((await findPRContinuation(ref))!.continuation_pr, 100);
        assert.equal((await findPRContinuation(ref))!.publication_bundle, null);
        assert.equal(git(repoPath('upstream'), 'rev-parse', 'propr/continuation-pr-42'), produced.at(-1));
        assert.equal(result.commit, produced.at(-1));
        assert.equal(taskStates.get('task-1'), interruption === 'agent failure' ? 'failed' : 'completed');
        assert.equal(taskStates.get('retry-task'), 'completed');
        assert.ok(comments.some(c => c.body.includes('propr-continuation-link:42:100')));
    });
}

for (const retryTaskId of ['task-1', 'replacement-task']) {
    test(`published completion survives PR closure and branch deletion on retry ${retryTaskId}`, async () => {
        failCompletion = true;
        await assert.rejects(run(), /Completion comment failed/);
        const record = (await findPRContinuation(ref))!;
        assert.equal(record.publication_bundle, null);
        assert.ok(record.publication_completion);
        prs[0].state = 'closed';
        git(repoPath('upstream'), 'update-ref', '-d', 'refs/heads/propr/continuation-pr-42');
        calls = [];
        failCompletion = false;
        const result = await run(job(retryTaskId));
        assert.equal(result.status, 'complete');
        assert.equal(result.commit, produced[0]);
        assert.equal(prompts.length, 1);
        assert.equal(taskStates.get('task-1'), 'completed');
        assert.equal(taskStates.get(retryTaskId), 'completed');
        assert.match(completionBodies[0], /Saved agent summary/);
        assert.match(completionBodies[0], /pull\/100/);
        assert.ok(!calls.some(c => ['git', 'worktree', 'ensureGitRepository', 'prepareVisualPreviewEvidence', 'auth'].includes(c.operation)));
        assert.ok(!calls.some(c => c.operation === 'GET /repos/{owner}/{repo}/pulls/{pull_number}'));
        assert.equal((await findPRContinuation(ref))!.publication_completion, null);
    });
}

test('a retry returns newly claimed instructions for a separate task without rerunning the original agent', async () => {
    failPRCreate = true;
    await assert.rejects(run(), /network error/);
    failPRCreate = false;
    pendingComments = [{ id: 6, body: 'New instructions', author: 'contributor', type: 'issue' }];
    assert.equal((await run()).status, 'complete');
    assert.deepEqual(restoredComments, pendingComments);
    assert.equal(prompts.length, 1);
});

test('a new batch containing recovered instruction IDs executes only the remaining instructions', async () => {
    failPRCreate = true;
    await assert.rejects(run(), /network error/);
    failPRCreate = false;
    const request = { ...job('task-2'), data: { ...job('task-2').data, comments: [
        { id: 5, body: 'Original instructions', author: 'contributor', type: 'issue' },
        { id: 6, body: 'New instructions', author: 'contributor', type: 'issue' },
    ] } };
    assert.equal((await run(request)).status, 'complete');
    assert.equal(prompts.length, 2);
    assert.ok(!prompts[1].includes('Original instructions'));
    assert.ok(prompts[1].includes('New instructions'));
});

test('a replacement request can finish after its own recovery attempt failed', async () => {
    continuationPushError = new Error('Connection timed out');
    await assert.rejects(run(), /Connection timed out/);
    await assert.rejects(run(job('replacement-task')), /Connection timed out/);
    continuationPushError = undefined;
    assert.equal((await run(job('replacement-task'))).status, 'complete');
    assert.equal(taskStates.get('task-1'), 'completed');
    assert.equal(taskStates.get('replacement-task'), 'completed');
    assert.equal(prompts.length, 1);
});

for (const lostResponse of [false, true]) {
    test(`an unmapped visible continuation contends on the creating worker's source lock (lost response: ${lostResponse})`, async () => {
        loseCreateResponse = lostResponse;
        let checkedContention = false;
        onPRCreated = async () => {
            assert.equal((await findPRContinuation(ref))!.continuation_pr, null);
            const request = job('continuation-task', 6, '/review');
            const result = await run({ ...request, data: { ...request.data, pullRequestNumber: 100, commandMode: 'review' } });
            assert.equal(result.status, 'deferred');
            assert.equal((await findPRContinuation(ref))!.continuation_pr, 100);
            assert.equal(events.filter(event => event === 'lock:pr:upstream:project:42').length, 2);
            assert.ok(!events.includes('lock:pr:upstream:project:100'));
            assert.ok(!events.includes('review:100'));
            checkedContention = true;
        };
        assert.equal((await run()).status, 'complete');
        // PR creation recovery catches API errors, including a failed hook assertion.
        assert.equal(checkedContention, true);
        assert.equal(prompts.length, 1);
    });
}

for (const failure of ['push acknowledgement', 'checkpoint clearing']) {
    for (const advanced of [false, true]) {
        test(`${failure}: retained ${advanced ? 'advanced' : 'identical'} PR head completes after merge and branch deletion`, async () => {
            if (failure === 'push acknowledgement') losePushResponse = true;
            else await database.raw("CREATE TRIGGER fail_checkpoint_clear BEFORE UPDATE OF publication_bundle ON pr_continuations WHEN OLD.publication_bundle IS NOT NULL AND NEW.publication_bundle IS NULL BEGIN SELECT RAISE(ABORT, 'Checkpoint clearing failed'); END");
            try {
                await assert.rejects(run(), /Lost push response|Checkpoint clearing failed/);
                await assertSavedCheckpoint();
            } finally {
                await database.raw('DROP TRIGGER IF EXISTS fail_checkpoint_clear');
            }
            let publishedHead = produced[0];
            if (advanced) {
                git(seed, 'fetch', repoPath('upstream'), 'refs/heads/propr/continuation-pr-42');
                publishedHead = git(seed, 'commit-tree', `${produced[0]}^{tree}`, '-p', produced[0], '-m', 'Later continuation commit');
                git(seed, 'push', repoPath('upstream'), `${publishedHead}:refs/heads/propr/continuation-pr-42`);
            }
            prs[0].head.sha = publishedHead;
            prs[0].state = 'closed';
            git(repoPath('upstream'), 'update-ref', 'refs/pull/100/head', publishedHead);
            git(repoPath('upstream'), 'update-ref', '-d', 'refs/heads/propr/continuation-pr-42');
            calls = []; losePushResponse = false;
            const result = await run();
            assert.equal(result.status, 'complete');
            assert.equal(result.commit, publishedHead);
            assert.equal(prompts.length, 1);
            assert.equal(taskStates.get('task-1'), 'completed');
            assert.match(completionBodies[0], /Saved agent summary/);
            assert.ok(!calls.some(c => ['git', 'worktree', 'ensureGitRepository', 'auth'].includes(c.operation)));
            assert.equal((await findPRContinuation(ref))!.publication_bundle, null);
            assert.equal((await findPRContinuation(ref))!.publication_completion, null);
        });
    }
}

for (const verification of ['missing commit', 'unrelated head', 'API failure']) {
    test(`closed continuation retains checkpoint when publication cannot be verified: ${verification}`, async () => {
        continuationPushError = new Error('Connection timed out');
        await assert.rejects(run(), /Connection timed out/);
        const saved = (await findPRContinuation(ref))!;
        prs[0].head.sha = sourceSha;
        prs[0].state = 'closed';
        if (verification === 'unrelated head') {
            // Make the saved commit visible remotely without putting it in the PR head.
            const worktree = path.join(root, `verify-${++cloneIndex}`);
            git(root, 'clone', '--branch', 'release', repoPath('upstream'), worktree);
            await writeFile(path.join(worktree, 'checkpoint.bundle'), Buffer.from(saved.publication_bundle!, 'base64'));
            git(worktree, 'fetch', 'checkpoint.bundle', 'HEAD');
            git(worktree, 'push', 'origin', 'FETCH_HEAD:refs/heads/unrelated');
        }
        if (verification === 'missing commit') comparisonError = Object.assign(new Error('Commit not found'), { status: 404 });
        if (verification === 'API failure') comparisonError = new Error('Comparison unavailable');
        git(repoPath('upstream'), 'update-ref', '-d', 'refs/heads/propr/continuation-pr-42');
        await assert.rejects(run(), /Continuation PR is closed|Comparison unavailable/);
        const retained = (await findPRContinuation(ref))!;
        assert.equal(retained.publication_bundle, saved.publication_bundle);
        assert.equal(retained.publication_completion, saved.publication_completion);
        assert.equal(prompts.length, 1);
        assert.equal(completions.length, 0);
    });
}

for (const duringRecovery of [false, true]) {
    test(`deleted starting comment is replaced and retained for completion retry (recovery: ${duringRecovery})`, async () => {
        if (duringRecovery) {
            continuationPushError = new Error('Connection timed out');
            await assert.rejects(run(), /Connection timed out/);
            await assertSavedCheckpoint();
            continuationPushError = undefined;
        }
        missingCommentIds.add(1);
        failTaskCompletion = true;
        await assert.rejects(run(), /Task completion failed/);
        const saved = JSON.parse((await findPRContinuation(ref))!.publication_completion!);
        assert.notEqual(saved.startingWorkComment.data.id, 1);
        const replacementId = saved.startingWorkComment.data.id;
        const replacements = () => calls.filter(c => c.operation.startsWith('POST') && c.operation.endsWith('/comments') && (c.args as any).body.includes('Saved agent summary'));
        assert.equal(replacements().length, 1);
        assert.equal((replacements()[0].args as any).issue_number, 42);
        assert.match(saved.startingWorkComment.data.html_url, /pull\/42#issuecomment-/);
        failTaskCompletion = false;
        assert.equal((await run()).status, 'complete');
        assert.equal(replacements().length, 1);
        assert.ok(calls.some(c => c.operation.startsWith('PATCH') && (c.args as any).comment_id === replacementId));
        assert.equal(prompts.length, 1);
        assert.equal(taskStates.get('task-1'), 'completed');
        assert.equal((await findPRContinuation(ref))!.publication_completion, null);
    });
}

for (const requestPR of [42, 100]) {
    test(`review on PR ${requestPR} recovers a deleted completion target on the originating PR`, async () => {
        failCompletion = true;
        await assert.rejects(run(), /Completion comment failed/);
        assert.equal(comments.length, 2, 'transient PATCH failure must not create a replacement');
        missingCommentIds.add(1);
        failCompletion = false;
        const review = job('new-review', 6, '/review');
        review.data.pullRequestNumber = requestPR;
        review.data.commandMode = 'review';
        await run(review);
        const replacement = calls.find(c => c.operation.startsWith('POST') && c.operation.endsWith('/comments') && (c.args as any).body.includes('Saved agent summary'));
        assert.equal((replacement!.args as any).issue_number, 42);
        assert.equal(taskStates.get('task-1'), 'completed');
        assert.equal((await findPRContinuation(ref))!.publication_completion, null);
        assert.equal(prompts.length, 1);
    });
}

for (const automatic of [false, true]) {
    test(`continuation implementation includes original discussion only outside Ultrafix (automatic: ${automatic})`, async () => {
        await run();
        const request = job('continuation-task', 6, 'Selected findings');
        request.data.pullRequestNumber = 100;
        if (automatic) Object.assign(request.data, { ultrafixMeta: { mode: 'ultrafix', instructions: 'Selected findings' } });
        await run(request);
        assert.equal(promptHistories.length, 2);
        if (automatic) assert.equal(promptHistories[1], '');
        else assert.match(promptHistories[1], /Original contribution discussion.*\nPrior review findings and scores/s);
    });
}

for (const failure of ['PR creation', 'continuation push']) {
    test(`cancelled ${failure} checkpoint is retired before review and cannot replay during later preparation`, async () => {
        if (failure === 'PR creation') failPRCreate = true;
        else continuationPushError = new Error('Connection timed out');
        await assert.rejects(run(), /network error|Connection timed out/);
        await assertSavedCheckpoint();
        taskStates.set('task-1', 'cancelled');
        failPRCreate = false; continuationPushError = undefined;
        calls = [];

        for (const id of ['new-review', 'later-review']) {
            const review = job(id, 6, '/review');
            review.data.commandMode = 'review';
            await run(review);
            const record = (await findPRContinuation(ref))!;
            assert.equal(record.publication_bundle, null);
            assert.equal(record.publication_completion, null);
            assert.equal(taskStates.get('task-1'), 'cancelled');
            assert.equal(git(repoPath('upstream'), 'rev-parse', record.branch_name), sourceSha);
        }
        assert.ok(!calls.some(c => ['git', 'worktree', 'ensureGitRepository', 'auth'].includes(c.operation)));
        assert.equal(completionBodies.length, 0);
        assert.equal(prompts.length, 1);

        expectedAgentHead = sourceSha;
        const result = await run(job('new-implementation', 7, 'New instructions'));
        assert.equal(result.status, 'complete');
        assert.equal(prompts.length, 2);
        assert.ok(!prompts[1].includes('Original instructions'));
        assert.equal(taskStates.get('task-1'), 'cancelled');
        assert.ok(!completions.some(c => c.taskId === 'task-1'));
        assert.equal(git(repoPath('upstream'), 'rev-parse', 'propr/continuation-pr-42'), produced[1]);
        assert.throws(() => git(repoPath('upstream'), 'merge-base', '--is-ancestor', produced[0], produced[1]));
    });
}

test('cancelled completion-only checkpoint is retired without completing the originating task', async () => {
    failCompletion = true;
    await assert.rejects(run(), /Completion comment failed/);
    assert.equal((await findPRContinuation(ref))!.publication_bundle, null);
    assert.ok((await findPRContinuation(ref))!.publication_completion);
    taskStates.set('task-1', 'cancelled');
    failCompletion = false;
    calls = [];
    const review = job('new-review', 6, '/review');
    review.data.commandMode = 'review';
    await run(review);
    assert.equal(taskStates.get('task-1'), 'cancelled');
    assert.equal((await findPRContinuation(ref))!.publication_completion, null);
    assert.equal(completionBodies.length, 0);
    assert.equal(prompts.length, 1);
    assert.ok(!calls.some(c => c.operation.startsWith('PATCH') || ['git', 'worktree', 'ensureGitRepository', 'auth'].includes(c.operation)));
});
