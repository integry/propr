import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { isDefaultRetryableError } from '../packages/core/src/utils/retryHandler.js';

const calls: Array<{ method: string; request: Record<string, unknown> }> = [];
const service = {
    async prepare(request: Record<string, unknown>) {
        calls.push({ method: 'prepare', request });
        return { eligible: true, attemptNumber: 2, maxReplacements: 2 };
    },
    async complete(request: Record<string, unknown>) {
        calls.push({ method: 'complete', request });
        return { action: 'dispatched' };
    },
    async lineage() { return []; },
    formatAttempts: () => '',
};
const log = { info() {}, warn() {}, error() {} };

await mock.module('@propr/core', { namedExports: {
    isDefaultRetryableError,
    isBookkeepingCancellation: () => false,
    issueQueue: { add: async () => ({}) }, safeRemoveLabel: async () => {}, safeAddLabel: async () => {},
    formatRetryTime: () => 'later', hoursUntil: () => 1, recordLLMMetrics: async () => {},
    updateWithdrawnIssueLabels: async () => {},
} });
const { isTransientProviderError } = await import('../src/taskReplacement/policy.js');
await mock.module('../src/taskReplacement/index.js', { namedExports: {
    getTaskReplacementService: () => service,
    isTransientProviderError,
} });
const { handleGenericError } = await import('../src/jobs/errorHandlers.js');
const { completeProviderReplacement, markAgentExecutionFailure, prepareProviderReplacement } = await import('../src/jobs/providerReplacement.js');

const issueRef = { repoOwner: 'integry', repoName: 'propr', number: 2739, correlationId: 'c', isChildJob: true } as any;
let marked: unknown[] = [];
const options = () => ({
    octokit: { request: async () => ({}) },
    claudeResult: { success: true } as any,
    worktreeInfo: undefined,
    correlatedLogger: log as any,
    stateManager: {
        getTaskState: async () => ({ state: 'processing' }),
        markTaskFailed: async (_taskId: string, error: unknown) => { marked.push(error); },
    } as any,
    taskId: 'task-1',
    AI_PROCESSING_TAG: 'AI-processing',
});

function serverError(message: string, status: number): Error {
    return Object.assign(new Error(message), { status });
}

beforeEach(() => { calls.length = 0; marked = []; });

for (const [label, error] of [
    ['a GitHub server error', serverError('GitHub API returned 503: <!DOCTYPE html> Unicorn!', 503)],
    ['a git failure', serverError('git push failed: 502 Bad Gateway', 502)],
] as const) {
    test(`${label} after the agent succeeded fails the task without a provider replacement`, async () => {
        assert.equal(isTransientProviderError(error), true, 'the status alone looks transient');
        await handleGenericError(error, { id: 'job' } as any, issueRef, options());
        assert.equal(marked.length, 1, 'the task is still marked failed');
        assert.deepEqual(calls, [], 'neither preparation nor completion treats it as a provider failure');
    });
}

test('a transient error thrown by the agent execution is replaced', async () => {
    const error = markAgentExecutionFailure(serverError('529 Overloaded', 529));
    await handleGenericError(error, { id: 'job' } as any, issueRef, { ...options(), claudeResult: null });
    assert.deepEqual(calls.map(({ method, request }) => [method, request.cause]),
        [['prepare', 'provider_transient'], ['complete', 'provider_transient']]);
});

test('provider replacement calls require agent-execution origin, not just a retryable status', async () => {
    const error = serverError('503 Service Unavailable', 503);
    assert.equal(await prepareProviderReplacement({ taskId: 'task-1', error, fromAgentExecution: false, correlatedLogger: log }), '');
    await completeProviderReplacement({ taskId: 'task-1', error, fromAgentExecution: false, correlatedLogger: log });
    assert.deepEqual(calls.filter(call => call.method !== 'lineage').map(call => call.method), []);

    assert.match(await prepareProviderReplacement({ taskId: 'task-1', error, fromAgentExecution: true, correlatedLogger: log }), /Retrying automatically/);
    await completeProviderReplacement({ taskId: 'task-1', error, fromAgentExecution: true, correlatedLogger: log });
    assert.deepEqual(calls.map(call => call.method), ['prepare', 'complete']);
});
