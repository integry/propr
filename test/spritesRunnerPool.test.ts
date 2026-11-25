/**
 * The shared Sprites runner pool through `SpritesRuntime`: two runtimes on one
 * store stand in for two workers. Leasing, FIFO queueing at the bound, health
 * checks, orphan reaping and startup reconciliation, warm clone checkpoints,
 * run usage timings and the status summary.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { closeConnection } from '../packages/core/src/db/connection.ts';
after(closeConnection);
import { AgentRunSpecBuilder, agentRunNetwork } from '../packages/core/src/agents/runtime/agentRunSpec.ts';
import { SpritesRuntime } from '../packages/core/src/agents/runtime/spritesRuntime.ts';
import {
    MemorySpritePoolStore, readSpritesPoolStatus, resolveSpritesPoolConfig, spritesPoolLabel, spritesPoolScope, spritesWarmCloneKey,
} from '../packages/core/src/agents/runtime/spritesPool.ts';
import { acquireSpriteRunner, emptySpritePoolState } from '../packages/core/src/agents/runtime/sprites/spritesPoolState.ts';
import { formatComputeUsage, normalizeComputeUsage } from '../packages/core/src/agents/runtime/computeUsage.ts';
import { WORKSPACE_TRANSPORT_ENVIRONMENT, WORKSPACE_TRANSPORT_SCRIPT } from '../packages/core/src/git/workspaceTransportScript.ts';
import { readSpriteSetup } from '../packages/core/src/agents/runtime/sprites/spritesProvisioning.ts';
import { SpritePool } from '../packages/core/src/agents/runtime/sprites/spritesRunnerPool.ts';
import { FakeSprite, FakeSprites } from './helpers/fakeSprites.ts';

const token = 'test-org-secret';
const scope = spritesPoolScope(token);

function worker(client: FakeSprites, store: MemorySpritePoolStore, env: Record<string, string> = {}, owner?: string) {
    return new SpritesRuntime(client, { PROPR_SPRITES_TOKEN: token, ...env }, { store, pollMs: 5, owner });
}

function spec(remote = 'https://github.com/example/one.git') {
    return new AgentRunSpecBuilder({
        name: 'test', stdin: true, agentType: 'antigravity', image: 'test', network: agentRunNetwork('bridge'), user: '0:0',
        workspace: { hostPath: '/unused', containerPath: '/home/node/workspace', readOnly: false, mode: 'clone',
            clone: { remote, baseRef: 'base', baseCommit: 'unused', branch: 'test', resultDir: '/tmp/propr-workspace-result', script: WORKSPACE_TRANSPORT_SCRIPT } },
    }).command('agy', '--version').build();
}

const tick = () => new Promise(resolve => setTimeout(resolve, 20));

test('the bound holds across workers: a run queues until a runner is released and then reuses it', { timeout: 10_000 }, async () => {
    const client = new FakeSprites();
    const store = new MemorySpritePoolStore();
    const a = worker(client, store, { PROPR_SPRITES_MAX: '1' });
    const b = worker(client, store, { PROPR_SPRITES_MAX: '1' });
    const first = a.start(spec());
    const firstResult = await first.wait();
    assert.equal(firstResult.computeUsage?.runnerPool?.provisioned, true);
    const queued = b.start(spec());
    await tick();
    assert.equal(client.created.length, 1, 'the second worker must not exceed the bound');
    const status = await readSpritesPoolStatus({ store });
    assert.equal(status.pools[0].waiting, 1);
    assert.equal(status.pools[0].runners.busy, 1);
    assert.equal(status.pools[0].max, 1);
    await first.release!();
    const result = await queued.wait();
    assert.equal(client.created.length, 1);
    assert.equal(client.created[0].launches.length, 2, 'the released runner serves the other worker');
    const usage = result.computeUsage!.runnerPool!;
    assert.equal(usage.provisioned, false);
    assert.ok(usage.waitMs > 0);
    assert.equal(typeof usage.previousRestoreMs, 'number', 'the reset restore of the previous run is reported');
    assert.equal(typeof usage.healthCheckMs, 'number');
    assert.equal(client.created[0].healthChecks, 1);
    await queued.release!();
    const idle = await readSpritesPoolStatus({ store });
    assert.equal(idle.pools[0].runners.idle, 1);
    assert.equal(idle.pools[0].restore.samples, 1);
    await Promise.all([a.close(), b.close()]);
});

test('queued runs are served first come, first served and a cancelled wait leaves the queue', { timeout: 10_000 }, async () => {
    const client = new FakeSprites();
    const store = new MemorySpritePoolStore();
    const runtime = worker(client, store, { PROPR_SPRITES_MAX: '1' });
    const holder = runtime.start(spec());
    await holder.wait();
    const order: string[] = [];
    const controller = new AbortController();
    const cancelled = runtime.start(spec(), { signal: controller.signal });
    await tick();
    const second = runtime.start(spec());
    await tick();
    const third = runtime.start(spec());
    await tick();
    controller.abort();
    await assert.rejects(cancelled.wait());
    void second.wait().then(() => order.push('second'));
    void third.wait().then(() => order.push('third'));
    await holder.release!();
    await second.wait();
    await tick();
    assert.deepEqual(order, ['second']);
    await second.release!();
    await third.wait();
    assert.deepEqual(order, ['second', 'third']);
    await third.release!();
    assert.equal((await readSpritesPoolStatus({ store })).pools[0].waiting, 0);
    assert.equal(client.created.length, 1);
    await runtime.close();
});

test('a run that times out in the queue leaves its slot with the holder', { timeout: 5000 }, async () => {
    const client = new FakeSprites();
    const store = new MemorySpritePoolStore();
    const runtime = worker(client, store, { PROPR_SPRITES_MAX: '1' });
    const holder = runtime.start(spec());
    await holder.wait();
    try {
        await assert.rejects(runtime.start(spec(), { timeout: 30 }).wait(), { name: 'TimeoutError' });
        assert.equal((await store.read(scope)).waiting.size, 0);
        assert.equal(client.created.length, 1);
        assert.equal(client.created[0].launches.length, 1);
    } finally {
        await holder.release!();
        await runtime.close();
    }
});

test('a runner failing its health check is destroyed and re-provisioned in its slot', { timeout: 10_000 }, async () => {
    const client = new FakeSprites();
    const store = new MemorySpritePoolStore();
    const runtime = worker(client, store, { PROPR_SPRITES_MAX: '1' });
    const run = runtime.start(spec());
    await run.wait();
    await run.release!();
    client.created[0].failHealth = true;
    const next = runtime.start(spec());
    const result = await next.wait();
    assert.equal(result.exitCode, 0);
    assert.deepEqual(client.deleted, [client.created[0].name]);
    assert.equal(client.created.length, 2);
    assert.equal(client.created[1].launches.length, 1);
    assert.equal(result.computeUsage?.runnerPool?.provisioned, true);
    await next.release!();
    await runtime.close();
});

test('a crashed worker\'s leased runner is reaped before its slot is reused; a kept result is never reaped', { timeout: 10_000 }, async () => {
    const client = new FakeSprites();
    const store = new MemorySpritePoolStore();
    const crashed = new FakeSprite('propr-crashed');
    const kept = new FakeSprite('propr-kept');
    client.foreign.push(crashed, kept);
    await store.transact(scope, state => {
        state.runners.set('propr-crashed', { state: 'leased', leaseId: 'dead', owner: 'gone', heartbeatAt: 0, since: 0, runs: 3, checkpoint: 'v1' });
        state.runners.set('propr-kept', { state: 'finished', leaseId: 'dead2', owner: 'gone', heartbeatAt: 0, since: 0, runs: 1, checkpoint: 'v1' });
    });
    const before = await readSpritesPoolStatus({ store });
    assert.equal(before.pools[0].runners.orphaned, 1);
    assert.equal(before.pools[0].runners.retained, 1);
    assert.equal(before.pools[0].attention.length, 2);
    const runtime = worker(client, store, { PROPR_SPRITES_MAX: '2' });
    const run = runtime.start(spec());
    await run.wait();
    assert.deepEqual(client.deleted, ['propr-crashed']);
    assert.equal(client.created.length, 1);
    const state = await store.read(scope);
    assert.equal(state.runners.get('propr-kept')?.state, 'retained');
    assert.equal(state.runners.has('propr-crashed'), false);
    // Both slots are taken (the run and the kept result): the next run waits.
    const next = runtime.start(spec());
    await tick();
    assert.equal(client.created.length, 1);
    await run.release!();
    await next.wait();
    await next.release!();
    await runtime.close();
});

test('startup reaps this pool\'s Sprites no record owns and forgets records whose Sprite is gone', { timeout: 10_000 }, async () => {
    const client = new FakeSprites();
    const store = new MemorySpritePoolStore();
    const label = spritesPoolLabel(scope);
    const leaked = Object.assign(new FakeSprite('propr-leaked'), { labels: ['propr-pool', label] });
    const otherPool = Object.assign(new FakeSprite('propr-other'), { labels: ['propr-pool', 'propr-pool-0000000000000000'] });
    const legacyOld = new FakeSprite(`propr-${randomUUID()}`);
    legacyOld.createdAt = new Date(Date.now() - 48 * 3600_000);
    const legacyResult = new FakeSprite(`propr-${randomUUID()}`);
    legacyResult.createdAt = legacyOld.createdAt;
    legacyResult.files.set('/opt/propr/result/result.bundle', Buffer.from('only copy'));
    const legacyNew = new FakeSprite(`propr-${randomUUID()}`);
    const unrelated = new FakeSprite('my-own-sprite');
    const pooled = Object.assign(new FakeSprite('propr-pooled'), { labels: ['propr-pool', label] });
    client.foreign.push(leaked, otherPool, legacyResult, legacyOld, legacyNew, unrelated, pooled);
    await store.transact(scope, state => {
        state.runners.set('propr-pooled', { setupFingerprint: readSpriteSetup().fingerprint, state: 'idle', heartbeatAt: 0, since: 0, runs: 1, checkpoint: 'v1' });
        state.runners.set('propr-vanished', { state: 'idle', heartbeatAt: 0, since: 0, runs: 1, checkpoint: 'v1' });
    });
    pooled.checkpoints.push({ id: 'v1', comment: 'propr clean setup', files: new Map() });
    const runtime = worker(client, store);
    const run = runtime.start(spec());
    await run.wait();
    assert.deepEqual(client.deleted, [leaked.name, legacyOld.name]);
    const recovered = await client.getSprite(legacyResult.name);
    assert.equal((await recovered.filesystem().readFile('/opt/propr/result/result.bundle', null)).toString(), 'only copy');
    assert.equal(pooled.launches.length, 1, 'an idle runner with a record is reused, not reaped');
    assert.equal((await store.read(scope)).runners.has('propr-vanished'), false);
    await run.release!();
    await runtime.close();
});

test('startup only inspects unlabelled legacy UUIDs known to be older than 24 hours', async t => {
    const client = new FakeSprites();
    const now = Date.now();
    const cutoff = now - 24 * 3600_000;
    t.mock.method(Date, 'now', () => now);
    for (const createdAt of [new Date(cutoff), new Date(NaN), undefined]) {
        client.foreign.push(Object.assign(new FakeSprite(`propr-${randomUUID()}`), { createdAt }));
    }
    const old = new Date(cutoff - 1);
    client.foreign.push(
        Object.assign(new FakeSprite('propr-custom'), { createdAt: old }),
        Object.assign(new FakeSprite(`propr-${randomUUID()}`), { createdAt: old, labels: ['another-service'] }),
    );
    const probes = client.foreign.map(sprite => t.mock.method(sprite, 'execFile'));
    const eligible = Object.assign(new FakeSprite(`propr-${randomUUID()}`), { createdAt: old });
    client.foreign.push(eligible);
    await pool(client, new MemorySpritePoolStore()).reconcile();
    assert.deepEqual(client.deleted, [eligible.name]);
    assert.ok(probes.every(probe => probe.mock.callCount() === 0));
});

test('legacy cleanup requires a conclusive inspection and rechecks ownership after it', async t => {
    const client = new FakeSprites();
    const store = new MemorySpritePoolStore();
    const oldSprite = () => Object.assign(new FakeSprite(`propr-${randomUUID()}`), { createdAt: new Date(0) });
    const unavailable = oldSprite();
    const failed = oldSprite();
    const claimed = oldSprite();
    client.foreign.push(unavailable, failed, claimed);
    t.mock.method(unavailable, 'execFile', async () => { throw new Error('inspection unavailable'); });
    t.mock.method(failed, 'execFile', async () => ({ exitCode: 1, stdout: 'absent', stderr: '' }));
    const inspected = t.mock.method(claimed, 'execFile', async () => {
        await store.transact(scope, state => state.runners.set(claimed.name, { state: 'retained', since: 0, heartbeatAt: 0, runs: 1 }));
        return { exitCode: 0, stdout: 'absent', stderr: '' };
    });
    await pool(client, store).reconcile();
    assert.equal(inspected.mock.callCount(), 1);
    assert.deepEqual(client.deleted, []);
    assert.equal((await store.read(scope)).runners.get(claimed.name)?.state, 'retained');
});

for (const kind of ['labelled', 'legacy']) {
    test(`a failed startup deletion keeps the ${kind} orphan counted across workers`, { timeout: 5000 }, async t => {
        const client = new FakeSprites();
        const store = new MemorySpritePoolStore();
        const orphan = new FakeSprite(`propr-${randomUUID()}`);
        if (kind === 'labelled') orphan.labels = [spritesPoolLabel(scope)];
        else orphan.createdAt = new Date(0);
        client.foreign.push(orphan);
        const unavailable = t.mock.method(client, 'deleteSprite', async () => { throw new Error('provider unavailable'); });
        const signal = new AbortController().signal;
        const a = pool(client, store, 2);
        const b = pool(client, store, 2);
        const first = await a.acquire(signal);
        assert.equal((await store.read(scope)).runners.get(orphan.name)?.state, 'orphaned');
        await assert.rejects(b.acquire(signal, { timeout: 50 }), { name: 'TimeoutError' });
        assert.deepEqual((await client.listAllSprites()).map(sprite => sprite.name).sort(), [first.name, orphan.name].sort());
        assert.equal(client.created.length, 1);

        unavailable.mock.restore();
        const second = await b.acquire(signal);
        assert.deepEqual(client.deleted, [orphan.name]);
        assert.equal((await store.read(scope)).runners.has(orphan.name), false);
        assert.equal((await client.listAllSprites()).length, 2);
        await Promise.all([a.discard(first), b.discard(second)]);
    });
}

test('acquisition retries startup inventory after the store fails to record a listed orphan', async t => {
    const client = new FakeSprites();
    const store = new MemorySpritePoolStore();
    const orphan = Object.assign(new FakeSprite('propr-untracked'), { labels: [spritesPoolLabel(scope)] });
    client.foreign.push(orphan);
    const runtime = pool(client, store);
    t.mock.method(store, 'transact', async () => { throw new Error('Redis unavailable'); }, { times: 1 });
    const signal = new AbortController().signal;
    await assert.rejects(runtime.acquire(signal), /Redis unavailable/);
    assert.deepEqual(client.created, []);
    assert.deepEqual(client.deleted, []);
    const slot = await runtime.acquire(signal);
    assert.deepEqual(client.deleted, [orphan.name]);
    await runtime.discard(slot);
});

test('a startup lookup failure leaves listed orphans counted and the remaining capacity available', async t => {
    const client = new FakeSprites();
    const store = new MemorySpritePoolStore();
    const orphan = Object.assign(new FakeSprite('propr-listed'), { labels: [spritesPoolLabel(scope)] });
    client.foreign.push(orphan);
    await store.transact(scope, state => state.runners.set('propr-missing', { state: 'retained', since: 0, heartbeatAt: 0, runs: 1 }));
    t.mock.method(client, 'getSprite', async () => { throw new Error('lookup unavailable'); });
    const runtime = pool(client, store, 3);
    const slot = await runtime.acquire(new AbortController().signal);
    const records = (await store.read(scope)).runners;
    assert.equal(records.size, 3);
    assert.equal(records.get(orphan.name)?.state, 'orphaned');
    assert.equal(records.get('propr-missing')?.state, 'retained');
    await runtime.discard(slot);
});

test('retrying a failed legacy deletion requires fresh evidence that no result is present', async t => {
    const client = new FakeSprites();
    const store = new MemorySpritePoolStore();
    const orphan = Object.assign(new FakeSprite(`propr-${randomUUID()}`), { createdAt: new Date(0) });
    client.foreign.push(orphan);
    t.mock.method(client, 'deleteSprite', async () => { throw new Error('provider unavailable'); }, { times: 1 });
    await pool(client, store).reconcile();
    orphan.files.set('/opt/propr/result/result.bundle', Buffer.from('only copy'));
    await pool(client, store).reconcile();
    assert.equal((await store.read(scope)).runners.get(orphan.name)?.state, 'retained');
    assert.deepEqual(client.deleted, []);
});

test('lowering the bound discards surplus runners on release', { timeout: 10_000 }, async () => {
    const client = new FakeSprites();
    const store = new MemorySpritePoolStore();
    const wide = worker(client, store, { PROPR_SPRITES_MAX: '2' });
    const runs = [wide.start(spec()), wide.start(spec())];
    await Promise.all(runs.map(run => run.wait()));
    const narrow = worker(client, store, { PROPR_SPRITES_MAX: '1' });
    await runs[0].release!();
    await runs[1].release!();
    // The wide worker still allows two; its releases keep both.
    assert.equal((await store.read(scope)).runners.size, 2);
    const run = narrow.start(spec());
    await run.wait();
    await run.release!();
    assert.equal((await store.read(scope)).runners.size, 1);
    assert.equal(client.deleted.length, 1);
    await Promise.all([wide.close(), narrow.close()]);
});

test('warm clones: a run refreshes its repository reference, the next run of it starts warm, another repository starts clean', { timeout: 10_000 }, async () => {
    const client = new FakeSprites();
    const store = new MemorySpritePoolStore();
    const runtime = worker(client, store, { PROPR_SPRITES_MAX: '1', PROPR_SPRITES_WARM_CLONES: 'on' });
    const repo = 'https://github.com/example/one.git';
    const reference = `/var/lib/propr/warm/${spritesWarmCloneKey(repo)}.git`;
    const first = runtime.start(spec(repo));
    await first.wait();
    const sprite = client.created[0];
    assert.equal(JSON.parse(sprite.launches[0]).transportEnv[WORKSPACE_TRANSPORT_ENVIRONMENT.reference], reference);
    // What the transport wrapper leaves: its refreshed reference, beside the agent's own changes.
    sprite.files.set(reference + '/objects', Buffer.from('objects'));
    sprite.files.set('/home/node/workspace/agent-change', Buffer.from('private'));
    await first.release!();
    assert.deepEqual(sprite.events.slice(-6), ['restart', 'wipe', 'carry', 'restore', 'install', 'warm-checkpoint']);
    assert.equal(sprite.files.has('/home/node/workspace/agent-change'), false, 'the warm baseline is the clean checkpoint plus the reference only');
    assert.equal(sprite.files.get(reference + '/objects')?.toString(), 'objects');
    assert.equal((await readSpritesPoolStatus({ store })).pools[0].warm, 1);

    const warm = runtime.start(spec(repo));
    const warmUsage = (await warm.wait()).computeUsage!.runnerPool!;
    assert.equal(warmUsage.baseline, 'warm');
    assert.equal(warmUsage.restoreBeforeLeaseMs, null);
    assert.equal(sprite.events.at(-1), 'launch');
    sprite.files.set('/home/node/workspace/agent-change', Buffer.from('private'));
    await warm.release!();
    assert.deepEqual(sprite.events.slice(-4), ['carry', 'restore', 'install', 'warm-checkpoint']);

    const other = runtime.start(spec('https://github.com/example/two.git'));
    const otherUsage = (await other.wait()).computeUsage!.runnerPool!;
    assert.deepEqual(sprite.events.slice(-2), ['restore', 'launch'], 'another repository waits for the clean restore');
    assert.equal(otherUsage.baseline, 'clean');
    assert.equal(typeof otherUsage.restoreBeforeLeaseMs, 'number');
    assert.match(formatComputeUsage({ ...(await other.wait()).computeUsage! }), /restore \d+\.\ds before start/);
    await other.release!();
    // The other repository's run left no reference: its runner returns to the clean checkpoint.
    assert.equal(sprite.events.at(-1), 'restore');
    assert.equal((await readSpritesPoolStatus({ store })).pools[0].warm, 0);
    await runtime.close();
});

test('pool settings: default bound 2, clamped to the organization limit, invalid values refused', () => {
    assert.deepEqual(resolveSpritesPoolConfig({}), { max: 2, orgLimit: 3, warmClones: false, clamped: false });
    assert.deepEqual(resolveSpritesPoolConfig({ PROPR_SPRITES_MAX: '5' }), { max: 3, orgLimit: 3, warmClones: false, clamped: true });
    assert.equal(resolveSpritesPoolConfig({ PROPR_SPRITES_MAX: '5', PROPR_SPRITES_ORG_LIMIT: '10' }).max, 5);
    assert.equal(resolveSpritesPoolConfig({ PROPR_SPRITES_WARM_CLONES: 'on' }).warmClones, true);
    assert.throws(() => resolveSpritesPoolConfig({ PROPR_SPRITES_MAX: '0' }), /PROPR_SPRITES_MAX/);
    assert.throws(() => resolveSpritesPoolConfig({ PROPR_SPRITES_WARM_CLONES: 'maybe' }), /PROPR_SPRITES_WARM_CLONES/);
});

test('an acquisition prefers an idle runner warm for the repository, then a clean one', () => {
    const state = emptySpritePoolState();
    const base = { heartbeatAt: 0, since: 0, runs: 0, checkpoint: 'v1' } as const;
    state.runners.set('warm-other', { ...base, state: 'idle', warm: { repo: 'b', checkpoint: 'v2' } });
    state.runners.set('clean', { ...base, state: 'idle' });
    state.runners.set('warm-mine', { ...base, state: 'idle', warm: { repo: 'a', checkpoint: 'v3' } });
    const request = (leaseId: string, repo?: string) => ({ leaseId, owner: 'w', max: 3, repo, newName: 'new', now: 1, ttlMs: 60_000 });
    assert.equal((acquireSpriteRunner(state, request('1', 'a')) as { name: string }).name, 'warm-mine');
    assert.equal((acquireSpriteRunner(state, request('2', 'a')) as { name: string }).name, 'clean');
    assert.equal((acquireSpriteRunner(state, request('3', 'a')) as { name: string }).name, 'warm-other');
    assert.equal(acquireSpriteRunner(state, request('4')).action, 'wait');
});

test('stored run usage keeps the runner pool timings', () => {
    const usage = normalizeComputeUsage({ runtime: 'sprites', wallTimeMs: 1000, runnerPool: {
        waitMs: 2500, provisioned: false, provisionMs: null, healthCheckMs: 300, previousRestoreMs: 14_200, restoreBeforeLeaseMs: null, baseline: 'clean',
    } });
    assert.equal(usage?.runnerPool?.previousRestoreMs, 14_200);
    assert.equal(formatComputeUsage(usage!), 'sprites · 1s wall · queued 3s · clean runner · restored in 14.2s');
    assert.equal(normalizeComputeUsage({ runtime: 'docker', wallTimeMs: 1, runnerPool: { waitMs: 'x' } })?.runnerPool, undefined);
});

test('a run cancelled during the health check hands the runner back instead of destroying it', { timeout: 10_000 }, async () => {
    const client = new FakeSprites();
    const store = new MemorySpritePoolStore();
    const runtime = worker(client, store, { PROPR_SPRITES_MAX: '1' });
    const run = runtime.start(spec());
    await run.wait();
    await run.release!();
    const sprite = client.created[0];
    const checking = Promise.withResolvers<void>();
    const exec = sprite.execFile.bind(sprite);
    sprite.execFile = async (cmd, args, options) => {
        if (cmd === '/bin/true') { checking.resolve(); await new Promise(() => {}); }
        return exec(cmd, args, options);
    };
    const controller = new AbortController();
    const cancelled = runtime.start(spec(), { signal: controller.signal });
    await checking.promise;
    controller.abort();
    await assert.rejects(cancelled.wait());
    await tick();
    assert.deepEqual(client.deleted, []);
    assert.equal((await store.read(scope)).runners.get(sprite.name)?.state, 'idle');
    sprite.execFile = exec;
    const next = runtime.start(spec());
    await next.wait();
    assert.equal(sprite.launches.length, 2);
    await next.release!();
    await runtime.close();
});

function pool(client: FakeSprites, store: MemorySpritePoolStore, max = 1) {
    return new SpritePool(client, { scope, store, pollMs: 5, ttlMs: 1000, config: resolveSpritesPoolConfig({ PROPR_SPRITES_MAX: String(max) }) });
}

test('an ambiguous restart waits for running status and a successful exec before resetting', { timeout: 5000 }, async t => {
    const client = new FakeSprites();
    const runtime = pool(client, new MemorySpritePoolStore());
    const signal = new AbortController().signal;
    const slot = await runtime.acquire(signal);
    const sprite = client.created[0];
    t.mock.method(sprite, 'restart', async () => { throw new Error('restart outcome unknown'); });
    let polls = 0;
    t.mock.method(client, 'getSprite', async () => {
        sprite.events.push('status');
        return Object.assign(sprite, { status: ++polls === 1 ? 'starting' : 'running' });
    });
    const exec = sprite.execFile.bind(sprite);
    let probes = 0;
    t.mock.method(sprite, 'execFile', async (...args: Parameters<typeof exec>) => {
        if (args[0] === '/bin/true') {
            sprite.events.push('probe');
            if (++probes === 1) throw new Error('exec unavailable');
        }
        return exec(...args);
    });
    sprite.events.length = 0;
    await runtime.release(slot);
    assert.deepEqual(sprite.events, ['status', 'status', 'probe', 'status', 'probe', 'wipe', 'restore']);
    const next = await runtime.acquire(signal);
    assert.equal(next.name, slot.name);
    assert.deepEqual(client.deleted, []);
    await runtime.discard(next);
});

test('ambiguous restart recovery replaces the runner if a status request hangs past the deadline', { timeout: 5000 }, async t => {
    const client = new FakeSprites();
    const runtime = pool(client, new MemorySpritePoolStore());
    const slot = await runtime.acquire(new AbortController().signal);
    const sprite = client.created[0];
    t.mock.method(sprite, 'restart', async () => ({ message: 'restart outcome unknown' }));
    const expire = controlDeadline(t, 60_000);
    const polling = Promise.withResolvers<void>();
    t.mock.method(client, 'getSprite', () => {
        polling.resolve();
        return new Promise(() => {});
    });
    const release = runtime.release(slot);
    await polling.promise;
    expire();
    await release;
    assert.deepEqual(client.deleted, [slot.name]);
    assert.equal(client.created.length, 2);
    assert.ok(!sprite.events.includes('wipe'));
    await runtime.close();
});

for (const cancelled of [false, true]) {
    test(`failed surplus deletion stays counted after ${cancelled ? 'cancelled health check' : 'reset'}`, { timeout: 5000 }, async () => {
        const client = new FakeSprites();
        const store = new MemorySpritePoolStore();
        const wide = pool(client, store, 2);
        const narrow = pool(client, store);
        const signal = new AbortController().signal;
        const busy = await wide.acquire(signal);
        const idle = await wide.acquire(signal);
        await wide.release(idle);
        const controller = new AbortController();
        if (cancelled) {
            const sprite = client.created[1];
            const exec = sprite.execFile.bind(sprite);
            sprite.execFile = (cmd, args, options) => {
                if (cmd === '/bin/true') controller.abort();
                return exec(cmd, args, options);
            };
        }
        const remove = client.deleteSprite.bind(client);
        let deletionState: string | undefined;
        client.deleteSprite = async () => {
            deletionState = (await store.read(scope)).runners.get(idle.name)?.state;
            throw new Error('provider unavailable');
        };
        if (cancelled) await assert.rejects(narrow.acquire(controller.signal), /abort/i);
        else await narrow.release(await narrow.acquire(signal));
        assert.equal(deletionState, 'reaping');
        assert.equal((await store.read(scope)).runners.get(idle.name)?.state, 'orphaned');
        client.deleteSprite = remove;
        await wide.discard(busy);
        const replacement = await narrow.acquire(signal);
        assert.deepEqual(client.deleted, [busy.name, idle.name]);
        assert.equal((await store.read(scope)).runners.size, 1);
        await narrow.discard(replacement);
    });
}

test('a blocked pool retries retained lookup after failure and frees the slot after manual deletion', { timeout: 5000 }, async () => {
    const client = new FakeSprites();
    const store = new MemorySpritePoolStore();
    const kept = new FakeSprite('propr-retained');
    client.foreign.push(kept);
    await store.transact(scope, state => state.runners.set(kept.name, {
        state: 'finished', leaseId: 'dead', since: 0, heartbeatAt: 0, runs: 1,
    }));
    const runtime = pool(client, store);
    const get = client.getSprite.bind(client);
    const checked = Promise.withResolvers<void>();
    let checks = 0;
    client.getSprite = async name => {
        if (++checks === 1) throw Object.assign(new Error('try again'), { statusCode: 503 });
        const sprite = await get(name);
        checked.resolve();
        return sprite;
    };
    const queued = runtime.acquire(new AbortController().signal);
    await checked.promise;
    assert.equal((await store.read(scope)).runners.get(kept.name)?.state, 'retained');
    assert.equal(client.created.length, 0);
    await client.deleteSprite(kept.name);
    const slot = await queued;
    assert.equal((await store.read(scope)).runners.has(kept.name), false);
    assert.deepEqual(client.deleted, [kept.name]);
    await runtime.discard(slot);
});

test('incompatible and historical checkpoints are replaced within their held slot', async () => {
    const client = new FakeSprites();
    const store = new MemorySpritePoolStore();
    const signal = new AbortController().signal;
    const first = pool(client, store);
    let slot = await first.acquire(signal);
    await first.release(slot);
    const fingerprint = readSpriteSetup().fingerprint;
    for (const previous of ['outdated', undefined]) {
        const old = slot.name;
        await store.transact(scope, state => {
            assert.equal(state.runners.get(old)?.setupFingerprint, fingerprint);
            state.runners.get(old)!.setupFingerprint = previous;
        });
        const next = pool(client, store);
        slot = await next.acquire(signal);
        assert.notEqual(slot.name, old);
        assert.equal(client.deleted.at(-1), old);
        assert.equal((await store.read(scope)).runners.size, 1);
        assert.equal(client.created.at(-2)?.healthChecks, 0);
        await next.release(slot);
    }
    await first.close();
});

test('the setup fingerprint covers CLI pins and the contents of every uploaded script', t => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'sprites-setup-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    cpSync('Dockerfile.agent', path.join(root, 'Dockerfile.agent'));
    const setup = readSpriteSetup();
    for (const file of setup.files) cpSync(path.join('scripts', file.name), path.join(root, 'scripts', file.name));
    assert.equal(readSpriteSetup(root).fingerprint, setup.fingerprint);
    for (const file of setup.files) {
        const target = path.join(root, 'scripts', file.name);
        writeFileSync(target, file.contents + '\n');
        assert.notEqual(readSpriteSetup(root).fingerprint, setup.fingerprint, file.name);
        writeFileSync(target, file.contents);
    }
    const dockerfile = path.join(root, 'Dockerfile.agent');
    writeFileSync(dockerfile, readFileSync(dockerfile, 'utf8').replace(/^ARG CODEX_CLI_VERSION=.*$/m, 'ARG CODEX_CLI_VERSION=99.0.0'));
    assert.notEqual(readSpriteSetup(root).fingerprint, setup.fingerprint);
});

/** Expire just this lifecycle deadline while an SDK request is in flight. */
function controlDeadline(t: TestContext, duration: number) {
    const deadline = new AbortController();
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    t.mock.method(AbortSignal, 'timeout', (ms: number) => ms === duration && !deadline.signal.aborted ? deadline.signal : timeout(ms));
    return () => deadline.abort(new DOMException('deadline expired', 'TimeoutError'));
}

for (const operation of ['retained lookup', 'orphan inspection', 'orphan deletion']) {
    test(`a queued acquisition times out during ${operation}`, { timeout: 5000 }, async t => {
        const client = new FakeSprites();
        const store = new MemorySpritePoolStore();
        const runtime = pool(client, store);
        const signal = new AbortController().signal;
        await runtime.discard(await runtime.acquire(signal)); // Finish startup before adding the blocked runner.
        t.mock.timers.enable({ apis: ['setInterval'] });
        const sprite = new FakeSprite('propr-blocked');
        client.foreign.push(sprite);
        const state = operation === 'retained lookup' ? 'retained' : 'orphaned';
        await store.transact(scope, pool => pool.runners.set(sprite.name, {
            state, since: 0, heartbeatAt: 0, runs: 1, inspectResultOnReap: operation === 'orphan inspection',
        }));
        const started = Promise.withResolvers<void>();
        const response = Promise.withResolvers<never>();
        const pending = () => { started.resolve(); return response.promise; };
        if (operation === 'retained lookup') t.mock.method(client, 'getSprite', pending);
        else if (operation === 'orphan inspection') t.mock.method(sprite, 'execFile', pending);
        else t.mock.method(client, 'deleteSprite', pending);
        const expire = controlDeadline(t, 4321);
        const queued = runtime.acquire(signal, { timeout: 4321 });
        await started.promise;
        expire();
        await assert.rejects(queued, { name: 'TimeoutError' });
        response.reject(Object.assign(new Error('late 404'), { statusCode: 404 }));
        await new Promise(resolve => setImmediate(resolve));
        const inventory = await store.read(scope);
        assert.equal(inventory.waiting.size, 0);
        assert.equal(inventory.runners.get(sprite.name)?.state, state);
        assert.equal(inventory.runners.get(sprite.name)?.leaseId, undefined);
        assert.ok(!client.deleted.includes(sprite.name));
        const writes = t.mock.method(store, 'transact');
        t.mock.timers.tick(1000);
        assert.equal(writes.mock.callCount(), 0);
    });
}

for (const step of ['health check', 'restore']) {
    test(`a stalled idle runner ${step} reaches its deadline and is replaced`, { timeout: 5000 }, async t => {
        const client = new FakeSprites();
        const store = new MemorySpritePoolStore();
        const runtime = pool(client, store);
        const signal = new AbortController().signal;
        const slot = await runtime.acquire(signal);
        await runtime.release(slot);
        const sprite = client.created[0];
        const started = Promise.withResolvers<void>();
        const stalled = () => { started.resolve(); return new Promise(() => {}); };
        if (step === 'health check') t.mock.method(sprite, 'execFile', stalled);
        else {
            await store.transact(scope, pool => { pool.runners.get(slot.name)!.warm = { repo: 'previous', checkpoint: 'warm' }; });
            t.mock.method(sprite, 'restoreCheckpoint', stalled);
        }
        const expire = controlDeadline(t, step === 'health check' ? 30_000 : 120_000);
        const acquiring = runtime.acquire(signal);
        await started.promise;
        expire();
        const next = await acquiring;
        assert.notEqual(next.name, slot.name);
        assert.deepEqual(client.deleted, [slot.name]);
        assert.equal((await store.read(scope)).runners.size, 1);
        await runtime.discard(next);
    });
}

for (const path of ['initial', 'failed health check']) {
    test(`a pending ${path} create keeps its slot through timeout, a peer 404 and late deletion`, { timeout: 5000 }, async t => {
        const client = new FakeSprites();
        const store = new MemorySpritePoolStore();
        const runtime = pool(client, store);
        const signal = new AbortController().signal;
        if (path === 'failed health check') {
            await runtime.release(await runtime.acquire(signal));
            client.created[0].failHealth = true;
        }
        const expire = controlDeadline(t, 21 * 60_000);
        const requested = Promise.withResolvers<string>();
        const resume = Promise.withResolvers<void>();
        const create = client.createSprite.bind(client);
        t.mock.method(client, 'createSprite', async (...args: Parameters<typeof create>) => {
            requested.resolve(args[0]);
            await resume.promise;
            return create(...args);
        }, { times: 1 });
        const acquiring = runtime.acquire(signal);
        const name = await requested.promise;
        expire();
        await assert.rejects(acquiring, { name: 'TimeoutError' });
        const peer = pool(client, store);
        await peer.reconcile();
        await assert.rejects(peer.acquire(signal, { timeout: 30 }), { name: 'TimeoutError' });
        const record = async () => (await store.read(scope)).runners.get(name);
        assert.equal((await record())?.state, 'orphaned');
        assert.equal((await record())?.leaseId, undefined);
        assert.ok(!client.deleted.includes(name));
        const remove = client.deleteSprite.bind(client);
        const deleting = Promise.withResolvers<void>();
        const deleted = Promise.withResolvers<void>();
        t.mock.method(client, 'deleteSprite', async (late: string) => {
            assert.equal(late, name);
            deleting.resolve();
            await deleted.promise;
            return remove(late);
        }, { times: 1 });
        resume.resolve();
        await deleting.promise;
        assert.equal((await record())?.state, 'reaping');
        deleted.resolve();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(await record(), undefined);
        assert.equal(client.deleted.at(-1), name);
        assert.deepEqual(client.created.at(-1)?.events, []);
        await peer.discard(await peer.acquire(signal));
    });
}

for (const outcome of ['peer reaped', 'conflict', 'successor lease']) {
    test(`a timed-out create respects ownership on a late response after ${outcome}`, { timeout: 5000 }, async t => {
        const client = new FakeSprites();
        const store = new MemorySpritePoolStore();
        const runtime = pool(client, store);
        const peer = pool(client, store);
        const expire = controlDeadline(t, 21 * 60_000);
        const create = client.createSprite.bind(client);
        const started = Promise.withResolvers<string>();
        const resume = Promise.withResolvers<void>();
        t.mock.method(client, 'createSprite', async (...args: Parameters<typeof create>) => {
            const sprite = outcome === 'conflict' ? undefined : await create(...args);
            if (!sprite) client.foreign.push(Object.assign(new FakeSprite(args[0]), { labels: [spritesPoolLabel(scope)] }));
            started.resolve(args[0]);
            await resume.promise;
            if (!sprite) throw Object.assign(new Error('conflict'), { statusCode: 409 });
            return sprite;
        });
        const acquiring = runtime.acquire(new AbortController().signal);
        const name = await started.promise;
        expire();
        await assert.rejects(acquiring, { name: 'TimeoutError' });
        if (outcome === 'successor lease') {
            await store.transact(scope, pool => Object.assign(pool.runners.get(name)!, { state: 'leased', leaseId: 'successor' }));
        } else {
            await peer.reconcile();
            assert.equal((await store.read(scope)).runners.has(name), outcome === 'conflict');
        }
        resume.resolve();
        await new Promise(resolve => setImmediate(resolve));
        const current = (await store.read(scope)).runners.get(name);
        if (outcome === 'successor lease') assert.equal(current?.leaseId, 'successor');
        else assert.equal(current, undefined);
        assert.deepEqual(client.deleted, outcome === 'peer reaped' ? [name] : []);
    });
}

test('a late ambiguous create failure stays counted until a peer sees the matching Sprite', { timeout: 5000 }, async t => {
    const client = new FakeSprites();
    const store = new MemorySpritePoolStore();
    const runtime = pool(client, store);
    const expire = controlDeadline(t, 21 * 60_000);
    const create = client.createSprite.bind(client);
    const requested = Promise.withResolvers<Parameters<typeof create>>();
    const response = Promise.withResolvers<never>();
    t.mock.method(client, 'createSprite', (...args: Parameters<typeof create>) => {
        requested.resolve(args);
        return response.promise;
    }, { times: 1 });
    const acquiring = runtime.acquire(new AbortController().signal);
    const args = await requested.promise;
    expire();
    await assert.rejects(acquiring, { name: 'TimeoutError' });
    response.reject(new Error('connection lost'));
    await new Promise(resolve => setImmediate(resolve));
    const peer = pool(client, store);
    const signal = new AbortController().signal;
    await assert.rejects(peer.acquire(signal, { timeout: 30 }), { name: 'TimeoutError' });
    assert.equal((await store.read(scope)).runners.get(args[0])?.state, 'orphaned');
    await create(...args);
    const next = await peer.acquire(signal);
    assert.deepEqual(client.deleted, [args[0]]);
    await peer.discard(next);
});

test('shutdown settles while a background replacement create is still pending', { timeout: 5000 }, async t => {
    const client = new FakeSprites();
    const store = new MemorySpritePoolStore();
    const runtime = pool(client, store);
    const slot = await runtime.acquire(new AbortController().signal);
    client.created[0].failWipe = true;
    const started = Promise.withResolvers<string>();
    t.mock.method(client, 'createSprite', (name: string) => { started.resolve(name); return new Promise(() => {}); });
    await runtime.release(slot);
    const name = await started.promise;
    await runtime.close();
    await pool(client, store).reconcile();
    assert.equal((await store.read(scope)).runners.get(name)?.state, 'orphaned');
    assert.deepEqual(client.deleted, [slot.name]);
});

for (const operation of ['list', 'lookup', 'delete']) {
    test(`startup reconciliation bounds a stalled inventory ${operation}`, { timeout: 5000 }, async t => {
        const client = new FakeSprites();
        const store = new MemorySpritePoolStore();
        const name = 'propr-inventory';
        const started = Promise.withResolvers<void>();
        const pending = () => { started.resolve(); return new Promise(() => {}); };
        if (operation === 'list') t.mock.method(client, 'listAllSprites', pending);
        if (operation === 'lookup') {
            await store.transact(scope, pool => pool.runners.set(name, { state: 'retained', since: 0, heartbeatAt: 0, runs: 1 }));
            t.mock.method(client, 'getSprite', pending);
        }
        if (operation === 'delete') {
            client.foreign.push(Object.assign(new FakeSprite(name), { labels: [spritesPoolLabel(scope)] }));
            t.mock.method(client, 'deleteSprite', pending);
        }
        const expire = controlDeadline(t, 60_000);
        const checking = pool(client, store).reconcile();
        await started.promise;
        expire();
        if (operation === 'delete') await checking;
        else await assert.rejects(checking, { name: 'TimeoutError' });
        if (operation === 'lookup') assert.equal((await store.read(scope)).runners.get(name)?.state, 'retained');
    });
}

for (const cleanup of ['replacement', 'shutdown']) {
    test(`a stalled ${cleanup} deletion leaves the runner counted for retry`, { timeout: 5000 }, async t => {
        const client = new FakeSprites();
        const store = new MemorySpritePoolStore();
        const runtime = pool(client, store);
        const slot = await runtime.acquire(new AbortController().signal);
        if (cleanup === 'shutdown') await runtime.release(slot);
        else client.created[0].failWipe = true;
        const expire = controlDeadline(t, 60_000);
        const started = Promise.withResolvers<void>();
        const response = Promise.withResolvers<void>();
        t.mock.method(client, 'deleteSprite', () => { started.resolve(); return response.promise; }, { times: 1 });
        const cleaning = cleanup === 'shutdown' ? runtime.close() : runtime.release(slot);
        await started.promise;
        expire();
        if (cleanup === 'shutdown') await cleaning;
        else await assert.rejects(cleaning, { name: 'TimeoutError' });
        response.resolve();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal((await store.read(scope)).runners.get(slot.name)?.state, 'orphaned');
        assert.equal(client.created.length, 1);
        await pool(client, store).reconcile();
        assert.deepEqual(client.deleted, [slot.name]);
        assert.equal((await store.read(scope)).runners.size, 0);
    });
}

test('a lost create response keeps the possible Sprite counted until reaped', async () => {
    const client = new FakeSprites();
    const store = new MemorySpritePoolStore();
    const runtime = pool(client, store);
    const signal = new AbortController().signal;
    const create = client.createSprite.bind(client);
    client.createSprite = async (...args) => {
        await create(...args);
        throw new Error('lost response');
    };
    await assert.rejects(runtime.acquire(signal), /lost response/);
    const name = client.created[0].name;
    assert.equal((await store.read(scope)).runners.get(name)?.state, 'orphaned');
    client.createSprite = create;
    const next = await runtime.acquire(signal);
    assert.deepEqual(client.deleted, [name]);
    await runtime.discard(next);
});

test('a retained lookup cannot forget a record claimed while the provider responds', { timeout: 5000 }, async () => {
    const client = new FakeSprites();
    const store = new MemorySpritePoolStore();
    const name = 'propr-kept';
    client.foreign.push(new FakeSprite(name));
    await store.transact(scope, state => state.runners.set(name, { state: 'retained', since: 0, heartbeatAt: 0, runs: 1 }));
    const runtime = pool(client, store);
    const controller = new AbortController();
    client.getSprite = async () => {
        await store.transact(scope, state => Object.assign(state.runners.get(name)!, { state: 'leased', leaseId: 'other', heartbeatAt: Date.now() }));
        controller.abort();
        throw Object.assign(new Error('gone'), { statusCode: 404 });
    };
    await assert.rejects(runtime.acquire(controller.signal), /abort/i);
    assert.equal((await store.read(scope)).runners.get(name)?.leaseId, 'other');
});

for (const cancelled of [false, true]) {
    test(`losing ownership during the health check prevents ${cancelled ? 'stale cleanup' : 'handoff'}`, async () => {
        const client = new FakeSprites();
        const store = new MemorySpritePoolStore();
        const runtime = pool(client, store);
        const controller = new AbortController();
        const slot = await runtime.acquire(controller.signal);
        await runtime.release(slot);
        const sprite = client.created[0];
        const exec = sprite.execFile.bind(sprite);
        sprite.execFile = async (cmd, args, options) => {
            if (cmd === '/bin/true') {
                await store.transact(scope, state => Object.assign(state.runners.get(slot.name)!, { state: 'retained', leaseId: undefined }));
                if (cancelled) controller.abort();
            }
            return exec(cmd, args, options);
        };
        await assert.rejects(runtime.acquire(controller.signal), cancelled ? /abort/i : /lease lapsed/);
        assert.deepEqual(client.deleted, []);
        assert.equal((await store.read(scope)).runners.get(slot.name)?.state, 'retained');
    });
}

test('concurrent releases discard only the surplus even while provider deletion is pending', async () => {
    const client = new FakeSprites();
    const store = new MemorySpritePoolStore();
    const wide = pool(client, store, 2);
    const narrow = pool(client, store);
    const signal = new AbortController().signal;
    const a = await wide.acquire(signal);
    const b = await wide.acquire(signal);
    await Promise.all([wide.release(a), wide.release(b)]);
    const first = await narrow.acquire(signal);
    const second = await narrow.acquire(signal);
    const deleting = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const remove = client.deleteSprite.bind(client);
    client.deleteSprite = async name => {
        deleting.resolve();
        await resume.promise;
        await remove(name);
    };
    const released = narrow.release(first);
    await deleting.promise;
    const other = narrow.release(second);
    await new Promise(resolve => setImmediate(resolve));
    resume.resolve();
    await Promise.all([released, other]);
    assert.deepEqual(client.deleted, [first.name]);
    assert.equal((await store.read(scope)).runners.get(second.name)?.state, 'idle');
    await narrow.close();
});

test('startup counts all orphans during deletion and rechecks ownership before the next delete', { timeout: 5000 }, async t => {
    const client = new FakeSprites();
    const store = new MemorySpritePoolStore();
    const peer = pool(client, store, 2);
    const signal = new AbortController().signal;
    const initial = await peer.acquire(signal);
    await peer.discard(initial); // This worker's acquisitions will skip startup inventory.
    const kept = 'propr-later';
    for (const name of ['propr-first', kept]) {
        client.foreign.push(Object.assign(new FakeSprite(name), { labels: ['propr-pool', spritesPoolLabel(scope)] }));
    }
    const remove = client.deleteSprite.bind(client);
    const deleting = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    t.mock.method(client, 'deleteSprite', async (name: string) => {
        deleting.resolve();
        await resume.promise;
        await remove(name);
    });
    const startup = pool(client, store, 2).reconcile();
    await deleting.promise;
    try {
        await assert.rejects(peer.acquire(signal, { timeout: 50 }), { name: 'TimeoutError' });
        assert.equal(client.created.length, 1);
        await store.transact(scope, state => state.runners.set(kept, { state: 'retained', heartbeatAt: 0, since: 0, runs: 1 }));
    } finally {
        resume.resolve();
        await startup;
    }
    assert.deepEqual(client.deleted, [initial.name, 'propr-first']);
    assert.equal((await store.read(scope)).runners.get(kept)?.state, 'retained');
});

test('a create conflict cannot grant deletion authority over the existing Sprite', async () => {
    const client = new FakeSprites();
    const store = new MemorySpritePoolStore();
    client.createSprite = async name => {
        client.foreign.push(new FakeSprite(name));
        throw Object.assign(new Error('name already taken'), { statusCode: 409 });
    };
    const runtime = pool(client, store);
    await assert.rejects(runtime.acquire(new AbortController().signal), /name already taken/);
    assert.equal((await store.read(scope)).runners.size, 0);
    await runtime.reconcile();
    assert.deepEqual(client.deleted, []);
});

test('a worker losing its reservation during setup cannot hand out the checkpoint', async () => {
    const client = new FakeSprites();
    const store = new MemorySpritePoolStore();
    client.setup = sprite => {
        const restore = sprite.restoreCheckpoint.bind(sprite);
        sprite.restoreCheckpoint = async checkpoint => {
            await store.transact(scope, state => Object.assign(state.runners.get(sprite.name)!, { state: 'reaping', leaseId: 'replacement' }));
            return restore(checkpoint);
        };
    };
    await assert.rejects(pool(client, store).acquire(new AbortController().signal), /lease lapsed/);
    assert.equal((await store.read(scope)).runners.get(client.created[0].name)?.leaseId, 'replacement');
    assert.deepEqual(client.deleted, []);
});

test('a heartbeat repairs a failed completion write and the unreleased result survives expiry', async t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const client = new FakeSprites();
    const store = new MemorySpritePoolStore();
    const runtime = worker(client, store);
    const launched = Promise.withResolvers<void>();
    client.setup = sprite => { void sprite.launched.promise.then(launched.resolve); };
    const run = runtime.start(spec());
    await launched.promise;
    const outage = t.mock.method(store, 'transact', async () => { throw new Error('Redis unavailable'); });
    assert.equal((await run.wait()).exitCode, 0);
    const sprite = client.created[0];
    const record = async () => (await store.read(scope)).runners.get(sprite.name)!;
    assert.equal((await record()).state, 'leased');
    sprite.files.set('/opt/propr/result/result.bundle', Buffer.from('only copy'));
    t.mock.timers.tick(15_000);
    assert.equal(outage.mock.callCount(), 2);
    outage.mock.restore();
    t.mock.timers.tick(15_000);
    assert.equal((await record()).state, 'finished');

    // Simulate the worker disappearing and a peer reconciling after its last heartbeat expires.
    await store.transact(scope, state => { state.runners.get(sprite.name)!.heartbeatAt = 0; });
    await pool(client, store).reconcile();
    assert.equal((await record()).state, 'retained');
    assert.deepEqual(client.deleted, []);
    assert.equal((await run.readFile!('/tmp/propr-workspace-result/result.bundle'))?.toString(), 'only copy');
    await run.release!();
    await runtime.close();
});

test('completion retries leave a resetting runner and a successor lease alone', async t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const store = new MemorySpritePoolStore();
    const client = new FakeSprites();
    const runtime = pool(client, store);
    const slot = await runtime.acquire(new AbortController().signal);
    t.mock.method(store, 'transact', async () => { throw new Error('Redis unavailable'); }, { times: 1 });
    await runtime.finished(slot);
    const sprite = client.created[0];
    const record = async () => (await store.read(scope)).runners.get(sprite.name)!;
    const resetting = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    t.mock.method(sprite, 'restart', async () => {
        resetting.resolve();
        await resume.promise;
    });
    const release = runtime.release(slot);
    await resetting.promise;
    try {
        t.mock.timers.tick(250);
        assert.equal((await record()).state, 'resetting');
    } finally {
        resume.resolve();
        await release;
    }
    assert.equal((await record()).state, 'idle');

    const next = await runtime.acquire(new AbortController().signal);
    t.mock.method(store, 'transact', async () => { throw new Error('Redis unavailable'); }, { times: 1 });
    await runtime.finished(next);
    await store.transact(scope, state => Object.assign(state.runners.get(next.name)!, { leaseId: 'successor', heartbeatAt: 1 }));
    t.mock.timers.tick(250);
    assert.equal((await record()).state, 'leased');
    assert.equal((await record()).heartbeatAt, 1);
    await runtime.release(next);
    assert.equal((await record()).leaseId, 'successor');
});

for (const reaper of ['startup', 'acquisition']) {
    test(`${reaper} retains the only bundle when the worker dies before completion repair`, { timeout: 5000 }, async t => {
        t.mock.timers.enable({ apis: ['setInterval'] });
        const client = new FakeSprites();
        const store = new MemorySpritePoolStore();
        const peer = pool(client, store);
        const signal = new AbortController().signal;
        // Initialize the acquiring peer before the lease expires, to bypass startup reaping.
        if (reaper === 'acquisition') await peer.discard(await peer.acquire(signal));
        const runtime = worker(client, store);
        const launched = Promise.withResolvers<void>();
        client.setup = sprite => { void sprite.launched.promise.then(launched.resolve); };
        const run = runtime.start(spec());
        await launched.promise;
        const sprite = client.created.at(-1)!;
        sprite.files.set('/opt/propr/result/result.bundle', Buffer.from('only copy'));
        const outage = t.mock.method(store, 'transact', async () => { throw new Error('Redis unavailable'); });
        await run.wait();
        outage.mock.restore();
        assert.equal((await store.read(scope)).runners.get(sprite.name)?.state, 'leased');
        const disconnected = t.mock.method(sprite, 'filesystem', () => { throw new Error('connection lost'); });
        await assert.rejects(run.readFile!('/tmp/propr-workspace-result/result.bundle'), /connection lost/);
        disconnected.mock.restore();
        // No further heartbeats or release from the original worker.
        await store.transact(scope, state => { state.runners.get(sprite.name)!.heartbeatAt = 0; });
        if (reaper === 'startup') await peer.reconcile();
        else {
            const controller = new AbortController();
            // A full pool polls the retained Sprite while the acquisition waits.
            t.mock.method(client, 'getSprite', async () => { controller.abort(); return sprite; }, { times: 1 });
            await assert.rejects(peer.acquire(controller.signal), /abort/i);
        }
        const retained = (await store.read(scope)).runners.get(sprite.name)!;
        assert.equal(retained.state, 'retained');
        assert.equal(retained.leaseId, undefined);
        assert.ok(!client.deleted.includes(sprite.name));
        const recovered = await client.getSprite(sprite.name);
        assert.equal((await recovered.filesystem().readFile('/opt/propr/result/result.bundle', null)).toString(), 'only copy');
        await run.release!();
        await runtime.close();
    });
}

for (const probe of ['completed directory', 'inspection failure', 'stale negative', 'stale positive']) {
    test(`expired execution result inspection handles ${probe}`, async t => {
        const client = new FakeSprites();
        const store = new MemorySpritePoolStore();
        const sprite = new FakeSprite('propr-expired');
        client.foreign.push(sprite);
        await store.transact(scope, state => state.runners.set(sprite.name, {
            state: 'leased', leaseId: 'dead', heartbeatAt: 0, since: 0, runs: 1,
        }));
        sprite.resultDirectoryCompleted = probe === 'completed directory' || probe === 'stale positive';
        const exec = sprite.execFile.bind(sprite);
        t.mock.method(sprite, 'execFile', async (...args: Parameters<typeof exec>) => {
            if (probe === 'inspection failure') throw new Error('provider unavailable');
            if (probe.startsWith('stale')) {
                await store.transact(scope, state => Object.assign(state.runners.get(sprite.name)!, { state: 'leased', leaseId: 'successor' }));
            }
            return exec(...args);
        });
        await pool(client, store).reconcile();
        const record = (await store.read(scope)).runners.get(sprite.name)!;
        assert.equal(record.state, probe.startsWith('stale') ? 'leased' : 'retained');
        assert.equal(record.leaseId, probe.startsWith('stale') ? 'successor' : undefined);
        assert.deepEqual(client.deleted, []);
    });
}
