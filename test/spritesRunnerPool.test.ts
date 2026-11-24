/**
 * The shared Sprites runner pool through `SpritesRuntime`: two runtimes on one
 * store stand in for two workers. Leasing, FIFO queueing at the bound, health
 * checks, orphan reaping and startup reconciliation, warm clone checkpoints,
 * run usage timings and the status summary.
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
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
    const legacyOld = Object.assign(new FakeSprite('propr-0b9d3a52-6f53-4f58-a9b2-2f7f0f0f0f0f'), { createdAt: new Date(Date.now() - 48 * 3600_000) });
    const legacyNew = new FakeSprite('propr-1b9d3a52-6f53-4f58-a9b2-2f7f0f0f0f0f');
    const unrelated = new FakeSprite('my-own-sprite');
    const pooled = Object.assign(new FakeSprite('propr-pooled'), { labels: ['propr-pool', label] });
    client.foreign.push(leaked, otherPool, legacyOld, legacyNew, unrelated, pooled);
    await store.transact(scope, state => {
        state.runners.set('propr-pooled', { state: 'idle', heartbeatAt: 0, since: 0, runs: 1, checkpoint: 'v1' });
        state.runners.set('propr-vanished', { state: 'idle', heartbeatAt: 0, since: 0, runs: 1, checkpoint: 'v1' });
    });
    pooled.checkpoints.push({ id: 'v1', comment: 'propr clean setup', files: new Map() });
    const runtime = worker(client, store);
    const run = runtime.start(spec());
    await run.wait();
    assert.deepEqual(client.deleted.sort(), ['propr-0b9d3a52-6f53-4f58-a9b2-2f7f0f0f0f0f', 'propr-leaked'].sort());
    assert.equal(pooled.launches.length, 1, 'an idle runner with a record is reused, not reaped');
    assert.equal((await store.read(scope)).runners.has('propr-vanished'), false);
    await run.release!();
    await runtime.close();
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
