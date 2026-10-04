import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Redis } from 'ioredis';
import { ACQUIRE_WORKFLOW_SLOT, RENEW_WORKFLOW_SLOT, RepositoryWorkflowCapacityError, RepositoryWorkflowLeaseLostError, withRepositoryWorkflowSlot } from '../src/workflow/workflowConcurrency.js';

import { getExecutionAbortError, getExecutionOwnershipContext, runWithExecutionAbortSignal } from '../src/claude/docker/dockerExecutionOwnership.js';

const binary = process.env.PROPR_TEST_REDIS_SERVER || 'redis-server';
const available = spawnSync(binary, ['--version']).status === 0;

test('shared admission respects active branch caps, legacy runs, expiry, release and cancellation', { skip: !available && 'redis-server is needed for the Lua integration test' }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'workflow-redis-'));
    const socket = path.join(directory, 'redis.sock');
    const server = spawn(binary, ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
    const redis = new Redis({ path: socket, lazyConnect: true, retryStrategy: () => 25, maxRetriesPerRequest: 20 });
    redis.on('error', () => undefined);
    try {
        for (let attempt = 0; ; attempt++) {
            try { await access(socket); break; }
            catch {
                if (attempt > 100) throw new Error('Redis test server did not create its socket');
                await new Promise(resolve => setTimeout(resolve, 25));
            }
        }
        await redis.connect();
        const key = 'slots';
        const claim = (token: string, limit: number) => redis.eval(ACQUIRE_WORKFLOW_SLOT, 2, key, 'limits', token, limit);
        assert.equal(await claim('legacy', 0), 1);
        const admissions = await Promise.all(Array.from({ length: 12 }, (_, index) => claim(`run-${index}`, 3)));
        assert.equal(admissions.filter(value => value === 1).length, 2, 'legacy run counts toward a workflow cap across workers');
        assert.equal(await claim('other-branch', 20), 0, 'larger branch policy cannot exceed an active lower cap');
        assert.equal(await claim('no-workflow', 0), 0, 'a legacy run cannot bypass an active cap');
        await redis.zadd(key, 1, 'legacy', 1, 'run-0', 1, 'run-1');
        assert.equal(await claim('recovered', 1), 1, 'abandoned leases are reclaimed');
        assert.equal(await redis.hlen('limits'), 1);
        assert.equal(await redis.eval(RENEW_WORKFLOW_SLOT, 2, key, 'limits', 'legacy'), 0, 'a reclaimed token loses ownership');
        assert.equal(await redis.eval(RENEW_WORKFLOW_SLOT, 2, key, 'limits', 'recovered'), 1);
        await redis.zadd(key, 1, 'recovered');
        assert.equal(await redis.eval(RENEW_WORKFLOW_SLOT, 2, key, 'limits', 'recovered'), 0, 'an expired token cannot revive itself before reclamation');

        const options = { redis, repository: 'example/workflow', limit: 1, checkCancelled: async () => {}, onLeaseError: (error: unknown) => { throw error; } };
        await assert.rejects(withRepositoryWorkflowSlot(options, async () => { throw new Error('agent failed'); }), /agent failed/);
        const counts = await withRepositoryWorkflowSlot(options, () => redis.zcard('propr:workflow:slots:{example/workflow}'));
        assert.equal(counts, 1);
        assert.equal(await redis.zcard('propr:workflow:slots:{example/workflow}'), 0);
        await assert.rejects(withRepositoryWorkflowSlot({ ...options, checkCancelled: async () => { throw new Error('cancelled'); } }, async () => assert.fail('cancelled task must never run')), /cancelled/);
    } finally {
        redis.disconnect();
        server.kill('SIGTERM');
        await new Promise<void>(resolve => server.once('exit', () => resolve()));
        await rm(directory, { recursive: true, force: true });
    }
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

function leaseHarness(t: TestContext) {
    let now = 0;
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    t.mock.method(performance, 'now', () => now);
    const slots = new Map<string, number>();
    const errors: unknown[] = [];
    let renew: (() => Promise<number>) | undefined;
    let releaseFails = false;
    let releases = 0;
    let renewals = 0;
    const redis = { eval: async (script: string, _keys: number, _key: string, _limits: string, token: string) => {
        if (script === ACQUIRE_WORKFLOW_SLOT) {
            for (const [member, deadline] of slots) if (deadline <= now) slots.delete(member);
            if (slots.size) return 0;
            slots.set(token, now + 120_000);
            return 1;
        }
        if (script === RENEW_WORKFLOW_SLOT) {
            renewals++;
            if (renew) return renew();
            if (!slots.has(token) || slots.get(token)! <= now) return 0;
            slots.set(token, now + 120_000);
            return 1;
        }
        releases++;
        if (releaseFails) throw new Error('Redis unavailable');
        slots.delete(token);
        return 1;
    } } as unknown as Redis;
    return {
        options: { redis, repository: 'example/workflow', limit: 1, checkCancelled: async () => {}, onLeaseError: (error: unknown) => { errors.push(error); } },
        slots, errors,
        setRenew: (operation: () => Promise<number>) => { renew = operation; },
        failRelease: () => { releaseFails = true; },
        get releases() { return releases; },
        get renewals() { return renewals; },
        async tick(ms: number) { now += ms; t.mock.timers.tick(ms); await setImmediate(); },
        jump(ms: number) { now += ms; },
    };
}

for (const failure of ['rejected', 'hung'] as const) {
    test(`stops a running execution before reclamation when renewal is ${failure}`, async t => {
        const h = leaseHarness(t);
        h.setRenew(() => failure === 'hung' ? new Promise(() => {}) : Promise.reject(new Error('Redis unavailable')));
        h.failRelease();
        let running = 0;
        let signal!: AbortSignal;
        const execution = withRepositoryWorkflowSlot(h.options, async () => {
            running++;
            signal = getExecutionOwnershipContext()!.signal;
            await new Promise<void>(resolve => signal.addEventListener('abort', () => {
                // Simulate asynchronous container termination.
                setTimeout(() => { running--; resolve(); }, 10_000);
            }, { once: true }));
        });
        const rejected = assert.rejects(execution, /capacity lease lost/);
        await setImmediate();
        await h.tick(30_000);
        await h.tick(30_000);
        await h.tick(28_999);
        assert.equal(signal.aborted, false);
        await h.tick(1);
        assert.equal(signal.aborted, true);
        // The Docker executor rejects with this reason; it must stay distinguishable from a user stop.
        const reason = getExecutionAbortError(signal);
        assert.ok(reason instanceof RepositoryWorkflowLeaseLostError);
        assert.notEqual(reason.name, 'ExecutionAbortedError');
        assert.doesNotMatch(reason.message, /aborted by user/);
        assert.equal(running, 1);
        assert.equal(h.releases, 0, 'aborting alone is not evidence that execution has stopped');
        assert.equal(h.slots.size, 1, 'reservation remains during teardown');
        await h.tick(10_000);
        await rejected;
        assert.equal(running, 0);
        assert.equal(h.slots.size, 1, 'failed release leaves the reservation for expiry');
        await h.tick(21_000);
        h.setRenew(async () => 1);
        await withRepositoryWorkflowSlot(h.options, async () => {
            assert.equal(running, 0, 'the old execution has stopped before the replacement starts');
            assert.equal(h.slots.size, 1);
        });
        if (failure === 'hung') assert.equal(h.renewals, 1, 'hung requests do not accumulate overlapping renewals');
    });
}

test('missing heartbeat ownership aborts immediately and waits for execution teardown', async t => {
    const h = leaseHarness(t);
    h.setRenew(async () => 0);
    const stopped = deferred<void>();
    let signal!: AbortSignal;
    const execution = withRepositoryWorkflowSlot(h.options, async () => {
        signal = getExecutionOwnershipContext()!.signal;
        await stopped.promise;
    });
    const rejected = assert.rejects(execution, /capacity lease lost/);
    await setImmediate();
    await h.tick(30_000);
    assert.equal(signal.aborted, true);
    assert.equal(h.releases, 0);
    stopped.resolve();
    await rejected;
    assert.equal(h.releases, 1);
});

test('confirmed renewals move the watchdog from the request start, not the reply time', async t => {
    const h = leaseHarness(t);
    const reply = deferred<number>();
    h.setRenew(() => reply.promise);
    let signal!: AbortSignal;
    const execution = withRepositoryWorkflowSlot(h.options, () => new Promise<void>(resolve => {
        signal = getExecutionOwnershipContext()!.signal;
        signal.addEventListener('abort', () => resolve(), { once: true });
    }));
    const rejected = assert.rejects(execution, /capacity lease lost/);
    await setImmediate();
    await h.tick(30_000);
    await h.tick(20_000);
    reply.resolve(1);
    await setImmediate();
    h.setRenew(() => new Promise(() => {}));
    await h.tick(39_000);
    assert.equal(signal.aborted, false, 'confirmed renewal extends the initial stop deadline');
    await h.tick(29_999);
    assert.equal(signal.aborted, false);
    await h.tick(1);
    await rejected;
});

test('a successful renewal reply cannot revive an aborted execution', async t => {
    const h = leaseHarness(t);
    const reply = deferred<number>();
    const stopped = deferred<void>();
    h.setRenew(() => reply.promise);
    let signal!: AbortSignal;
    const execution = withRepositoryWorkflowSlot(h.options, async () => {
        signal = getExecutionOwnershipContext()!.signal;
        await stopped.promise;
    });
    const rejected = assert.rejects(execution, /capacity lease lost/);
    await setImmediate();
    await h.tick(30_000);
    await h.tick(59_000);
    reply.resolve(1);
    await setImmediate();
    assert.equal(signal.aborted, true);
    await h.tick(30_000);
    assert.equal(h.renewals, 1);
    stopped.resolve();
    await rejected;
});

test('a delayed admission reply cannot start execution past its conservative deadline', async t => {
    const h = leaseHarness(t);
    const evalSlot = h.options.redis.eval.bind(h.options.redis);
    t.mock.method(h.options.redis, 'eval', async (...args: Parameters<Redis['eval']>) => {
        const result = await evalSlot(...args);
        if (args[0] === ACQUIRE_WORKFLOW_SLOT) h.jump(90_000);
        return result;
    });
    await assert.rejects(withRepositoryWorkflowSlot(h.options, async () => assert.fail('must not start')), /capacity lease lost/);
    assert.equal(h.releases, 1);
});

test('ownership is checked after the post-admission cancellation await', async t => {
    const h = leaseHarness(t);
    let checks = 0;
    h.options.checkCancelled = async () => { if (++checks === 2) h.jump(90_000); };
    await assert.rejects(withRepositoryWorkflowSlot(h.options, async () => assert.fail('must not start')), /capacity lease lost/);
    assert.equal(h.releases, 1);
});

test('preserves parent cancellation and the attempt generation used for container teardown', async t => {
    const h = leaseHarness(t);
    const parent = new AbortController();
    const execution = runWithExecutionAbortSignal(parent.signal, () => withRepositoryWorkflowSlot(h.options, () => new Promise<void>(resolve => {
        const ownership = getExecutionOwnershipContext()!;
        assert.equal(ownership.attemptGeneration, 'pr-attempt');
        ownership.signal.addEventListener('abort', () => resolve(), { once: true });
    })), 'pr-attempt');
    const rejected = assert.rejects(execution, /PR lock lost/);
    await setImmediate();
    parent.abort(new Error('PR lock lost'));
    await rejected;
    assert.equal(h.releases, 1);
});


test('refused admission settles without polling or releasing another execution reservation', async t => {
    const h = leaseHarness(t);
    const done = deferred<void>();
    const active = withRepositoryWorkflowSlot(h.options, () => done.promise);
    await setImmediate();
    let refused = false;
    const waiter = withRepositoryWorkflowSlot(h.options, async () => assert.fail('capacity is full'));
    const rejection = assert.rejects(waiter, RepositoryWorkflowCapacityError).then(() => { refused = true; });
    await setImmediate();
    assert.equal(refused, true, 'a processor must return without waiting for a timer or the running task');
    assert.equal(h.releases, 0, 'a refused attempt has no authority to release the active lease');
    assert.equal(h.slots.size, 1);
    done.resolve();
    await Promise.all([active, rejection]);
});
