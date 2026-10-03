import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { Queue, Worker, DelayedError } from 'bullmq';
import { Redis } from 'ioredis';
import { ACQUIRE_WORKFLOW_SLOT, withRepositoryWorkflowSlot, RepositoryWorkflowCapacityError } from '../packages/core/src/workflow/workflowConcurrency.js';
import { loadRepositoryWorkflow, WORKFLOW_MAX_BYTES, WORKFLOW_PATH } from '../packages/core/src/workflow/repositoryWorkflow.js';
import { runWithExecutionAbortSignal } from '../packages/core/src/claude/docker/dockerExecutionOwnership.js';
import { executeWithRepositoryWorkflow } from '../packages/core/src/workflow/workflowExecution.js';

await mock.module('@propr/core', { namedExports: {
    withRepositoryWorkflowSlot, RepositoryWorkflowCapacityError, loadRepositoryWorkflow, WORKFLOW_MAX_BYTES, WORKFLOW_PATH,
    executeWithRepositoryWorkflow, loadSettings: async () => ({}),
    TaskStates: { CANCELLED: 'cancelled', FAILED: 'failed', COMPLETED: 'completed' },
} });
const { deferRepositoryWorkflowJob, withRepositoryWorkflowAdmission, runRepositoryWorkflow, repositoryWorkflowDeferralDelayMs, resolveRepositoryWorkflow, repositoryWorkflowDeferralData } = await import('../src/jobs/repositoryWorkflow.js');
const log = { error() {} };

test('capacity deferral waits for cleanup and passes the current BullMQ lock token', async () => {
    const events: string[] = [];
    const job = { token: 'token', moveToDelayed: async (deadline: number, token?: string) => {
        assert.ok(deadline > Date.now());
        assert.equal(token, 'token');
        events.push('delayed');
    } };
    await assert.rejects(deferRepositoryWorkflowJob(job as never, async () => {
        try { throw new RepositoryWorkflowCapacityError(); }
        finally { await Promise.resolve(); events.push('cleanup'); }
    }), DelayedError);
    assert.deepEqual(events, ['cleanup', 'delayed']);
    await assert.rejects(deferRepositoryWorkflowJob(job as never, async () => { throw new Error('unrelated'); }), /unrelated/);
    assert.equal(events.length, 2);
    await assert.rejects(deferRepositoryWorkflowJob({ ...job, moveToDelayed: async () => { throw new Error('lock lost'); } } as never,
        async () => { throw new RepositoryWorkflowCapacityError(); }), /lock lost/);
});

test('capacity deferrals back off exponentially with jitter up to a ceiling', async () => {
    assert.deepEqual([1, 2, 3, 4].map(n => repositoryWorkflowDeferralDelayMs(n, () => 1)), [10_000, 20_000, 40_000, 80_000]);
    assert.deepEqual([1, 2].map(n => repositoryWorkflowDeferralDelayMs(n, () => 0)), [5_000, 10_000]);
    assert.equal(repositoryWorkflowDeferralDelayMs(50, () => 1), 300_000);
    const deadlines: number[] = [];
    for (const deferrals of [1, 6]) {
        await assert.rejects(deferRepositoryWorkflowJob({ token: 't', data: { repositoryWorkflowDeferrals: deferrals },
            moveToDelayed: async (deadline: number) => { deadlines.push(deadline - Date.now()); } } as never,
        async () => { throw new RepositoryWorkflowCapacityError(); }), DelayedError);
    }
    assert.ok(deadlines[0] <= 10_000 && deadlines[1] >= 150_000 - 50);
});

test('deferred re-entry reuses the resolved policy, including no policy, unless the base branch changed', async () => {
    const cached = { revision: 'sha', baseBranch: 'main' } as never;
    let loads = 0;
    const prepare = async () => { loads++; return undefined; };
    assert.equal(await resolveRepositoryWorkflow({ repositoryWorkflow: cached, repositoryWorkflowDeferrals: 2 }, 'main', prepare), cached);
    assert.equal(await resolveRepositoryWorkflow({ repositoryWorkflow: cached, repositoryWorkflowDeferrals: 2 }, undefined, prepare), cached);
    assert.equal(await resolveRepositoryWorkflow({ repositoryWorkflow: null, repositoryWorkflowBaseBranch: 'main', repositoryWorkflowDeferrals: 1 }, 'main', prepare), undefined);
    assert.equal(await resolveRepositoryWorkflow({ repositoryWorkflow: null, repositoryWorkflowBaseBranch: null, repositoryWorkflowDeferrals: 1 }, undefined, prepare), undefined);
    assert.equal(loads, 0);
    await resolveRepositoryWorkflow({ repositoryWorkflow: cached, repositoryWorkflowDeferrals: 2 }, 'release', prepare);
    await resolveRepositoryWorkflow({ repositoryWorkflow: cached }, 'main', prepare);
    await resolveRepositoryWorkflow({}, 'main', prepare);
    assert.equal(loads, 3);
});

test('an absent policy is reloaded when the task was retargeted or the snapshot has no branch identity', async () => {
    const release = { revision: 'release-sha', baseBranch: 'release' } as never;
    let loads = 0;
    const prepare = async () => { loads++; return release; };
    assert.equal(await resolveRepositoryWorkflow({ repositoryWorkflow: null, repositoryWorkflowBaseBranch: 'main', repositoryWorkflowDeferrals: 1 }, 'release', prepare), release);
    assert.equal(await resolveRepositoryWorkflow({ repositoryWorkflow: null, repositoryWorkflowBaseBranch: null, repositoryWorkflowDeferrals: 1 }, 'release', prepare), release);
    assert.equal(await resolveRepositoryWorkflow({ repositoryWorkflow: null, repositoryWorkflowDeferrals: 1 }, 'main', prepare), release);
    assert.equal(loads, 3);
});

test('deferral data records the base branch with the snapshot, including when no workflow exists', () => {
    const workflow = { revision: 'sha', baseBranch: 'develop' } as never;
    assert.deepEqual(repositoryWorkflowDeferralData({}, undefined, 'main'), { repositoryWorkflow: null, repositoryWorkflowBaseBranch: 'main', repositoryWorkflowDeferrals: 1 });
    assert.deepEqual(repositoryWorkflowDeferralData({ repositoryWorkflowDeferrals: 1 }, undefined, undefined), { repositoryWorkflow: null, repositoryWorkflowBaseBranch: null, repositoryWorkflowDeferrals: 2 });
    assert.equal(repositoryWorkflowDeferralData({}, workflow, undefined).repositoryWorkflowBaseBranch, 'develop');
});

test('cancelled re-entry and cancellation during admission never delay or execute', async () => {
    for (const cancelDuringAcquire of [false, true]) {
        let state = cancelDuringAcquire ? 'pending' : 'cancelled';
        let acquisitions = 0;
        await assert.rejects(deferRepositoryWorkflowJob({ moveToDelayed: () => assert.fail('must not delay') } as never,
            () => withRepositoryWorkflowAdmission({
                repoOwner: 'owner', repoName: 'repo', taskId: 'same-task', correlatedLogger: log as never,
                stateManager: { getTaskState: async () => ({ state }) } as never,
                redisClient: { eval: async () => { acquisitions++; state = 'cancelled'; return 0; } } as never,
            }, async () => assert.fail('must not execute'))), /Task ended/);
        assert.equal(acquisitions, cancelDuringAcquire ? 1 : 0);
    }
});

test('a shared processor advances from refused repository A to repository B without waiting for A to finish', async () => {
    const slots = new Map<string, string>();
    const started: string[] = [];
    const delayed: string[] = [];
    let finishA!: () => void;
    const activeA = new Promise<void>(resolve => { finishA = resolve; });
    const redisClient = { eval: async (script: string, _count: number, key: string, _limits: string, token: string) => {
        if (script === ACQUIRE_WORKFLOW_SLOT) {
            if (slots.has(key)) return 0;
            slots.set(key, token);
        } else if (slots.get(key) === token) slots.delete(key);
        return 1;
    } };
    const process = (repoName: string, id: string) => deferRepositoryWorkflowJob({
        token: id, moveToDelayed: async () => { delayed.push(id); },
    } as never, () => withRepositoryWorkflowAdmission({
        redisClient: redisClient as never, repoOwner: 'owner', repoName, taskId: id,
        stateManager: { getTaskState: async () => ({ state: 'pending' }) } as never,
        correlatedLogger: log as never,
    }, async () => { started.push(id); if (id === 'A1') await activeA; }));
    const firstProcessor = process('A', 'A1');
    await setImmediate();
    const secondProcessor = (async () => {
        await assert.rejects(process('A', 'A2'), DelayedError);
        await assert.rejects(process('A', 'A3'), DelayedError);
        await process('B', 'B1');
    })();
    try {
        await setImmediate();
        assert.deepEqual(started, ['A1', 'B1']);
        assert.deepEqual(delayed, ['A2', 'A3']);
        assert.equal(slots.size, 1, 'A remains running while B has already finished');
    } finally {
        finishA();
        await Promise.all([firstProcessor, secondProcessor]);
    }
});

test('agent execution rechecks cancellation and lease ownership after preparation awaits', async () => {
    const controller = new AbortController();
    const options = { repoOwner: 'owner', repoName: 'repo', taskId: 'task',
        correlatedLogger: log as never, redisClient: {} as never,
        stateManager: { getTaskState: async () => ({ state: 'cancelled' }) } as never,
    };
    await assert.rejects(runRepositoryWorkflow(options, async () => assert.fail('cancelled during preparation')), /Task ended/);
    await assert.rejects(runWithExecutionAbortSignal(controller.signal, () => runRepositoryWorkflow({
        ...options, stateManager: { getTaskState: async () => {
            controller.abort(new Error('lease lost during task-state read'));
            return { state: 'pending' };
        } } as never,
    }, async () => assert.fail('lease lost during cancellation check'))), /lease lost during task-state read/);
});

const binary = process.env.PROPR_TEST_REDIS_SERVER || 'redis-server';
const available = spawnSync(binary, ['--version']).status === 0;
test('saturated repository jobs release shared BullMQ processors so another repository runs', {
    skip: !available && 'redis-server is needed for the queue integration test', timeout: 15_000,
}, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'workflow-queue-'));
    const socket = path.join(directory, 'redis.sock');
    const server = spawn(binary, ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
    const redis = new Redis({ path: socket, lazyConnect: true, retryStrategy: () => 25, maxRetriesPerRequest: null });
    redis.on('error', () => {});
    let queue: Queue | undefined;
    let worker: Worker | undefined;
    let finishA!: () => void;
    const runningA = new Promise<void>(resolve => { finishA = resolve; });
    let bStarted!: () => void;
    const ranB = new Promise<void>(resolve => { bStarted = resolve; });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const started: string[] = [];
    try {
        for (let attempt = 0; ; attempt++) {
            try { await access(socket); break; }
            catch { if (attempt > 100) throw new Error('Redis socket unavailable'); await new Promise(resolve => setTimeout(resolve, 25)); }
        }
        await redis.connect();
        queue = new Queue('workflow-capacity', { connection: redis });
        await queue.addBulk([
            { name: 'issue', data: { repo: 'A', id: 'A1' } },
            { name: 'followup', data: { repo: 'A', id: 'A2' } },
            { name: 'issue', data: { repo: 'A', id: 'A3' } },
            { name: 'followup', data: { repo: 'B', id: 'B1' } },
        ]);
        worker = new Worker('workflow-capacity', job => deferRepositoryWorkflowJob(job, () => withRepositoryWorkflowAdmission({
            repoOwner: 'owner', repoName: job.data.repo, taskId: job.id!, redisClient: redis,
            workflow: { maxParallelTasks: 1 } as never,
            stateManager: { getTaskState: async () => ({ state: 'pending' }) } as never,
            correlatedLogger: log as never,
        }, async () => {
            started.push(job.data.id);
            if (job.data.repo === 'A') await runningA;
            else bStarted();
        })), { connection: redis, concurrency: 2 });
        await Promise.race([ranB, new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error('Repository B was blocked by A waiters')), 5000);
        })]);
        assert.deepEqual(started, ['A1', 'B1']);
        assert.equal(await queue.getDelayedCount(), 2);
        for (const job of await queue.getDelayed()) assert.equal(job.attemptsMade, 0, 'capacity does not consume failure retries');
    } finally {
        clearTimeout(timeout);
        finishA();
        await worker?.close();
        await queue?.close();
        redis.disconnect();
        server.kill('SIGTERM');
        await new Promise<void>(resolve => server.once('exit', () => resolve()));
        await rm(directory, { recursive: true, force: true });
    }
});
