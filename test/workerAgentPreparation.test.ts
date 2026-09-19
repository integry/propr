import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

import { DelayedError } from 'bullmq';
import type { AgentRegistryOperationalStatus } from '../packages/core/src/agents/agentRegistryTypes.js';

let ready = false;
let builtImage: string | undefined;
let failure: AgentRegistryOperationalStatus['unifiedAgentImage'];
const ensureBundle = mock.fn(async (_versions: unknown, contentHash: string) => {
    builtImage = contentHash;
    return { success: true, error: undefined as string | undefined };
});
const recover = mock.fn(async () => {});
const refresh = mock.fn(async () => {
    initialized = true;
    ready = builtImage === 'required';
});
const inspect = mock.fn(async () => {});
let initialized = false;
let resumePoll: (() => void) | undefined;
const prepare = mock.fn(async () => { initialized = true; });
const registry = {
    setImagePreparationOwner: mock.fn(),
    prepareImagesAndRefresh: prepare,
    recoverImagesAndRefresh: recover,
    refresh,
    inspectAgentImageAvailability: inspect,
    isInitialized: () => initialized,
    getOperationalStatus: () => ({
        unifiedAgentImage: ready
            ? { status: 'ready' }
            : failure,
    }),
    getAllAgents: () => [],
};

await mock.module('@propr/core', {
    namedExports: {
        AgentRegistry: { getInstance: () => registry },
        ensureAgentBundleImage: ensureBundle,
        logger: { info: () => {}, error: () => {} },
    },
});
await mock.module('node:timers/promises', {
    namedExports: {
        setTimeout: async () => new Promise<void>(resolve => { resumePoll = resolve; }),
    },
});
const { prepareAgentRegistryAtStartup, processAgentImagePreparationJob } = await import('../src/workerAgentPreparation.js');

beforeEach(() => {
    ready = false;
    initialized = false;
    builtImage = undefined;
    failure = { status: 'unavailable', error: 'ENOSPC', retryCount: 1, circuitBreakerOpen: true, operatorActionRequired: true };
    for (const fn of [prepare, recover, refresh, ensureBundle, inspect]) fn.mock.resetCalls();
});

for (const throws of [false, true]) {
    test(`startup remains alive without task capacity after preparation failure (throws=${throws})`, async () => {
        ready = false;
        initialized = false;
        prepare.mock.resetCalls();
        prepare.mock.mockImplementation(async () => {
            if (throws) throw new Error('ENOSPC');
            initialized = true;
        });
        let taskCapacityStarted = false;
        const startup = prepareAgentRegistryAtStartup().then(() => { taskCapacityStarted = true; });
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.strictEqual(taskCapacityStarted, false);
        assert.strictEqual(prepare.mock.callCount(), 1);

        // The startup gate yields while the independent preparation consumer
        // serves requests. Status polling runs the throttled inspect-only
        // availability check and must never start more builds.
        resumePoll!();
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.strictEqual(taskCapacityStarted, false);
        assert.strictEqual(prepare.mock.callCount(), 1);
        assert.strictEqual(inspect.mock.callCount(), 1);

        // The preparation processor remains usable while startup is waiting
        // and returns the underlying error to the requesting API registry.
        const request = { data: { imageTag: 'propr/agent:missing' } };
        await assert.rejects(processAgentImagePreparationJob(request as never), /ENOSPC/);
        assert.strictEqual(taskCapacityStarted, false);
        assert.strictEqual(prepare.mock.callCount(), 1, 'automatic request must use guarded recovery');

        // Building a different bundle cannot release startup. Only inspection
        // after an explicit build of the required bundle establishes readiness.
        const explicit = { data: { imageTag: 'propr/agent:other', versions: { claude: '1' }, contentHash: 'other' } };
        await processAgentImagePreparationJob(explicit as never);
        resumePoll!();
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.strictEqual(taskCapacityStarted, false);
        explicit.data.contentHash = 'required';
        explicit.data.imageTag = 'propr/agent:required';
        await processAgentImagePreparationJob(explicit as never);
        assert.strictEqual(refresh.mock.callCount(), 2);
        assert.strictEqual(prepare.mock.callCount(), 1);
        resumePoll!();
        await startup;
        assert.strictEqual(taskCapacityStarted, true);
        assert.strictEqual(registry.setImagePreparationOwner.mock.calls.at(-1)?.arguments[0], true);
    });
}

test('automatic jobs defer to the owner deadline and retry through guarded recovery', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
    failure = { status: 'unavailable', error: 'temporary failure', retryCount: 2, nextRetryAt: new Date(11_000).toISOString() };
    const job = {
        data: { imageTag: 'propr/agent:required' },
        token: 'lock-token',
        moveToDelayed: mock.fn(async (_deadline: number, _token?: string) => {}),
    };
    await assert.rejects(processAgentImagePreparationJob(job as never), DelayedError);
    assert.deepStrictEqual(job.moveToDelayed.mock.calls[0].arguments, [11_000, 'lock-token']);
    assert.strictEqual(recover.mock.callCount(), 0);
    assert.strictEqual(prepare.mock.callCount(), 0);
    t.mock.timers.tick(10_000);
    await assert.rejects(processAgentImagePreparationJob(job as never), /temporary failure/);
    assert.strictEqual(recover.mock.callCount(), 1);
    assert.strictEqual(prepare.mock.callCount(), 0);
});

for (const error of ['ENOSPC', 'temporary download failure']) {
    test(`requeued automatic jobs propagate the recorded open-circuit error: ${error}`, async () => {
        failure = { status: 'unavailable', error, circuitBreakerOpen: true, retryCount: error === 'ENOSPC' ? 1 : 5 };
        const job = { data: { imageTag: 'propr/agent:required' } };
        for (let request = 0; request < 3; request += 1) {
            await assert.rejects(processAgentImagePreparationJob(job as never), { message: error });
        }
        assert.strictEqual(recover.mock.callCount(), 3);
        assert.strictEqual(prepare.mock.callCount(), 0);
        assert.strictEqual(ensureBundle.mock.callCount(), 0);
    });
}

test('failed explicit builds preserve the build error without refreshing readiness', async () => {
    ensureBundle.mock.mockImplementationOnce(async () => ({ success: false, error: 'explicit build failed' }));
    const job = { data: { imageTag: 'propr/agent:required', versions: { claude: '1' }, contentHash: 'required' } };
    await assert.rejects(processAgentImagePreparationJob(job as never), /explicit build failed/);
    assert.strictEqual(refresh.mock.callCount(), 0);
    assert.strictEqual(ready, false);
});
