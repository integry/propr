import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

const states = new Map<string, any>();
const conversations = new Map<string, any[]>();
const redisValues = new Map<string, string>();
const jobs: any[] = [];
const requests: Array<{ endpoint: string; params: any }> = [];
const containers: string[] = [];
let tracker: any = { state: 'open', labels: [{ name: 'AI' }] };
let trackerError: Error | undefined;
let onRequest: ((endpoint: string) => void) | undefined;
const redis = {
    get: async (key: string) => key.startsWith('worker:state:')
        ? (states.has(key.slice(13)) ? JSON.stringify(states.get(key.slice(13))) : null)
        : redisValues.get(key) ?? null,
    set: async (key: string, value: string) => { redisValues.set(key, value); return 'OK'; },
    rpush: async (key: string, value: string) => {
        const messages = conversations.get(key) ?? [];
        messages.push(JSON.parse(value));
        conversations.set(key, messages);
        return messages.length;
    },
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
const queue = {
    getJobs: async (statuses: string[]) => jobs.filter(j => statuses.includes(j.status)),
    getJob: async (id: string) => jobs.find(j => j.id === id),
    add: async (name: string, data: any, options: { jobId: string }) => jobs.find(j => j.id === options.jobId)
        ?? addJob(options.jobId, data, 'delayed', name),
};
await mock.module('@propr/core', { namedExports: { issueQueue: queue } });
const { schedulePRCommentUsageLimitRetry } = await import('../src/jobs/prCommentUsageLimitRecovery.js');
const clearedLoops: number[] = [];
await mock.module('../packages/core/src/utils/workerStateManager.js', { namedExports: { getStateManager: () => manager } });
await mock.module('../packages/core/src/queue/taskQueue.js', { namedExports: { getIssueQueue: async () => queue } });
await mock.module('../packages/core/src/auth/githubAuth.js', { namedExports: { getAuthenticatedOctokit: async () => ({ request: async (endpoint: string, params: any) => {
    requests.push({ endpoint, params });
    onRequest?.(endpoint);
    if (trackerError) throw trackerError;
    return { data: tracker };
} }) } });
await mock.module('../packages/core/src/config/configManager.js', { namedExports: { loadPrimaryProcessingLabels: async () => ['AI', 'build'] } });
await mock.module('../packages/core/src/db/connection.js', { namedExports: { db: () => ({ select: () => ({ where: () => ({ first: async () => undefined }) }) }) } });
await mock.module('../packages/core/src/claude/docker/dockerExecutor.js', { namedExports: { stopDockerContainer: async (id: string) => { containers.push(id); return { success: true }; } } });
await mock.module('../packages/core/src/webhook/checkRunHelpers.js', { namedExports: { getUltrafixStateRedis: () => redis, clearUltrafixLoopState: async (_owner: string, _repo: string, number: number) => { clearedLoops.push(number); } } });
const { cancelWithdrawnIntent, reconcileTaskIntents, preventWithdrawnJob, withdrawnIntentReason, updateWithdrawnIssueLabels, taskIntentTarget, intentJobTaskId } = await import('../packages/core/src/services/taskIntent.js');
await mock.module('../packages/core/src/webhook/planIssueTracking.js', { namedExports: {
    handlePlanIssueStatusUpdate: async () => {}, handlePlanPRUpdate: async () => {}, handlePlanPRCommentTracking: async () => {},
} });
await mock.module('../packages/core/src/webhook/checkRunHandler.js', { namedExports: {
    handleCheckRunEvent: async () => {}, handleStatusEvent: async () => {}, reevaluatePRAutoMerge: async () => {},
} });
await mock.module('../packages/core/src/webhook/epicPRHandler.js', { namedExports: {
    handleEpicPRCreationOnMerge: async () => {}, handleEpicPRLabelCleanup: async () => {},
} });
await mock.module('../packages/core/src/webhook/closedPullRequestCi.js', { namedExports: {
    getClosedPullRequestCiRedis: () => redis, recordClosedPullRequestForCiCancellation: async () => {},
} });
await mock.module('../packages/core/src/webhook/mergeConflictDetector.js', { namedExports: {
    handlePullRequestConflictDetection: async () => {}, handlePushConflictDetection: async () => {},
} });
const { initializeWebhookHandler, processWebhookEvent } = await import('../packages/core/src/webhook/webhookHandler.js');
await initializeWebhookHandler({
    issueProcessor: async () => {}, commentProcessor: async () => {},
    commentDeletedHandler: async () => {}, commentEditedHandler: async () => {}, redisClient: redis as never,
});
async function removeTrigger(label: string, labels: string[]) {
    await processWebhookEvent({
        repository: { full_name: 'acme/widgets' }, action: 'unlabeled', label: { name: label },
        issue: { number: 42, state: 'open', labels: labels.map(name => ({ name })) },
    }, 'issues', 'trigger-removal');
}
const target = { repoOwner: 'acme', repoName: 'widgets', number: 42, kind: 'issue' as const, triggeringLabel: 'AI' };

beforeEach(() => { states.clear(); redisValues.clear(); conversations.clear(); jobs.length = 0; requests.length = 0; containers.length = 0; clearedLoops.length = 0; tracker = { state: 'open', labels: [{ name: 'AI' }] }; trackerError = undefined; onRequest = undefined; });
function addJob(id: string, data: any, status = 'waiting', name = 'processGitHubIssue') {
    const job = { id, data, status, name, getState: async () => job.status, remove: async () => { jobs.splice(jobs.indexOf(job), 1); } };
    jobs.push(job);
    return job;
}
function addRunning(id: string, ref = target, state = 'claude_execution') {
    states.set(id, { taskId: id, issueRef: ref, state, history: [{ state, metadata: { containerId: `container-${id}` } }] });
}

for (const reason of ['cancelled_by_user', 'timed_out', 'cancelled_pr_closed', 'pr_merged', undefined] as const) {
    test(`label cleanup ignores non-issue-withdrawal reason ${reason ?? '(missing)'}`, async () => {
        tracker = { state: 'open', labels: ['AI', 'AI-done', 'AI-processing', 'AI-waiting'] };
        await updateWithdrawnIssueLabels(target, ['AI', 'build'], reason);
        assert.deepEqual(requests, [], 'stopping one attempt must not alter sibling status or discovery labels');
    });
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

for (const [reason, explanation, kind] of [
    ['cancelled_issue_closed', 'Cancelled because the issue was closed.', 'issue'],
    ['cancelled_label_removed', 'Cancelled because the processing trigger label was removed.', 'issue'],
    ['cancelled_pr_closed', 'Cancelled because the pull request was closed without merging.', 'pr'],
] as const) {
    for (const phase of ['running', 'active-without-state', 'queued', 'admission'] as const) {
        test(`${reason} persists readable history and conversation text for ${phase}`, async () => {
            const ref = { ...target, kind, ...(kind === 'pr' ? { pullRequestNumber: target.number } : {}) };
            const name = kind === 'pr' ? 'processPullRequestComment' : 'processGitHubIssue';
            if (phase === 'running') addRunning('task', ref);
            else addJob('task', ref, phase === 'queued' ? 'waiting' : 'active', name);
            if (phase === 'admission') {
                tracker = reason === 'cancelled_label_removed' ? { state: 'open', labels: [] } : { state: 'closed', merged: false };
                assert.equal(await preventWithdrawnJob(jobs[0]), reason);
            } else {
                await cancelWithdrawnIntent(ref, reason, redis as never);
            }
            const state = states.get('task');
            assert.equal(state.terminalReason, reason);
            assert.equal(state.history.at(-1).metadata.reason, explanation);
            const messages = conversations.get('conversation:task') ?? [];
            if (phase === 'running' || phase === 'active-without-state') {
                assert.equal(messages.find(message => message.level === 'warning')?.content, explanation);
                assert.equal(JSON.parse(redisValues.get('worker:abort:task')!).reason, reason);
            }
            assert.ok(messages.every(message => !message.content.includes(reason)));
        });
    }
}

test('cancelling a dispatcher does not block a new request under its reused queue ID', async () => {
    const old = addJob('issue-acme-widgets-42', { ...target, correlationId: 'old-request' }, 'delayed');
    await cancelWithdrawnIntent(target, 'cancelled_issue_closed', redis as never);
    const oldTaskId = intentJobTaskId(old);
    assert.equal(states.get(oldTaskId).state, 'cancelled');
    assert.equal(await preventWithdrawnJob(old), 'cancelled_issue_closed');
    const fresh = addJob(old.id, { ...target, correlationId: 'new-request' });
    assert.equal(await preventWithdrawnJob(fresh), null);
    assert.ok(requests.some(r => r.endpoint === 'GET /repos/{owner}/{repo}/issues/{issue_number}'));
    tracker = { state: 'open', labels: [] };
    assert.equal(await preventWithdrawnJob(fresh), 'cancelled_label_removed');
    assert.equal(states.get(oldTaskId).terminalReason, 'cancelled_issue_closed');
});

for (const phase of ['delayed', 'active', 'running']) {
    test(`a new PR usage-limit retry survives cancellation of an earlier ${phase} request`, async () => {
        const pr = { ...target, kind: 'pr' as const };
        const data = { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 42, correlationId: 'old-request', comments: [{ id: 1, body: 'First request', author: 'alice', type: 'issue' }] };
        const source = { id: 'source', name: 'processPullRequestComment', data };
        const oldId = await schedulePRCommentUsageLimitRetry(source as never, data.comments as never, 'ratelimit-retry', 1000);
        const old = jobs.find(job => job.id === oldId);
        if (phase !== 'delayed') old.status = 'active';
        if (phase === 'running') addRunning(oldId, { ...pr, pullRequestNumber: 42, type: 'pr-comment' } as any);
        await cancelWithdrawnIntent(pr, 'cancelled_pr_closed', redis as never);
        assert.equal(states.get(oldId).terminalReason, 'cancelled_pr_closed');
        assert.equal(await preventWithdrawnJob(old), 'cancelled_pr_closed');
        const freshData = { ...data, correlationId: 'new-request', comments: [{ ...data.comments[0], id: 2, body: 'New request' }] };
        const newId = await schedulePRCommentUsageLimitRetry({ ...source, data: freshData } as never, freshData.comments as never, 'ratelimit-retry', 1000);
        assert.notEqual(newId, oldId);
        const fresh = jobs.find(job => job.id === newId);
        assert.equal(await preventWithdrawnJob(fresh), null);
        assert.deepEqual(fresh.data.comments, freshData.comments);
        assert.ok(requests.some(r => r.endpoint === 'GET /repos/{owner}/{repo}/pulls/{pull_number}'));
        tracker = { state: 'closed', merged: false };
        assert.equal(await preventWithdrawnJob(fresh), 'cancelled_pr_closed');
    });
}


test('unlabel webhook preserves running and queued AI work when only build is removed', async () => {
    addRunning('implementation');
    addJob('matrix-waiting', target);
    addJob('matrix-active', target, 'active');
    await removeTrigger('build', ['AI']);
    assert.equal(states.get('implementation').state, 'claude_execution');
    assert.equal(states.size, 1);
    assert.equal(jobs.length, 2);
    assert.equal(redisValues.size, 0);
    assert.deepEqual(containers, []);
    assert.deepEqual(requests, []);
});

for (const path of ['webhook', 'polling', 'admission'] as const) {
    test(`${path} cancels only build work and preserves AI status and discovery eligibility`, async () => {
        const build = { ...target, triggeringLabel: 'build' };
        addRunning('ai-running');
        addRunning('build-running', build);
        addJob('ai-matrix', target, 'delayed');
        const withdrawn = addJob('build-matrix', build, 'prioritized');
        tracker = { state: 'open', labels: ['AI', 'AI-processing', 'AI-waiting', 'AI-done', 'build-processing'] };
        if (path === 'webhook') await removeTrigger('build', tracker.labels);
        else if (path === 'polling') await reconcileTaskIntents(redis as never, ['acme/widgets']);
        else assert.equal(await preventWithdrawnJob(withdrawn), 'cancelled_label_removed');
        assert.equal(states.get('ai-running').state, 'claude_execution');
        assert.ok(jobs.some(job => job.id === 'ai-matrix'));
        assert.equal(states.has('ai-matrix'), false);
        assert.equal(states.get('build-matrix').terminalReason, 'cancelled_label_removed');
        if (path !== 'admission') assert.equal(states.get('build-running').terminalReason, 'cancelled_label_removed');
        assert.ok(requests.some(r => r.params.name === 'build-processing'));
        assert.ok(requests.every(r => !r.params.name?.startsWith('AI-')));
        assert.ok(requests.every(r => !r.params.labels?.some((label: string) => label.endsWith('-cancelled'))));
    });
}

test('legacy work without a recorded trigger survives until the last configured trigger is removed', async () => {
    const legacy = { ...target, triggeringLabel: undefined };
    addRunning('legacy-running', legacy as any);
    addJob('legacy-queued', legacy);
    await removeTrigger('build', ['AI']);
    assert.equal(states.get('legacy-running').state, 'claude_execution');
    assert.equal(jobs.length, 1);
    tracker = { state: 'open', labels: [] };
    await removeTrigger('AI', []);
    assert.equal(states.get('legacy-running').terminalReason, 'cancelled_label_removed');
    assert.equal(states.get('legacy-queued').terminalReason, 'cancelled_label_removed');
    assert.ok(requests.some(r => r.params.labels?.includes('AI-cancelled')));
});

test('polling legacy work does not cancel a sibling with its own surviving trigger', async () => {
    addRunning('legacy', { ...target, triggeringLabel: undefined } as any);
    addRunning('custom', { ...target, triggeringLabel: 'custom' });
    tracker = { state: 'open', labels: ['custom'] };
    await reconcileTaskIntents(redis as never, ['acme/widgets']);
    assert.equal(states.get('legacy').terminalReason, 'cancelled_label_removed');
    assert.equal(states.get('custom').state, 'claude_execution');
});

test('closure still cancels work from both triggers', async () => {
    addRunning('ai');
    addRunning('build', { ...target, triggeringLabel: 'build' });
    await cancelWithdrawnIntent(target, 'cancelled_issue_closed', redis as never);
    assert.equal(states.get('ai').terminalReason, 'cancelled_issue_closed');
    assert.equal(states.get('build').terminalReason, 'cancelled_issue_closed');
});

test('label cleanup refreshes intent after an awaited stop', async () => {
    addRunning('build', { ...target, triggeringLabel: 'build' });
    tracker = { state: 'open', labels: [] };
    const cancel = manager.markTaskCancelled;
    const stub = mock.method(manager, 'markTaskCancelled', async (...args: Parameters<typeof cancel>) => {
        const result = await cancel(...args);
        tracker = { state: 'open', labels: ['AI', 'AI-processing'] };
        return result;
    });
    try {
        await cancelWithdrawnIntent({ ...target, triggeringLabel: 'build' }, 'cancelled_label_removed', redis as never);
    } finally {
        stub.mock.restore();
    }
    assert.ok(requests.some(r => r.endpoint.startsWith('GET ')));
    assert.ok(requests.every(r => r.params.name !== 'AI-processing' && !r.params.labels));
});


test('a trigger restored during label cleanup prevents a discovery-blocking cancellation label', async () => {
    addRunning('build', { ...target, triggeringLabel: 'build' });
    tracker = { state: 'open', labels: [] };
    onRequest = endpoint => {
        if (endpoint.startsWith('DELETE ')) tracker = { state: 'open', labels: ['AI'] };
    };
    await cancelWithdrawnIntent({ ...target, triggeringLabel: 'build' }, 'cancelled_label_removed', redis as never);
    assert.ok(requests.some(r => r.params.name === 'build-processing'));
    assert.ok(requests.every(r => !r.params.labels));
});

test('unlabel webhook respects a task trigger still present in the payload', async () => {
    addRunning('implementation');
    addJob('matrix', target);
    await removeTrigger('AI', ['AI', 'build']);
    assert.equal(states.get('implementation').state, 'claude_execution');
    assert.equal(jobs.length, 1);
    assert.equal(requests.length, 0);
});
