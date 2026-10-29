import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    AGENT_IMAGE_BUILD_LOCK_KEY,
    abortAgentImageBuildsForShutdown,
    describeAgentImageBuildSlotHolder,
    inspectAgentImageBuildSlot,
    runAgentImageBuild,
    withAgentImageBuildSlot,
    type AgentImageBuildLockClient,
    type AgentImageBuildLockOptions,
} from '../packages/core/src/agents/agentImageBuildLock.js';
import type { ClaimOwner, ClaimOwnerProbe } from '../packages/core/src/storage/claimOwner.js';

class FakeRedis implements AgentImageBuildLockClient {
    value: string | null = null;
    expiresAt = 0;
    deletes = 0;

    async set(key: string, value: string, ...args: Array<string | number>): Promise<string | null> {
        assert.equal(key, AGENT_IMAGE_BUILD_LOCK_KEY);
        if (this.value && this.expiresAt <= Date.now()) this.value = null;
        if (args.includes('NX') && this.value) return null;
        const pxIndex = args.indexOf('PX');
        this.value = value;
        this.expiresAt = Date.now() + Number(args[pxIndex + 1]);
        return 'OK';
    }

    async eval(script: string, _numberOfKeys: number, _key: string, token?: string, lease?: string): Promise<unknown> {
        if (this.value && this.expiresAt <= Date.now()) this.value = null;
        if (script.includes('pttl')) return [this.value, this.value ? this.expiresAt - Date.now() : -2];
        if (script.includes('pexpire')) {
            if (this.value !== token || this.expiresAt <= Date.now()) return 0;
            this.expiresAt = Date.now() + Number(lease);
            return 1;
        }
        if (script.includes('del')) {
            if (this.value !== token) return 0;
            this.value = null;
            this.expiresAt = 0;
            this.deletes += 1;
            return 1;
        }
        return 0;
    }
}

const wait = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));

test('runtime-package and unified-agent build work cannot overlap', async () => {
    const client = new FakeRedis();
    let active = 0;
    let maximumActive = 0;
    const releaseFirst = Promise.withResolvers<void>();
    const build = (name: string, gate?: Promise<void>) => runAgentImageBuild(
        async () => undefined,
        async () => {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            if (gate) await gate;
            active -= 1;
            return name;
        },
        { client, leaseMs: 500, acquireTimeoutMs: 2000, pollIntervalMs: 1, token: name },
    );

    const runtime = build('runtime', releaseFirst.promise);
    await wait(5);
    const unified = build('unified');
    await wait(5);
    assert.equal(maximumActive, 1);
    releaseFirst.resolve();
    assert.deepEqual(await Promise.all([runtime, unified]), ['runtime', 'unified']);
    assert.equal(maximumActive, 1);
});

test('capacity check runs only after the shared build slot is acquired', async () => {
    const client = new FakeRedis();
    const events: string[] = [];
    const result = await runAgentImageBuild(
        async () => {
            events.push('capacity');
            assert.ok(client.value, 'capacity check must run while the lock is held');
        },
        async () => {
            events.push('build');
            return 'built';
        },
        { client, leaseMs: 500, acquireTimeoutMs: 1000, pollIntervalMs: 1, token: 'capacity-test' },
    );
    assert.equal(result, 'built');
    assert.deepEqual(events, ['capacity', 'build']);
});

test('a failed build releases the shared slot for the next request', async () => {
    const client = new FakeRedis();
    await assert.rejects(
        withAgentImageBuildSlot(
            async () => { throw new Error('build failed'); },
            { client, leaseMs: 500, acquireTimeoutMs: 1000, pollIntervalMs: 1, token: 'failed-build' },
        ),
        /build failed/,
    );
    assert.equal(client.value, null);
    assert.equal(
        await withAgentImageBuildSlot(async () => 'recovered', {
            client, leaseMs: 500, acquireTimeoutMs: 1000, pollIntervalMs: 1, token: 'recovery-build',
        }),
        'recovered',
    );
});

test('an expired lease permits recovery after a worker crash', async () => {
    const client = new FakeRedis();
    await client.set(AGENT_IMAGE_BUILD_LOCK_KEY, 'dead-worker', 'PX', 10, 'NX');
    await wait(20);
    assert.equal(
        await withAgentImageBuildSlot(async () => 'recovered', {
            client, leaseMs: 500, acquireTimeoutMs: 1000, pollIntervalMs: 1, token: 'new-worker',
        }),
        'recovered',
    );
});

const LIVE_HOST = 'live-worker';
const GONE_HOST = 'feedfacecafe';

/** Containers named GONE_HOST no longer exist; on LIVE_HOST only `livePids` run. */
function fakeProbe(livePids: Set<number>): ClaimOwnerProbe {
    return {
        hostname: () => LIVE_HOST,
        pidExists: pid => livePids.has(pid),
        containerStartedAt: async host => host === GONE_HOST ? null : 0,
    };
}

function owner(host: string, pid: number): ClaimOwner {
    return { host, pid, startedAt: 1_000 };
}

async function seedHolder(client: FakeRedis, holder: ClaimOwner, token = 'old-build'): Promise<string> {
    const value = JSON.stringify({ token, owner: holder });
    await client.set(AGENT_IMAGE_BUILD_LOCK_KEY, value, 'PX', 60_000, 'NX');
    return value;
}

function recordingLogger(): { messages: string[]; logger: NonNullable<AgentImageBuildLockOptions['logger']> } {
    const messages: string[] = [];
    return { messages, logger: { warn: (_details, message) => { messages.push(message); } } };
}

test('the slot records its owner and a release frees it', async () => {
    const client = new FakeRedis();
    const self = owner(LIVE_HOST, 42);
    await withAgentImageBuildSlot(async () => {
        const holder = await inspectAgentImageBuildSlot(client);
        assert.deepEqual(holder?.owner, self);
        assert.equal(holder?.token, 'owned');
        assert.match(describeAgentImageBuildSlotHolder(holder!), /^live-worker pid 42, lease expires in 1m$/);
    }, { client, leaseMs: 500, pollIntervalMs: 1, token: 'owned', owner: self });
    assert.equal(await inspectAgentImageBuildSlot(client), null);
});

test('a waiter reclaims a slot whose holder container is gone and proceeds', async () => {
    const client = new FakeRedis();
    await seedHolder(client, owner(GONE_HOST, 7));
    const { messages, logger } = recordingLogger();
    const result = await withAgentImageBuildSlot(async () => {
        assert.equal(JSON.parse(client.value!).token, 'new-worker');
        return 'built';
    }, {
        client, leaseMs: 500, acquireTimeoutMs: 1000, pollIntervalMs: 1, token: 'new-worker',
        owner: owner(LIVE_HOST, 1), ownerProbe: fakeProbe(new Set([1])), logger,
    });
    assert.equal(result, 'built');
    assert.equal(messages.length, 1);
    assert.match(messages[0], /Reclaimed the agent image build slot from feedfacecafe pid 7/);
});

test('a waiter reclaims a slot whose holder pid is gone in the same container', async () => {
    const client = new FakeRedis();
    await seedHolder(client, owner(LIVE_HOST, 9));
    assert.equal(await withAgentImageBuildSlot(async () => 'built', {
        client, leaseMs: 500, acquireTimeoutMs: 1000, pollIntervalMs: 1, token: 'new-worker',
        owner: owner(LIVE_HOST, 1), ownerProbe: fakeProbe(new Set([1])), logger: recordingLogger().logger,
    }), 'built');
});

test('a live holder keeps the slot and the waiter warns while it waits', async () => {
    const client = new FakeRedis();
    const held = await seedHolder(client, owner(LIVE_HOST, 9));
    const { messages, logger } = recordingLogger();
    await assert.rejects(
        withAgentImageBuildSlot(async () => assert.fail('must not run while a live process holds the slot'), {
            client, leaseMs: 500, acquireTimeoutMs: 120, pollIntervalMs: 1, token: 'waiter',
            owner: owner(LIVE_HOST, 1), ownerProbe: fakeProbe(new Set([1, 9])), ownerProbeIntervalMs: 5,
            waitWarningAfterMs: 0, waitWarningIntervalMs: 40, logger,
        }),
        /Timed out waiting for the ProPR agent image build slot/,
    );
    assert.equal(client.value, held);
    assert.ok(messages.length >= 2, `expected periodic warnings, got ${messages.length}`);
    for (const message of messages) {
        assert.match(message, /^Waiting for the agent image build slot held by live-worker pid 9, lease expires in 1m$/);
    }
});

test('a slot without a recorded owner is never reclaimed before its lease expires', async () => {
    const client = new FakeRedis();
    await client.set(AGENT_IMAGE_BUILD_LOCK_KEY, 'legacy-token', 'PX', 60_000, 'NX');
    const { messages, logger } = recordingLogger();
    await assert.rejects(
        withAgentImageBuildSlot(async () => 'built', {
            client, leaseMs: 500, acquireTimeoutMs: 30, pollIntervalMs: 1, token: 'waiter',
            ownerProbe: fakeProbe(new Set()), waitWarningAfterMs: 0, logger,
        }),
        /Timed out/,
    );
    assert.equal(client.value, 'legacy-token');
    assert.match(messages[0], /held by an unidentified holder \(token legacy-token\)/);
});

test('concurrent reclaimers of a dead slot: exactly one proceeds at a time', async () => {
    const client = new FakeRedis();
    await seedHolder(client, owner(GONE_HOST, 7));
    let active = 0;
    let maximumActive = 0;
    const entered: string[] = [];
    const releaseWinner = Promise.withResolvers<void>();
    const reclaim = (name: string, pid: number) => withAgentImageBuildSlot(async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        entered.push(name);
        if (entered.length === 1) await releaseWinner.promise;
        active -= 1;
        return name;
    }, {
        client, leaseMs: 500, acquireTimeoutMs: 2000, pollIntervalMs: 1, token: name,
        owner: owner(LIVE_HOST, pid), ownerProbe: fakeProbe(new Set([1, 2, 3])),
        ownerProbeIntervalMs: 1, logger: recordingLogger().logger,
    });
    const runs = [reclaim('a', 1), reclaim('b', 2), reclaim('c', 3)];
    await wait(30);
    assert.equal(entered.length, 1, 'only one reclaimer may proceed while it holds the slot');
    assert.equal(client.deletes, 1, 'the dead holder is deleted exactly once');
    releaseWinner.resolve();
    assert.deepEqual((await Promise.all(runs)).sort(), ['a', 'b', 'c']);
    assert.equal(maximumActive, 1);
});

// Shutdown is permanent for the process, so this runs last.
test('graceful shutdown aborts the in-flight build, releases the slot and refuses new builds', async () => {
    const client = new FakeRedis();
    const started = Promise.withResolvers<void>();
    let aborted = false;
    const build = withAgentImageBuildSlot(signal => new Promise<string>((_resolve, reject) => {
        started.resolve();
        signal.addEventListener('abort', () => { aborted = true; reject(new Error('docker build aborted')); });
    }), { client, leaseMs: 60_000, pollIntervalMs: 1, token: 'stopping', owner: owner(LIVE_HOST, 1) });
    await started.promise;
    assert.ok(client.value);
    await abortAgentImageBuildsForShutdown(1000);
    await assert.rejects(build, /docker build aborted/);
    assert.equal(aborted, true);
    assert.equal(client.value, null);
    await assert.rejects(
        withAgentImageBuildSlot(async () => 'late', { client, pollIntervalMs: 1, token: 'late' }),
        /worker is shutting down/,
    );
});
