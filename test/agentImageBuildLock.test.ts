import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    AGENT_IMAGE_BUILD_LOCK_KEY,
    runAgentImageBuild,
    withAgentImageBuildSlot,
    type AgentImageBuildLockClient,
} from '../packages/core/src/agents/agentImageBuildLock.js';

class FakeRedis implements AgentImageBuildLockClient {
    value: string | null = null;
    expiresAt = 0;

    async set(key: string, value: string, ...args: Array<string | number>): Promise<string | null> {
        assert.equal(key, AGENT_IMAGE_BUILD_LOCK_KEY);
        if (this.value && this.expiresAt <= Date.now()) this.value = null;
        if (args.includes('NX') && this.value) return null;
        const pxIndex = args.indexOf('PX');
        this.value = value;
        this.expiresAt = Date.now() + Number(args[pxIndex + 1]);
        return 'OK';
    }

    async eval(script: string, _numberOfKeys: number, _key: string, token: string, lease?: string): Promise<number> {
        if (script.includes('pexpire')) {
            if (this.value !== token || this.expiresAt <= Date.now()) return 0;
            this.expiresAt = Date.now() + Number(lease);
            return 1;
        }
        if (script.includes('del')) {
            if (this.value !== token) return 0;
            this.value = null;
            this.expiresAt = 0;
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
