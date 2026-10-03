import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { isBookkeepingCancellation } from '../packages/core/src/utils/workerStateManager.types.js';
import { buildIssueTaskId } from '@propr/shared';

const jobs = new Map<string, any>();
let state: any;
let onAdd: (() => void) | undefined;
let onUpdate: (() => void) | undefined;
let onReload: ((job: any) => any) | undefined;
const log = { info() {}, warn() {}, error() {} };
const queue = {
    add: async (name: string, data: any, opts: any) => {
        const job = jobs.get(opts.jobId) ?? { id: opts.jobId, name, data, getState: async () => 'delayed', remove: async () => { jobs.delete(opts.jobId); } };
        jobs.set(job.id, job);
        onAdd?.();
        return job;
    },
    getJob: async (id: string) => onReload ? onReload(jobs.get(id)) : jobs.get(id),
};
const labels: unknown[][] = [];
await mock.module('@propr/core', { namedExports: {
    isBookkeepingCancellation,
    issueQueue: queue, safeRemoveLabel: async () => {}, safeAddLabel: async () => {},
    formatRetryTime: () => 'later', hoursUntil: () => 1, recordLLMMetrics: async () => {},
    updateWithdrawnIssueLabels: async (...args: unknown[]) => { labels.push(args); },
    TaskStates: { CANCELLED: 'cancelled', COMPLETED: 'completed', FAILED: 'failed' },
} });
const { handleUsageLimitError, handleGenericError, postCancellationNotice } = await import('../src/jobs/errorHandlers.js');
const { completedJobTransition } = await import('../src/taskReconciliationTransitions.js');
const data = { repoOwner: 'acme', repoName: 'widgets', number: 42, agentAlias: 'codex', modelName: 'model', correlationId: 'original-request', isChildJob: true, triggeringLabel: 'AI' };
const source = { id: 'source', name: 'processGitHubIssue', data };
const taskIdFor = (data: any) => buildIssueTaskId({ ...data, issueNumber: data.number });
const manager = {
    getTaskState: async () => state,
    updateTaskState: async () => { onUpdate?.(); },
    markTaskCancelled: async () => { state = { state: 'cancelled', terminalReason: 'cancelled_by_user' }; },
};
const options = () => ({ octokit: null, correlatedLogger: log, stateManager: manager, taskId: taskIdFor(source.data) }) as any;
beforeEach(() => { jobs.clear(); labels.length = 0; state = { state: 'processing' }; onAdd = undefined; onUpdate = undefined; onReload = undefined; });

test('usage-limit retries preserve task identity and goal correlation across queue handoffs', async () => {
    await handleUsageLimitError(new Error('usage limit'), source as any, data, options());
    const retry = [...jobs.values()][0];
    const transition = completedJobTransition({ status: 'requeued', reason: 'rate_limit' });
    assert.equal(transition.state, 'cancelled');
    assert.equal(transition.metadata.terminalReason, undefined);
    state = { state: transition.state };
    assert.equal(taskIdFor(retry.data), taskIdFor(source.data));
    assert.equal(retry.data.correlationId, source.data.correlationId);
    assert.equal(retry.data.isRetryFromRateLimit, true);
    assert.equal(retry.data.triggeringLabel, 'AI');
    // Another usage limit gets another queue job, while replaying one source deduplicates.
    state = { state: 'processing' };
    await handleUsageLimitError(new Error('usage limit'), source as any, data, options());
    assert.equal(jobs.size, 1);
    await handleUsageLimitError(new Error('usage limit'), retry, retry.data, { ...options(), taskId: taskIdFor(retry.data) });
    assert.equal(jobs.size, 2);
    assert.equal(new Set([...jobs.values()].map(job => taskIdFor(job.data))).size, 1);
});

for (const boundary of ['before scheduling', 'queue add', 'state update']) {
    test(`user cancellation at ${boundary} leaves no delayed retry`, async () => {
        const cancel = () => { state = { state: 'cancelled', terminalReason: 'cancelled_by_user' }; };
        if (boundary === 'before scheduling') cancel();
        if (boundary === 'queue add') onAdd = cancel;
        if (boundary === 'state update') onUpdate = cancel;
        await handleUsageLimitError(new Error('usage limit'), source as any, data, options());
        assert.equal(jobs.size, 0);
        assert.equal(state.terminalReason, 'cancelled_by_user');
    });
}

for (const defect of ['missing', 'wrong payload', 'completed']) {
    test(`does not report a durable retry for ${defect} persisted queue data`, async () => {
        onReload = job => defect === 'missing' ? undefined : defect === 'wrong payload'
            ? { ...job, data: source.data } : { ...job, getState: async () => 'completed' };
        await assert.rejects(handleUsageLimitError(new Error('usage limit'), source as any, data, options()), /Unable to persist issue usage-limit retry/);
    });
}

test('legacy user-abort handler delegates processing cleanup with the stopped task identity', async () => {
    await handleGenericError(new Error('Execution aborted by user'), source as any, data, {
        ...options(), octokit: { request: async () => ({}) }, claudeResult: null, AI_PROCESSING_TAG: 'AI-processing',
    });
    assert.equal(labels.length, 1);
    assert.equal((labels[0][0] as any).triggeringLabel, 'AI');
    assert.equal(labels[0][2], 'cancelled_by_user');
    assert.equal(labels[0][3], taskIdFor(data));
});

for (const boundary of ['before scheduling', 'queue add', 'state update']) {
    test(`bookkeeping cancellation at ${boundary} does not discard the same-task retry`, async () => {
        const handoff = () => { state = { state: 'cancelled', history: [{ reason: 'Task job requeued: rate_limit', metadata: { jobResultStatus: 'requeued' } }] }; };
        if (boundary === 'before scheduling') handoff();
        if (boundary === 'queue add') onAdd = handoff;
        if (boundary === 'state update') onUpdate = handoff;
        await handleUsageLimitError(new Error('usage limit'), source as any, data, options());
        assert.equal(jobs.size, 1);
        assert.equal([...jobs.values()][0].data.correlationId, data.correlationId);
    });
}

for (const terminal of ['completed', 'failed']) {
    test(`a BullMQ-retried source gets a new owner after the previous retry ${terminal}`, async () => {
        await handleUsageLimitError(new Error('usage limit'), source as any, data, options());
        const previous = [...jobs.values()][0];
        previous.getState = async () => terminal;
        const retriedSource = { ...source, attemptsMade: 1 };
        await handleUsageLimitError(new Error('usage limit'), retriedSource as any, data, options());
        const next = [...jobs.values()].find(job => job.id !== previous.id)!;
        assert.ok(next);
        assert.equal(await next.getState(), 'delayed');
        assert.equal(taskIdFor(next.data), taskIdFor(data));
        await handleUsageLimitError(new Error('usage limit'), retriedSource as any, data, options());
        assert.equal(jobs.size, 2, 'the same BullMQ attempt still deduplicates');
        await handleUsageLimitError(new Error('usage limit'), { ...source, attemptsMade: 2 } as any, data, options());
        assert.equal(jobs.size, 2, 'later attempts reuse a live replacement too');
        next.getState = async () => terminal;
        await handleUsageLimitError(new Error('usage limit'), { ...source, attemptsMade: 2 } as any, data, options());
        assert.equal(jobs.size, 3, 'later attempts replace a terminal replacement');
    });
}

test('user-stop notice explains how to restart a trigger that remains applied', async () => {
    const request = mock.fn(async () => ({}));
    await postCancellationNotice(data, { ...options(), octokit: { request } });
    const [, params] = request.mock.calls[0].arguments as unknown as [string, { body: string }];
    assert.match(params.body, /remove and re-add the trigger label/);
});


test('a BullMQ retry reuses its existing live issue handoff', async () => {
    await handleUsageLimitError(new Error('usage limit'), source as any, data, options());
    await handleUsageLimitError(new Error('usage limit'), { ...source, attemptsMade: 1 } as any, data, options());
    assert.equal(jobs.size, 1);
});


test('cancellation while scheduling a replacement removes the new retry', async () => {
    await handleUsageLimitError(new Error('usage limit'), source as any, data, options());
    const previous = [...jobs.values()][0];
    previous.getState = async () => 'completed';
    let adds = 0;
    onAdd = () => { if (++adds === 2) state = { state: 'cancelled', terminalReason: 'cancelled_by_user' }; };
    await handleUsageLimitError(new Error('usage limit'), { ...source, attemptsMade: 1 } as any, data, options());
    assert.deepEqual([...jobs.keys()], [previous.id]);
});
