/**
 * The Redis store of the shared Sprites runner pool over a real Redis: the
 * bound holds under concurrent acquisitions from separate connections (as
 * separate workers would make them), state round-trips, unreadable records
 * still count, and the status report reads every pool.
 * Redis: a spawned `redis-server` when available (PROPR_TEST_REDIS_SERVER),
 * otherwise REDIS_HOST / REDIS_PORT. With PROPR_REQUIRE_REDIS_INTEGRATION=1 an
 * unavailable Redis fails the suite instead of skipping it.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Redis } from 'ioredis';
import { RedisSpritePoolStore, spritesPoolKeys } from '../packages/core/src/agents/runtime/sprites/spritesPoolStore.ts';
import { acquireSpriteRunner, releaseSpriteRunner } from '../packages/core/src/agents/runtime/sprites/spritesPoolState.ts';
import { readSpritesPoolStatus } from '../packages/core/src/agents/runtime/spritesPool.ts';

const required = process.env.PROPR_REQUIRE_REDIS_INTEGRATION === '1';
const binary = process.env.PROPR_TEST_REDIS_SERVER || 'redis-server';
let server: ChildProcess | undefined;
const clients: Redis[] = [];

async function freePort(): Promise<number> {
    const probe = createServer();
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as { port: number };
    await new Promise<void>(resolve => probe.close(() => resolve()));
    return port;
}
async function connect(host: string, port: number, attempts: number): Promise<Redis | undefined> {
    for (let attempt = 0; attempt < attempts; attempt++) {
        const client = new Redis({ host, port, lazyConnect: true, retryStrategy: () => null, maxRetriesPerRequest: 1 });
        client.on('error', () => {});
        try { await client.connect(); await client.ping(); return client; }
        catch { client.disconnect(); await delay(100); }
    }
    return undefined;
}
async function endpoint(): Promise<{ host: string; port: number } | undefined> {
    if (spawnSync(binary, ['--version']).status === 0) {
        const port = await freePort();
        server = spawn(binary, ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
        const probe = await connect('127.0.0.1', port, 50);
        if (probe) { probe.disconnect(); return { host: '127.0.0.1', port }; }
    }
    if (process.env.REDIS_HOST || process.env.REDIS_PORT) {
        const host = process.env.REDIS_HOST || '127.0.0.1', port = Number(process.env.REDIS_PORT || 6379);
        const probe = await connect(host, port, 3);
        if (probe) { probe.disconnect(); return { host, port }; }
    }
    return undefined;
}

const target = await endpoint();
if (!target && required) throw new Error('Redis integration tests are required (PROPR_REQUIRE_REDIS_INTEGRATION=1) but no Redis is available');
const options = { skip: target ? false : 'Redis required: no redis-server binary and no reachable REDIS_HOST/REDIS_PORT', timeout: 30_000 };
async function store(): Promise<RedisSpritePoolStore> {
    const client = (await connect(target!.host, target!.port, 3))!;
    clients.push(client);
    return new RedisSpritePoolStore(client);
}
after(() => {
    for (const client of clients) client.disconnect();
    server?.kill();
});

test('concurrent acquisitions from separate connections never provision past the bound', options, async () => {
    const scope = `test-${randomUUID().slice(0, 8)}`;
    const stores = await Promise.all([store(), store(), store()]);
    const now = Date.now();
    const decisions = await Promise.all(Array.from({ length: 24 }, (_, index) => stores[index % 3].transact(scope, state =>
        acquireSpriteRunner(state, { leaseId: `lease-${index}`, owner: `worker-${index % 3}`, max: 2, newName: `propr-${index}`, now: now + index, ttlMs: 60_000 }))));
    assert.equal(decisions.filter(decision => decision.action === 'provision').length, 2);
    assert.equal(decisions.filter(decision => decision.action === 'wait').length, 22);
    const state = await stores[0].read(scope);
    assert.equal(state.runners.size, 2);
    assert.equal(state.waiting.size, 22);
    // A release hands the runner to the longest waiter, wherever it waits.
    const [name, record] = [...state.runners].find(([, r]) => r.state === 'provisioning')!;
    assert.equal(await stores[1].transact(scope, s => releaseSpriteRunner(s, { name, leaseId: record.leaseId!, max: 2, now: Date.now() }, { checkpoint: 'v1' })), 'idle');
    const waiters = [...state.waiting].sort(([, a], [, b]) => a.joinedAt - b.joinedAt).map(([id]) => id);
    const late = await stores[2].transact(scope, s => acquireSpriteRunner(s, { leaseId: waiters[1], owner: 'w', max: 2, newName: 'x', now: Date.now(), ttlMs: 60_000 }));
    assert.equal(late.action, 'wait');
    const first = await stores[2].transact(scope, s => acquireSpriteRunner(s, { leaseId: waiters[0], owner: 'w', max: 2, newName: 'x', now: Date.now(), ttlMs: 60_000 }));
    assert.deepEqual([first.action, 'name' in first && first.name], ['lease', name]);
});

test('an unreadable runner record counts as orphaned and the status report reads every pool', options, async () => {
    const scope = `test-${randomUUID().slice(0, 8)}`;
    const pool = await store();
    await pool.publishConfig(scope, { max: 2, orgLimit: 3, warmClones: true, updatedAt: Date.now() });
    await pool.transact(scope, state => {
        state.runners.set('propr-idle', { state: 'idle', heartbeatAt: Date.now(), since: Date.now(), runs: 4, checkpoint: 'v1', lastRestoreMs: 14_000 });
    });
    await clients.at(-1)!.hset(spritesPoolKeys(scope).runners, 'propr-garbled', '{not json');
    const report = await readSpritesPoolStatus({ store: pool });
    const status = report.pools.find(entry => entry.id === scope.slice(0, 12))!;
    assert.equal(status.max, 2);
    assert.equal(status.warmClones, true);
    assert.equal(status.runners.idle, 1);
    assert.equal(status.runners.orphaned, 1);
    assert.equal(status.restore.lastMs, 14_000);
    assert.equal(report.unavailable, undefined);
    assert.ok((await pool.scopes()).includes(scope));
});
