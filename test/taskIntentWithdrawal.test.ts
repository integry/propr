import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { isBookkeepingCancellation } from '../packages/core/src/utils/workerStateManager.types.js';

const states = new Map<string, any>();
const conversations = new Map<string, any[]>();
const redisValues = new Map<string, string>();
const jobs: any[] = [];
const requests: Array<{ endpoint: string; params: any }> = [];
const containers: string[] = [];
let tracker: any = { state: 'open', labels: [{ name: 'AI' }] };
let trackerError: Error | undefined;
let closingPR: any;
let onClosingPR: (() => void) | undefined;
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
const reconciliationWarn = mock.fn();
await mock.module('@propr/core', { namedExports: {
    isBookkeepingCancellation,
    issueQueue: queue,
    reconcileTaskIntents: (...args: Parameters<typeof reconcileTaskIntents>) => reconcileTaskIntents(...args),
    logger: { warn: reconciliationWarn },
    safeRemoveLabel: async () => {}, safeAddLabel: async () => {},
    formatRetryTime: () => 'later', hoursUntil: () => 1, recordLLMMetrics: async () => {},
    updateWithdrawnIssueLabels: (...args: Parameters<typeof updateWithdrawnIssueLabels>) => updateWithdrawnIssueLabels(...args),
} });
const { schedulePRCommentUsageLimitRetry } = await import('../src/jobs/prCommentUsageLimitRecovery.js');
const clearedLoops: number[] = [];
await mock.module('../packages/core/src/utils/workerStateManager.js', { namedExports: { getStateManager: () => manager } });
await mock.module('../packages/core/src/queue/taskQueue.js', { namedExports: { getIssueQueue: async () => queue } });
await mock.module('../packages/core/src/auth/githubAuth.js', { namedExports: { getAuthenticatedOctokit: async () => ({ graphql: async () => {
    onClosingPR?.();
    return { repository: { issue: { state: tracker.state.toUpperCase(), timelineItems: { nodes: [{ closer: closingPR }] } } } };
}, request: async (endpoint: string, params: any) => {
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
const discovered: any[] = [];
await initializeWebhookHandler({
    issueProcessor: async issue => { discovered.push(issue); }, commentProcessor: async () => {},
    commentDeletedHandler: async () => {}, commentEditedHandler: async () => {}, redisClient: redis as never,
});
async function removeTrigger(label: string, labels: string[]) {
    await processWebhookEvent({
        repository: { full_name: 'acme/widgets' }, action: 'unlabeled', label: { name: label },
        issue: { number: 42, state: 'open', labels: labels.map(name => ({ name })) },
    }, 'issues', 'trigger-removal');
}
const target = { repoOwner: 'acme', repoName: 'widgets', number: 42, kind: 'issue' as const, type: 'issue', triggeringLabel: 'AI' };

beforeEach(() => { states.clear(); redisValues.clear(); conversations.clear(); jobs.length = 0; requests.length = 0; containers.length = 0; clearedLoops.length = 0; tracker = { state: 'open', labels: [{ name: 'AI' }] }; trackerError = undefined; onRequest = undefined; closingPR = undefined; onClosingPR = undefined; });
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
    tracker = { state: 'closed', labels: tracker.labels };
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
    tracker = { state: 'open', labels: [] };
    await cancelWithdrawnIntent(target, 'cancelled_label_removed', redis as never);
    assert.equal(states.get(taskId).terminalReason, 'cancelled_label_removed');
    assert.equal(JSON.parse(redisValues.get(`worker:abort:${taskId}`)!).reason, 'cancelled_label_removed');
    tracker = { state: 'open', labels: ['AI'] };
    assert.equal(await preventWithdrawnJob(job), 'cancelled_label_removed', 'a redelivery cannot revive a cancelled attempt');
});

test('pending worker state is cancellable during initialization', async () => {
    addRunning('initializing', target, 'pending');
    tracker = { state: 'closed', labels: tracker.labels };
    await cancelWithdrawnIntent(target, 'cancelled_issue_closed', redis as never);
    assert.equal(states.get('initializing').state, 'cancelled');
});

test('PR closure cancels follow-up, review, and Ultrafix and clears the loop', async () => {
    for (const mode of ['default', 'review', 'ultrafix']) addJob(mode, { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 87, commandMode: mode }, 'active', 'processPullRequestComment');
    tracker = { state: 'closed', merged: false };
    await cancelWithdrawnIntent({ ...target, number: 87, kind: 'pr' }, 'cancelled_pr_closed', redis as never);
    for (const mode of ['default', 'review', 'ultrafix']) assert.equal(states.get(mode).terminalReason, 'cancelled_pr_closed');
    assert.deepEqual(clearedLoops, [87]);
    assert.equal(requests.filter(r => !r.endpoint.startsWith('GET ')).length, 0, 'PR cancellation does not change issue labels');
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
            const ref = { ...target, kind, type: kind === 'pr' ? 'pr-comment' : 'issue', ...(kind === 'pr' ? { pullRequestNumber: target.number } : {}) };
            const name = kind === 'pr' ? 'processPullRequestComment' : 'processGitHubIssue';
            if (phase === 'running') addRunning('task', ref);
            else addJob('task', ref, phase === 'queued' ? 'waiting' : 'active', name);
            if (phase === 'admission') {
                tracker = reason === 'cancelled_label_removed' ? { state: 'open', labels: [] } : { state: 'closed', merged: false };
                assert.equal(await preventWithdrawnJob(jobs[0]), reason);
            } else {
                tracker = reason === 'cancelled_label_removed' ? { state: 'open', labels: [] } : { state: 'closed', merged: false };
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
    tracker = { state: 'closed', labels: tracker.labels };
    await cancelWithdrawnIntent(target, 'cancelled_issue_closed', redis as never);
    const oldTaskId = intentJobTaskId(old);
    assert.equal(states.get(oldTaskId).state, 'cancelled');
    assert.equal(await preventWithdrawnJob(old), 'cancelled_issue_closed');
    tracker = { state: 'open', labels: ['AI'] };
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
        tracker = { state: 'closed', merged: false };
        await cancelWithdrawnIntent(pr, 'cancelled_pr_closed', redis as never);
        assert.equal(states.get(oldId).terminalReason, 'cancelled_pr_closed');
        assert.equal(await preventWithdrawnJob(old), 'cancelled_pr_closed');
        const freshData = { ...data, correlationId: 'new-request', comments: [{ ...data.comments[0], id: 2, body: 'New request' }] };
        const newId = await schedulePRCommentUsageLimitRetry({ ...source, data: freshData } as never, freshData.comments as never, 'ratelimit-retry', 1000);
        assert.notEqual(newId, oldId);
        tracker = { state: 'open', labels: ['AI'] };
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
    assert.ok(requests.every(r => r.endpoint.startsWith('GET ')));
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
    tracker = { state: 'closed', labels: tracker.labels };
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
    assert.equal(requests.filter(r => !r.endpoint.startsWith('GET ')).length, 0);
});

for (const labels of [['AI-done'], ['build-done']]) {
    test(`closure preserves successful sibling status (${labels[0]})`, async () => {
        addRunning('remaining');
        tracker = { state: 'closed', labels: [...labels, 'AI-processing', 'build-waiting'] };
        tracker = { state: 'closed', labels: tracker.labels };
    await cancelWithdrawnIntent(target, 'cancelled_issue_closed', redis as never);
        assert.equal(states.get('remaining').terminalReason, 'cancelled_issue_closed');
        assert.ok(requests.some(r => r.params.name === 'AI-processing'));
        assert.ok(requests.every(r => !r.params.name?.endsWith('-done') && !r.params.labels));
    });
}

test('closure checks for completion after awaited label cleanup', async () => {
    tracker = { state: 'closed', labels: [] };
    onRequest = endpoint => {
        if (endpoint.startsWith('DELETE ')) tracker = { state: 'closed', labels: ['AI-done'] };
    };
    await updateWithdrawnIssueLabels(target, ['AI'], 'cancelled_issue_closed');
    assert.ok(requests.every(r => !r.params.labels && r.params.name !== 'AI-done'));
});

for (const phase of ['none', 'running', 'waiting', 'delayed', 'active', 'prioritized', 'other-trigger', 'other-repo', 'terminal'] as const) {
    test(`user stop processing cleanup respects ${phase} siblings`, async () => {
        addRunning('stopped', target, 'cancelled');
        states.get('stopped').terminalReason = 'cancelled_by_user';
        addJob('stopped', target, 'active');
        if (phase === 'running') addRunning('sibling');
        else if (phase === 'other-trigger') addRunning('sibling', { ...target, triggeringLabel: 'build' });
        else if (phase === 'other-repo') addRunning('sibling', { ...target, repoName: 'elsewhere' });
        else if (phase === 'terminal') {
            addRunning('sibling', target, 'completed');
            addJob('sibling', target, 'active');
        } else if (phase !== 'none') addJob('sibling', target, phase);
        await updateWithdrawnIssueLabels(target, ['AI', 'build'], 'cancelled_by_user', 'stopped');
        const shouldClean = ['none', 'other-trigger', 'other-repo', 'terminal'].includes(phase);
        assert.deepEqual(requests.map(r => r.params.name), shouldClean ? ['AI-processing'] : []);
    });
}

test('user stop sees a sibling started during the queue lookup', async () => {
    const getJobs = mock.method(queue, 'getJobs', async () => {
        addRunning('new-sibling');
        return [];
    });
    try {
        await updateWithdrawnIssueLabels(target, ['AI'], 'cancelled_by_user', 'stopped');
        assert.ok(requests.every(r => r.endpoint.startsWith('GET ')));
    } finally { getJobs.mock.restore(); }
});

test('admission cleans up an already user-cancelled issue attempt', async () => {
    addRunning('stopped', target, 'cancelled');
    states.get('stopped').terminalReason = 'cancelled_by_user';
    assert.equal(await preventWithdrawnJob(addJob('stopped', target)), 'cancelled_by_user');
    assert.deepEqual(requests.map(r => r.params.name), ['AI-processing']);
});

test('untyped and system task refs are ineligible even with a resource number', async () => {
    for (const ref of [{ ...target, type: undefined }, { ...target, type: 'system' }, { ...target, type: undefined, pullRequestNumber: 42 }]) {
        assert.equal(taskIntentTarget(ref), null);
        addRunning(JSON.stringify(ref), ref);
    }
    tracker = { state: 'closed', labels: [] };
    await reconcileTaskIntents(redis as never, ['acme/widgets']);
    tracker = { state: 'closed', labels: tracker.labels };
    await cancelWithdrawnIntent(target, 'cancelled_issue_closed', redis as never);
    assert.ok([...states.values()].every(state => state.state === 'claude_execution'));
    assert.ok(requests.every(r => r.endpoint.startsWith('GET ')));
});

test('known queue jobs without type metadata still reconcile issues and PRs', async () => {
    const issue = addJob('issue', { ...target, type: undefined });
    const pr = addJob('pr', { ...target, type: undefined, pullRequestNumber: 43 }, 'waiting', 'processPullRequestComment');
    tracker = { state: 'closed', merged: false, labels: [] };
    await reconcileTaskIntents(redis as never, ['acme/widgets']);
    assert.equal(states.get(issue.id).terminalReason, 'cancelled_issue_closed');
    assert.equal(states.get(pr.id).terminalReason, 'cancelled_pr_closed');
});

const { reconcileTaskIntentsSafely } = await import('../src/daemon/taskIntentReconciliation.js');
for (const boundary of ['scanNonTerminalTasks', 'getJobs'] as const) {
    test(`daemon reconciliation isolates ${boundary} failures and retries on the next cycle`, async () => {
        reconciliationWarn.mock.resetCalls();
        const stub = boundary === 'getJobs'
            ? mock.method(queue, boundary, async () => { throw new Error('Queue unavailable'); })
            : mock.method(manager, boundary, async () => { throw new Error('Scan unavailable'); });
        try {
            await reconcileTaskIntentsSafely(redis as never, ['acme/widgets']);
            assert.equal(reconciliationWarn.mock.callCount(), 1);
            assert.match(reconciliationWarn.mock.calls[0].arguments[1] as string, /continuing discovery/);
        } finally { stub.mock.restore(); }
        addRunning('next-cycle');
        tracker = { state: 'closed', labels: [] };
        await reconcileTaskIntentsSafely(redis as never, ['acme/widgets']);
        assert.equal(states.get('next-cycle').terminalReason, 'cancelled_issue_closed');
        assert.equal(reconciliationWarn.mock.callCount(), 1);
    });
}

const { handleUsageLimitError } = await import('../src/jobs/errorHandlers.js');
test('issue usage-limit retry passes admission after its source is reconciled as cancelled', async () => {
    const data = { ...target, isChildJob: true, agentAlias: 'codex', modelName: 'model', correlationId: 'original-request' };
    const source = addJob('source', data, 'active');
    const taskId = intentJobTaskId(source);
    addRunning(taskId, data);
    await handleUsageLimitError(new Error('Usage limit'), source as never, data, {
        taskId, octokit: null, correlatedLogger: { warn() {}, info() {} },
        stateManager: { ...manager, updateTaskState: async () => {} },
    } as never);
    const retry = jobs.find(job => job.status === 'delayed')!;
    states.get(taskId).state = 'cancelled'; // completedJobTransition for the requeued source
    states.get(taskId).history.push({ state: 'cancelled', reason: 'Task job requeued: rate_limit', metadata: { jobResultStatus: 'requeued' } });
    assert.equal(intentJobTaskId(retry), taskId);
    assert.equal(await preventWithdrawnJob(retry), null);
    assert.equal(retry.data.correlationId, data.correlationId);
    tracker = { state: 'closed', labels: [] };
    assert.equal(await preventWithdrawnJob(retry), 'cancelled_issue_closed');
});

for (const [kind, reason, action] of [
    ['issue', 'cancelled_issue_closed', 'closed'],
    ['issue', 'cancelled_label_removed', 'unlabeled'],
    ['pr', 'cancelled_pr_closed', 'closed'],
] as const) {
    test(`delayed ${reason} webhook cannot cancel a newly admitted request`, async () => {
        const ref = { ...target, kind, type: kind === 'pr' ? 'pr-comment' : 'issue', ...(kind === 'pr' ? { pullRequestNumber: 42 } : {}) };
        const job = addJob('fresh', ref, 'active', kind === 'pr' ? 'processPullRequestComment' : 'processGitHubIssue');
        assert.equal(await preventWithdrawnJob(job), null);
        addRunning('fresh', ref as any);
        await processWebhookEvent({ repository: { full_name: 'acme/widgets' }, action,
            label: { name: 'AI' },
            ...(kind === 'pr' ? { pull_request: { number: 42, state: 'closed', merged: false } }
                : { issue: { number: 42, state: action === 'closed' ? 'closed' : 'open', labels: [] } }),
        }, kind === 'pr' ? 'pull_request' : 'issues', 'stale');
        assert.equal(states.get('fresh').state, 'claude_execution');
        assert.equal(redisValues.size, 0);
        assert.equal(jobs.length, 1);
        assert.deepEqual(containers, []);
        assert.deepEqual(clearedLoops, []);
        assert.ok(requests.every(r => r.endpoint.startsWith('GET ')));
    });
}

test('withdrawal refresh happens after awaited resource scans', async () => {
    addRunning('fresh');
    tracker = { state: 'closed', labels: [] };
    const stub = mock.method(queue, 'getJobs', async () => { tracker = { state: 'open', labels: ['AI'] }; return []; });
    try { await cancelWithdrawnIntent(target, 'cancelled_issue_closed', redis as never); }
    finally { stub.mock.restore(); }
    assert.equal(states.get('fresh').state, 'claude_execution');
});

test('reopening during cleanup prevents publishing a cancelled marker', async () => {
    tracker = { state: 'closed', labels: ['AI-processing'] };
    onRequest = endpoint => { if (endpoint.startsWith('DELETE ')) tracker = { state: 'open', labels: ['AI'] }; };
    await updateWithdrawnIssueLabels(target, ['AI'], 'cancelled_issue_closed');
    assert.ok(requests.some(r => r.endpoint.startsWith('DELETE ')));
    assert.ok(requests.every(r => !r.params.labels));
});

test('merged PR state revokes an earlier unmerged closure event', async () => {
    const pr = { ...target, kind: 'pr' as const };
    addJob('review', { ...pr, pullRequestNumber: 42 }, 'active', 'processPullRequestComment');
    tracker = { state: 'closed', merged: true };
    await cancelWithdrawnIntent(pr, 'cancelled_pr_closed', redis as never);
    assert.equal(states.size, 0);
    assert.equal(jobs.length, 1);
    assert.deepEqual(clearedLoops, []);
});

async function reapplyTrigger(label = 'AI') {
    return processWebhookEvent({ repository: { full_name: 'acme/widgets' }, action: 'labeled', label: { name: label },
        issue: { number: 42, state: 'open', labels: ['AI', 'AI-processing', 'AI-cancelled', 'build-processing'].map(name => ({ name })) },
    }, 'issues', 'restore');
}

test('trigger reapplication repairs failed cleanup after the task and queue are terminal', async () => {
    addRunning('old');
    tracker = { state: 'open', labels: ['AI-processing'] };
    onRequest = endpoint => { if (endpoint.startsWith('DELETE ')) throw new Error('cleanup unavailable'); };
    await assert.rejects(cancelWithdrawnIntent(target, 'cancelled_label_removed', redis as never), /cleanup unavailable/);
    assert.equal(states.get('old').terminalReason, 'cancelled_label_removed');
    assert.equal(jobs.length, 0);
    onRequest = undefined;
    tracker = { state: 'open', labels: ['AI', 'AI-processing', 'AI-cancelled', 'build-processing'] };
    requests.length = 0;
    await reapplyTrigger();
    assert.deepEqual(requests.filter(r => r.endpoint.startsWith('DELETE ')).map(r => r.params.name), ['AI-processing', 'AI-cancelled']);
    assert.deepEqual(discovered.at(-1).labels, ['AI', 'build-processing']);
    assert.equal(states.get('old').terminalReason, 'cancelled_label_removed');
});

for (const endpointPrefix of ['GET ', 'DELETE ', 'POST ']) {
    test(`cleanup retries transient ${endpointPrefix.trim()} errors`, async () => {
        tracker = { state: 'closed', labels: [] };
        let attempts = 0;
        onRequest = endpoint => {
            if (endpoint.startsWith(endpointPrefix) && attempts++ === 0) throw Object.assign(new Error('temporary'), { status: 503 });
        };
        await updateWithdrawnIssueLabels(target, ['AI'], 'cancelled_issue_closed');
        assert.ok(attempts >= 2);
        assert.ok(requests.some(r => r.params.labels?.includes('AI-cancelled')));
    });
}

test('admission retries a transient tracker read and stores a compact reference', async () => {
    tracker = { state: 'closed', merged: false };
    let attempts = 0;
    onRequest = () => { if (attempts++ === 0) throw Object.assign(new Error('temporary'), { status: 503 }); };
    const job = addJob('compact', { ...target, pullRequestNumber: 42, agentAlias: 'codex', correlationId: 'goal-id',
        issuePayload: { body: 'large' }, repoPayload: { description: 'large' }, prProcessingLockToken: 'secret',
    }, 'active', 'processPullRequestComment');
    assert.equal(await preventWithdrawnJob(job), 'cancelled_pr_closed');
    assert.equal(attempts, 2);
    assert.deepEqual(states.get('compact').issueRef, { repoOwner: 'acme', repoName: 'widgets', number: 42,
        type: 'pr-comment', pullRequestNumber: 42, triggeringLabel: 'AI', agentAlias: 'codex', correlationId: 'goal-id' });
});

test('already cancelled admission retries previously failed withdrawal cleanup', async () => {
    addRunning('stopped', target, 'cancelled');
    states.get('stopped').terminalReason = 'cancelled_label_removed';
    tracker = { state: 'open', labels: ['AI-processing'] };
    assert.equal(await preventWithdrawnJob(addJob('stopped', target)), 'cancelled_label_removed');
    assert.ok(requests.some(r => r.params.name === 'AI-processing'));
});

for (const path of ['webhook', 'polling', 'admission'] as const) {
    for (const protection of ['prResult', 'own PR', 'unrelated PR'] as const) {
        test(`${path} issue closure respects ${protection}`, async () => {
            addRunning('publishing', target, 'post_processing');
            states.get('publishing').worktreeInfo = { branchName: 'work-42' };
            if (protection === 'prResult') states.get('publishing').prResult = { prNumber: 87 };
            closingPR = { headRefName: protection === 'own PR' ? 'work-42' : 'other-work', headRepository: { nameWithOwner: 'acme/widgets' } };
            const job = addJob('publishing', target, 'active');
            tracker = { state: 'closed', labels: ['AI'] };
            if (path === 'admission') await preventWithdrawnJob(job);
            else if (path === 'polling') await reconcileTaskIntents(redis as never, ['acme/widgets']);
            else await processWebhookEvent({ repository: { full_name: 'acme/widgets' }, action: 'closed', issue: { number: 42, state: 'closed' } }, 'issues', 'closure');
            if (protection === 'unrelated PR') assert.equal(states.get('publishing').terminalReason, 'cancelled_issue_closed');
            else {
                assert.equal(states.get('publishing').state, 'post_processing');
                assert.equal(redisValues.size, 0);
                assert.deepEqual(containers, []);
                assert.ok(requests.every(r => r.endpoint.startsWith('GET ')));
            }
        });
    }
}

test('a PR result published during the closing-PR lookup prevents a stop', async () => {
    addRunning('publishing', target, 'post_processing');
    states.get('publishing').worktreeInfo = { branchName: 'work-42' };
    tracker = { state: 'closed', labels: ['AI'] };
    onClosingPR = () => { states.get('publishing').prResult = { prNumber: 87 }; };
    await cancelWithdrawnIntent(target, 'cancelled_issue_closed', redis as never);
    assert.equal(states.get('publishing').state, 'post_processing');
    assert.equal(redisValues.size, 0);
    assert.deepEqual(containers, []);
});

test('cancelled-label publish retries revalidate closure after backoff', async () => {
    tracker = { state: 'closed', labels: ['AI-processing'] };
    let publishes = 0;
    onRequest = endpoint => {
        if (endpoint.startsWith('POST ')) {
            publishes++;
            tracker = { state: 'open', labels: ['AI'] };
            throw Object.assign(new Error('temporary'), { status: 503 });
        }
    };
    await updateWithdrawnIssueLabels(target, ['AI'], 'cancelled_issue_closed');
    assert.equal(publishes, 1, 'the retry must not publish to the reopened issue');
    assert.equal(requests.at(-1)?.endpoint, 'GET /repos/{owner}/{repo}/issues/{issue_number}');
});

test('trigger reapplication retries cleanup and model labels do not clear status', async () => {
    tracker = { state: 'open', labels: ['AI', 'AI-processing', 'AI-cancelled'] };
    let deletes = 0;
    onRequest = endpoint => {
        if (endpoint.startsWith('DELETE ') && deletes++ === 0) throw Object.assign(new Error('temporary'), { status: 503 });
    };
    await reapplyTrigger();
    assert.equal(deletes, 3);
    assert.deepEqual(discovered.at(-1).labels, ['AI']);
    requests.length = 0;
    await reapplyTrigger('llm-codex-astra');
    assert.deepEqual(requests, []);
});

test('user-stop cleanup preserves a sibling that starts during retry backoff', async () => {
    let deletes = 0;
    onRequest = endpoint => {
        if (endpoint.startsWith('DELETE ')) {
            deletes++;
            addRunning('new-sibling');
            throw Object.assign(new Error('temporary'), { status: 503 });
        }
    };
    await updateWithdrawnIssueLabels(target, ['AI'], 'cancelled_by_user', 'stopped');
    assert.equal(deletes, 1);
});
