import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

const states = new Map<string, any>();
const redisValues = new Map<string, string>();
const jobs: any[] = [];
const requests: Array<{ endpoint: string; params: any }> = [];
const containers: string[] = [];
let tracker: any = { state: 'open', labels: [{ name: 'AI' }] };
let trackerError: Error | undefined;
const redis = {
    get: async (key: string) => key.startsWith('worker:state:')
        ? (states.has(key.slice(13)) ? JSON.stringify(states.get(key.slice(13))) : null)
        : redisValues.get(key) ?? null,
    set: async (key: string, value: string) => { redisValues.set(key, value); return 'OK'; },
    rpush: async () => 1,
    del: async (key: string) => { redisValues.delete(key); return 1; },
};
const manager = {
    getTaskState: async (id: string) => states.get(id) ?? null,
    scanNonTerminalTasks: async () => ({ tasks: [...states.values()].filter(t => !['completed', 'failed', 'cancelled'].includes(t.state)), nextCursor: '0' }),
    createTaskStateIfAbsent: async (id: string, ref: any) => {
        if (!states.has(id)) states.set(id, { taskId: id, state: 'pending', issueRef: ref, history: [{ state: 'pending' }] });
        return states.get(id);
    },
    markTaskCancelled: async (id: string, by: string, metadata: any) => {
        const state = states.get(id);
        if (!state) throw new Error('missing state');
        state.state = 'cancelled';
        state.terminalReason = metadata.terminalReason ?? metadata.historyMetadata.cancellationReason;
        state.history.push({ state: 'cancelled', metadata });
        return state;
    },
};
const queue = { getJobs: async (statuses: string[]) => jobs.filter(j => statuses.includes(j.status)) };
const clearedLoops: number[] = [];
await mock.module('../packages/core/src/utils/workerStateManager.js', { namedExports: { getStateManager: () => manager } });
await mock.module('../packages/core/src/queue/taskQueue.js', { namedExports: { getIssueQueue: async () => queue } });
await mock.module('../packages/core/src/auth/githubAuth.js', { namedExports: { getAuthenticatedOctokit: async () => ({ request: async (endpoint: string, params: any) => {
    requests.push({ endpoint, params });
    if (trackerError) throw trackerError;
    return { data: tracker };
} }) } });
await mock.module('../packages/core/src/config/configManager.js', { namedExports: { loadPrimaryProcessingLabels: async () => ['AI', 'build'] } });
await mock.module('../packages/core/src/db/connection.js', { namedExports: { db: () => ({ select: () => ({ where: () => ({ first: async () => undefined }) }) }) } });
await mock.module('../packages/core/src/claude/docker/dockerExecutor.js', { namedExports: { stopDockerContainer: async (id: string) => { containers.push(id); return { success: true }; } } });
await mock.module('../packages/core/src/webhook/checkRunHelpers.js', { namedExports: { clearUltrafixLoopState: async (_owner: string, _repo: string, number: number) => { clearedLoops.push(number); } } });
const { cancelWithdrawnIntent, reconcileTaskIntents, preventWithdrawnJob, withdrawnIntentReason, taskIntentTarget, intentJobTaskId } = await import('../packages/core/src/services/taskIntent.js');
const target = { repoOwner: 'acme', repoName: 'widgets', number: 42, kind: 'issue' as const, triggeringLabel: 'AI' };

beforeEach(() => { states.clear(); redisValues.clear(); jobs.length = 0; requests.length = 0; containers.length = 0; clearedLoops.length = 0; tracker = { state: 'open', labels: [{ name: 'AI' }] }; trackerError = undefined; });
function addJob(id: string, data: any, status = 'waiting', name = 'processGitHubIssue') {
    const job = { id, data, status, name, remove: async () => { jobs.splice(jobs.indexOf(job), 1); } };
    jobs.push(job);
    return job;
}
function addRunning(id: string, ref = target, state = 'claude_execution') {
    states.set(id, { taskId: id, issueRef: ref, state, history: [{ state, metadata: { containerId: `container-${id}` } }] });
}

test('issue closure cancels active and all queued matrix jobs without touching its PR or other repositories', async () => {
    addRunning('implementation');
    addRunning('followup', { ...target, kind: 'pr', type: 'pr-comment', pullRequestNumber: 87 } as any);
    addJob('queued-a', target);
    addJob('queued-b', target, 'prioritized');
    addJob('queued-c', target, 'delayed');
    addJob('unrelated', { ...target, repoOwner: 'other' });
    await cancelWithdrawnIntent(target, 'cancelled_issue_closed', redis as never);
    for (const id of ['implementation', 'queued-a', 'queued-b', 'queued-c']) assert.equal(states.get(id).terminalReason, 'cancelled_issue_closed');
    assert.equal(states.get('followup').state, 'claude_execution');
    assert.deepEqual(jobs.map(j => j.id), ['unrelated']);
    assert.deepEqual(containers, ['container-implementation']);
    assert.ok(requests.some(r => r.params.name === 'AI-processing'));
    assert.ok(requests.some(r => r.params.name === 'AI-waiting'));
    assert.ok(requests.some(r => r.params.labels?.includes('AI-cancelled')));
});

test('queue pickup before worker state exists uses the canonical child task ID and leaves an abort marker', async () => {
    const job = addJob('issue-acme-widgets-42-codex-model-main', { ...target, isChildJob: true, agentAlias: 'codex', modelName: 'model', correlationId: 'attempt-one' }, 'active');
    const taskId = intentJobTaskId(job);
    await cancelWithdrawnIntent(target, 'cancelled_label_removed', redis as never);
    assert.equal(states.get(taskId).terminalReason, 'cancelled_label_removed');
    assert.equal(JSON.parse(redisValues.get(`worker:abort:${taskId}`)!).reason, 'cancelled_label_removed');
    tracker = { state: 'open', labels: ['AI'] };
    assert.equal(await preventWithdrawnJob(job), 'cancelled_label_removed', 'a redelivery cannot revive a cancelled attempt');
});

test('pending worker state is cancellable during initialization', async () => {
    addRunning('initializing', target, 'pending');
    await cancelWithdrawnIntent(target, 'cancelled_issue_closed', redis as never);
    assert.equal(states.get('initializing').state, 'cancelled');
});

test('PR closure cancels follow-up, review, and Ultrafix and clears the loop', async () => {
    for (const mode of ['default', 'review', 'ultrafix']) addJob(mode, { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 87, commandMode: mode }, 'active', 'processPullRequestComment');
    await cancelWithdrawnIntent({ ...target, number: 87, kind: 'pr' }, 'cancelled_pr_closed', redis as never);
    for (const mode of ['default', 'review', 'ultrafix']) assert.equal(states.get(mode).terminalReason, 'cancelled_pr_closed');
    assert.deepEqual(clearedLoops, [87]);
    assert.equal(requests.length, 0, 'PR cancellation does not change issue labels');
});

test('polling finds running and delayed work even when discovery no longer lists the issue', async () => {
    addRunning('implementation');
    addJob('rate-limit-retry', target, 'delayed');
    tracker = { state: 'open', labels: [{ name: 'llm-codex-astra' }] };
    await reconcileTaskIntents(redis as never, ['acme/widgets']);
    assert.equal(states.get('implementation').terminalReason, 'cancelled_label_removed');
    assert.equal(states.get('rate-limit-retry').terminalReason, 'cancelled_label_removed');
});

test('fresh pre-start checks ignore saved issue snapshots and never dispatch withdrawn work', async () => {
    for (const [current, reason] of [[{ state: 'closed', labels: ['AI'] }, 'cancelled_issue_closed'], [{ state: 'open', labels: [] }, 'cancelled_label_removed']] as const) {
        tracker = current;
        const job = addJob(reason, { ...target, issuePayload: { state: 'open', labels: ['AI'] } }, 'active');
        assert.equal(await preventWithdrawnJob(job), reason);
        assert.equal(states.get(reason).terminalReason, reason);
    }
});

test('removing only model labels preserves intent; the configured trigger is the authority', () => {
    assert.equal(withdrawnIntentReason(target, { state: 'open', labels: ['AI'] }, ['AI']), null);
    assert.equal(withdrawnIntentReason(target, { state: 'open', labels: ['build'] }, ['AI', 'build']), 'cancelled_label_removed');
    assert.equal(withdrawnIntentReason({ ...target, kind: 'pr' }, { state: 'closed', merged: true }, ['AI']), null);
    assert.equal(taskIntentTarget({ ...target, type: 'goal' }, 'goal'), null);
});

test('tracker failure cannot start a job or fabricate a cancellation', async () => {
    trackerError = new Error('GitHub unavailable');
    await assert.rejects(preventWithdrawnJob(addJob('prestart', target)), /GitHub unavailable/);
    assert.equal(states.size, 0);
});

test('worker admission returns cancellation without invoking an implementation or review processor', async () => {
    const { createMainJobProcessor } = await import('../src/workerFactory.js');
    const process = mock.fn(async () => ({ status: 'complete' }));
    const processor = createMainJobProcessor({
        processGitHubIssueJob: process, processPullRequestCommentJob: process,
        processMergeConflictJob: process, processTaskImportJob: process,
        processGoalJob: process, processSystemTaskJob: process,
    }, async job => {
        const reason = await preventWithdrawnJob(job);
        return reason ? { status: 'cancelled', reason } : null;
    });
    tracker = { state: 'closed', merged: false, labels: ['AI'] };
    assert.deepEqual(await processor(addJob('closed-issue', target) as never), { status: 'cancelled', reason: 'cancelled_issue_closed' });
    assert.deepEqual(await processor(addJob('closed-pr', { ...target, pullRequestNumber: 87 }, 'active', 'processPullRequestComment') as never), { status: 'cancelled', reason: 'cancelled_pr_closed' });
    assert.equal(process.mock.callCount(), 0);
});
