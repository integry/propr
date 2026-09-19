import { after, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentCliVersionMatrix } from '../packages/core/src/agents/version/versionService.js';

let imageChecks = 0;
let pulls = 0;
let releasePull: (() => void) | undefined;
const pullGate = new Promise<void>(resolve => {
    releasePull = resolve;
});

await mock.module('../packages/core/src/claude/docker/dockerExecutor.js', {
    namedExports: {
        getDockerRootDir: mock.fn(async () => '/docker/storage'),
        executeDockerCommand: mock.fn(async (_command: string, args: string[]) => {
            if (args[0] === 'images') {
                imageChecks += 1;
                return { exitCode: 0, stdout: '', stderr: '', messageTimestamps: new Map() };
            }
            if (args[0] === 'pull') {
                pulls += 1;
                await pullGate;
                return { exitCode: 0, stdout: 'pulled', stderr: '', messageTimestamps: new Map() };
            }
            throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
        }),
    },
});

const queue = {
    getJob: mock.fn(async (_jobId: string): Promise<unknown> => undefined),
    add: mock.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
    getWorkersCount: mock.fn(async () => 1),
    waitUntilReady: async () => producerReady(),
    close: async () => {},
};
type MockedConnection = { maxRetriesPerRequest?: number | null };
const queueConnections: MockedConnection[] = [];
const eventsConnections: MockedConnection[] = [];
let eventsReady: () => Promise<void> = async () => {};
let producerReady: () => Promise<void> = async () => {};
await mock.module('bullmq', {
    namedExports: {
        ErrorCode: { JobNotExist: -1, JobNotInState: -3 },
        Queue: class {
            constructor(_name: string, options?: { connection?: MockedConnection }) {
                if (options?.connection) queueConnections.push(options.connection);
                return queue;
            }
        },
        QueueEvents: class {
            constructor(_name: string, options?: { connection?: MockedConnection }) {
                if (options?.connection) eventsConnections.push(options.connection);
            }
            async waitUntilReady() { return eventsReady(); }
            async close() {}
        },
    },
});

const { ensureAgentBundleImage } = await import('../packages/core/src/claude/docker/dockerImageBuilder.js');
const { agentImagePreparationJobId, enqueueAgentImagePreparation, closeAgentImagePreparationQueue } = await import('../packages/core/src/agents/agentImagePreparationQueue.js');

test('concurrent preparation of the same bundle shares one Docker operation', async () => {
    const versions: AgentCliVersionMatrix = {
        claude: '1.0.0',
        codex: '1.0.0',
        antigravity: '1.0.0',
        opencode: '1.0.0',
        vibe: '1.0.0',
    };

    const preparations = Array.from({ length: 8 }, () => ensureAgentBundleImage(versions, 'content'));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.strictEqual(imageChecks, 1);
    assert.strictEqual(pulls, 1);

    releasePull?.();
    const results = await Promise.all(preparations);
    assert.ok(results.every(result => result.success));
    assert.strictEqual(new Set(results.map(result => result.imageTag)).size, 1);
});

test('worker-owned image preparation uses one deterministic job identity per image', () => {
    assert.strictEqual(
        agentImagePreparationJobId('propr/runtime-agent:one'),
        agentImagePreparationJobId('propr/runtime-agent:one'),
    );
    assert.notStrictEqual(
        agentImagePreparationJobId('propr/runtime-agent:one'),
        agentImagePreparationJobId('propr/runtime-agent:two'),
    );
});

after(closeAgentImagePreparationQueue);

for (const state of ['completed', 'failed', 'unknown', 'waiting', 'active', 'delayed', 'prioritized', 'waiting-children']) {
    test(`worker-owned preparation handles an existing ${state} job`, async () => {
        const existing = {
            getState: async () => state,
            retry: mock.fn(async (_state: string) => {}),
            waitUntilFinished: mock.fn(async () => {}),
        };
        const fresh = { waitUntilFinished: mock.fn(async () => {}) };
        queue.getJob.mock.mockImplementation(async () => existing);
        queue.add.mock.resetCalls();
        queue.add.mock.mockImplementation(async () => fresh);
        const imageTag = 'propr/runtime-agent:missing-again';

        await enqueueAgentImagePreparation(imageTag);

        const replace = state === 'unknown';
        const retry = state === 'completed' || state === 'failed';
        assert.strictEqual(existing.retry.mock.callCount(), retry ? 1 : 0);
        if (retry) assert.deepStrictEqual(existing.retry.mock.calls[0].arguments, [state]);
        assert.strictEqual(queue.add.mock.callCount(), replace ? 1 : 0);
        assert.strictEqual(existing.waitUntilFinished.mock.callCount(), replace ? 0 : 1);
        assert.strictEqual(fresh.waitUntilFinished.mock.callCount(), replace ? 1 : 0);
        if (replace) {
            assert.deepStrictEqual(queue.add.mock.calls[0].arguments, [
                'prepare-unified-agent-image',
                { imageTag, requestedAt: (queue.add.mock.calls[0].arguments[1] as { requestedAt: string }).requestedAt },
                { jobId: agentImagePreparationJobId(imageTag) },
            ]);
        }
    });
}


test('explicit version builds coalesce only with requests for the same preparation contract', async () => {
    const imageTag = 'propr/agent:requested-a';
    const versions: AgentCliVersionMatrix = {
        claude: '1.0.0', codex: '1.0.0', antigravity: '1.0.0', opencode: '1.0.0', vibe: '1.0.0',
    };
    const options = { versions, contentHash: 'content-a' };
    const refresh = {
        getState: async () => 'waiting',
        waitUntilFinished: mock.fn(async () => {}),
    };
    const explicit = {
        getState: async () => 'waiting',
        waitUntilFinished: mock.fn(async () => {}),
    };
    const jobs = new Map([[agentImagePreparationJobId(imageTag), refresh]]);
    queue.getJob.mock.mockImplementation(async jobId => jobs.get(jobId));
    queue.add.mock.resetCalls();
    queue.add.mock.mockImplementation(async (...args) => {
        jobs.set((args[2] as { jobId: string }).jobId, explicit);
        return explicit;
    });

    // A refresh queued for A may execute current configuration B. The explicit
    // request must retain A's versions in its own job, then share that job.
    await enqueueAgentImagePreparation(imageTag, options);
    await enqueueAgentImagePreparation(imageTag, {
        ...options,
        versions: Object.fromEntries(Object.entries(versions).reverse()) as AgentCliVersionMatrix,
    });

    assert.strictEqual(refresh.waitUntilFinished.mock.callCount(), 0);
    assert.strictEqual(explicit.waitUntilFinished.mock.callCount(), 2);
    assert.strictEqual(queue.add.mock.callCount(), 1);
    assert.deepStrictEqual(queue.add.mock.calls[0].arguments[1], {
        imageTag, ...options,
        requestedAt: (queue.add.mock.calls[0].arguments[1] as { requestedAt: string }).requestedAt,
    });
    assert.notStrictEqual(agentImagePreparationJobId(imageTag, options), agentImagePreparationJobId(imageTag));
    assert.notStrictEqual(agentImagePreparationJobId(imageTag, options), agentImagePreparationJobId(imageTag, {
        ...options, versions: { ...versions, claude: '2.0.0' },
    }));
    assert.notStrictEqual(agentImagePreparationJobId(imageTag, options), agentImagePreparationJobId(imageTag, {
        ...options, contentHash: 'content-b',
    }));
});

test('preparation can wait 18 minutes for the slot and then build for 10 minutes', async t => {
    t.mock.timers.enable({ apis: ['Date'] });
    const timeout = new Error('Job wait prepare-unified-agent-image timed out before finishing, no finish notification arrived');
    const finishAt = Date.now() + 28 * 60_000;
    const budgets: number[] = [];
    const job = {
        getState: async () => 'active',
        waitUntilFinished: mock.fn(async (_events: unknown, budget: number) => {
            budgets.push(budget);
            if (Date.now() + budget < finishAt) {
                t.mock.timers.tick(budget);
                throw timeout;
            }
            t.mock.timers.tick(finishAt - Date.now());
        }),
    };
    queue.getJob.mock.mockImplementation(async () => job);
    await enqueueAgentImagePreparation('propr/agent:serialized');
    assert.ok(budgets.length >= 28, 'the job state is re-evaluated at least once a minute');
    assert.ok(budgets.every(budget => budget <= 60_000), 'each probe stays on the registry backoff scale');
});

for (const state of ['waiting', 'active', 'delayed', 'prioritized', 'waiting-children', 'completed', 'failed', 'unknown']) {
    test(`completion timeout checks the actual ${state} job before reporting a failure`, async () => {
        const timeout = new Error('Job wait prepare-unified-agent-image timed out before finishing, no finish notification arrived');
        const failure = new Error('actual Docker build failure');
        let checks = 0;
        let waits = 0;
        const job = {
            getState: async () => ++checks === 1 ? 'waiting' : state,
            waitUntilFinished: mock.fn(async () => {
                if (++waits === 1) throw timeout;
                if (state === 'failed') throw failure;
            }),
        };
        queue.getJob.mock.mockImplementation(async () => job);
        queue.add.mock.resetCalls();
        const preparation = enqueueAgentImagePreparation('propr/agent:still-pending');
        if (state === 'failed' || state === 'unknown') {
            await assert.rejects(preparation, error => error === (state === 'failed' ? failure : timeout));
        } else {
            await preparation;
        }
        assert.strictEqual(waits, state === 'unknown' ? 1 : 2);
        assert.strictEqual(queue.add.mock.callCount(), 0);
    });
}

test('preparation fails instead of waiting forever when no worker consumes the queue', async () => {
    const timeout = new Error('Job wait prepare-unified-agent-image timed out before finishing, no finish notification arrived');
    const job = {
        id: 'prepare-orphaned',
        getState: async () => 'waiting',
        waitUntilFinished: mock.fn(async () => { throw timeout; }),
    };
    queue.getJob.mock.mockImplementation(async () => job);
    queue.getWorkersCount.mock.mockImplementationOnce(async () => 0);
    await assert.rejects(
        enqueueAgentImagePreparation('propr/agent:orphaned'),
        /prepare-orphaned is waiting but no worker is consuming the agent-image-preparation queue/,
    );
    assert.strictEqual(job.waitUntilFinished.mock.callCount(), 1);
});

test('preparation wait has an overall deadline even while a worker is attached', async t => {
    t.mock.timers.enable({ apis: ['Date'] });
    const timeout = new Error('Job wait prepare-unified-agent-image timed out before finishing, no finish notification arrived');
    const budgets: number[] = [];
    const job = {
        id: 'prepare-stuck',
        getState: async () => 'active',
        waitUntilFinished: mock.fn(async (_events: unknown, budget: number) => {
            budgets.push(budget);
            t.mock.timers.tick(budget);
            throw timeout;
        }),
    };
    queue.getJob.mock.mockImplementation(async () => job);
    await assert.rejects(enqueueAgentImagePreparation('propr/agent:stuck'), /prepare-stuck did not finish within 175 minutes/);
    assert.ok(budgets.every(budget => budget <= 60_000), 'a stuck job cannot suppress state re-evaluation for hours');
    assert.strictEqual(budgets.reduce((sum, budget) => sum + budget, 0), 2 * (60 + 20) * 60_000 + 15 * 60_000,
        'short probes still consume the full lease/build budget before the deadline fails the wait');
});

test('preparation propagates worker failures without extending the wait', async () => {
    const failure = new Error('Docker build failed: no space left on device');
    const job = {
        getState: mock.fn(async () => 'active'),
        waitUntilFinished: mock.fn(async () => { throw failure; }),
    };
    queue.getJob.mock.mockImplementation(async () => job);
    await assert.rejects(enqueueAgentImagePreparation('propr/agent:failed'), error => error === failure);
    assert.strictEqual(job.waitUntilFinished.mock.callCount(), 1);
});


for (const terminal of ['completed', 'failed']) {
    test(`concurrent callers atomically retry the same ${terminal} job without deleting it`, async () => {
        let state = terminal;
        let transitions = 0;
        let readers = 0;
        let release!: () => void;
        const bothRead = new Promise<void>(resolve => { release = resolve; });
        const existing = {
            getState: async () => {
                const observed = state;
                if (++readers === 2) release();
                await bothRead;
                return observed;
            },
            retry: async (expected: string) => {
                if (state !== expected) throw Object.assign(new Error('Job is not in terminal state'), { code: -3 });
                state = 'waiting';
                transitions += 1;
            },
            waitUntilFinished: mock.fn(async () => { assert.strictEqual(state, 'waiting'); }),
        };
        queue.getJob.mock.mockImplementation(async () => existing);
        queue.add.mock.resetCalls();
        await Promise.all([
            enqueueAgentImagePreparation('propr/agent:concurrent'),
            enqueueAgentImagePreparation('propr/agent:concurrent'),
        ]);
        assert.strictEqual(transitions, 1);
        assert.strictEqual(existing.waitUntilFinished.mock.callCount(), 2);
        assert.strictEqual(queue.add.mock.callCount(), 0);
    });
}

test('terminal retry propagates Redis failures', async () => {
    const failure = new Error('Redis disconnected');
    queue.getJob.mock.mockImplementation(async () => ({
        getState: async () => 'failed',
        retry: async () => { throw failure; },
    }));
    await assert.rejects(enqueueAgentImagePreparation('propr/agent:redis-failure'), error => error === failure);
});

test('enqueue fails instead of waiting forever when the events connection cannot become ready', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    eventsReady = () => new Promise<never>(() => {});
    const job = {
        getState: async () => 'waiting',
        waitUntilFinished: mock.fn(async () => {}),
    };
    queue.getJob.mock.mockImplementation(async () => job);
    try {
        const preparation = assert.rejects(
            enqueueAgentImagePreparation('propr/agent:redis-outage'),
            /events for the agent-image-preparation queue were not ready within/,
        );
        await new Promise<void>(resolve => setImmediate(resolve));
        t.mock.timers.tick(30_000);
        await preparation;
        assert.strictEqual(job.waitUntilFinished.mock.callCount(), 0);
    } finally {
        eventsReady = async () => {};
    }
});

test('enqueue fails instead of waiting forever when the producer connection cannot become ready', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    // Redis is unavailable when the producer is first constructed.
    await closeAgentImagePreparationQueue();
    producerReady = () => new Promise<never>(() => {});
    queue.getJob.mock.resetCalls();
    queue.add.mock.resetCalls();
    try {
        const preparation = assert.rejects(
            enqueueAgentImagePreparation('propr/agent:redis-down-at-start'),
            /producer connections for the agent-image-preparation queue were not ready within/,
        );
        await new Promise<void>(resolve => setImmediate(resolve));
        t.mock.timers.tick(30_000);
        await preparation;
        assert.strictEqual(queue.getJob.mock.callCount(), 0);
        assert.strictEqual(queue.add.mock.callCount(), 0);
    } finally {
        producerReady = async () => {};
    }
});

test('producer connections bound Redis request retries while event connections stay blocking', () => {
    assert.ok(queueConnections.length > 0 && eventsConnections.length > 0);
    for (const producer of queueConnections) {
        assert.ok(typeof producer.maxRetriesPerRequest === 'number' && producer.maxRetriesPerRequest > 0,
            'producer commands must reject during a Redis outage');
    }
    for (const events of eventsConnections) {
        assert.strictEqual(events.maxRetriesPerRequest, null,
            'the blocking events connection must keep unlimited per-request retries');
    }
});
