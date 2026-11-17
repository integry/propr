import assert from 'node:assert/strict';
import { beforeEach, describe, mock, test } from 'node:test';
import { isBookkeepingCancellation } from '../packages/core/src/utils/workerStateManager.types.js';
import { formatRetryTime, parseResetTimeFromMessage } from '../packages/core/src/utils/scheduling.js';

// #3622 point 5 / #3556: a weekly limit, its stated reset, one retry per issue run.
const jobs = new Map<string, { id: string; name: string; data: Record<string, unknown>; getState: () => Promise<string>; remove: () => Promise<void> }>();
const comments: string[] = [];
const queue = {
    add: async (name: string, data: Record<string, unknown>, opts: { jobId: string }) => {
        const job = jobs.get(opts.jobId) ?? { id: opts.jobId, name, data, getState: async () => 'delayed', remove: async () => { jobs.delete(opts.jobId); } };
        jobs.set(job.id, job);
        return job;
    },
    getJob: async (id: string) => jobs.get(id),
    getDelayed: async () => [...jobs.values()],
};
await mock.module('@propr/core', { namedExports: {
    isBookkeepingCancellation,
    issueQueue: queue, safeRemoveLabel: async () => {}, safeAddLabel: async () => {},
    formatRetryTime, recordLLMMetrics: async () => {}, updateWithdrawnIssueLabels: async () => {},
    TaskStates: { CANCELLED: 'cancelled', COMPLETED: 'completed', FAILED: 'failed' },
} });
const { formatRateLimitComment, handleUsageLimitError } = await import('../src/jobs/errorHandlers.js');

const log = { info() {}, warn() {}, error() {} };
const octokit = { request: async (_route: string, params: { body?: string }) => { if (params.body) comments.push(params.body); return { data: {} }; } };
const manager = { getTaskState: async () => ({ state: 'processing' }), updateTaskState: async () => {} };
const issue = (correlationId: string) => ({ repoOwner: 'integry', repoName: 'propr', number: 3556, agentAlias: 'claude', modelName: 'claude-opus-5-5', correlationId, isChildJob: true, triggeringLabel: 'AI' });
const weekly = () => Object.assign(new Error('usage limit'), {
    name: 'UsageLimitError',
    resetTimestamp: Math.floor(Date.now() / 1000) + 2 * 86_400,
    resetTimeStated: true,
    rawErrorMessage: "You've hit your weekly limit · resets Nov 18, 4pm (UTC)",
});

beforeEach(() => { jobs.clear(); comments.length = 0; });

describe('rate-limit retry guards (#3556)', () => {
    test('the dated weekly reset is parsed instead of falling back to the next hour', () => {
        const now = new Date('2026-11-16T16:57:53Z');
        const reset = parseResetTimeFromMessage("You've hit your weekly limit · resets Nov 18, 4pm (UTC)", now);
        assert.equal(reset, Date.UTC(2026, 10, 18, 16, 0, 0) / 1000);
        assert.equal(parseResetTimeFromMessage('resets Nov 18 at 4:30pm (UTC)', now), Date.UTC(2026, 10, 18, 16, 30, 0) / 1000);
        // A date just past the year boundary is next year's.
        assert.equal(parseResetTimeFromMessage('resets Jan 2, 1am (UTC)', new Date('2026-12-30T00:00:00Z')), Date.UTC(2027, 0, 2, 1, 0, 0) / 1000);
    });

    test('the notice shows one reset time, the weekly one, and a single retry after it', () => {
        const now = Date.UTC(2026, 10, 16, 16, 57, 53);
        const reset = Date.UTC(2026, 10, 18, 16, 0, 0) / 1000;
        const body = formatRateLimitComment({ ...weekly(), resetTimestamp: reset } as never, reset + 30, now);
        assert.match(body, /\*\*Reset time:\*\* Nov 18, 4:00 PM UTC \(in 1 day 23 h\), when the weekly limit resets/);
        assert.match(body, /\*\*Retry:\*\* once, at Nov 18, 4:00 PM UTC/);
        assert.equal((body.match(/Reset time:/g) ?? []).length, 1);
        assert.doesNotMatch(body, /approximately|less than an hour|5:02 PM/);
    });

    test('an estimated reset is not presented as the provider\'s', () => {
        const now = Date.UTC(2026, 10, 16, 16, 57, 53);
        const body = formatRateLimitComment({ ...weekly(), resetTimeStated: false, resetTimestamp: now / 1000 + 300 } as never, now / 1000 + 330, now);
        assert.match(body, /\*\*Reset time:\*\* not stated by the provider for the weekly limit/);
    });

    test('a second task of the same issue run does not schedule another retry or post another notice', async () => {
        await handleUsageLimitError(weekly() as never, { id: 'job-a', name: 'processGitHubIssue', data: issue('task-a') } as never, issue('task-a') as never,
            { octokit, correlatedLogger: log, stateManager: manager, taskId: 'task-a' } as never);
        assert.equal(jobs.size, 1);
        assert.equal(comments.filter(body => body.includes('Rate Limit Reached')).length, 1);
        const [retry] = jobs.values();
        assert.ok(Number(retry.id.length) > 0);

        await handleUsageLimitError(weekly() as never, { id: 'job-b', name: 'processGitHubIssue', data: issue('task-b') } as never, issue('task-b') as never,
            { octokit, correlatedLogger: log, stateManager: manager, taskId: 'task-b' } as never);
        assert.equal(jobs.size, 1, 'one pending retry per issue run');
        assert.equal(comments.filter(body => body.includes('Rate Limit Reached')).length, 1, 'one notice');
    });

    test('the retry is never due before the stated reset', async () => {
        const error = weekly();
        const before = Date.now();
        const added: number[] = [];
        const add = queue.add;
        queue.add = async (name, data, opts) => { added.push((opts as unknown as { delay: number }).delay); return add(name, data, opts); };
        try {
            await handleUsageLimitError(error as never, { id: 'job-c', name: 'processGitHubIssue', data: issue('task-c') } as never, issue('task-c') as never,
                { octokit, correlatedLogger: log, stateManager: manager, taskId: 'task-c' } as never);
        } finally {
            queue.add = add;
        }
        assert.ok(before + added[0] >= error.resetTimestamp * 1000);
    });
});
