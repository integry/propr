import { describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Job } from 'bullmq';

let exactLiveness: 'running' | 'stopped' | 'not_found' | 'unavailable' = 'not_found';
let legacyLiveness: 'running' | 'not_found' | 'unavailable' = 'not_found';
const exactLivenessByTask = new Map<string, typeof exactLiveness>();
const queueAdd = mock.fn(async () => ({ id: 'replacement-task-2' }));

await mock.module('@propr/core', {
    namedExports: {
        inspectTaskContainerLivenessForTask: mock.fn(async (taskId: string) => {
            const liveness = exactLivenessByTask.get(taskId) ?? exactLiveness;
            return {
            liveness,
            container: liveness === 'running' || liveness === 'stopped'
                ? { id: 'container-1', name: 'codex-task-old' }
                : null,
            };
        }),
        inspectLegacyDockerContainerLivenessForTask: mock.fn(async () => legacyLiveness),
        issueQueue: { add: queueAdd },
        TaskStates: { PENDING: 'pending', PROCESSING: 'processing', CANCELLED: 'cancelled' },
        getPendingPrCommentsKey: (owner: string, repo: string, pr: number) => `pending-pr-comments:${owner}:${repo}:${pr}`,
    },
});

const {
    inspectPRCommentContainerCollision,
    isContainerCollisionCancellation,
    evaluatePRCommentPreExecutionRecovery,
    handlePRCommentLockContention,
    schedulePRCommentRecovery,
} = await import('../src/jobs/prCommentCollisionRecovery.js');
const {
    acquirePRProcessingLock,
    ensurePRProcessingLockToken,
    releasePRProcessingLock,
} = await import('../src/jobs/prProcessingLock.js');

describe('PR comment container collision recovery', () => {
    test('continues past stopped containers but defers live and unavailable inspection', async () => {
        exactLiveness = 'stopped';
        legacyLiveness = 'not_found';
        assert.equal(await inspectPRCommentContainerCollision(['attempt-1']), null);

        exactLiveness = 'running';
        const running = await inspectPRCommentContainerCollision(['attempt-1']);
        assert.equal(running?.inspection.liveness, 'running');
        assert.equal(running?.source, 'exact-label');

        exactLiveness = 'unavailable';
        const unavailable = await inspectPRCommentContainerCollision(['attempt-1']);
        assert.equal(unavailable?.inspection.liveness, 'unavailable');
    });

    test('distinguishes collision cancellation from user cancellation', () => {
        const state = (reason: string) => ({
            state: 'cancelled',
            history: [{ state: 'cancelled', reason }],
        });
        assert.equal(isContainerCollisionCancellation(state('agent_container_already_running') as never), true);
        assert.equal(isContainerCollisionCancellation(state('Task cancelled by user') as never), false);
    });

    test('latest explicit user cancellation overrides a retained collision lastError', () => {
        const state = {
            state: 'cancelled',
            history: [
                { state: 'cancelled', reason: 'agent_container_already_running' },
                { state: 'cancelled', reason: 'Task cancelled by user' },
            ],
            lastError: { message: 'agent_container_already_running' },
        };

        assert.equal(isContainerCollisionCancellation(state as never), false);
    });

    test('restores the claim, delays a fenced replacement, and preserves cancellation ownership', async () => {
        queueAdd.mock.resetCalls();
        const pending = new Map<string, string[]>();
        const redis = {
            async lrange(key: string) { return [...(pending.get(key) ?? [])]; },
            async lpush(key: string, ...values: string[]) {
                const list = pending.get(key) ?? [];
                for (const value of values) list.unshift(value);
                pending.set(key, list);
                return list.length;
            },
            async expire() { return 1; },
        };
        const states = new Map<string, { state: string }>([['cancelled-task-1', { state: 'cancelled' }]]);
        const created: string[] = [];
        const metadataUpdates: Array<{ taskId: string; state: string; metadata: Record<string, unknown> }> = [];
        const stateManager = {
            async getTaskState(taskId: string) { return states.get(taskId) ?? null; },
            async createTaskStateIfAbsent(taskId: string) {
                const existing = states.get(taskId);
                if (existing) return existing;
                created.push(taskId);
                const state = { state: 'pending' };
                states.set(taskId, state);
                return state;
            },
            async updateHistoryMetadata(taskId: string, state: string, metadata: Record<string, unknown>) {
                metadataUpdates.push({ taskId, state, metadata });
            },
        };
        const logger = { info: mock.fn(), warn: mock.fn() };
        const comment = { id: 2228, body: 'preserve me', author: 'alice', type: 'issue' as const };
        const job = {
            id: 'cancelled-task-1',
            name: 'processPullRequestComment',
            data: {
                pullRequestNumber: 42,
                repoOwner: 'acme',
                repoName: 'web',
                correlationId: 'correlation-1',
                comments: [],
            },
        } as Job;

        const replacementTaskId = await schedulePRCommentRecovery({
            job: job as never,
            taskId: 'cancelled-task-1',
            stateManager: stateManager as never,
            redisClient: redis as never,
            pickedUpComments: [comment],
            delay: 60000,
            reason: 'agent_container_already_running',
            correlatedLogger: logger as never,
            containerCollisionTaskId: 'cancelled-task-1',
        });

        assert.equal(replacementTaskId, 'replacement-task-2');
        assert.equal(queueAdd.mock.calls[0].arguments[2]?.delay, 60000);
        assert.equal(queueAdd.mock.calls[0].arguments[1].containerCollisionTaskId, 'cancelled-task-1');
        assert.deepStrictEqual(
            (pending.get('pending-pr-comments:acme:web:42') ?? []).map(value => JSON.parse(value).id),
            [2228],
        );
        assert.deepStrictEqual(created, ['replacement-task-2']);
        assert.equal(states.get('cancelled-task-1')?.state, 'cancelled', 'the terminal attempt is never reopened');
        const originalUpdate = metadataUpdates.find(update => update.taskId === 'cancelled-task-1');
        assert.equal(originalUpdate?.state, 'cancelled');
        assert.equal(
            originalUpdate?.metadata.replacementTaskId,
            'replacement-task-2',
        );
    });

    test('does not rewind a replacement that starts during recovery-link bookkeeping', async () => {
        queueAdd.mock.resetCalls();
        const replacementState = { state: 'pending' };
        const stateUpdates: string[] = [];
        const metadataUpdates: Array<{ taskId: string; state: string }> = [];
        const stateManager = {
            async getTaskState(taskId: string) {
                return taskId === 'replacement-task-2' ? null : { state: 'cancelled' };
            },
            async createTaskStateIfAbsent() {
                replacementState.state = 'processing';
                return replacementState;
            },
            async updateTaskState(_taskId: string, state: string) { stateUpdates.push(state); },
            async updateHistoryMetadata(taskId: string, state: string) {
                metadataUpdates.push({ taskId, state });
            },
        };
        const job = {
            id: 'attempt-a',
            name: 'processPullRequestComment',
            data: { pullRequestNumber: 42, repoOwner: 'acme', repoName: 'web', correlationId: 'correlation-1' },
        } as Job;

        await schedulePRCommentRecovery({
            job: job as never,
            taskId: 'attempt-a',
            stateManager: stateManager as never,
            redisClient: {} as never,
            pickedUpComments: [],
            delay: 1000,
            reason: 'pr_locked_by_other_job',
            correlatedLogger: { info: mock.fn(), warn: mock.fn() } as never,
        });

        assert.deepStrictEqual(stateUpdates, []);
        assert.deepStrictEqual(metadataUpdates[0], { taskId: 'replacement-task-2', state: 'processing' });
        assert.equal(replacementState.state, 'processing');
    });

    test('retains A and live B for C while giving C fresh lease ownership', async () => {
        queueAdd.mock.resetCalls();
        exactLiveness = 'not_found';
        exactLivenessByTask.clear();
        exactLivenessByTask.set('attempt-b', 'running');
        const states = new Map<string, { state: string }>();
        const stateManager = {
            async getTaskState(taskId: string) { return states.get(taskId) ?? null; },
            async createTaskStateIfAbsent(taskId: string) {
                const state = states.get(taskId) ?? { state: 'pending' };
                states.set(taskId, state);
                return state;
            },
            async updateHistoryMetadata() {},
        };
        let liveLease = 'lease-b';
        const lockRedis = {
            async set() { return null; },
            async eval(script: string, _keyCount: number, _key: string, token: string) {
                if (token !== liveLease) return 0;
                if (script.includes("redis.call('del'")) liveLease = '';
                return 1;
            },
        };
        const job = {
            id: 'attempt-b',
            name: 'processPullRequestComment',
            data: {
                pullRequestNumber: 42,
                repoOwner: 'acme',
                repoName: 'web',
                correlationId: 'correlation-1',
                prProcessingLockToken: 'lease-b',
                containerCollisionTaskIds: ['attempt-a'],
            },
        } as Job;

        const decision = await evaluatePRCommentPreExecutionRecovery({
            job: job as never,
            taskId: 'attempt-b',
            stateManager: stateManager as never,
            redisClient: lockRedis as never,
            pickedUpComments: [],
            correlatedLogger: { info: mock.fn(), warn: mock.fn() } as never,
            releaseLock: () => releasePRProcessingLock(lockRedis as never, 'lock:pr', 'lease-b'),
        });

        assert.equal(decision.result?.reason, 'agent_container_already_running');
        const queuedData = queueAdd.mock.calls[0].arguments[1];
        assert.deepStrictEqual(queuedData.containerCollisionTaskIds, ['attempt-a', 'attempt-b']);
        assert.equal(queuedData.prProcessingLockToken, undefined);
        assert.equal(liveLease, 'lease-b', 'same-job recovery must not release its live predecessor lease');

        const leaseC = await ensurePRProcessingLockToken(queuedData, 'correlation-1', async () => {});
        assert.notEqual(leaseC, 'lease-b');
        assert.equal(await acquirePRProcessingLock(lockRedis as never, 'lock:pr', leaseC), false);
        assert.equal(await releasePRProcessingLock(lockRedis as never, 'lock:pr', leaseC), false);
        assert.equal(liveLease, 'lease-b');
        exactLivenessByTask.clear();
    });

    test('lock contention preserves a latest user cancellation and its claimed comments', async () => {
        queueAdd.mock.resetCalls();
        const restored: string[] = [];
        const state = {
            state: 'cancelled',
            history: [{ state: 'cancelled', reason: 'Task cancelled by user' }],
            lastError: { message: 'agent_container_already_running' },
        };
        const comment = { id: 900, body: 'keep this', author: 'alice', type: 'issue' as const };
        const decision = await handlePRCommentLockContention({
            job: {
                id: 'cancelled-task',
                data: { pullRequestNumber: 42, repoOwner: 'acme', repoName: 'web' },
            } as never,
            taskId: 'cancelled-task',
            stateManager: { getTaskState: async () => state } as never,
            redisClient: {
                async lrange() { return []; },
                async lpush(_key: string, ...values: string[]) { restored.push(...values); return values.length; },
                async expire() { return 1; },
            } as never,
            pickedUpComments: [comment],
            correlatedLogger: { info: mock.fn() } as never,
        });

        assert.equal(decision.reason, 'task_already_cancelled');
        assert.deepStrictEqual(restored.map(value => JSON.parse(value).id), [900]);
        assert.equal(queueAdd.mock.callCount(), 0);
    });
});
